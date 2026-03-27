import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { reconcileRetry, reconcileDrop, reconcileAck } from "../core/reconcile.js";
import { computeHealth } from "../core/health.js";
import { log } from "../lib/logger.js";

/**
 * Register the cortex_reconcile tool on the MCP server.
 * Provides retry, drop, and ack actions for sync failure reconciliation.
 */
export function registerReconcileTool(
  server: McpServer,
  db: Database.Database
): void {
  server.tool(
    "cortex_reconcile",
    "Reconcile sync failures. Actions: retry(observation_id), drop(observation_id), ack (acknowledge blocked state for this session).",
    {
      action: z.enum(["retry", "drop", "ack"]).describe("Reconcile action to perform"),
      observation_id: z.number().optional().describe("Observation ID (required for retry and drop)"),
    },
    async ({ action, observation_id }) => {
      try {
        if ((action === "retry" || action === "drop") && observation_id === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `observation_id required for ${action}`,
                  health: computeHealth(db),
                }),
              },
            ],
            isError: true,
          };
        }

        let result;
        switch (action) {
          case "retry":
            result = reconcileRetry(db, observation_id!);
            break;
          case "drop":
            result = reconcileDrop(db, observation_id!);
            break;
          case "ack":
            result = reconcileAck(db);
            break;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        log("error", "cortex_reconcile handler error:", (err as Error).message);
        return {
          content: [
            { type: "text" as const, text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );
}
