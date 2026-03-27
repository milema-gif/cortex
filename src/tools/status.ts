import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { getStatus } from "../core/status.js";
import { log } from "../lib/logger.js";

/**
 * Register the cortex_status tool on the MCP server.
 * Reports health of DB, engram-vec, Ollama, and Cortex tables.
 */
export function registerStatusTool(
  server: McpServer,
  db: Database.Database
): void {
  server.tool(
    "cortex_status",
    "Health check: reports DB connectivity, engram-vec status, Ollama status, and table row counts.",
    {},
    async () => {
      try {
        return await getStatus(db);
      } catch (err) {
        log("error", "cortex_status handler error:", (err as Error).message);
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
