import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { search } from "../core/search.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

/**
 * Register the cortex_search tool on the MCP server.
 * Searches memories with hybrid FTS5+vector results.
 */
export function registerSearchTool(
  server: McpServer,
  db: Database.Database
): void {
  server.tool(
    "cortex_search",
    "Search memories with hybrid FTS5+vector results. Returns ranked results combining text and semantic similarity. Set explain=true for per-result scoring breakdown.",
    {
      query: z.string().min(1).describe("Search query text"),
      project: z
        .string()
        .optional()
        .describe("Filter results to this project"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum results to return"),
      explain: z
        .boolean()
        .default(false)
        .describe(
          "When true, include per-result scoring breakdown showing FTS, vector, graph, lifecycle, and recency contributions"
        ),
    },
    async ({ query, project, limit, explain }) => {
      try {
        const effectiveExplain = explain || config.cortexMode === 'debug';
        return await search(db, query, { project, limit, explain: effectiveExplain });
      } catch (err) {
        log("error", "cortex_search handler error:", (err as Error).message);
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
