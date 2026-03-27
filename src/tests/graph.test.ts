import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extractEntities, normalize } from "../lib/entity-patterns.js";
import {
  upsertEntity,
  linkObservationEntity,
  inferRelations,
  extractAndLink,
  backfillEntities,
  expandGraph,
  observationsForEntities,
} from "../core/graph.js";
import { queryEntities, queryRelations } from "../tools/graph.js";

/**
 * Tests for knowledge graph: entity extraction, normalization, graph core.
 * Uses in-memory SQLite DB for graph operation tests.
 */

// ─── Entity Extraction Tests ────────────────────────────────────────

describe("extractEntities", () => {
  it("extracts project, technology from mixed text", () => {
    const entities = extractEntities("Cortex uses SQLite and FTS5", "");
    const types = entities.map((e) => `${e.type}:${e.normalizedName}`);
    assert.ok(types.includes("project:cortex"), `expected project:cortex in ${JSON.stringify(types)}`);
    assert.ok(types.includes("technology:sqlite"), `expected technology:sqlite in ${JSON.stringify(types)}`);
    assert.ok(types.includes("technology:fts5"), `expected technology:fts5 in ${JSON.stringify(types)}`);
  });

  it("extracts file_path and technology from code reference", () => {
    const entities = extractEntities("Fix in src/core/search.ts for React app", "");
    const types = entities.map((e) => `${e.type}:${e.normalizedName}`);
    assert.ok(types.some((t) => t.startsWith("file_path:") && t.includes("src/core/search.ts")),
      `expected file_path containing src/core/search.ts in ${JSON.stringify(types)}`);
    assert.ok(types.includes("technology:react"), `expected technology:react in ${JSON.stringify(types)}`);
  });

  it("extracts tool names", () => {
    const entities = extractEntities("Engram-vec sidecar built", "");
    const types = entities.map((e) => `${e.type}:${e.normalizedName}`);
    assert.ok(types.includes("tool:engram-vec"), `expected tool:engram-vec in ${JSON.stringify(types)}`);
  });

  it("extracts decision patterns", () => {
    const entities = extractEntities("Added lifecycle deprecation pattern", "");
    const types = entities.map((e) => `${e.type}:${e.normalizedName}`);
    assert.ok(types.some((t) => t === "pattern:lifecycle"), `expected pattern:lifecycle in ${JSON.stringify(types)}`);
    assert.ok(types.some((t) => t.startsWith("pattern:deprecat")), `expected pattern:deprecat* in ${JSON.stringify(types)}`);
  });

  it("deduplicates entities with same type and normalized name", () => {
    const entities = extractEntities("SQLite and sqlite and SQLITE", "");
    const sqliteEntities = entities.filter((e) => e.normalizedName === "sqlite" && e.type === "technology");
    assert.equal(sqliteEntities.length, 1, "should have exactly one sqlite entity");
  });

  it("strips trailing punctuation from file paths", () => {
    const entities = extractEntities("Check /path/to/project/src/server.ts, and continue", "");
    const filePaths = entities.filter((e) => e.type === "file_path");
    assert.ok(filePaths.length > 0, "should find at least one file path");
    const path = filePaths[0].normalizedName;
    assert.ok(!path.endsWith(","), `file path should not end with comma: ${path}`);
  });

  it("does NOT extract URLs as file paths", () => {
    const entities = extractEntities("Visit https://example.com/src/foo.ts for docs", "");
    const filePaths = entities.filter((e) => e.type === "file_path");
    const urlPaths = filePaths.filter((e) => e.normalizedName.includes("example.com"));
    assert.equal(urlPaths.length, 0, "should not extract URLs as file paths");
  });
});

// ─── Normalization Tests ────────────────────────────────────────────

describe("normalize", () => {
  it("lowercases and trims", () => {
    assert.equal(normalize("  SQLite  "), "sqlite");
  });

  it("preserves dots in names", () => {
    assert.equal(normalize("React.JS"), "react.js");
  });

  it("preserves slashes in paths", () => {
    const result = normalize("src/core/search.ts");
    assert.ok(result.includes("/"), "should preserve slashes");
  });

  it("preserves hyphens", () => {
    assert.equal(normalize("engram-vec"), "engram-vec");
  });

  it("collapses whitespace", () => {
    assert.equal(normalize("knowledge  graph"), "knowledge graph");
  });
});

