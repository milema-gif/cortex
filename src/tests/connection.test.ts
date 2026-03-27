import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db/connection.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("connection", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-test-"));
  const dbPath = path.join(tmpDir, "test.db");

  after(() => {
    // Clean up temp files
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("openDatabase() creates a database in WAL mode", () => {
    const db = openDatabase(dbPath);
    const mode = db.pragma("journal_mode", { simple: true });
    assert.equal(mode, "wal", "journal_mode should be WAL");
    db.close();
  });

  it("openDatabase() sets busy_timeout=5000", () => {
    const db = openDatabase(dbPath);
    const timeout = db.pragma("busy_timeout", { simple: true });
    assert.equal(timeout, 5000, "busy_timeout should be 5000");
    db.close();
  });

  it("openDatabase() sets synchronous=NORMAL", () => {
    const db = openDatabase(dbPath);
    // synchronous=1 is NORMAL
    const sync = db.pragma("synchronous", { simple: true });
    assert.equal(sync, 1, "synchronous should be 1 (NORMAL)");
    db.close();
  });

  it("openDatabase() sets wal_autocheckpoint=500", () => {
    const db = openDatabase(dbPath);
    const checkpoint = db.pragma("wal_autocheckpoint", { simple: true });
    assert.equal(checkpoint, 500, "wal_autocheckpoint should be 500");
    db.close();
  });
});
