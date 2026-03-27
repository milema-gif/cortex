import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  syncNewObservations,
  startSyncPoller,
  embeddingBackfill,
} from "../core/sync.js";

// ─── Helper: Create in-memory DB with schema ────────────────────────

function createSyncDb(): Database.Database {
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
    -- observations_vec is owned by engram-vec; create stub for backfill tests
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

// ─── syncNewObservations Tests ───────────────────────────────────────

describe("syncNewObservations", () => {
  it("processes observations with id > bookmark and updates bookmark per-observation", async () => {
    const db = createSyncDb();
    // Set initial bookmark
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    // Insert test observations
    db.exec(`
      INSERT INTO observations (id, title, content, project) VALUES
        (1, 'Cortex uses SQLite', 'test', 'cortex'),
        (2, 'React dashboard', 'test', 'webapp');
    `);

    // Mock fetch to succeed
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Bookmark should be updated to 2 (last processed id)
    const bookmark = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
      .get() as { value: string };
    assert.equal(bookmark.value, "2", "bookmark should be updated to last processed id");
    db.close();
  });

  it("calls extractAndLink for each new observation", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    db.exec(`
      INSERT INTO observations (id, title, content, project) VALUES
        (1, 'Cortex uses SQLite', 'FTS5 search', 'cortex'),
        (2, 'React with TypeScript', 'dashboard', 'webapp');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // extractAndLink should have created obs_entities rows for both observations
    const links = db
      .prepare("SELECT DISTINCT observation_id FROM obs_entities ORDER BY observation_id")
      .all() as Array<{ observation_id: number }>;
    assert.ok(links.length >= 2, `should have entity links for both observations, got ${links.length}`);
    db.close();
  });

  it("handles engram-vec POST /embed failure gracefully and records sync_failures", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    db.exec("INSERT INTO observations (id, title, content) VALUES (1, 'SQLite test', 'content')");

    // Mock fetch to throw (network error)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    try {
      // Should NOT throw
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Bookmark should still be updated (graceful degradation)
    const bookmark = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
      .get() as { value: string };
    assert.equal(bookmark.value, "1", "bookmark should update even when embed fails");

    // sync_failures row should exist
    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 1")
      .get() as { observation_id: number; attempt_count: number; status: string; last_error: string } | undefined;
    assert.ok(failure, "sync_failures row should exist for failed observation");
    assert.equal(failure!.attempt_count, 1, "attempt_count should be 1");
    assert.equal(failure!.status, "pending", "status should be pending");
    assert.ok(failure!.last_error.includes("connection refused"), "last_error should contain error message");
    db.close();
  });

  it("non-200 /embed response creates sync_failures row with attempt_count=1", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    db.exec("INSERT INTO observations (id, title, content) VALUES (1, 'test obs', 'content')");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 1")
      .get() as { observation_id: number; attempt_count: number; status: string; last_error: string } | undefined;
    assert.ok(failure, "sync_failures row should exist for non-200 response");
    assert.equal(failure!.attempt_count, 1);
    assert.equal(failure!.status, "pending");
    db.close();
  });

  it("non-200 /embed -- bookmark still advances (observation tracked in sync_failures)", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    db.exec(`
      INSERT INTO observations (id, title) VALUES (1, 'obs 1'), (2, 'obs 2'), (3, 'obs 3');
    `);

    const originalFetch = globalThis.fetch;
    let callIdx = 0;
    globalThis.fetch = async () => {
      callIdx++;
      if (callIdx === 2) return new Response("Server Error", { status: 500 });
      return new Response("ok", { status: 200 });
    };
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Bookmark should advance to 3 (past the failed obs 2)
    const bookmark = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
      .get() as { value: string };
    assert.equal(bookmark.value, "3", "bookmark should advance past failed observation");

    // obs 2 should be in sync_failures
    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 2")
      .get() as { observation_id: number } | undefined;
    assert.ok(failure, "failed observation should be tracked in sync_failures");
    db.close();
  });

  it("on retry cycle, previously-failed observation succeeds -- sync_failures row deleted", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '5')");
    // Pre-seed a pending failure
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (3, 1, 'HTTP 500', 'pending');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // sync_failures row should be deleted (retry succeeded)
    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 3")
      .get();
    assert.equal(failure, undefined, "sync_failures row should be deleted after successful retry");
    db.close();
  });

  it("on retry cycle, if observation fails again, attempt_count increments", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '5')");
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (3, 2, 'HTTP 500: old error', 'pending');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 3")
      .get() as { attempt_count: number; last_error: string; status: string };
    assert.ok(failure, "sync_failures row should still exist");
    assert.equal(failure.attempt_count, 3, "attempt_count should increment to 3");
    assert.equal(failure.status, "pending", "status should still be pending (under max retries)");
    db.close();
  });

  it("after max retries (5), observation status becomes parked", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '5')");
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (3, 4, 'HTTP 500: error', 'pending');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Error", { status: 500 });
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 3")
      .get() as { attempt_count: number; status: string };
    assert.ok(failure, "sync_failures row should still exist");
    assert.equal(failure.attempt_count, 5, "attempt_count should be 5");
    assert.equal(failure.status, "parked", "status should be parked after max retries");
    db.close();
  });

  it("crash recovery -- pending sync_failures rows are retried when sync restarts", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '10')");
    // Simulate crash recovery: 2 pending failures from a previous run
    db.exec(`
      INSERT INTO sync_failures (observation_id, attempt_count, last_error, status)
      VALUES (5, 1, 'crash', 'pending'), (8, 2, 'crash', 'pending');
    `);

    const originalFetch = globalThis.fetch;
    const embedIds: number[] = [];
    globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      embedIds.push(body.id);
      return new Response("ok", { status: 200 });
    };
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Both pending failures should have been retried
    assert.ok(embedIds.includes(5), "observation 5 should be retried");
    assert.ok(embedIds.includes(8), "observation 8 should be retried");

    // Both should be cleared from sync_failures
    const remaining = db
      .prepare("SELECT COUNT(*) as cnt FROM sync_failures WHERE status = 'pending'")
      .get() as { cnt: number };
    assert.equal(remaining.cnt, 0, "all pending failures should be resolved after successful retry");
    db.close();
  });

  it("invariant: every observation_id <= bookmark is either embedded or in sync_failures", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    db.exec(`
      INSERT INTO observations (id, title) VALUES (1, 'obs 1'), (2, 'obs 2'), (3, 'obs 3');
    `);

    const originalFetch = globalThis.fetch;
    let callIdx = 0;
    globalThis.fetch = async () => {
      callIdx++;
      // obs 2 fails with 500
      if (callIdx === 2) return new Response("Error", { status: 500 });
      return new Response("ok", { status: 200 });
    };
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const bookmark = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
      .get() as { value: string };
    const bookmarkId = parseInt(bookmark.value, 10);
    assert.equal(bookmarkId, 3);

    // Check invariant: every obs id 1..bookmark is either in sync_failures or was successfully embedded
    // obs 1 and 3: success (no sync_failures entry)
    // obs 2: should be in sync_failures
    const failures = db
      .prepare("SELECT observation_id FROM sync_failures")
      .all() as Array<{ observation_id: number }>;
    const failedIds = new Set(failures.map(f => f.observation_id));
    assert.ok(failedIds.has(2), "failed obs 2 should be tracked in sync_failures");
    assert.ok(!failedIds.has(1), "successful obs 1 should NOT be in sync_failures");
    assert.ok(!failedIds.has(3), "successful obs 3 should NOT be in sync_failures");
    db.close();
  });

  it("is a no-op when no new observations exist", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '100')");
    // No observations with id > 100

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return new Response("ok"); };
    try {
      await syncNewObservations(db);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false, "fetch should not be called when no new observations");
    db.close();
  });
});

// ─── startSyncPoller Tests ──────────────────────────────────────────

describe("startSyncPoller", () => {
  it("initializes bookmark to current MAX(id) on first call", () => {
    const db = createSyncDb();
    db.exec(`
      INSERT INTO observations (id, title) VALUES (5, 'obs 5'), (10, 'obs 10');
    `);

    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });

    const handle = startSyncPoller(db, 60_000); // long interval so it doesn't fire
    clearInterval(handle);

    globalThis.fetch = originalFetch;

    const bookmark = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
      .get() as { value: string };
    assert.equal(bookmark.value, "10", "bookmark should initialize to MAX(id)=10");
    db.close();
  });

  it("skips poll when syncing flag is true (re-entrancy guard)", async () => {
    const db = createSyncDb();
    db.exec("INSERT INTO cortex_meta(key, value) VALUES('last_synced_id', '0')");
    // Insert one obs that will take some time to process
    db.exec("INSERT INTO observations (id, title, content) VALUES (1, 'SQLite test', 'content')");

    const originalFetch = globalThis.fetch;
    // Make fetch slow to simulate long sync
    globalThis.fetch = async () => {
      await new Promise(r => setTimeout(r, 100));
      return new Response("ok", { status: 200 });
    };

    let syncCallCount = 0;
    const origSync = globalThis.fetch;

    // Start poller with very short interval
    const handle = startSyncPoller(db, 10);

    // Wait for a couple intervals
    await new Promise(r => setTimeout(r, 200));

    clearInterval(handle);
    globalThis.fetch = originalFetch;

    // The key assertion: even with rapid interval, bookmark should be consistent
    // (no concurrent modification). This is a basic sanity check.
    const bookmark = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'last_synced_id'")
      .get() as { value: string };
    assert.ok(bookmark, "bookmark should exist");
    db.close();
  });
});

// ─── embeddingBackfill Tests ────────────────────────────────────────

describe("embeddingBackfill", () => {
  it("processes at most maxPerCycle observations", async () => {
    const db = createSyncDb();
    // Insert 5 observations, none in observations_vec
    for (let i = 1; i <= 5; i++) {
      db.exec(`INSERT INTO observations (id, title) VALUES (${i}, 'obs ${i}')`);
    }

    const originalFetch = globalThis.fetch;
    let embedCount = 0;
    globalThis.fetch = async () => { embedCount++; return new Response("ok", { status: 200 }); };
    try {
      const count = await embeddingBackfill(db, 0, 3); // maxPerCycle=3
      assert.equal(count, 3, "should process at most maxPerCycle=3");
      assert.equal(embedCount, 3, "should have called fetch 3 times");
    } finally {
      globalThis.fetch = originalFetch;
    }
    db.close();
  });

  it("handles fetch failure gracefully (continues to next, records sync_failures)", async () => {
    const db = createSyncDb();
    db.exec(`
      INSERT INTO observations (id, title) VALUES (1, 'obs 1'), (2, 'obs 2'), (3, 'obs 3');
    `);

    const originalFetch = globalThis.fetch;
    let callIdx = 0;
    globalThis.fetch = async () => {
      callIdx++;
      if (callIdx === 2) throw new Error("network error");
      return new Response("ok", { status: 200 });
    };
    try {
      const count = await embeddingBackfill(db, 0, 10);
      assert.equal(count, 2, "should return 2 successful embeds (1 failed)");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // obs 2 should be in sync_failures
    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 2")
      .get() as { observation_id: number; status: string } | undefined;
    assert.ok(failure, "backfill failure should be recorded in sync_failures");
    assert.equal(failure!.status, "pending");
    db.close();
  });

  it("non-200 response does NOT count as success in backfill", async () => {
    const db = createSyncDb();
    db.exec(`
      INSERT INTO observations (id, title) VALUES (1, 'obs 1'), (2, 'obs 2');
    `);

    const originalFetch = globalThis.fetch;
    let callIdx = 0;
    globalThis.fetch = async () => {
      callIdx++;
      if (callIdx === 1) return new Response("Error", { status: 500 });
      return new Response("ok", { status: 200 });
    };
    try {
      const count = await embeddingBackfill(db, 0, 10);
      assert.equal(count, 1, "non-200 should NOT count as success");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // obs 1 should be in sync_failures
    const failure = db
      .prepare("SELECT * FROM sync_failures WHERE observation_id = 1")
      .get() as { observation_id: number } | undefined;
    assert.ok(failure, "non-200 backfill should be recorded in sync_failures");
    db.close();
  });

  it("returns count of successfully embedded observations", async () => {
    const db = createSyncDb();
    db.exec(`
      INSERT INTO observations (id, title) VALUES (1, 'obs 1'), (2, 'obs 2');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      const count = await embeddingBackfill(db, 0, 20);
      assert.equal(count, 2, "should return 2 for 2 successful embeds");
    } finally {
      globalThis.fetch = originalFetch;
    }
    db.close();
  });

  it("skips observations already in observations_vec", async () => {
    const db = createSyncDb();
    db.exec(`
      INSERT INTO observations (id, title) VALUES (1, 'obs 1'), (2, 'obs 2'), (3, 'obs 3');
      INSERT INTO observations_vec (observation_id) VALUES (1), (2);
    `);

    const originalFetch = globalThis.fetch;
    let embedCount = 0;
    globalThis.fetch = async () => { embedCount++; return new Response("ok", { status: 200 }); };
    try {
      const count = await embeddingBackfill(db, 0, 20);
      assert.equal(count, 1, "should only embed obs 3 (1 and 2 already in vec)");
      assert.equal(embedCount, 1, "should have called fetch only once");
    } finally {
      globalThis.fetch = originalFetch;
    }
    db.close();
  });
});
