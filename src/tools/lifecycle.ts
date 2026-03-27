import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { deprecate, supersede, verify, findPotentialConflicts } from "../core/lifecycle.js";
import { log } from "../lib/logger.js";

/**
 * Register lifecycle management tools on the MCP server.
 * Tools: cortex_deprecate, cortex_verify
 */
export function registerLifecycleTools(
  server: McpServer,
  db: Database.Database
): void {
  server.tool(
    "cortex_deprecate",
    "Deprecate or supersede an observation. Deprecated observations no longer appear in search or preflight results.",
    {
      observation_id: z
        .number()
        .int()
        .positive()
        .describe("ID of the observation to deprecate"),
      reason: z
        .string()
        .min(1)
        .describe("Why this observation is being deprecated"),
      superseded_by: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "ID of the observation that replaces this one (creates supersession link)"
        ),
    },
    async ({ observation_id, reason, superseded_by }) => {
      try {
        if (superseded_by) {
          supersede(db, observation_id, superseded_by);
          deprecate(db, observation_id, reason);

          // Check for other potentially related observations
          const row = db
            .prepare("SELECT title FROM observations WHERE id = ?")
            .get(observation_id) as { title: string } | undefined;
          let relatedNote = "";
          if (row) {
            const conflicts = findPotentialConflicts(db, row.title);
            if (conflicts.length > 0) {
              const names = conflicts
                .filter((c) => c.id !== observation_id && c.id !== superseded_by)
                .map((c) => `  - #${c.id}: ${c.title}`)
                .join("\n");
              if (names) {
                relatedNote = `\n\nRelated active observations that may also need review:\n${names}`;
              }
            }
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Observation ${observation_id} superseded by ${superseded_by}. Reason: ${reason}${relatedNote}`,
              },
            ],
          };
        }

        deprecate(db, observation_id, reason);
        return {
          content: [
            {
              type: "text" as const,
              text: `Observation ${observation_id} deprecated. Reason: ${reason}`,
            },
          ],
        };
      } catch (err) {
        log(
          "error",
          "cortex_deprecate handler error:",
          (err as Error).message
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "cortex_verify",
    "Mark an observation as recently verified. Verified observations rank higher in search and preflight results.",
    {
      observation_id: z
        .number()
        .int()
        .positive()
        .describe("ID of the observation to verify"),
    },
    async ({ observation_id }) => {
      try {
        verify(db, observation_id);
        const row = db
          .prepare(
            "SELECT last_verified_at FROM obs_lifecycle WHERE observation_id = ?"
          )
          .get(observation_id) as { last_verified_at: string } | undefined;
        const timestamp = row?.last_verified_at || "unknown";

        return {
          content: [
            {
              type: "text" as const,
              text: `Observation ${observation_id} verified at ${timestamp}`,
            },
          ],
        };
      } catch (err) {
        log("error", "cortex_verify handler error:", (err as Error).message);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
