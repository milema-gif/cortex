import type Database from "better-sqlite3";
import type { HealthLevel } from "../types.js";

export type { HealthLevel };

/**
 * Compute system health from sync_failures state.
 *
 * - blocked: parked_count > 5 OR any parked item older than 24h
 * - degraded: any sync_failures rows exist (pending or parked)
 * - healthy: no sync_failures rows
 *
 * Returns 'healthy' if sync_failures table doesn't exist.
 */
export function computeHealth(db: Database.Database): HealthLevel {
  try {
    // Check parked count
    const parked = db
      .prepare("SELECT COUNT(*) as cnt FROM sync_failures WHERE status = 'parked'")
      .get() as { cnt: number };

    // Check for any parked item older than 24 hours
    const oldParked = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM sync_failures WHERE status = 'parked' AND first_failed_at < datetime('now', '-24 hours')"
      )
      .get() as { cnt: number };

    if (parked.cnt > 5 || oldParked.cnt > 0) {
      return "blocked";
    }

    // Check total sync_failures rows (pending + parked)
    const total = db
      .prepare("SELECT COUNT(*) as cnt FROM sync_failures")
      .get() as { cnt: number };

    if (total.cnt > 0) {
      return "degraded";
    }

    return "healthy";
  } catch {
    // sync_failures table doesn't exist -- healthy by default
    return "healthy";
  }
}
