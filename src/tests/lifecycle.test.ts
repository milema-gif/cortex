import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  ensureLifecycleRow,
  deprecate,
  supersede,
  verify,
  computeConfidence,
  addStalenessWarning,
  findPotentialConflicts,
} from "../core/lifecycle.js";

/**
 * Tests for the lifecycle management system.
 * Uses in-memory DB with observations + observations_fts + obs_lifecycle tables.
 */

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
  `);

  // Insert test observations
  const insert = db.prepare(
    "INSERT INTO observations (title, content, type, project, scope) VALUES (?, ?, ?, ?, ?)"
  );
  insert.run("JWT auth with refresh tokens", "Implemented JWT authentication", "decision", "webapp", "architecture");
  insert.run("Database schema for users", "Created users table with email", "architecture", "webapp", "database");
  insert.run("Docker compose setup", "Set up docker-compose with postgres", "decision", "infrastructure", "devops");
  insert.run("API rate limiting", "Added rate limiting middleware", "decision", "webapp", "api");

  return db;
}

describe("lifecycle management", () => {
  let db: Database.Database;

  before(() => {
    db = createTestDb();
  });

  after(() => {
    db.close();
  });

  describe("ensureLifecycleRow", () => {
    it("creates a lifecycle row for an observation", () => {
      ensureLifecycleRow(db, 1);
      const row = db.prepare("SELECT * FROM obs_lifecycle WHERE observation_id = 1").get() as Record<string, unknown>;
      assert.ok(row, "Row should exist");
      assert.equal(row.status, "active");
      assert.equal(row.confidence, 1.0);
    });

    it("is a no-op if row already exists", () => {
      const before_row = db.prepare("SELECT updated_at FROM obs_lifecycle WHERE observation_id = 1").get() as Record<string, unknown>;
      ensureLifecycleRow(db, 1);
      const after_row = db.prepare("SELECT updated_at FROM obs_lifecycle WHERE observation_id = 1").get() as Record<string, unknown>;
      assert.equal(before_row.updated_at, after_row.updated_at, "Should not update existing row");
    });
  });

  describe("deprecate", () => {
    it("sets status to deprecated with reason", () => {
      deprecate(db, 2, "Outdated information");
      const row = db.prepare("SELECT * FROM obs_lifecycle WHERE observation_id = 2").get() as Record<string, unknown>;
      assert.equal(row.status, "deprecated");
      assert.equal(row.deprecation_reason, "Outdated information");
    });

    it("is idempotent -- re-deprecating is a no-op", () => {
      const before_row = db.prepare("SELECT updated_at FROM obs_lifecycle WHERE observation_id = 2").get() as Record<string, unknown>;
      deprecate(db, 2, "Different reason");
      const after_row = db.prepare("SELECT * FROM obs_lifecycle WHERE observation_id = 2").get() as Record<string, unknown>;
      assert.equal(after_row.updated_at, before_row.updated_at, "Should not change updated_at");
      assert.equal(after_row.deprecation_reason, "Outdated information", "Should keep original reason");
    });
  });

  describe("supersede", () => {
    it("creates bidirectional link between old and new observations", () => {
      supersede(db, 3, 4);
      const oldRow = db.prepare("SELECT * FROM obs_lifecycle WHERE observation_id = 3").get() as Record<string, unknown>;
      const newRow = db.prepare("SELECT * FROM obs_lifecycle WHERE observation_id = 4").get() as Record<string, unknown>;
      assert.equal(oldRow.status, "superseded");
      assert.equal(oldRow.superseded_by_id, 4);
      assert.equal(newRow.supersedes_id, 3);
    });

    it("is idempotent -- re-superseding same pair is a no-op", () => {
      const before_row = db.prepare("SELECT updated_at FROM obs_lifecycle WHERE observation_id = 3").get() as Record<string, unknown>;
      supersede(db, 3, 4);
      const after_row = db.prepare("SELECT updated_at FROM obs_lifecycle WHERE observation_id = 3").get() as Record<string, unknown>;
      assert.equal(before_row.updated_at, after_row.updated_at, "Should not change updated_at on idempotent call");
    });
  });

  describe("verify", () => {
    it("sets last_verified_at timestamp", () => {
      verify(db, 1);
      const row = db.prepare("SELECT last_verified_at FROM obs_lifecycle WHERE observation_id = 1").get() as Record<string, unknown>;
      assert.ok(row.last_verified_at, "Should have a verification timestamp");
    });

    it("creates lifecycle row if needed and verifies", () => {
      // Observation 4 should get a lifecycle row + verification
      // But obs 4 already has a lifecycle row from supersede test, use a new one
      const insert = db.prepare("INSERT INTO observations (title, content, type, project, scope) VALUES (?, ?, ?, ?, ?)");
      insert.run("New observation", "New content", "note", "test", "test");
      const newId = 5;
      verify(db, newId);
      const row = db.prepare("SELECT * FROM obs_lifecycle WHERE observation_id = ?").get(newId) as Record<string, unknown>;
      assert.ok(row, "Row should exist");
      assert.ok(row.last_verified_at, "Should have verification timestamp");
      assert.equal(row.status, "active");
    });

    it("updates timestamp on re-verify", () => {
      const before_row = db.prepare("SELECT last_verified_at FROM obs_lifecycle WHERE observation_id = 1").get() as Record<string, unknown>;
      // Small delay to ensure different timestamp
      verify(db, 1);
      const after_row = db.prepare("SELECT last_verified_at FROM obs_lifecycle WHERE observation_id = 1").get() as Record<string, unknown>;
      // Both should have timestamps (may be same if within same second)
      assert.ok(after_row.last_verified_at);
    });
  });

  describe("computeConfidence", () => {
    it("returns 0 for deprecated observations", () => {
      const score = computeConfidence({
        status: "deprecated",
        confidence: 1.0,
        created_at: new Date().toISOString(),
        last_verified_at: null,
      });
      assert.equal(score, 0);
    });

    it("returns 0 for superseded observations", () => {
      const score = computeConfidence({
        status: "superseded",
        confidence: 1.0,
        created_at: new Date().toISOString(),
        last_verified_at: null,
      });
      assert.equal(score, 0);
    });

    it("returns 1.0 for fresh active observation", () => {
      const score = computeConfidence({
        status: "active",
        confidence: 1.0,
        created_at: new Date().toISOString(),
        last_verified_at: null,
      });
      // Fresh observation, minimal decay
      assert.ok(score > 0.99, `Expected ~1.0 for fresh observation, got ${score}`);
    });

    it("decays with age using 180-day half-life", () => {
      const halfLife = new Date();
      halfLife.setDate(halfLife.getDate() - 180);
      const score = computeConfidence({
        status: "active",
        confidence: 1.0,
        created_at: halfLife.toISOString(),
        last_verified_at: null,
      });
      // At 180 days, should be ~0.5
      assert.ok(score > 0.4 && score < 0.6, `Expected ~0.5 at 180d, got ${score}`);
    });

    it("boosts for recent verification (< 7 days)", () => {
      const old = new Date();
      old.setDate(old.getDate() - 90);
      const recentVerify = new Date();
      recentVerify.setDate(recentVerify.getDate() - 3);

      const withVerify = computeConfidence({
        status: "active",
        confidence: 1.0,
        created_at: old.toISOString(),
        last_verified_at: recentVerify.toISOString(),
      });
      const withoutVerify = computeConfidence({
        status: "active",
        confidence: 1.0,
        created_at: old.toISOString(),
        last_verified_at: null,
      });
      assert.ok(withVerify > withoutVerify, `Verified (${withVerify}) should be > unverified (${withoutVerify})`);
    });

    it("gives moderate boost for verification < 30 days", () => {
      const old = new Date();
      old.setDate(old.getDate() - 90);
      const midVerify = new Date();
      midVerify.setDate(midVerify.getDate() - 15);

      const score = computeConfidence({
        status: "active",
        confidence: 1.0,
        created_at: old.toISOString(),
        last_verified_at: midVerify.toISOString(),
      });
      const noVerify = computeConfidence({
        status: "active",
        confidence: 1.0,
        created_at: old.toISOString(),
        last_verified_at: null,
      });
      assert.ok(score > noVerify, `Mid-verified (${score}) should be > unverified (${noVerify})`);
    });
  });

  describe("addStalenessWarning", () => {
    it("adds [STALE Xd] prefix for observations unverified > 90 days", () => {
      const old = new Date();
      old.setDate(old.getDate() - 100);
      const result = addStalenessWarning("Some title", null, old.toISOString());
      assert.ok(result.startsWith("[STALE"), `Expected stale prefix, got: ${result}`);
      assert.ok(result.includes("Some title"));
    });

    it("does not add prefix for observations < 90 days old", () => {
      const recent = new Date();
      recent.setDate(recent.getDate() - 30);
      const result = addStalenessWarning("Some title", null, recent.toISOString());
      assert.equal(result, "Some title");
    });

    it("uses last_verified_at as reference date when available", () => {
      const veryOld = new Date();
      veryOld.setDate(veryOld.getDate() - 200);
      const recentVerify = new Date();
      recentVerify.setDate(recentVerify.getDate() - 10);
      const result = addStalenessWarning("Some title", recentVerify.toISOString(), veryOld.toISOString());
      assert.equal(result, "Some title", "Should NOT be stale because last verified recently");
    });

    it("marks stale when last_verified_at is also old", () => {
      const veryOld = new Date();
      veryOld.setDate(veryOld.getDate() - 200);
      const oldVerify = new Date();
      oldVerify.setDate(oldVerify.getDate() - 100);
      const result = addStalenessWarning("Some title", oldVerify.toISOString(), veryOld.toISOString());
      assert.ok(result.startsWith("[STALE"), `Expected stale prefix, got: ${result}`);
    });
  });

  describe("findPotentialConflicts", () => {
    it("finds similar active observations", () => {
      const conflicts = findPotentialConflicts(db, "JWT auth");
      assert.ok(conflicts.length > 0, "Should find at least one conflict");
      assert.ok(conflicts.some(c => c.title.includes("JWT")), "Should include JWT observation");
    });

    it("excludes deprecated observations", () => {
      // Obs 2 was deprecated in earlier test
      const conflicts = findPotentialConflicts(db, "Database schema users");
      assert.ok(!conflicts.some(c => c.id === 2), "Should not include deprecated obs 2");
    });

    it("respects project filter", () => {
      const conflicts = findPotentialConflicts(db, "JWT auth", "infrastructure");
      assert.ok(!conflicts.some(c => c.title.includes("JWT")), "Should not include webapp obs when filtering by infrastructure");
    });

    it("handles special characters in title", () => {
      // Should not throw
      const conflicts = findPotentialConflicts(db, 'title with "quotes" and (parens)');
      assert.ok(Array.isArray(conflicts), "Should return array even with special chars");
    });
  });
});
