import type Database from "better-sqlite3";
import { config } from "../config.js";
import type { ConflictMatch } from "../types.js";

/**
 * Ensure an obs_lifecycle row exists for the given observation.
 * INSERT OR IGNORE: no-op if row already exists.
 */
export function ensureLifecycleRow(db: Database.Database, observationId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO obs_lifecycle (observation_id) VALUES (?)"
  ).run(observationId);
}

/**
 * Deprecate an observation. Idempotent: re-deprecating a deprecated observation is a no-op.
 */
export function deprecate(db: Database.Database, observationId: number, reason: string): void {
  ensureLifecycleRow(db, observationId);
  db.prepare(
    `UPDATE obs_lifecycle
     SET status = 'deprecated', deprecation_reason = ?, updated_at = datetime('now')
     WHERE observation_id = ? AND status != 'deprecated'`
  ).run(reason, observationId);
}

/**
 * Supersede old observation with new one. Creates bidirectional link.
 * Idempotent: if old is already superseded by newId, no-op.
 */
export function supersede(db: Database.Database, oldId: number, newId: number): void {
  ensureLifecycleRow(db, oldId);
  ensureLifecycleRow(db, newId);

  const existing = db.prepare(
    "SELECT superseded_by_id FROM obs_lifecycle WHERE observation_id = ?"
  ).get(oldId) as { superseded_by_id: number | null } | undefined;

  if (existing?.superseded_by_id === newId) {
    return; // Already superseded by this exact newId -- no-op
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE obs_lifecycle
       SET status = 'superseded', superseded_by_id = ?, updated_at = datetime('now')
       WHERE observation_id = ?`
    ).run(newId, oldId);

    db.prepare(
      `UPDATE obs_lifecycle
       SET supersedes_id = ?, updated_at = datetime('now')
       WHERE observation_id = ?`
    ).run(oldId, newId);
  })();
}

/**
 * Mark an observation as verified. Creates lifecycle row if needed.
 */
export function verify(db: Database.Database, observationId: number): void {
  ensureLifecycleRow(db, observationId);
  db.prepare(
    `UPDATE obs_lifecycle
     SET last_verified_at = datetime('now'), updated_at = datetime('now')
     WHERE observation_id = ?`
  ).run(observationId);
}

/**
 * Compute confidence score for an observation based on lifecycle state.
 * Pure function -- no DB access.
 *
 * Returns 0 for deprecated/superseded.
 * Otherwise: base confidence * age decay (180d half-life) * verification boost.
 */
export function computeConfidence(obs: {
  status: string;
  confidence: number;
  created_at: string;
  last_verified_at: string | null;
}): number {
  if (obs.status === "deprecated" || obs.status === "superseded") {
    return 0;
  }

  const base = obs.confidence ?? 1.0;
  const now = Date.now();
  const createdAt = new Date(obs.created_at).getTime();
  const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);

  // Age decay: half-life of 180 days
  const decay = Math.pow(0.5, ageDays / config.confidenceHalfLifeDays);

  // Verification boost
  let verifyBoost = 1.0;
  if (obs.last_verified_at) {
    const verifiedAt = new Date(obs.last_verified_at).getTime();
    const verifyDays = (now - verifiedAt) / (1000 * 60 * 60 * 24);
    if (verifyDays < 7) {
      verifyBoost = 1.5; // Full boost for very recent verification
    } else if (verifyDays < 30) {
      verifyBoost = 1.2; // Moderate boost
    }
  }

  return Math.min(1.0, base * decay * verifyBoost);
}

/**
 * Add staleness warning prefix to a title if the observation is unverified for > 90 days.
 * Uses last_verified_at as reference date if available, otherwise created_at.
 */
export function addStalenessWarning(
  title: string,
  lastVerifiedAt: string | null,
  createdAt: string
): string {
  const referenceDate = lastVerifiedAt ? new Date(lastVerifiedAt) : new Date(createdAt);
  const now = Date.now();
  const daysSinceReference = (now - referenceDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceReference > config.stalenessThresholdDays) {
    const staleDays = Math.floor(daysSinceReference);
    return `[STALE ${staleDays}d] ${title}`;
  }
  return title;
}

/**
 * Find potential conflicts -- active observations with similar titles.
 * Sanitizes title for FTS5 safety. Returns top 5 matches.
 */
export function findPotentialConflicts(
  db: Database.Database,
  title: string,
  project?: string
): ConflictMatch[] {
  // Sanitize FTS5 query: remove special chars that break MATCH
  const sanitized = title.replace(/[^\w\s]/g, " ").trim();
  if (!sanitized) return [];

  let sql = `
    SELECT o.id, o.title, rank
    FROM observations o
    JOIN observations_fts f ON o.id = f.rowid
    LEFT JOIN obs_lifecycle lc ON o.id = lc.observation_id
    WHERE observations_fts MATCH ?
      AND o.deleted_at IS NULL
      AND COALESCE(lc.status, 'active') = 'active'
  `;
  const params: unknown[] = [sanitized];

  if (project) {
    sql += " AND o.project = ?";
    params.push(project);
  }

  sql += " ORDER BY rank LIMIT 5";

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    title: string;
    rank: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    similarity: `FTS rank: ${row.rank.toFixed(4)}`,
  }));
}
