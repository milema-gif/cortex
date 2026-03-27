import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { generatePreflight } from "../core/preflight.js";
import { log } from "../lib/logger.js";

/**
 * Register the cortex_preflight tool on the MCP server.
 * Returns a compact memory brief for the specified project.
 */
export function registerPreflightTool(
  server: McpServer,
  db: Database.Database
): void {
  server.tool(
    "cortex_preflight",
    "Get a compact memory brief for the current project. Returns recent decisions, gotchas, architecture patterns, active todos, and relevant context. Call at session start and periodically during work.",
    {
      project: z
        .string()
        .min(1)
        .describe("Project name to generate brief for"),
    },
    async ({ project }) => {
      try {
        const result = await generatePreflight(db, project);
        const text = result.changed
          ? result.brief || "No observations found for this project."
          : result.brief;
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        log("error", "cortex_preflight handler error:", (err as Error).message);
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
