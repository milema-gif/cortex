/**
 * MCP tools for browsing the knowledge graph: cortex_entities and cortex_relations.
 * Lets agents explore entities, relationships, and observation connections.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { normalize } from "../lib/entity-patterns.js";
import { log } from "../lib/logger.js";

export interface McpContent {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Query entities from the knowledge graph. Testable standalone function.
 */
export function queryEntities(
  db: Database.Database,
  type?: string,
  search?: string,
  limit: number = 20
): McpContent {
  let sql = `SELECT id, type, name, aliases, mention_count, first_seen, last_seen FROM entities`;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  if (search) {
    conditions.push("name LIKE ?");
    params.push(`%${search.toLowerCase()}%`);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY mention_count DESC, last_seen DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    type: string;
    name: string;
    aliases: string | null;
    mention_count: number;
    first_seen: string;
    last_seen: string;
  }>;

  if (rows.length === 0) {
    return {
      content: [{ type: "text", text: "No entities found." }],
    };
  }

  const lines = rows.map((r, i) => {
    const aliases: string[] = r.aliases ? JSON.parse(r.aliases) : [];
    const aliasStr = aliases.length > 0 ? `, aliases: [${aliases.join(", ")}]` : "";
    return `${i + 1}. [${r.type}] ${r.name} (mentions: ${r.mention_count}${aliasStr})`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

/**
 * Query relations for a given entity. Testable standalone function.
 */
export function queryRelations(
  db: Database.Database,
  entityName: string,
  type?: string
): McpContent {
  const normalizedName = normalize(entityName);

  // Find entity by normalized name
  const entity = db
    .prepare("SELECT id, name FROM entities WHERE name = ?")
    .get(normalizedName) as { id: number; name: string } | undefined;

  if (!entity) {
    return {
      content: [{ type: "text", text: `Entity not found: ${entityName}` }],
    };
  }

  let sql = `
    SELECT
      r.relation_type,
      r.weight,
      CASE
        WHEN r.src_entity_id = ? THEN dst.name
        ELSE src.name
      END AS connected_name,
      CASE
        WHEN r.src_entity_id = ? THEN dst.type
        ELSE src.type
      END AS connected_type
    FROM relations r
    JOIN entities src ON r.src_entity_id = src.id
    JOIN entities dst ON r.dst_entity_id = dst.id
    WHERE r.src_entity_id = ? OR r.dst_entity_id = ?
  `;
  const params: unknown[] = [entity.id, entity.id, entity.id, entity.id];

  if (type) {
    sql += " AND r.relation_type = ?";
    params.push(type);
  }

  sql += " ORDER BY r.weight DESC";

  const rows = db.prepare(sql).all(...params) as Array<{
    relation_type: string;
    weight: number;
    connected_name: string;
    connected_type: string;
  }>;

  if (rows.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No relations found for entity: ${entity.name}`,
        },
      ],
    };
  }

  const lines = rows.map((r, i) => {
    return `${i + 1}. ${entity.name} --[${r.relation_type}]--> ${r.connected_name} (weight: ${r.weight})`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

/**
 * Register cortex_entities and cortex_relations tools on the MCP server.
 */
export function registerGraphTools(
  server: McpServer,
  db: Database.Database
): void {
  server.tool(
    "cortex_entities",
    "List entities in the knowledge graph with observation counts and types. Use to browse what Cortex knows about.",
    {
      type: z
        .string()
        .optional()
        .describe(
          "Filter by entity type: project, file_path, technology, tool, pattern, person"
        ),
      search: z
        .string()
        .optional()
        .describe("Filter entities by name substring"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max entities to return"),
    },
    async ({ type, search, limit }) => {
      try {
        return queryEntities(db, type, search, limit);
      } catch (err) {
        log(
          "error",
          "cortex_entities handler error:",
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
    "cortex_relations",
    "Show relationships for a given entity. Returns connected entities and relationship types.",
    {
      entity: z.string().min(1).describe("Entity name to look up"),
      type: z
        .string()
        .optional()
        .describe(
          "Filter by relation type: uses, contains, implements, co-occurs, depends-on"
        ),
    },
    async ({ entity, type }) => {
      try {
        return queryRelations(db, entity, type);
      } catch (err) {
        log(
          "error",
          "cortex_relations handler error:",
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
}
