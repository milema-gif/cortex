import type Database from "better-sqlite3";
import type { ReconcileResult } from "../types.js";
import { computeHealth } from "./health.js";
import { log } from "../lib/logger.js";

// ─── Session-scoped ack state ────────────────────────────────────────

let sessionAcked = false;

export function isAcked(): boolean {
  return sessionAcked;
}

export function resetAck(): void {
  sessionAcked = false;
}

// ─── Reconcile actions ───────────────────────────────────────────────

/**
 * Re-queue a parked observation for retry.
 * Resets attempt_count to 0 and status to 'pending'.
 */
export function reconcileRetry(
  db: Database.Database,
  observationId: number
): ReconcileResult {
  const row = db
    .prepare("SELECT observation_id, status FROM sync_failures WHERE observation_id = ?")
    .get(observationId) as { observation_id: number; status: string } | undefined;

  if (!row) {
    return {
      success: false,
      message: `Observation ${observationId} not found in sync_failures`,
      health: computeHealth(db),
    };
  }

  if (row.status === "pending") {
    return {
      success: false,
      message: `Observation ${observationId} is already pending retry`,
      health: computeHealth(db),
    };
  }

  db.prepare(
    "UPDATE sync_failures SET status = 'pending', attempt_count = 0 WHERE observation_id = ?"
  ).run(observationId);

  return {
    success: true,
    message: `Observation ${observationId} re-queued for retry`,
    health: computeHealth(db),
  };
}

/**
 * Permanently remove a sync_failures row.
 */
export function reconcileDrop(
  db: Database.Database,
  observationId: number
): ReconcileResult {
  const row = db
    .prepare("SELECT observation_id FROM sync_failures WHERE observation_id = ?")
    .get(observationId) as { observation_id: number } | undefined;

  if (!row) {
    return {
      success: false,
      message: `Observation ${observationId} not found in sync_failures`,
      health: computeHealth(db),
    };
  }

  db.prepare("DELETE FROM sync_failures WHERE observation_id = ?").run(observationId);
  log("info", `reconcile: dropped observation ${observationId} from sync tracking`);

  return {
    success: true,
    message: `Observation ${observationId} permanently dropped from sync tracking`,
    health: computeHealth(db),
  };
}

/**
 * Acknowledge blocked state for this session.
 * Mutating operations will proceed until process restart.
 */
export function reconcileAck(db: Database.Database): ReconcileResult {
  sessionAcked = true;
  log(
    "warn",
    "reconcile: blocked state acknowledged -- mutating operations resumed for this session"
  );

  return {
    success: true,
    message: "Blocked state acknowledged. Mutating operations will proceed for this session.",
    health: computeHealth(db),
  };
}
