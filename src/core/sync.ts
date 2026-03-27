/**
 * Sync module: observation polling, embedding via engram-vec, rate-limited backfill.
 *
 * INVARIANT: Every observation_id <= bookmark is either:
 *   (a) successfully embedded, OR
 *   (b) tracked in sync_failures (pending retry or parked)
 * Failed observations never silently disappear.
 */

import type Database from "better-sqlite3";
import { config } from "../config.js";
import { extractAndLink } from "./graph.js";
import { log } from "../lib/logger.js";
import { computeHealth } from "./health.js";
import { isAcked } from "./reconcile.js";

// ─── Failure tracking helpers ──────────────────────────────────────

function prepareFailureStatements(db: Database.Database) {
  return {
    insertFailure: db.prepare(`
      INSERT OR REPLACE INTO sync_failures (observation_id, attempt_count, last_error, last_attempt_at, first_failed_at, status)
      VALUES (?, 1, ?, datetime('now'), datetime('now'), 'pending')
    `),
    getPending: db.prepare(
      "SELECT * FROM sync_failures WHERE status = 'pending' ORDER BY observation_id ASC"
    ),
    deleteFailure: db.prepare(
      "DELETE FROM sync_failures WHERE observation_id = ?"
    ),
    incrementFailure: db.prepare(`
      UPDATE sync_failures
      SET attempt_count = attempt_count + 1,
          last_error = ?,
          last_attempt_at = datetime('now')
      WHERE observation_id = ?
    `),
    parkFailure: db.prepare(`
      UPDATE sync_failures
      SET status = 'parked',
          attempt_count = attempt_count + 1,
          last_error = ?,
          last_attempt_at = datetime('now')
      WHERE observation_id = ?
    `),
    getFailure: db.prepare(
      "SELECT * FROM sync_failures WHERE observation_id = ?"
    ),
  };
}

// ─── syncNewObservations ────────────────────────────────────────────

/**
 * Reads last_synced_id bookmark from cortex_meta, queries observations with
 * id > bookmark. For each new observation:
 *   (a) calls extractAndLink for entity extraction
 *   (b) POSTs to engram-vec /embed with response.ok check
 *   (c) on failure: records in sync_failures (never silently lost)
 *   (d) updates bookmark per-observation for crash safety
 *
 * Before processing new observations, retries any pending sync_failures entries.
 */
export async function syncNewObservations(db: Database.Database): Promise<void> {
  const health = computeHealth(db);
  if (health === 'blocked' && !isAcked()) {
    log("warn", "sync: BLOCKED -- mutating operation skipped. Run cortex_reconcile to resolve.");
    return;
  }

  const stmts = prepareFailureStatements(db);

  // ── Phase 1: Retry pending failures ──────────────────────────────
  const pendingFailures = stmts.getPending.all() as Array<{
    observation_id: number;
    attempt_count: number;
  }>;

  for (const failure of pendingFailures) {
    try {
      const response = await fetch(`${config.engramVecUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: failure.observation_id }),
      });

      if (response.ok) {
        stmts.deleteFailure.run(failure.observation_id);
        db.prepare("INSERT OR REPLACE INTO cortex_meta(key, value) VALUES('last_successful_sync_at', datetime('now'))").run();
        log("info", `sync: retry succeeded for observation ${failure.observation_id}`);
      } else {
        const errorText = await response.text().catch(() => response.statusText);
        const errorMsg = `HTTP ${response.status}: ${errorText}`;
        const newCount = failure.attempt_count + 1;

        if (newCount >= config.syncMaxRetries) {
          stmts.parkFailure.run(errorMsg, failure.observation_id);
          log("warn", `sync: parking observation ${failure.observation_id} after ${newCount} attempts`);
        } else {
          stmts.incrementFailure.run(errorMsg, failure.observation_id);
          log("warn", `sync: retry ${newCount} failed for observation ${failure.observation_id}: ${errorMsg}`);
        }
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      const newCount = failure.attempt_count + 1;

      if (newCount >= config.syncMaxRetries) {
        stmts.parkFailure.run(errorMsg, failure.observation_id);
        log("warn", `sync: parking observation ${failure.observation_id} after ${newCount} attempts`);
      } else {
        stmts.incrementFailure.run(errorMsg, failure.observation_id);
        log("warn", `sync: retry ${newCount} failed for observation ${failure.observation_id}: ${errorMsg}`);
      }
    }
  }

  // ── Phase 2: Process new observations ────────────────────────────
  const bookmarkRow = db
    .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
    .get() as { value: string } | undefined;

  const lastSyncedId = bookmarkRow ? parseInt(bookmarkRow.value, 10) : 0;

  const newObs = db
    .prepare("SELECT id FROM observations WHERE id > ? ORDER BY id ASC")
    .all(lastSyncedId) as Array<{ id: number }>;

  if (newObs.length === 0) return;

  const updateBookmark = db.prepare(
    "INSERT OR REPLACE INTO cortex_meta(key, value) VALUES('last_synced_id', ?)"
  );

  for (const obs of newObs) {
    // Extract entities and link
    extractAndLink(db, obs.id);

    // Attempt embedding via engram-vec
    try {
      const response = await fetch(`${config.engramVecUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: obs.id }),
      });

      if (response.ok) {
        db.prepare("INSERT OR REPLACE INTO cortex_meta(key, value) VALUES('last_successful_sync_at', datetime('now'))").run();
      } else {
        const errorText = await response.text().catch(() => response.statusText);
        const errorMsg = `HTTP ${response.status}: ${errorText}`;
        stmts.insertFailure.run(obs.id, errorMsg);
        log("warn", `embed failed for observation ${obs.id}: ${errorMsg}`);
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      stmts.insertFailure.run(obs.id, errorMsg);
      log("warn", `embed failed for observation ${obs.id}:`, err);
    }

    // Update bookmark per-observation for crash safety
    // Bookmark advances even on failure -- failed obs is tracked in sync_failures
    updateBookmark.run(String(obs.id));
  }
}

