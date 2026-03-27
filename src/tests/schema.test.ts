import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("schema", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-schema-"));
  const dbPath = path.join(tmpDir, "test.db");

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("runMigrations() creates all 7 Cortex-owned tables", () => {
    const db = openDatabase(dbPath);
    runMigrations(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cortex_meta','obs_lifecycle','entities','relations','obs_entities','preflight_cache','sync_failures') ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name).sort();
    assert.deepEqual(tableNames, [
      "cortex_meta",
      "entities",
      "obs_entities",
      "obs_lifecycle",
      "preflight_cache",
      "relations",
      "sync_failures",
    ]);
    db.close();
  });

  it("runMigrations() is idempotent (running twice does not error)", () => {
    const db = openDatabase(dbPath);
    // Should not throw on second run
    runMigrations(db);
    runMigrations(db);

    const version = db
      .prepare("SELECT value FROM cortex_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(version.value, "3");
    db.close();
  });

  it("runMigrations() does NOT create Engram-owned tables", () => {
    const db = openDatabase(dbPath);
    runMigrations(db);

    const engramTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observations','observations_fts','sessions')"
      )
      .all();

    assert.equal(engramTables.length, 0, "Should not create observations, observations_fts, or sessions tables");
    db.close();
  });

  it("obs_lifecycle has CHECK constraints on status and confidence", () => {
    const db = openDatabase(dbPath);
    runMigrations(db);

    // Valid insert should work
    db.prepare(
      "INSERT INTO obs_lifecycle (observation_id, status, confidence) VALUES (1, 'active', 0.8)"
    ).run();

    // Invalid status should fail
    assert.throws(
      () => {
        db.prepare(
          "INSERT INTO obs_lifecycle (observation_id, status, confidence) VALUES (2, 'invalid_status', 0.5)"
        ).run();
      },
      /CHECK/i,
      "Invalid status should trigger CHECK constraint"
    );

    // Invalid confidence should fail
    assert.throws(
      () => {
        db.prepare(
          "INSERT INTO obs_lifecycle (observation_id, status, confidence) VALUES (3, 'active', 1.5)"
        ).run();
      },
      /CHECK/i,
      "Confidence > 1.0 should trigger CHECK constraint"
    );

    db.close();
  });

  it("entities table has UNIQUE(type, name) constraint", () => {
    const db = openDatabase(dbPath);
    runMigrations(db);

    db.prepare("INSERT INTO entities (type, name) VALUES ('project', 'cortex')").run();

    assert.throws(
      () => {
        db.prepare("INSERT INTO entities (type, name) VALUES ('project', 'cortex')").run();
      },
      /UNIQUE/i,
      "Duplicate (type, name) should trigger UNIQUE constraint"
    );

    db.close();
  });
});
