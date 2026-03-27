import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/schema.js";
import { log } from "./lib/logger.js";
import { registerSearchTool } from "./tools/search.js";
import { registerStatusTool } from "./tools/status.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerPreflightTool } from "./tools/preflight.js";
import { registerGraphTools } from "./tools/graph.js";
import { backfillEntities } from "./core/graph.js";
import { startSyncPoller, embeddingBackfill } from "./core/sync.js";
import { registerReconcileTool } from "./tools/reconcile.js";
import { computeHealth } from "./core/health.js";

// Global error handlers: log but do NOT exit.
// MCP servers must stay alive through transient errors.
process.on("uncaughtException", (err) => {
  log("error", "Uncaught exception:", err.message, err.stack);
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled rejection:", reason);
});

async function main(): Promise<void> {
  log("info", "Cortex MCP server starting...");

  const db = openDatabase(config.engramDb);
  runMigrations(db);

  const server = new McpServer({
    name: "cortex",
    version: "0.1.0",
  });

  registerSearchTool(server, db);
  registerStatusTool(server, db);
  registerLifecycleTools(server, db);
  registerPreflightTool(server, db);
  registerGraphTools(server, db);
  registerReconcileTool(server, db);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("info", `Cortex MCP server running on stdio in "${config.cortexMode}" mode`);

  // Startup health check: warn loudly if blocked
  const startupHealth = computeHealth(db);
  if (startupHealth === 'blocked') {
    log("warn", "=== CORTEX HEALTH: BLOCKED ===");
    log("warn", "Parked sync failures require reconciliation.");
    log("warn", "Run cortex_reconcile with retry, drop, or ack to proceed.");
    log("warn", "Mutating operations (sync, backfill) will be skipped until resolved.");
    log("warn", "==============================");
  } else if (startupHealth === 'degraded') {
    log("info", `Cortex health: degraded (sync failures exist). Use cortex_status for details.`);
  }

  // Mode-conditional startup: gate backfill and poller based on cortexMode
  switch (config.cortexMode) {
    case "readonly":
      log("info", "Readonly mode: poller and backfill disabled");
      break;

    case "backfill-once":
      // Run backfills but do NOT start the poller afterward
      backfillEntities(db)
        .then((count) => {
          if (count > 0) log("info", `Entity backfill complete: ${count} observations processed`);
        })
        .catch((err) => {
          log("warn", "Entity backfill failed (non-fatal):", (err as Error).message);
        });

      embeddingBackfill(db)
        .then((count) => {
          if (count > 0) log("info", `Embedding backfill complete: ${count} observations processed`);
          log("info", "Backfill-once mode: backfill complete, poller not started");
        })
        .catch((err) => {
          log("warn", "Embedding backfill failed (non-fatal):", (err as Error).message);
        });
      break;

    case "debug":
    case "default":
    default:
      // Full startup: entity backfill -> embedding backfill -> start poller
      backfillEntities(db)
        .then((count) => {
          if (count > 0) log("info", `Entity backfill complete: ${count} observations processed`);
        })
        .catch((err) => {
          log("warn", "Entity backfill failed (non-fatal):", (err as Error).message);
        });

      embeddingBackfill(db)
        .then((count) => {
          if (count > 0) log("info", `Embedding backfill complete: ${count} observations processed`);
          startSyncPoller(db);
          log("info", "Sync poller started");
        })
        .catch((err) => {
          log("warn", "Embedding backfill failed (non-fatal):", (err as Error).message);
          startSyncPoller(db);
          log("info", "Sync poller started (after backfill failure)");
        });
      break;
  }
}

main().catch((err) => {
  log("error", "Fatal:", err);
  process.exit(1);
});
