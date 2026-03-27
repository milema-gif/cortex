import type Database from "better-sqlite3";
import { config } from "../config.js";
import { getEngramVecStatus } from "../lib/engram-vec.js";
import { log } from "../lib/logger.js";
import type { StatusReport, SyncHealth } from "../types.js";
import type { McpContent } from "./search.js";

const CORTEX_TABLES = [
  "cortex_meta",
  "obs_lifecycle",
  "entities",
  "relations",
  "obs_entities",
  "preflight_cache",
  "sync_failures",
] as const;

/**
 * Check DB connectivity and counts.
 */
function checkDb(db: Database.Database): StatusReport["db"] {
  try {
    const obsRow = db
      .prepare("SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL")
      .get() as { cnt: number };

    let embedded = 0;
    try {
      const vecRow = db
        .prepare("SELECT COUNT(*) as cnt FROM observations_vec")
        .get() as { cnt: number };
      embedded = vecRow.cnt;
    } catch {
      // observations_vec may not exist
    }

    return { status: "ok", observations: obsRow.cnt, embedded };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}

/**
 * Check engram-vec sidecar status.
 */
async function checkEngramVec(): Promise<StatusReport["engram_vec"]> {
  try {
    const data = await getEngramVecStatus();
    return { status: "up", ...data };
  } catch {
    return { status: "down" };
  }
}

/**
 * Check Ollama availability.
 */
async function checkOllama(): Promise<string> {
  try {
    const resp = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

/**
 * Get row counts for each Cortex-owned table.
 */
function checkCortexTables(
  db: Database.Database
): Record<string, number | "not_created"> {
  const result: Record<string, number | "not_created"> = {};

  for (const table of CORTEX_TABLES) {
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as cnt FROM ${table}`)
        .get() as { cnt: number };
      result[table] = row.cnt;
    } catch {
      result[table] = "not_created";
    }
  }

  return result;
}

/**
 * Format a duration in seconds as a human-readable string.
 * e.g., 7350 -> "2h 2m", 90000 -> "1d 1h", 45 -> "0h 0m"
 */
function formatAge(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * Query sync_failures table for health metrics.
 * Returns null if sync_failures table doesn't exist.
 */
function checkSyncHealth(db: Database.Database): SyncHealth | null {
  try {
    const pending = db
      .prepare("SELECT COUNT(*) as cnt FROM sync_failures WHERE status = 'pending'")
      .get() as { cnt: number };
    const parked = db
      .prepare("SELECT COUNT(*) as cnt FROM sync_failures WHERE status = 'parked'")
      .get() as { cnt: number };
    const oldest = db
      .prepare("SELECT MIN(first_failed_at) as oldest FROM sync_failures WHERE status = 'pending'")
      .get() as { oldest: string | null };
    const retries = db
      .prepare("SELECT COALESCE(SUM(attempt_count), 0) as total FROM sync_failures")
      .get() as { total: number };
    const lastSync = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_successful_sync_at'")
      .get() as { value: string } | undefined;

    let oldestPendingAge: string | null = null;
    if (oldest.oldest) {
      const oldestDate = new Date(oldest.oldest + (oldest.oldest.endsWith("Z") ? "" : "Z"));
      const ageSeconds = Math.floor((Date.now() - oldestDate.getTime()) / 1000);
      oldestPendingAge = formatAge(ageSeconds);
    }

    return {
      pending_count: pending.cnt,
      parked_count: parked.cnt,
      oldest_pending_age: oldestPendingAge,
      last_successful_sync: lastSync?.value ?? null,
      total_retry_attempts: retries.total,
    };
  } catch {
    return null; // sync_failures table doesn't exist yet
  }
}

/**
 * Comprehensive status check across all services.
 * Returns MCP-formatted content response with JSON status report.
 */
export async function getStatus(db: Database.Database): Promise<McpContent> {
  try {
    const [dbStatus, engramVec, ollama] = await Promise.all([
      checkDb(db),
      checkEngramVec(),
      checkOllama(),
    ]);

    const cortexTables = checkCortexTables(db);
    const syncHealth = checkSyncHealth(db);

    const report: StatusReport = {
      db: dbStatus,
      engram_vec: engramVec,
      ollama,
      cortex_tables: cortexTables,
      ...(syncHealth && { sync_health: syncHealth }),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  } catch (err) {
    log("error", "Status check failed:", (err as Error).message);
    return {
      content: [{ type: "text", text: `Status check failed: ${(err as Error).message}` }],
      isError: true,
    };
  }
}
