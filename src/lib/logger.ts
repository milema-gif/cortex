export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Log to stderr only. stdout is reserved for JSON-RPC in MCP servers.
 * Format: [cortex HH:MM:SS.mmm] LEVEL: args
 */
export function log(level: LogLevel, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.error(`[cortex ${ts}] ${level.toUpperCase()}:`, ...args);
}