// ─── startSyncPoller ────────────────────────────────────────────────

/**
 * Initializes bookmark to MAX(id) from observations table (or 0 if empty).
 * Returns setInterval handle that calls syncNewObservations with re-entrancy guard.
 */
export function startSyncPoller(
  db: Database.Database,
  intervalMs?: number
): ReturnType<typeof setInterval> {
  // Initialize bookmark to current MAX(id) if not set
  const existing = db
    .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
    .get() as { value: string } | undefined;

  if (!existing) {
    const maxRow = db
      .prepare("SELECT MAX(id) as maxId FROM observations")
      .get() as { maxId: number | null };
    const maxId = maxRow?.maxId ?? 0;
    db.prepare(
      "INSERT OR REPLACE INTO cortex_meta(key, value) VALUES('last_synced_id', ?)"
    ).run(String(maxId));
  }

  let syncing = false;
  const interval = intervalMs ?? config.syncIntervalMs;

  const handle = setInterval(async () => {
    if (syncing) {
      log("debug", "sync: skipping poll, previous sync still running");
      return;
    }
    syncing = true;
    try {
      await syncNewObservations(db);
    } catch (err) {
      log("error", "sync: poll error:", err);
    } finally {
      syncing = false;
    }
  }, interval);

  return handle;
}

// ─── embeddingBackfill ──────────────────────────────────────────────

/**
 * Queries observations missing from observations_vec. For each (up to maxPerCycle),
 * POSTs to engram-vec /embed. Checks response.ok -- non-200 does NOT count as success.
 * Failures are recorded in sync_failures. Returns count of successful embeds.
 */
export async function embeddingBackfill(
  db: Database.Database,
  delayMs?: number,
  maxPerCycle?: number
): Promise<number> {
  const health = computeHealth(db);
  if (health === 'blocked' && !isAcked()) {
    log("warn", "backfill: BLOCKED -- mutating operation skipped. Run cortex_reconcile to resolve.");
    return 0;
  }

  const delay = delayMs ?? config.backfillDelayMs;
  const max = maxPerCycle ?? config.backfillMaxPerCycle;
  const stmts = prepareFailureStatements(db);

  const missing = db
    .prepare(
      `SELECT o.id
       FROM observations o
       LEFT JOIN observations_vec v ON o.id = v.observation_id
       WHERE v.observation_id IS NULL AND o.deleted_at IS NULL
       ORDER BY o.id ASC
       LIMIT ?`
    )
    .all(max) as Array<{ id: number }>;

  let successCount = 0;

  for (let i = 0; i < missing.length; i++) {
    const obs = missing[i];

    try {
      const response = await fetch(`${config.engramVecUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: obs.id }),
      });

      if (response.ok) {
        successCount++;
      } else {
        const errorText = await response.text().catch(() => response.statusText);
        const errorMsg = `HTTP ${response.status}: ${errorText}`;
        stmts.insertFailure.run(obs.id, errorMsg);
        log("warn", `backfill embed non-200 for observation ${obs.id}: ${errorMsg}`);
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      stmts.insertFailure.run(obs.id, errorMsg);
      log("warn", `backfill embed failed for observation ${obs.id}:`, err);
    }

    // Sleep between calls (except after last)
    if (delay > 0 && i < missing.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return successCount;
}
