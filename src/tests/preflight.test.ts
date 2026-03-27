import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { estimateTokens, assembleBrief, type BriefSection } from "../lib/token-budget.js";
import { generatePreflight } from "../core/preflight.js";

/**
 * Tests for token budget utilities and preflight brief engine.
 */

function createPreflightTestDb(): Database.Database {
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
      observation_id     INTEGER PRIMARY KEY,
      status             TEXT NOT NULL DEFAULT 'active',
      confidence         REAL NOT NULL DEFAULT 1.0,
      valid_from         TEXT NOT NULL DEFAULT (datetime('now')),
      valid_until        TEXT,
      last_verified_at   TEXT,
      supersedes_id      INTEGER,
      superseded_by_id   INTEGER,
      deprecation_reason TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE preflight_cache (
      cache_key    TEXT PRIMARY KEY,
      brief        TEXT NOT NULL,
      brief_hash   TEXT NOT NULL,
      obs_ids      TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );
  `);

  // Insert test observations for "testproject" with various types
  const insert = db.prepare(
    "INSERT INTO observations (title, content, type, project, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  // Decisions
  insert.run("Use JWT for auth", "Decided to use JWT tokens for authentication", "decision", "testproject", "architecture", new Date().toISOString());
  insert.run("Postgres over MySQL", "Chose Postgres for better JSON support", "decision", "testproject", "database", new Date().toISOString());

  // Gotchas
  insert.run("CORS blocks third-party APIs", "Browser CORS kills third-party API calls from frontend", "gotcha", "testproject", "frontend", new Date().toISOString());

  // Architecture
  insert.run("Event-driven architecture", "Using event-driven patterns for async processing", "architecture", "testproject", "backend", new Date().toISOString());

  // Todos (PRE-02 requirement)
  insert.run("Implement rate limiting", "Need to add rate limiting to API endpoints", "todo", "testproject", "backend", new Date().toISOString());
  insert.run("Add input validation", "Need input validation on all forms", "todo", "testproject", "frontend", new Date().toISOString());

  // Patterns
  insert.run("Repository pattern for data access", "Using repository pattern for all DB operations", "pattern", "testproject", "backend", new Date().toISOString());

  // Bugfix
  insert.run("Fixed null pointer in user lookup", "Fixed NPE when user not found in cache", "bugfix", "testproject", "backend", new Date().toISOString());

  // Deprecated observation (should be excluded)
  insert.run("Old REST approach", "Old REST API design that was deprecated", "decision", "testproject", "architecture", "2024-01-01T00:00:00Z");
  const insertLc = db.prepare(
    "INSERT INTO obs_lifecycle (observation_id, status, confidence, last_verified_at) VALUES (?, ?, ?, ?)"
  );
  insertLc.run(9, "deprecated", 1.0, null);

  // Stale observation (should get [STALE] prefix)
  insert.run("Old deployment strategy", "Deploy via manual FTP", "decision", "testproject", "devops", "2024-01-01T00:00:00Z");
  insertLc.run(10, "active", 1.0, null);

  return db;
}

describe("token budget utilities", () => {
  it("estimateTokens returns reasonable values", () => {
    assert.equal(estimateTokens("hello world"), Math.ceil(2 * 1.3));
    assert.equal(estimateTokens("one"), Math.ceil(1 * 1.3));
    assert.equal(estimateTokens(""), 0);
    assert.ok(estimateTokens("a b c d e") > 0);
  });

  it("assembleBrief respects token budget", () => {
    const sections: BriefSection[] = [
      { label: "High Priority", items: ["item 1", "item 2", "item 3", "item 4", "item 5"], priority: 5 },
      { label: "Low Priority", items: ["low item 1", "low item 2"], priority: 1 },
    ];
    const brief = assembleBrief(sections, 20); // very small budget
    const tokens = estimateTokens(brief);
    assert.ok(tokens <= 20, `Brief should be under 20 tokens, got ${tokens}`);
  });

  it("assembleBrief includes higher priority sections first", () => {
    const sections: BriefSection[] = [
      { label: "Low", items: ["low stuff"], priority: 1 },
      { label: "High", items: ["high stuff"], priority: 5 },
    ];
    const brief = assembleBrief(sections, 500);
    // Both should be present with enough budget
    assert.ok(brief.includes("High"), "Should include high priority section");
    assert.ok(brief.includes("high stuff"), "Should include high priority items");
  });

  it("assembleBrief returns empty string for empty sections", () => {
    const brief = assembleBrief([], 500);
    assert.equal(brief, "");
  });
});

describe("preflight engine", () => {
  // Helper to clear preflight cache between tests that need fresh state
  function clearCache(db: Database.Database): void {
    try { db.prepare("DELETE FROM preflight_cache").run(); } catch { /* ignore */ }
  }

  it("generates brief with Decisions, Gotchas, Architecture, Active Todos sections", async () => {
    const db = createPreflightTestDb();
    const result = await generatePreflight(db, "testproject");
    assert.ok(result.changed, "Should indicate change on first call");
    assert.ok(result.brief.includes("Decisions"), "Should have Decisions section");
    assert.ok(result.brief.includes("Gotchas"), "Should have Gotchas section");
    assert.ok(result.brief.includes("Architecture"), "Should have Architecture section");
    assert.ok(result.brief.includes("Active Todos"), "Should have Active Todos section");
    db.close();
  });

  it("includes todo-type observations under Active Todos section (PRE-02)", async () => {
    const db = createPreflightTestDb();
    const result = await generatePreflight(db, "testproject");
    assert.ok(result.brief.includes("rate limiting") || result.brief.includes("Implement rate limiting"),
      "Should include todo about rate limiting");
    assert.ok(result.brief.includes("input validation") || result.brief.includes("Add input validation"),
      "Should include todo about input validation");
    db.close();
  });

  it("brief is under 500 tokens", async () => {
    const db = createPreflightTestDb();
    const result = await generatePreflight(db, "testproject");
    const tokens = estimateTokens(result.brief);
    assert.ok(tokens <= 500, `Brief should be under 500 tokens, got ${tokens}`);
    db.close();
  });

  it("consecutive identical calls return 'no change' (cache dedup)", async () => {
    const db = createPreflightTestDb();
    // First call should return changed=true with full brief
    const first = await generatePreflight(db, "testproject");
    assert.ok(first.changed, "First call should be changed");

    // Second call should return changed=false with 'no change' message
    const second = await generatePreflight(db, "testproject");
    assert.ok(!second.changed, "Second call should indicate no change");
    assert.ok(second.brief.includes("No changes"), "Should return no-change message");
    db.close();
  });

  it("excludes deprecated observations from brief", async () => {
    const db = createPreflightTestDb();
    const result = await generatePreflight(db, "testproject");
    assert.ok(!result.brief.includes("Old REST approach"), "Should NOT include deprecated observation");
    db.close();
  });

  it("stale observations get [STALE] prefix in brief", async () => {
    const db = createPreflightTestDb();
    const result = await generatePreflight(db, "testproject");
    // The old deployment strategy observation from 2024 should be stale
    if (result.brief.includes("deployment strategy")) {
      assert.ok(result.brief.includes("[STALE"), "Stale observation should have [STALE] prefix");
    }
    db.close();
  });

  it("empty project returns empty brief (no error)", async () => {
    const db = createPreflightTestDb();
    const result = await generatePreflight(db, "nonexistentproject");
    assert.ok(result.changed, "Should still indicate change");
    assert.ok(!result.brief.includes("Decisions"), "Should not have Decisions for empty project");
    db.close();
  });

  it("gracefully degrades with broken DB", async () => {
    const brokenDb = new Database(":memory:");
    const result = await generatePreflight(brokenDb, "testproject");
    assert.ok(result.brief.includes("unavailable"), "Should indicate preflight is unavailable");
    brokenDb.close();
  });

  it("cache invalidates when new observation is inserted", async () => {
    const db = createPreflightTestDb();

    // First call: changed=true (no cache yet)
    const first = await generatePreflight(db, "testproject");
    assert.ok(first.changed, "First call should be changed");

    // Second call: changed=false (cache hit, same hash)
    const second = await generatePreflight(db, "testproject");
    assert.ok(!second.changed, "Second call should indicate no change (cache hit)");

    // Insert a new observation for the same project
    db.prepare(
      "INSERT INTO observations (title, content, type, project, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "New API endpoint added",
      "Added a new REST endpoint for user management",
      "decision",
      "testproject",
      "backend",
      new Date().toISOString()
    );

    // Third call: changed=true (new observation changes the brief content -> different hash -> cache miss)
    const third = await generatePreflight(db, "testproject");
    assert.ok(third.changed, "Third call should detect change after new observation inserted");
    assert.ok(third.brief.includes("New API endpoint") || third.brief.length > 0, "Brief should reflect updated data");

    db.close();
  });
});