// ─── Helper: Create in-memory DB with schema ────────────────────────

function createGraphDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      type TEXT,
      project TEXT,
      scope TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    CREATE TABLE obs_lifecycle (
      observation_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 1.0,
      valid_from TEXT NOT NULL DEFAULT (datetime('now')),
      valid_until TEXT,
      last_verified_at TEXT,
      supersedes_id INTEGER,
      superseded_by_id INTEGER,
      deprecation_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      mention_count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(type, name)
    );
    CREATE INDEX idx_entities_type ON entities(type);
    CREATE INDEX idx_entities_name ON entities(name);
    CREATE TABLE relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src_entity_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      dst_entity_id INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      evidence_obs_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(src_entity_id, relation_type, dst_entity_id)
    );
    CREATE INDEX idx_relations_src ON relations(src_entity_id);
    CREATE INDEX idx_relations_dst ON relations(dst_entity_id);
    CREATE TABLE obs_entities (
      observation_id INTEGER NOT NULL,
      entity_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'mention',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (observation_id, entity_id)
    );
    CREATE INDEX idx_obs_entities_entity ON obs_entities(entity_id);
  `);
  return db;
}

// ─── Entity Upsert Tests ────────────────────────────────────────────

describe("upsertEntity", () => {
  it("inserts new entity with normalized name and mention_count=1", () => {
    const db = createGraphDb();
    const id = upsertEntity(db, "technology", "React", []);
    assert.ok(id > 0, "should return a positive ID");
    const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as {
      name: string; mention_count: number;
    };
    assert.equal(row.name, "react");
    assert.equal(row.mention_count, 1);
    db.close();
  });

  it("increments mention_count and merges aliases on duplicate", () => {
    const db = createGraphDb();
    const id1 = upsertEntity(db, "technology", "React", []);
    const id2 = upsertEntity(db, "technology", "ReactJS", []);
    assert.equal(id1, id2, "should return same entity ID");
    const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(id1) as {
      mention_count: number; aliases: string;
    };
    assert.equal(row.mention_count, 2);
    const aliases: string[] = JSON.parse(row.aliases);
    assert.ok(aliases.includes("ReactJS"), `aliases should include ReactJS: ${JSON.stringify(aliases)}`);
    db.close();
  });
});

// ─── Observation Linking Tests ──────────────────────────────────────

describe("linkObservationEntity", () => {
  it("creates obs_entities row", () => {
    const db = createGraphDb();
    db.exec("INSERT INTO observations (title) VALUES ('test obs')");
    const entityId = upsertEntity(db, "technology", "SQLite", []);
    linkObservationEntity(db, 1, entityId, "mention");
    const row = db.prepare("SELECT * FROM obs_entities WHERE observation_id = 1 AND entity_id = ?").get(entityId);
    assert.ok(row, "should have created obs_entities row");
    db.close();
  });

  it("is idempotent (duplicate call is no-op)", () => {
    const db = createGraphDb();
    db.exec("INSERT INTO observations (title) VALUES ('test obs')");
    const entityId = upsertEntity(db, "technology", "SQLite", []);
    linkObservationEntity(db, 1, entityId, "mention");
    linkObservationEntity(db, 1, entityId, "mention"); // should not throw
    const count = db.prepare("SELECT COUNT(*) as c FROM obs_entities WHERE observation_id = 1").get() as { c: number };
    assert.equal(count.c, 1);
    db.close();
  });
});

// ─── Relation Inference Tests ───────────────────────────────────────

describe("inferRelations", () => {
  it("creates 'uses' relation for project + technology", () => {
    const db = createGraphDb();
    const projId = upsertEntity(db, "project", "cortex", []);
    const techId = upsertEntity(db, "technology", "sqlite", []);
    inferRelations(db, [
      { type: "project", entityId: projId },
      { type: "technology", entityId: techId },
    ], 1);
    const rel = db.prepare(
      "SELECT * FROM relations WHERE src_entity_id = ? AND dst_entity_id = ?"
    ).get(projId, techId) as { relation_type: string } | undefined;
    assert.ok(rel, "should create a relation");
    assert.equal(rel!.relation_type, "uses");
    db.close();
  });

  it("creates 'contains' relation for project + file_path", () => {
    const db = createGraphDb();
    const projId = upsertEntity(db, "project", "cortex", []);
    const fileId = upsertEntity(db, "file_path", "src/server.ts", []);
    inferRelations(db, [
      { type: "project", entityId: projId },
      { type: "file_path", entityId: fileId },
    ], 1);
    const rel = db.prepare(
      "SELECT * FROM relations WHERE relation_type = 'contains'"
    ).get() as { src_entity_id: number; dst_entity_id: number } | undefined;
    assert.ok(rel, "should create contains relation");
    db.close();
  });

  it("increments weight on duplicate relation", () => {
    const db = createGraphDb();
    const projId = upsertEntity(db, "project", "cortex", []);
    const techId = upsertEntity(db, "technology", "sqlite", []);
    const entities = [
      { type: "project" as const, entityId: projId },
      { type: "technology" as const, entityId: techId },
    ];
    inferRelations(db, entities, 1);
    inferRelations(db, entities, 2);
    const rel = db.prepare(
      "SELECT weight FROM relations WHERE src_entity_id = ? AND dst_entity_id = ?"
    ).get(projId, techId) as { weight: number };
    assert.equal(rel.weight, 2.0, "weight should be 2 after two inferences");
    db.close();
  });
});

// ─── extractAndLink Tests ───────────────────────────────────────────

describe("extractAndLink", () => {
  it("reads observation, extracts entities, upserts, links, and infers relations", () => {
    const db = createGraphDb();
    db.exec(`INSERT INTO observations (id, title, content, project) VALUES
      (1, 'Cortex uses SQLite for storage', 'FTS5 search enabled', 'cortex')`);
    const count = extractAndLink(db, 1);
    assert.ok(count > 0, "should extract at least one entity");
    // Check obs_entities rows exist
    const links = db.prepare("SELECT COUNT(*) as c FROM obs_entities WHERE observation_id = 1").get() as { c: number };
    assert.ok(links.c > 0, "should have observation-entity links");
    // Check relations exist
    const rels = db.prepare("SELECT COUNT(*) as c FROM relations").get() as { c: number };
    assert.ok(rels.c > 0, "should have inferred relations");
    db.close();
  });
});

// ─── backfillEntities Tests ─────────────────────────────────────────

describe("backfillEntities", () => {
  it("processes unlinked observations and returns count", async () => {
    const db = createGraphDb();
    db.exec(`
      INSERT INTO observations (title, content, project) VALUES
        ('Cortex uses SQLite', 'test content', 'cortex'),
        ('React dashboard built', 'with TypeScript', 'webapp'),
        ('Engram-vec sidecar deployed', '', 'infrastructure');
    `);
    const processed = await backfillEntities(db);
    assert.equal(processed, 3, "should process all 3 observations");
    // Verify entities were created
    const entityCount = db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number };
    assert.ok(entityCount.c > 0, "should have created entities");
    db.close();
  });

  it("skips already-linked observations", async () => {
    const db = createGraphDb();
    db.exec(`INSERT INTO observations (id, title, content) VALUES (1, 'SQLite test', '')`);
    const entityId = upsertEntity(db, "technology", "sqlite", []);
    linkObservationEntity(db, 1, entityId, "mention");
    const processed = await backfillEntities(db);
    assert.equal(processed, 0, "should skip already-linked observations");
    db.close();
  });
});

// ─── Graph Expansion Tests ──────────────────────────────────────────

describe("expandGraph", () => {
  it("returns seed entities when no relations exist", () => {
    const db = createGraphDb();
    const id = upsertEntity(db, "project", "cortex", []);
    const result = expandGraph(db, [id], 2, 20);
    assert.ok(result.includes(id), "should include seed entity");
    db.close();
  });

  it("follows relations up to maxDepth", () => {
    const db = createGraphDb();
    const a = upsertEntity(db, "project", "cortex", []);
    const b = upsertEntity(db, "technology", "sqlite", []);
    const c = upsertEntity(db, "technology", "fts5", []);
    // a -> b -> c
    db.exec(`INSERT INTO relations (src_entity_id, relation_type, dst_entity_id) VALUES
      (${a}, 'uses', ${b}), (${b}, 'uses', ${c})`);
    const result = expandGraph(db, [a], 2, 20);
    assert.ok(result.includes(b), "should include depth-1 entity");
    assert.ok(result.includes(c), "should include depth-2 entity");
    db.close();
  });

  it("respects maxEntities limit", () => {
    const db = createGraphDb();
    // Create many connected entities
    const seed = upsertEntity(db, "project", "cortex", []);
    for (let i = 0; i < 30; i++) {
      const e = upsertEntity(db, "technology", `tech-${i}`, []);
      db.exec(`INSERT INTO relations (src_entity_id, relation_type, dst_entity_id) VALUES (${seed}, 'uses', ${e})`);
    }
    const result = expandGraph(db, [seed], 2, 5);
    assert.ok(result.length <= 5, `should respect maxEntities=5, got ${result.length}`);
    db.close();
  });
});

// ─── observationsForEntities Tests ──────────────────────────────────

describe("observationsForEntities", () => {
  it("returns observation IDs linked to entities", () => {
    const db = createGraphDb();
    db.exec("INSERT INTO observations (id, title) VALUES (10, 'test')");
    const entityId = upsertEntity(db, "technology", "sqlite", []);
    linkObservationEntity(db, 10, entityId, "mention");
    const result = observationsForEntities(db, [entityId]);
    assert.ok(result.includes(10), "should include linked observation");
    db.close();
  });

  it("excludes deprecated observations via obs_lifecycle", () => {
    const db = createGraphDb();
    db.exec(`
      INSERT INTO observations (id, title) VALUES (10, 'test'), (11, 'deprecated');
      INSERT INTO obs_lifecycle (observation_id, status) VALUES (11, 'deprecated');
    `);
    const entityId = upsertEntity(db, "technology", "sqlite", []);
    linkObservationEntity(db, 10, entityId, "mention");
    linkObservationEntity(db, 11, entityId, "mention");
    const result = observationsForEntities(db, [entityId]);
    assert.ok(result.includes(10), "should include active observation");
    assert.ok(!result.includes(11), "should exclude deprecated observation");
    db.close();
  });
});

// ─── GRPH-07 Coverage Threshold Test ────────────────────────────────

// ─── cortex_entities and cortex_relations Tool Output Tests ──────────

describe("cortex_entities and cortex_relations tool output", () => {
  function createPopulatedDb(): Database.Database {
    const db = createGraphDb();
    // Insert 3 entities of different types with aliases and mention counts
    db.exec(`
      INSERT INTO entities (id, type, name, aliases, mention_count) VALUES
        (1, 'project', 'cortex', '["Cortex"]', 15),
        (2, 'technology', 'sqlite', '["SQLite","sqlite3"]', 8),
        (3, 'technology', 'react', '["React","ReactJS"]', 5),
        (4, 'tool', 'engram', '["Engram"]', 3);
    `);
    // Create relations between entities
    db.exec(`
      INSERT INTO relations (src_entity_id, relation_type, dst_entity_id, weight) VALUES
        (1, 'uses', 2, 3.0),
        (1, 'uses', 3, 1.0);
    `);
    return db;
  }

  it("queryEntities with no filters returns all entities in numbered list format", () => {
    const db = createPopulatedDb();
    const result = queryEntities(db);
    const text = result.content[0].text;
    assert.ok(text.includes("1."), "Should have numbered list");
    assert.ok(text.includes("[project]"), "Should include project type tag");
    assert.ok(text.includes("cortex"), "Should include cortex entity");
    assert.ok(text.includes("mentions:"), "Should include mention count");
    assert.ok(text.includes("[technology]"), "Should include technology type tag");
    db.close();
  });

  it("queryEntities with type filter returns only matching type", () => {
    const db = createPopulatedDb();
    const result = queryEntities(db, "project");
    const text = result.content[0].text;
    assert.ok(text.includes("cortex"), "Should include cortex");
    assert.ok(!text.includes("[technology]"), "Should NOT include technology entities");
    assert.ok(!text.includes("[tool]"), "Should NOT include tool entities");
    db.close();
  });

  it("queryEntities with search filter returns name-matched entities", () => {
    const db = createPopulatedDb();
    const result = queryEntities(db, undefined, "react");
    const text = result.content[0].text;
    assert.ok(text.includes("react"), "Should include react entity");
    assert.ok(!text.includes("cortex"), "Should NOT include cortex");
    assert.ok(!text.includes("sqlite"), "Should NOT include sqlite");
    db.close();
  });

  it("queryEntities on empty table returns 'No entities found' message", () => {
    const db = createGraphDb();
    const result = queryEntities(db);
    assert.equal(result.content[0].text, "No entities found.");
    db.close();
  });

  it("queryEntities includes aliases in output", () => {
    const db = createPopulatedDb();
    const result = queryEntities(db);
    const text = result.content[0].text;
    assert.ok(text.includes("aliases:"), "Should include aliases");
    assert.ok(text.includes("SQLite"), "Should include SQLite alias");
    db.close();
  });

  it("queryRelations for known entity returns formatted relation lines", () => {
    const db = createPopulatedDb();
    const result = queryRelations(db, "cortex");
    const text = result.content[0].text;
    assert.ok(text.includes("--[uses]-->"), "Should have relation arrow format");
    assert.ok(text.includes("sqlite"), "Should include sqlite connection");
    assert.ok(text.includes("weight:"), "Should include weight");
    assert.ok(text.includes("1."), "Should have numbered format");
    db.close();
  });

  it("queryRelations for nonexistent entity returns 'Entity not found' message", () => {
    const db = createPopulatedDb();
    const result = queryRelations(db, "nonexistent-entity");
    assert.ok(
      result.content[0].text.includes("Entity not found: nonexistent-entity"),
      "Should return entity not found message"
    );
    db.close();
  });

  it("queryRelations with type filter returns only matching relation type", () => {
    const db = createPopulatedDb();
    // Add a co-occurs relation to test filtering
    db.exec(`INSERT INTO relations (src_entity_id, relation_type, dst_entity_id, weight) VALUES (2, 'co-occurs', 3, 1.0)`);
    const result = queryRelations(db, "cortex", "uses");
    const text = result.content[0].text;
    assert.ok(text.includes("uses"), "Should include uses relations");
    assert.ok(!text.includes("co-occurs"), "Should NOT include co-occurs relations");
    db.close();
  });
});

describe("entity extraction coverage (GRPH-07)", () => {
  it("extracts entities from at least 8 of 10 representative observations (80% coverage)", () => {
    const samples = [
      { title: "Decision: use SQLite for cortex storage", content: "Chose SQLite for local-first data persistence" },
      { title: "Architecture: engram-vec sidecar with FTS5 and vector search", content: "Hybrid search combining full-text and semantic" },
      { title: "Bug fix in src/core/search.ts — query escaping for special chars", content: "FTS5 MATCH syntax errors from unescaped punctuation" },
      { title: "Session summary: worked on webapp dashboard React components", content: "Built chart widgets and data tables" },
      { title: "Grafana prometheus configuration for api-server monitoring", content: "Added service discovery and alert rules" },
      { title: "Docker expert skill added for container debugging", content: "Installed docker skill" },
      { title: "Implemented lifecycle deprecation pattern in cortex", content: "Observations can be marked deprecated or superseded" },
      { title: "Fixed mobile-app webhook handler for Discord bot", content: "Event parsing and response formatting" },
      { title: "Added typescript strict mode to api-server build config", content: "tsconfig.json noImplicitAny enabled" },
      { title: "Deployed cli-tool to infrastructure with PM2 process manager", content: "Production deployment with clustering" },
    ];

    const withEntities = samples.filter(
      (s) => extractEntities(s.title, s.content).length > 0
    ).length;

    assert.ok(
      withEntities >= 8,
      `GRPH-07: expected 80%+ coverage, got ${withEntities}/10`
    );
  });
});
