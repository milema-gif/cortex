import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { computeHealth } from "../core/health.js";
import {
  reconcileRetry,
  reconcileDrop,
  reconcileAck,
  isAcked,
  resetAck,
} from "../core/reconcile.js";
import {
  syncNewObservations,
  embeddingBackfill,
} from "../core/sync.js";

// ─── Helper: Create in-memory DB with schema ────────────────────────

function createReconcileDb(): Database.Database {
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
    CREATE TABLE cortex_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE observations_vec (
      observation_id INTEGER PRIMARY KEY
    );
    CREATE TABLE sync_failures (
      observation_id   INTEGER PRIMARY KEY,
      attempt_count    INTEGER NOT NULL DEFAULT 1,
      last_error       TEXT NOT NULL,
      last_attempt_at  TEXT NOT NULL DEFAULT (datetime('now')),
      first_failed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending','parked'))
    );
    CREATE INDEX idx_sync_failures_status ON sync_failures(status);
  `);
  return db;
}

// ─── computeHealth Tests ──────────────────────────────────────────────

describe("computeHealth", () => {
  it("returns 'healthy' when sync_failures is empty", () => {
    const db = createReconcileDb();
    assert.equal(computeHealth(db), "healthy");
    db.close();
  });

  it("returns 'degraded' when pending failures exist but no blocking condition", () => {
    const db = createReconcileDb();
    // Insert 2 pending failures (under the 5 parked threshold)
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (1, 1, 'HTTP 500', 'pending'), (2, 2, 'HTTP 502', 'pending');
    `);
    assert.equal(computeHealth(db), "degraded");
    db.close();
  });

  it("returns 'blocked' when parked_count > 5", () => {
    const db = createReconcileDb();
    for (let i = 1; i <= 6; i++) {
      db.prepare(
        "INSERT INTO sync_failures (observation_id, attempt_count, last_error, status) VALUES (?, 5, 'parked error', 'parked')"
      ).run(i);
    }
    assert.equal(computeHealth(db), "blocked");
    db.close();
  });

  it("returns 'blocked' when any parked item older than 24h", () => {
    const db = createReconcileDb();
    // Insert 1 parked row with first_failed_at 25 hours ago
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, first_failed_at, status)
      VALUES (1, 5, 'old error', datetime('now', '-25 hours'), 'parked');
    `);
    assert.equal(computeHealth(db), "blocked");
    db.close();
  });

  it("returns 'healthy' when sync_failures table missing (graceful)", () => {
    // Create a DB without sync_failures table
    const db = new Database(":memory:");
    db.exec("CREATE TABLE cortex_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    assert.equal(computeHealth(db), "healthy");
    db.close();
  });
});

// ─── Reconcile Actions Tests ─────────────────────────────────────────

describe("reconcile actions", () => {
  afterEach(() => {
    resetAck();
  });

  it("reconcileRetry re-queues a parked observation (status -> pending, attempt_count -> 0)", () => {
    const db = createReconcileDb();
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (42, 5, 'HTTP 500', 'parked');
    `);

    const result = reconcileRetry(db, 42);
    assert.equal(result.success, true);
    assert.ok(result.message.includes("42"));

    const row = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 42")
      .get() as { status: string; attempt_count: number };
    assert.equal(row.status, "pending");
    assert.equal(row.attempt_count, 0);
    db.close();
  });

  it("reconcileRetry returns error for unknown observation_id", () => {
    const db = createReconcileDb();
    const result = reconcileRetry(db, 999);
    assert.equal(result.success, false);
    assert.ok(result.message.includes("999"));
    assert.ok(result.message.toLowerCase().includes("not found"));
    db.close();
  });

  it("reconcileRetry returns error for already-pending observation", () => {
    const db = createReconcileDb();
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (10, 2, 'HTTP 500', 'pending');
    `);

    const result = reconcileRetry(db, 10);
    assert.equal(result.success, false);
    assert.ok(result.message.includes("pending"));
    db.close();
  });

  it("reconcileDrop removes a sync_failures row", () => {
    const db = createReconcileDb();
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (77, 3, 'HTTP 503', 'parked');
    `);

    const result = reconcileDrop(db, 77);
    assert.equal(result.success, true);

    const row = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 77")
      .get();
    assert.equal(row, undefined, "row should be deleted");
    db.close();
  });

  it("reconcileDrop returns error for unknown observation_id", () => {
    const db = createReconcileDb();
    const result = reconcileDrop(db, 888);
    assert.equal(result.success, false);
    assert.ok(result.message.includes("888"));
    db.close();
  });

  it("reconcileAck sets session flag, isAcked() returns true", () => {
    const db = createReconcileDb();
    assert.equal(isAcked(), false, "should not be acked initially");

    const result = reconcileAck(db);
    assert.equal(result.success, true);
    assert.equal(isAcked(), true, "should be acked after reconcileAck");
    db.close();
  });

  it("resetAck clears session flag", () => {
    const db = createReconcileDb();
    reconcileAck(db);
    assert.equal(isAcked(), true);
    resetAck();
    assert.equal(isAcked(), false, "should be cleared after resetAck");
    db.close();
  });
});

// ─── Execution Gate Tests ────────────────────────────────────────────

describe("execution gate", () => {
  afterEach(() => {
    resetAck();
  });

  it("syncNewObservations skips when blocked and not acked", async () => {
    const db = createReconcileDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    // Insert observation to process
    db.exec("INSERT INTO observations (id, title) VALUES (1, 'test obs')");
    // Seed 6 parked failures to trigger blocked
    for (let i = 100; i <= 105; i++) {
      db.prepare(
        "INSERT INTO sync_failures (observation_id, attempt_count, last_error, status) VALUES (?, 5, 'error', 'parked')"
      ).run(i);
    }

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    };
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false, "fetch should NOT be called when blocked and not acked");

    // Bookmark should NOT advance
    const bookmark = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
      .get() as { value: string };
    assert.equal(bookmark.value, "0", "bookmark should not advance when blocked");
    db.close();
  });

  it("syncNewObservations proceeds when blocked but acked", async () => {
    const db = createReconcileDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    db.exec("INSERT INTO observations (id, title, content) VALUES (1, 'test obs', 'content')");
    // Seed 6 parked failures to trigger blocked
    for (let i = 100; i <= 105; i++) {
      db.prepare(
        "INSERT INTO sync_failures (observation_id, attempt_count, last_error, status) VALUES (?, 5, 'error', 'parked')"
      ).run(i);
    }

    // Ack the blocked state
    reconcileAck(db);

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    };
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, true, "fetch SHOULD be called when blocked but acked");
    db.close();
  });

  it("embeddingBackfill returns 0 when blocked and not acked", async () => {
    const db = createReconcileDb();
    // Insert unembedded observations
    db.exec("INSERT INTO observations (id, title) VALUES (1, 'obs 1'), (2, 'obs 2')");
    // Seed 6 parked failures to trigger blocked
    for (let i = 100; i <= 105; i++) {
      db.prepare(
        "INSERT INTO sync_failures (observation_id, attempt_count, last_error, status) VALUES (?, 5, 'error', 'parked')"
      ).run(i);
    }

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    };
    try {
      const count = await embeddingBackfill(db, 0, 10);
      assert.equal(count, 0, "should return 0 when blocked");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false, "fetch should NOT be called when blocked");
    db.close();
  });
});
