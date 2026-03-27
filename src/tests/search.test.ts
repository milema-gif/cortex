import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { search, graphExpandResults } from "../core/search.js";
import { config } from "../config.js";
import type { SearchResult } from "../types.js";

/**
 * Tests for the search coordinator.
 * Uses a temp in-memory DB with test observations for FTS fallback testing.
 * Forces FTS fallback by pointing engramVecUrl to a dead endpoint.
 */

// Save original URL and force FTS fallback for all search tests
const originalVecUrl = config.engramVecUrl;

function forceFlsFallback(): void {
  config.engramVecUrl = "http://127.0.0.1:1"; // unreachable
}

function restoreVecUrl(): void {
  config.engramVecUrl = originalVecUrl;
}

function createTestDb(): Database.Database {
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
    CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, content=observations, content_rowid=id);
    CREATE TRIGGER obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    CREATE TABLE obs_lifecycle (
      observation_id     INTEGER PRIMARY KEY,
      status             TEXT NOT NULL DEFAULT 'active'
                           CHECK(status IN ('active','superseded','deprecated','uncertain')),
      confidence         REAL NOT NULL DEFAULT 1.0
                           CHECK(confidence >= 0.0 AND confidence <= 1.0),
      valid_from         TEXT NOT NULL DEFAULT (datetime('now')),
      valid_until        TEXT,
      last_verified_at   TEXT,
      supersedes_id      INTEGER,
      superseded_by_id   INTEGER,
      deprecation_reason TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_lifecycle_status ON obs_lifecycle(status);
  `);

  // Insert test observations
  const insert = db.prepare(
    "INSERT INTO observations (title, content, type, project, scope) VALUES (?, ?, ?, ?, ?)"
  );
  insert.run("JWT auth with refresh tokens", "Implemented JWT authentication with refresh token rotation using jose library", "decision", "webapp", "architecture");
  insert.run("Database schema for users", "Created users table with email, password hash, and role columns", "architecture", "webapp", "database");
  insert.run("Docker compose setup", "Set up docker-compose with postgres, redis, and nginx services", "decision", "infrastructure", "devops");
  insert.run("Deleted observation", "This should not appear", "note", "test", "test");
  // Mark last one as deleted
  db.prepare("UPDATE observations SET deleted_at = datetime('now') WHERE id = 4").run();

  return db;
}

describe("search coordinator", () => {
  let db: Database.Database;

  before(() => {
    forceFlsFallback();
    db = createTestDb();
  });

  after(() => {
    db.close();
    restoreVecUrl();
  });

  describe("formatting", () => {
    it("formats results as numbered list with type, project, score, source, and content preview", async () => {
      const result = await search(db, "JWT auth");
      assert.ok(result.content[0].text.includes("1."), "Should have numbered list");
      assert.ok(result.content[0].text.includes("[decision]") || result.content[0].text.includes("[architecture]"), "Should have type in brackets");
      assert.ok(!result.isError, "Should not be an error");
    });

    it("truncates content preview to 200 chars max", async () => {
      const longContent = "A".repeat(300);
      const insertLong = db.prepare(
        "INSERT INTO observations (title, content, type, project, scope) VALUES (?, ?, ?, ?, ?)"
      );
      insertLong.run("Long content test", longContent, "note", "test", "test");

      const result = await search(db, "Long content test");
      const text = result.content[0].text;
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("   ")) {
          assert.ok(line.length <= 210, `Content line too long: ${line.length} chars`);
        }
      }
    });

    it("returns 'No results found.' for empty results", async () => {
      const result = await search(db, "xyznonexistentquery12345");
      assert.equal(result.content[0].text, "No results found.");
      assert.ok(!result.isError);
    });
  });

  describe("FTS fallback", () => {
    it("falls back to direct FTS when engram-vec is unavailable", async () => {
      const result = await search(db, "JWT");
      assert.ok(result.content[0].text.includes("[FTS-only fallback"), "Should have FTS fallback prefix");
      assert.ok(result.content[0].text.includes("JWT"), "Should contain JWT results");
      assert.ok(!result.isError);
    });

    it("FTS fallback filters by project when provided", async () => {
      const result = await search(db, "auth OR schema OR docker", { project: "webapp" });
      const text = result.content[0].text;
      assert.ok(text.includes("webapp"), "Should contain webapp results");
      assert.ok(!text.includes("infrastructure"), "Should NOT contain infrastructure results");
    });

    it("FTS fallback respects limit parameter", async () => {
      const result = await search(db, "auth OR schema OR docker", { limit: 1 });
      const text = result.content[0].text;
      assert.ok(!text.includes("2."), "Should not have a second result");
    });

    it("returns isError when both hybrid and FTS fail", async () => {
      const brokenDb = new Database(":memory:");
      const result = await search(brokenDb, "test");
      assert.ok(result.isError, "Should return isError when both fail");
      brokenDb.close();
    });
  });

  describe("lifecycle-aware search", () => {
    let lcDb: Database.Database;

    before(() => {
      lcDb = createTestDb();

      const insert = lcDb.prepare(
        "INSERT INTO observations (title, content, type, project, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertLc = lcDb.prepare(
        "INSERT INTO obs_lifecycle (observation_id, status, confidence, last_verified_at) VALUES (?, ?, ?, ?)"
      );

      // id=5: deprecated observation about auth
      insert.run("Auth deprecated method", "Old auth method that is deprecated", "decision", "webapp", "architecture", "2025-01-01T00:00:00Z");
      insertLc.run(5, "deprecated", 1.0, null);

      // id=6: superseded observation about auth
      insert.run("Auth superseded approach", "Old auth approach that was superseded", "decision", "webapp", "architecture", "2025-01-01T00:00:00Z");
      insertLc.run(6, "superseded", 1.0, null);

      // id=7: active, recently verified observation
      insert.run("Auth best practice current", "Current best practice for auth verified recently", "decision", "webapp", "architecture", new Date().toISOString());
      insertLc.run(7, "active", 1.0, new Date().toISOString());

      // id=8: stale observation (very old, never verified)
      insert.run("Auth stale observation", "Stale auth observation from long ago", "decision", "webapp", "architecture", "2024-01-01T00:00:00Z");
      insertLc.run(8, "active", 1.0, null);
    });

    after(() => {
      lcDb.close();
    });

    it("excludes deprecated observations from FTS fallback results", async () => {
      const result = await search(lcDb, "Auth deprecated method");
      const text = result.content[0].text;
      assert.ok(!text.includes("Auth deprecated method"), "Should NOT contain deprecated observation");
    });

    it("excludes superseded observations from FTS fallback results", async () => {
      const result = await search(lcDb, "Auth superseded approach");
      const text = result.content[0].text;
      assert.ok(!text.includes("Auth superseded approach"), "Should NOT contain superseded observation");
    });

    it("includes active observations with no lifecycle row (NULL = active)", async () => {
      // Observation id=1 has no lifecycle row -> should still appear
      const result = await search(lcDb, "JWT auth");
      const text = result.content[0].text;
      assert.ok(text.includes("JWT auth"), "Should contain observation with no lifecycle row");
    });

    it("ranks recently verified observation higher by composite score", async () => {
      const result = await search(lcDb, "Auth", { project: "webapp" });
      const text = result.content[0].text;
      // The recently verified "Auth best practice current" should rank higher
      // than the stale "Auth stale observation"
      const currentIdx = text.indexOf("Auth best practice current");
      const staleIdx = text.indexOf("Auth stale observation");
      // Both should be present
      assert.ok(currentIdx >= 0, "Should include recently verified observation");
      assert.ok(staleIdx >= 0, "Should include stale observation");
      // Current should appear before stale
      assert.ok(currentIdx < staleIdx, "Recently verified should rank higher than stale");
    });

    it("adds [STALE] prefix to stale observation titles", async () => {
      const result = await search(lcDb, "Auth stale observation");
      const text = result.content[0].text;
      assert.ok(text.includes("[STALE"), "Should have STALE prefix for old unverified observation");
    });
  });

  describe("composite score ranking order", () => {
    let rankDb: Database.Database;

    before(() => {
      rankDb = new Database(":memory:");
      rankDb.exec(`
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
        CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, content=observations, content_rowid=id);
        CREATE TRIGGER obs_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        END;
        CREATE TABLE obs_lifecycle (
          observation_id     INTEGER PRIMARY KEY,
          status             TEXT NOT NULL DEFAULT 'active'
                               CHECK(status IN ('active','superseded','deprecated','uncertain')),
          confidence         REAL NOT NULL DEFAULT 1.0
                               CHECK(confidence >= 0.0 AND confidence <= 1.0),
          valid_from         TEXT NOT NULL DEFAULT (datetime('now')),
          valid_until        TEXT,
          last_verified_at   TEXT,
          supersedes_id      INTEGER,
          superseded_by_id   INTEGER,
          deprecation_reason TEXT,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_lifecycle_status ON obs_lifecycle(status);
      `);

      const insert = rankDb.prepare(
        "INSERT INTO observations (title, content, type, project, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertLc = rankDb.prepare(
        "INSERT INTO obs_lifecycle (observation_id, status, confidence, last_verified_at) VALUES (?, ?, ?, ?)"
      );

      const now = new Date();
      const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

      // id=1: recent active observation (today)
      insert.run("Widget deployment config", "Deployment configuration for widget service", "decision", "webapp", "devops", now.toISOString());
      insertLc.run(1, "active", 1.0, now.toISOString());

      // id=2: old active observation (200 days ago, same FTS content)
      insert.run("Widget deployment plan", "Deployment plan for widget service", "decision", "webapp", "devops", daysAgo(200));
      insertLc.run(2, "active", 1.0, null);

      // id=3: very stale observation (400 days ago)
      insert.run("Widget deployment legacy", "Deployment legacy for widget service", "decision", "webapp", "devops", daysAgo(400));
      insertLc.run(3, "active", 1.0, null);
    });

    after(() => {
      rankDb.close();
    });

    it("composite score orders results: recent active > old active at same FTS relevance", async () => {
      const result = await search(rankDb, "Widget deployment");
      const text = result.content[0].text;
      const recentIdx = text.indexOf("Widget deployment config");
      const oldIdx = text.indexOf("Widget deployment plan");
      assert.ok(recentIdx >= 0, "Should include recent observation");
      assert.ok(oldIdx >= 0, "Should include old observation");
      assert.ok(recentIdx < oldIdx, "Recent active observation should rank above old active observation");
    });

    it("FTS rank dominates when recency difference is small", async () => {
      // Both observations are from today (same recency), but "config" was inserted first
      // so FTS rank difference should determine order. Both should appear.
      const result = await search(rankDb, "Widget deployment config");
      const text = result.content[0].text;
      // "config" is a better FTS match for "Widget deployment config" than "plan" or "legacy"
      const configIdx = text.indexOf("Widget deployment config");
      assert.ok(configIdx >= 0, "Should include exact FTS match");
      // It should be the top result since it's the best FTS match AND recent
      const lines = text.split("\n").filter(l => l.match(/^\d+\./));
      assert.ok(lines[0].includes("Widget deployment config"), "Best FTS match should be first result");
    });

    it("composite ranking: very stale observation ranks below fresh one", async () => {
      const result = await search(rankDb, "Widget deployment");
      const text = result.content[0].text;
      const freshIdx = text.indexOf("Widget deployment config");
      const staleIdx = text.indexOf("Widget deployment legacy");
      assert.ok(freshIdx >= 0, "Should include fresh observation");
      assert.ok(staleIdx >= 0, "Should include stale observation");
      assert.ok(freshIdx < staleIdx, "Fresh observation should rank above very stale observation");
    });
  });
});

// ─── Graph Expansion Tests ───────────────────────────────────────────

describe("graphExpandResults", () => {
  function createGraphSearchDb(): Database.Database {
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
      CREATE TABLE obs_entities (
        observation_id INTEGER NOT NULL,
        entity_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'mention',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (observation_id, entity_id)
      );
      CREATE INDEX idx_obs_entities_entity ON obs_entities(entity_id);
    `);

    // Insert observations
    db.exec(`
      INSERT INTO observations (id, title, content, type, project) VALUES
        (1, 'JWT auth implementation', 'Using jose library for JWT', 'decision', 'webapp'),
        (2, 'Database schema design', 'Users table with roles', 'architecture', 'webapp'),
        (3, 'React component patterns', 'Hooks-based architecture', 'decision', 'webapp'),
        (4, 'SQLite performance tuning', 'WAL mode and indexes', 'decision', 'cortex');
    `);

    // Insert entities
    db.exec(`
      INSERT INTO entities (id, type, name) VALUES
        (1, 'project', 'webapp'),
        (2, 'technology', 'jwt'),
        (3, 'technology', 'sqlite'),
        (4, 'project', 'cortex');
    `);

    // Link observations to entities
    db.exec(`
      INSERT INTO obs_entities (observation_id, entity_id) VALUES
        (1, 1), (1, 2),
        (2, 1),
        (3, 3),
        (4, 3), (4, 4);
    `);

    // Relations: webapp uses jwt, cortex uses sqlite
    db.exec(`
      INSERT INTO relations (src_entity_id, relation_type, dst_entity_id, weight) VALUES
        (1, 'uses', 2, 2.0),
        (4, 'uses', 3, 3.0);
    `);

    return db;
  }

  it("returns graph-expanded results after direct results", () => {
    const db = createGraphSearchDb();
    // Direct result: observation 1 (webapp JWT)
    const directResults: SearchResult[] = [
      {
        id: 1, title: "JWT auth implementation", content: "Using jose library",
        type: "decision", project: "webapp", scope: null,
        created_at: new Date().toISOString(), score: 0.8,
        ftsRank: -5, vecRank: null, source: "fts-fallback",
      },
    ];

    const expanded = graphExpandResults(db, directResults, 10);
    // Should find obs 2 (also linked to webapp entity) via graph
    assert.ok(expanded.length > 1, `Should have graph-expanded results, got ${expanded.length}`);
    // Direct result should be first (highest score)
    assert.equal(expanded[0].id, 1, "Direct result should be first");
    // Graph-expanded results should have source "graph-expanded"
    const graphResults = expanded.filter((r) => r.source === "graph-expanded");
    assert.ok(graphResults.length > 0, "Should have at least one graph-expanded result");
    db.close();
  });

  it("graph-expanded results have discounted score (0.5x lowest direct)", () => {
    const db = createGraphSearchDb();
    const directResults: SearchResult[] = [
      {
        id: 1, title: "JWT auth", content: null,
        type: "decision", project: "webapp", scope: null,
        created_at: null, score: 0.6,
        ftsRank: null, vecRank: null, source: "fts-fallback",
      },
    ];

    const expanded = graphExpandResults(db, directResults, 10);
    const graphResults = expanded.filter((r) => r.source === "graph-expanded");
    for (const r of graphResults) {
      assert.ok(r.score <= 0.6 * 0.5 + 0.001, `Graph score ${r.score} should be <= ${0.6 * 0.5}`);
    }
    db.close();
  });

  it("deduplicates: keeps direct result when also found via graph", () => {
    const db = createGraphSearchDb();
    // Direct result includes obs 1 and obs 2 (both linked to webapp)
    const directResults: SearchResult[] = [
      {
        id: 1, title: "JWT auth", content: null,
        type: "decision", project: "webapp", scope: null,
        created_at: null, score: 0.8,
        ftsRank: null, vecRank: null, source: "fts-fallback",
      },
      {
        id: 2, title: "Database schema", content: null,
        type: "architecture", project: "webapp", scope: null,
        created_at: null, score: 0.7,
        ftsRank: null, vecRank: null, source: "fts-fallback",
      },
    ];

    const expanded = graphExpandResults(db, directResults, 10);
    // Obs 1 and 2 should not be duplicated
    const ids = expanded.map((r) => r.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, "Should have no duplicate IDs");
    // Direct results should keep their original source
    const obs1 = expanded.find((r) => r.id === 1);
    assert.equal(obs1?.source, "fts-fallback", "Direct result should keep original source");
    db.close();
  });

  it("gracefully degrades when no entities exist for direct results", () => {
    const db = createGraphSearchDb();
    // Direct result with an ID not linked to any entity
    const directResults: SearchResult[] = [
      {
        id: 999, title: "Unlinked observation", content: null,
        type: "note", project: "test", scope: null,
        created_at: null, score: 0.5,
        ftsRank: null, vecRank: null, source: "fts-fallback",
      },
    ];

    const expanded = graphExpandResults(db, directResults, 10);
    assert.equal(expanded.length, 1, "Should return direct results unchanged");
    assert.equal(expanded[0].id, 999);
    db.close();
  });

  it("respects limit parameter for total results", () => {
    const db = createGraphSearchDb();
    const directResults: SearchResult[] = [
      {
        id: 1, title: "JWT auth", content: null,
        type: "decision", project: "webapp", scope: null,
        created_at: null, score: 0.8,
        ftsRank: null, vecRank: null, source: "fts-fallback",
      },
    ];

    const expanded = graphExpandResults(db, directResults, 2);
    assert.ok(expanded.length <= 2, `Should respect limit=2, got ${expanded.length}`);
    db.close();
  });

  it("returns empty array unchanged", () => {
    const db = createGraphSearchDb();
    const expanded = graphExpandResults(db, [], 10);
    assert.equal(expanded.length, 0);
    db.close();
  });

  it("gracefully degrades when obs_entities table missing", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, content TEXT, type TEXT, project TEXT, scope TEXT, created_at TEXT, deleted_at TEXT)`);
    const directResults: SearchResult[] = [
      {
        id: 1, title: "Test", content: null,
        type: "note", project: "test", scope: null,
        created_at: null, score: 0.5,
        ftsRank: null, vecRank: null, source: "fts-fallback",
      },
    ];
    const expanded = graphExpandResults(db, directResults, 10);
    assert.equal(expanded.length, 1, "Should return direct results when no graph tables");
    db.close();
  });
});
