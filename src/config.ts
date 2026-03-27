import { homedir } from "node:os";
import path from "node:path";

export type CortexMode = 'readonly' | 'default' | 'backfill-once' | 'debug';
const VALID_MODES: CortexMode[] = ['readonly', 'default', 'backfill-once', 'debug'];

function parseCortexMode(): CortexMode {
  const raw = process.env.CORTEX_MODE?.toLowerCase().trim();
  if (!raw || raw === 'default') return 'default';
  if (VALID_MODES.includes(raw as CortexMode)) return raw as CortexMode;
  process.stderr.write(`[cortex] WARNING: Unknown CORTEX_MODE="${raw}", falling back to "default". Valid modes: ${VALID_MODES.join(', ')}\n`);
  return 'default';
}

export const config = {
  cortexMode: parseCortexMode(),
  engramDb: process.env.ENGRAM_DB || path.join(homedir(), ".engram", "engram.db"),
  engramVecUrl: process.env.ENGRAM_VEC_URL || "http://127.0.0.1:7438",
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  stalenessThresholdDays: 90,
  confidenceHalfLifeDays: 180,
  preflightTokenBudget: 500,
  preflightCacheTtlMinutes: 5,
  syncIntervalMs: parseInt(process.env.CORTEX_SYNC_INTERVAL_MS || "30000", 10),
  backfillDelayMs: parseInt(process.env.CORTEX_BACKFILL_DELAY_MS || "2500", 10),
  backfillMaxPerCycle: parseInt(process.env.CORTEX_BACKFILL_MAX_PER_CYCLE || "20", 10),
  syncMaxRetries: parseInt(process.env.CORTEX_SYNC_MAX_RETRIES || "5", 10),
};
