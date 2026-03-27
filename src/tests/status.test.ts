import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getStatus } from "../core/status.js";
import { config } from "../config.js";

/**
 * Tests for the status checker.
 * Uses a temp in-memory DB with Cortex tables created.
 * Forces engram-vec to be unreachable so status reports "down".
 */

const originalVecUrl = config.engramVecUrl;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");

  // Create Engram-owned tables
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
  `);

  // Insert some test data
  db.prepare("INSERT INTO observations (title) VALUES (?)").run("Test 1");
  db.prepare("INSERT INTO observations (title) VALUES (?)").run("Test 2");
  db.prepare("INSERT INTO observations (title, deleted_at) VALUES (?, datetime('now'))").run("Deleted");

  // Create Cortex-owned tables
  db.exec(`
    CREATE TABLE cortex_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE obs_lifecycle (observation_id INTEGER PRIMARY KEY, status TEXT DEFAULT 'active');
    CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT);
    CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src_entity_id INTEGER, relation_type TEXT, dst_entity_id INTEGER);
    CREATE TABLE obs_entities (observation_id INTEGER, entity_id INTEGER, PRIMARY KEY(observation_id, entity_id));
    CREATE TABLE preflight_cache (cache_key TEXT PRIMARY KEY, brief TEXT, obs_ids TEXT, created_at TEXT, expires_at TEXT);
  `);

  // Insert some data
  db.prepare("INSERT INTO cortex_meta (key, value) VALUES (?, ?)").run("schema_version", "1");
  db.prepare("INSERT INTO entities (type, name) VALUES (?, ?)").run("project", "test");

  return db;
}

describe("status checker", () => {
  let db: Database.Database;

  before(() => {
    config.engramVecUrl = "http://127.0.0.1:1"; // unreachable — force "down"
    db = createTestDb();
  });

  after(() => {
    config.engramVecUrl = originalVecUrl;
    db.close();
  });

  it("reports DB connectivity with observation counts", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.db.status, "ok");
    assert.equal(status.db.observations, 2, "Should count non-deleted observations");
  });

  it("reports Cortex table row counts", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.cortex_tables.cortex_meta, 1);
    assert.equal(status.cortex_tables.entities, 1);
    assert.equal(status.cortex_tables.relations, 0);
    assert.equal(status.cortex_tables.obs_entities, 0);
    assert.equal(status.cortex_tables.preflight_cache, 0);
    assert.equal(status.cortex_tables.obs_lifecycle, 0);
  });

  it("reports engram-vec as down when unavailable", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    // engram-vec is not running in test, should report down
    assert.equal(status.engram_vec.status, "down");
  });

  it("reports Ollama status", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    // Ollama may or may not be running, but should be a string
    assert.ok(typeof status.ollama === "string");
  });

  it("does not throw when a table is missing", async () => {
    const sparseDb = new Database(":memory:");
    sparseDb.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT)");
    // No Cortex tables at all
    const result = await getStatus(sparseDb);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.cortex_tables.cortex_meta, "not_created");
    assert.equal(status.cortex_tables.entities, "not_created");
    sparseDb.close();
  });

  it("returns valid MCP content format", async () => {
    const result = await getStatus(db);
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, "text");
    assert.ok(typeof result.content[0].text === "string");
    // Should be valid JSON
    JSON.parse(result.content[0].text);
  });
});

describe("sync_health reporting", () => {
  let db: Database.Database;

  before(() => {
    db = new Database(":memory:");

    // Create Engram-owned tables
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
    `);
    db.prepare("INSERT INTO observations (title) VALUES (?)").run("Test 1");

    // Create Cortex-owned tables
    db.exec(`
      CREATE TABLE cortex_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE obs_lifecycle (observation_id INTEGER PRIMARY KEY, status TEXT DEFAULT 'active');
      CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT);
      CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src_entity_id INTEGER, relation_type TEXT, dst_entity_id INTEGER);
      CREATE TABLE obs_entities (observation_id INTEGER, entity_id INTEGER, PRIMARY KEY(observation_id, entity_id));
      CREATE TABLE preflight_cache (cache_key TEXT PRIMARY KEY, brief TEXT, obs_ids TEXT, created_at TEXT, expires_at TEXT);
    `);

    // Create sync_failures table
    db.exec(`
      CREATE TABLE sync_failures (
        observation_id   INTEGER PRIMARY KEY,
        attempt_count    INTEGER NOT NULL DEFAULT 1,
        last_error       TEXT NOT NULL,
        last_attempt_at  TEXT NOT NULL DEFAULT (datetime('now')),
        first_failed_at  TEXT NOT NULL DEFAULT (datetime('now')),
        status           TEXT NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','parked'))
      );
    `);

    // Insert test failure data: 2 pending, 1 parked
    db.prepare(
      "INSERT INTO sync_failures (observation_id, attempt_count, last_error, first_failed_at, last_attempt_at, status) VALUES (?, ?, ?, datetime('now', '-2 hours'), datetime('now', '-30 minutes'), 'pending')"
    ).run(10, 2, "HTTP 500: Internal Server Error");
    db.prepare(
      "INSERT INTO sync_failures (observation_id, attempt_count, last_error, first_failed_at, last_attempt_at, status) VALUES (?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-10 minutes'), 'pending')"
    ).run(20, 1, "HTTP 503: Service Unavailable");
    db.prepare(
      "INSERT INTO sync_failures (observation_id, attempt_count, last_error, first_failed_at, last_attempt_at, status) VALUES (?, ?, ?, datetime('now', '-3 hours'), datetime('now', '-1 hour'), 'parked')"
    ).run(5, 5, "HTTP 500: repeated failure");

    // Insert last_successful_sync_at
    db.prepare("INSERT INTO cortex_meta (key, value) VALUES (?, ?)").run(
      "last_successful_sync_at",
      "2026-03-27T10:00:00Z"
    );
  });

  after(() => {
    db.close();
  });

  it("includes sync_health object in status report", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    assert.ok(status.sync_health, "sync_health section must exist");
    assert.equal(typeof status.sync_health, "object");
  });

  it("sync_health.pending_count returns count of pending rows", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.sync_health.pending_count, 2);
  });

  it("sync_health.parked_count returns count of parked rows", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.sync_health.parked_count, 1);
  });

  it("sync_health.oldest_pending_age returns human-readable age string", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    // oldest pending is 2 hours ago, should be a string like "2h 0m"
    assert.ok(typeof status.sync_health.oldest_pending_age === "string");
    assert.ok(status.sync_health.oldest_pending_age.length > 0);
  });

  it("sync_health.last_successful_sync returns timestamp from cortex_meta", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.sync_health.last_successful_sync, "2026-03-27T10:00:00Z");
  });

  it("sync_health.total_retry_attempts returns sum of attempt_count", async () => {
    const result = await getStatus(db);
    const status = JSON.parse(result.content[0].text);
    // 2 + 1 + 5 = 8
    assert.equal(status.sync_health.total_retry_attempts, 8);
  });

  it("sync_health gracefully handles missing sync_failures table", async () => {
    const sparseDb = new Database(":memory:");
    sparseDb.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT)");
    // No sync_failures table
    const result = await getStatus(sparseDb);
    const status = JSON.parse(result.content[0].text);
    // sync_health should be absent or null when table doesn't exist
    assert.ok(
      status.sync_health === undefined || status.sync_health === null,
      "sync_health should be absent when sync_failures table missing"
    );
    sparseDb.close();
  });

  it("sync_health shows zeros when sync_failures table is empty", async () => {
    const emptyDb = new Database(":memory:");
    emptyDb.exec(`
      CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT);
      CREATE TABLE cortex_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE obs_lifecycle (observation_id INTEGER PRIMARY KEY, status TEXT DEFAULT 'active');
      CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT);
      CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src_entity_id INTEGER, relation_type TEXT, dst_entity_id INTEGER);
      CREATE TABLE obs_entities (observation_id INTEGER, entity_id INTEGER, PRIMARY KEY(observation_id, entity_id));
      CREATE TABLE preflight_cache (cache_key TEXT PRIMARY KEY, brief TEXT, obs_ids TEXT, created_at TEXT, expires_at TEXT);
      CREATE TABLE sync_failures (
        observation_id INTEGER PRIMARY KEY,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        last_error TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
        first_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','parked'))
      );
    `);
    const result = await getStatus(emptyDb);
    const status = JSON.parse(result.content[0].text);
    assert.ok(status.sync_health, "sync_health should exist with empty table");
    assert.equal(status.sync_health.pending_count, 0);
    assert.equal(status.sync_health.parked_count, 0);
    assert.equal(status.sync_health.oldest_pending_age, null);
    assert.equal(status.sync_health.last_successful_sync, null);
    assert.equal(status.sync_health.total_retry_attempts, 0);
    emptyDb.close();
  });
});
