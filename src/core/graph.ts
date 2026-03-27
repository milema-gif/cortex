/**
 * Knowledge graph core: entity upsert, relation inference, observation linking,
 * backfill, and graph expansion queries.
 */

import type Database from "better-sqlite3";
import {
  extractEntities,
  normalize,
  type EntityType,
} from "../lib/entity-patterns.js";

// ─── Canonical Name Resolution ───────────────────────────────────────

/** Maps known variant names to their canonical normalized form. */
const CANONICAL_NAMES = new Map<string, string>([
  // JavaScript / Node.js variants
  ["reactjs", "react"],
  ["react.js", "react"],
  ["nodejs", "node.js"],
  ["node", "node.js"],
  ["js", "javascript"],
  ["ts", "typescript"],
  // Database variants
  ["postgres", "postgresql"],
  ["mongo", "mongodb"],
  // Tool variants
  ["k8s", "kubernetes"],
]);

// ─── Entity Upsert ──────────────────────────────────────────────────

/**
 * Insert or update an entity. Normalizes name, merges aliases, increments mention_count.
 * Returns the entity ID.
 */
export function upsertEntity(
  db: Database.Database,
  type: string,
  rawName: string,
  aliases: string[] = []
): number {
  const normalizedName = normalize(rawName);
  // Resolve known aliases to canonical name
  const canonicalName = CANONICAL_NAMES.get(normalizedName) ?? normalizedName;

  // Exact name match (using canonical name)
  const existing = db
    .prepare(
      "SELECT id, aliases, mention_count FROM entities WHERE type = ? AND name = ?"
    )
    .get(type, canonicalName) as
    | { id: number; aliases: string | null; mention_count: number }
    | undefined;

  if (existing) {
    // Merge aliases
    const existingAliases: string[] = existing.aliases
      ? JSON.parse(existing.aliases)
      : [];
    const mergedAliases = [
      ...new Set([...existingAliases, ...aliases, rawName]),
    ];

    db.prepare(
      `UPDATE entities SET
        mention_count = mention_count + 1,
        last_seen = datetime('now'),
        aliases = ?
       WHERE id = ?`
    ).run(JSON.stringify(mergedAliases), existing.id);

    return existing.id;
  }

  // Insert new entity (use canonical name for storage)
  const result = db
    .prepare("INSERT INTO entities (type, name, aliases) VALUES (?, ?, ?)")
    .run(type, canonicalName, JSON.stringify([rawName]));

  return Number(result.lastInsertRowid);
}

// ─── Observation Linking ────────────────────────────────────────────

/**
 * Link an observation to an entity. INSERT OR IGNORE for idempotency.
 */
export function linkObservationEntity(
  db: Database.Database,
  observationId: number,
  entityId: number,
  role: string = "mention"
): void {
  db.prepare(
    "INSERT OR IGNORE INTO obs_entities (observation_id, entity_id, role) VALUES (?, ?, ?)"
  ).run(observationId, entityId, role);
}

// ─── Relation Inference ─────────────────────────────────────────────

interface EntityRef {
  type: string;
  entityId: number;
}

/**
 * Infer typed relations from entity co-occurrence within an observation.
 * - project + technology => 'uses'
 * - project + file_path => 'contains'
 * - project + pattern => 'implements'
 * - other pairs => 'co-occurs' (capped at 10 per observation)
 */
export function inferRelations(
  db: Database.Database,
  entities: EntityRef[],
  observationId: number
): void {
  const upsertRel = db.prepare(`
    INSERT INTO relations (src_entity_id, relation_type, dst_entity_id, weight, evidence_obs_id)
    VALUES (?, ?, ?, 1.0, ?)
    ON CONFLICT(src_entity_id, relation_type, dst_entity_id)
    DO UPDATE SET weight = weight + 1, evidence_obs_id = ?
  `);

  let coOccursCount = 0;
  const MAX_CO_OCCURS = 10;

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];

      // Determine relation type
      const relType = inferRelationType(a.type, b.type);

      if (relType === "co-occurs") {
        if (coOccursCount >= MAX_CO_OCCURS) continue;
        coOccursCount++;
      }

      // Ensure project is always src for typed relations
      if (relType !== "co-occurs" && b.type === "project") {
        upsertRel.run(
          b.entityId,
          relType,
          a.entityId,
          observationId,
          observationId
        );
      } else {
        upsertRel.run(
          a.entityId,
          relType,
          b.entityId,
          observationId,
          observationId
        );
      }
    }
  }
}

function inferRelationType(typeA: string, typeB: string): string {
  const pair = new Set([typeA, typeB]);

  if (pair.has("project") && pair.has("technology")) return "uses";
  if (pair.has("project") && pair.has("file_path")) return "contains";
  if (pair.has("project") && pair.has("pattern")) return "implements";

  return "co-occurs";
}

