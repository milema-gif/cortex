import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { config } from "../config.js";
import { computeConfidence, addStalenessWarning } from "./lifecycle.js";
import { estimateTokens, assembleBrief, type BriefSection } from "../lib/token-budget.js";
import { log } from "../lib/logger.js";

/**
 * Preflight categories mapped from observation types to brief section labels.
 * Priority determines order and budget allocation in the brief.
 */
const PREFLIGHT_CATEGORIES: Array<{
  type: string;
  label: string;
  priority: number;
}> = [
  { type: "decision", label: "Decisions", priority: 4 },
  { type: "gotcha", label: "Gotchas", priority: 3 },
  { type: "architecture", label: "Architecture", priority: 3 },
  { type: "todo", label: "Active Todos", priority: 2 },
  { type: "pattern", label: "Patterns", priority: 2 },
  { type: "bugfix", label: "Recent Fixes", priority: 1 },
];

export interface PreflightResult {
  changed: boolean;
  brief: string;
}

/**
 * Generate a compact preflight memory brief for a project.
 *
 * Queries observations by category type, applies lifecycle filtering,
 * assembles within token budget, deduplicates via hash-based cache.
 *
 * Gracefully degrades: returns error message if DB unavailable (PRE-05).
 */
export async function generatePreflight(
  db: Database.Database,
  project: string
): Promise<PreflightResult> {
  try {
    const sections: BriefSection[] = [];
    const allObsIds: number[] = [];

    for (const cat of PREFLIGHT_CATEGORIES) {
      const rows = db
        .prepare(
          `SELECT o.id, o.title, o.content, o.created_at,
                  COALESCE(lc.status, 'active') AS status,
                  COALESCE(lc.confidence, 1.0) AS confidence,
                  lc.last_verified_at
           FROM observations o
           LEFT JOIN obs_lifecycle lc ON o.id = lc.observation_id
           WHERE o.project = ? AND o.type = ? AND o.deleted_at IS NULL
             AND COALESCE(lc.status, 'active') = 'active'
           ORDER BY o.created_at DESC
           LIMIT 10`
        )
        .all(project, cat.type) as Array<{
          id: number;
          title: string;
          content: string | null;
          created_at: string;
          status: string;
          confidence: number;
          last_verified_at: string | null;
        }>;

      if (rows.length === 0) continue;

      // Compute confidence and sort by it
      const enriched = rows.map((row) => {
        const conf = computeConfidence({
          status: row.status,
          confidence: row.confidence,
          created_at: row.created_at,
          last_verified_at: row.last_verified_at,
        });
        const title = addStalenessWarning(row.title, row.last_verified_at, row.created_at);
        return { ...row, computedConfidence: conf, title };
      });

      enriched.sort((a, b) => b.computedConfidence - a.computedConfidence);

      const items = enriched.map((r) => r.title);
      allObsIds.push(...enriched.map((r) => r.id));

      sections.push({
        label: cat.label,
        items,
        priority: cat.priority,
      });
    }

    // Assemble brief within token budget
    const brief = assembleBrief(sections, config.preflightTokenBudget);

    // Hash for cache dedup
    const briefHash = createHash("sha256").update(brief).digest("hex").slice(0, 16);

    // Check cache
    const cacheKey = `preflight:${project}`;
    const cached = db
      .prepare(
        `SELECT brief_hash FROM preflight_cache
         WHERE cache_key = ? AND expires_at > datetime('now')`
      )
      .get(cacheKey) as { brief_hash: string } | undefined;

    if (cached && cached.brief_hash === briefHash) {
      return { changed: false, brief: "No changes since last preflight." };
    }

    // Store in cache
    const ttlMinutes = config.preflightCacheTtlMinutes;
    db.prepare(
      `INSERT OR REPLACE INTO preflight_cache (cache_key, brief, brief_hash, obs_ids, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' minutes'))`
    ).run(cacheKey, brief, briefHash, JSON.stringify(allObsIds), ttlMinutes);

    return { changed: true, brief };
  } catch (err) {
    log("warn", "Preflight generation failed:", (err as Error).message);
    return { changed: true, brief: `Preflight unavailable: ${(err as Error).message}` };
  }
}