// ─── Extract and Link (Full Pipeline) ───────────────────────────────

/**
 * Read observation from DB, extract entities, upsert, link, infer relations.
 * Wraps everything in a transaction. Returns entity count.
 */
export function extractAndLink(
  db: Database.Database,
  observationId: number
): number {
  const obs = db
    .prepare(
      "SELECT id, title, content, project FROM observations WHERE id = ?"
    )
    .get(observationId) as
    | {
        id: number;
        title: string;
        content: string | null;
        project: string | null;
      }
    | undefined;

  if (!obs) return 0;

  return db.transaction(() => {
    const entities = extractEntities(obs.title, obs.content || "");

    // Also add project field as entity if present
    if (obs.project) {
      const normalizedProject = normalize(obs.project);
      const alreadyHasProject = entities.some(
        (e) => e.type === "project" && e.normalizedName === normalizedProject
      );
      if (!alreadyHasProject) {
        entities.push({
          type: "project",
          rawName: obs.project,
          normalizedName: normalizedProject,
          aliases: [],
        });
      }
    }

    const entityRefs: EntityRef[] = [];

    for (const entity of entities) {
      const entityId = upsertEntity(
        db,
        entity.type,
        entity.rawName,
        entity.aliases
      );
      linkObservationEntity(db, observationId, entityId);
      entityRefs.push({ type: entity.type, entityId });
    }

    // Infer relations from co-occurrence
    inferRelations(db, entityRefs, observationId);

    return entities.length;
  })();
}

// ─── Backfill ───────────────────────────────────────────────────────

/**
 * Backfill entity extraction for all observations without existing obs_entities rows.
 * Processes in batches of 50 with setImmediate between batches.
 * Returns total processed count.
 */
export async function backfillEntities(
  db: Database.Database
): Promise<number> {
  const unprocessed = db
    .prepare(
      `SELECT o.id, o.title, o.content, o.project
       FROM observations o
       LEFT JOIN obs_entities oe ON o.id = oe.observation_id
       WHERE o.deleted_at IS NULL AND oe.observation_id IS NULL`
    )
    .all() as Array<{
    id: number;
    title: string;
    content: string | null;
    project: string | null;
  }>;

  let processed = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
    const batch = unprocessed.slice(i, i + BATCH_SIZE);

    db.transaction(() => {
      for (const obs of batch) {
        extractAndLink(db, obs.id);
        processed++;
      }
    })();

    // Yield to event loop between batches
    if (i + BATCH_SIZE < unprocessed.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return processed;
}

// ─── Graph Expansion ────────────────────────────────────────────────

/**
 * BFS graph expansion from seed entity IDs via recursive CTE.
 * Returns up to maxEntities entity IDs connected within maxDepth hops.
 */
export function expandGraph(
  db: Database.Database,
  seedEntityIds: number[],
  maxDepth: number = 2,
  maxEntities: number = 20
): number[] {
  if (seedEntityIds.length === 0) return [];

  const placeholders = seedEntityIds.map(() => "?").join(",");

  const sql = `
    WITH RECURSIVE graph_walk(entity_id, depth) AS (
      SELECT id, 0 FROM entities WHERE id IN (${placeholders})
      UNION
      SELECT
        CASE
          WHEN r.src_entity_id = gw.entity_id THEN r.dst_entity_id
          ELSE r.src_entity_id
        END,
        gw.depth + 1
      FROM graph_walk gw
      JOIN relations r ON r.src_entity_id = gw.entity_id
                       OR r.dst_entity_id = gw.entity_id
      WHERE gw.depth < ?
    )
    SELECT DISTINCT entity_id FROM graph_walk LIMIT ?
  `;

  const rows = db
    .prepare(sql)
    .all(...seedEntityIds, maxDepth, maxEntities) as Array<{
    entity_id: number;
  }>;
  return rows.map((r) => r.entity_id);
}

/**
 * Find observation IDs linked to given entity IDs.
 * Excludes deprecated/superseded via obs_lifecycle join.
 */
export function observationsForEntities(
  db: Database.Database,
  entityIds: number[]
): number[] {
  if (entityIds.length === 0) return [];

  const placeholders = entityIds.map(() => "?").join(",");

  const sql = `
    SELECT DISTINCT oe.observation_id
    FROM obs_entities oe
    LEFT JOIN obs_lifecycle lc ON oe.observation_id = lc.observation_id
    WHERE oe.entity_id IN (${placeholders})
      AND COALESCE(lc.status, 'active') NOT IN ('deprecated', 'superseded')
  `;

  const rows = db.prepare(sql).all(...entityIds) as Array<{
    observation_id: number;
  }>;
  return rows.map((r) => r.observation_id);
}
