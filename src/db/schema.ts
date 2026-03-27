import type Database from "better-sqlite3";
import { log } from "../lib/logger.js";

/**
 * Run Cortex-owned schema migrations. Creates tables only for Cortex data.
 * NEVER creates or modifies Engram-owned tables (observations, observations_fts, sessions).
 * Idempotent: safe to call multiple times.
 */
export function runMigrations(db: Database.Database): void {
  // Meta table for version tracking (always create first)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Read current schema version
  const version = (() => {
    try {
      const row = db
        .prepare("SELECT value FROM cortex_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  })();

  if (version < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS obs_lifecycle (
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
        CREATE INDEX IF NOT EXISTS idx_lifecycle_status ON obs_lifecycle(status);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_supersedes ON obs_lifecycle(supersedes_id);

        CREATE TABLE IF NOT EXISTS entities (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL,
          name          TEXT NOT NULL,
          aliases       TEXT,
          first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
          mention_count INTEGER NOT NULL DEFAULT 1,
          UNIQUE(type, name)
        );
        CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
        CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

        CREATE TABLE IF NOT EXISTS relations (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          src_entity_id   INTEGER NOT NULL,
          relation_type   TEXT NOT NULL,
          dst_entity_id   INTEGER NOT NULL,
          weight          REAL NOT NULL DEFAULT 1.0,
          evidence_obs_id INTEGER,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(src_entity_id, relation_type, dst_entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_relations_src ON relations(src_entity_id);
        CREATE INDEX IF NOT EXISTS idx_relations_dst ON relations(dst_entity_id);

        CREATE TABLE IF NOT EXISTS obs_entities (
          observation_id  INTEGER NOT NULL,
          entity_id       INTEGER NOT NULL,
          role            TEXT NOT NULL DEFAULT 'mention',
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (observation_id, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_obs_entities_entity ON obs_entities(entity_id);

        CREATE TABLE IF NOT EXISTS preflight_cache (
          cache_key    TEXT PRIMARY KEY,
          brief        TEXT NOT NULL,
          obs_ids      TEXT NOT NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at   TEXT NOT NULL
        );

        INSERT OR REPLACE INTO cortex_meta(key, value) VALUES('schema_version', '1');
      `);
    })();

    log("info", "Schema migration v1 applied");
  }

  // Re-read version after v1 migration
  const version2 = (() => {
    try {
      const row = db
        .prepare("SELECT value FROM cortex_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  })();

  if (version2 < 2) {
    db.transaction(() => {
      // Add brief_hash column to preflight_cache for efficient dedup comparison
      // Check if column exists first (SQLite has no IF NOT EXISTS for ALTER TABLE)
      const columns = db
        .prepare("PRAGMA table_info(preflight_cache)")
        .all() as Array<{ name: string }>;
      const hasBriefHash = columns.some((c) => c.name === "brief_hash");
      if (!hasBriefHash) {
        db.exec(
          `ALTER TABLE preflight_cache ADD COLUMN brief_hash TEXT NOT NULL DEFAULT ''`
        );
      }

      db.exec(
        `INSERT OR REPLACE INTO cortex_meta(key, value) VALUES('schema_version', '2')`
      );
    })();

    log("info", "Schema migration v2 applied (preflight_cache brief_hash)");
  }

  // Re-read version after v2 migration
  const version3 = (() => {
    try {
      const row = db
        .prepare("SELECT value FROM cortex_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  })();

  if (version3 < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_failures (
          observation_id   INTEGER PRIMARY KEY,
          attempt_count    INTEGER NOT NULL DEFAULT 1,
          last_error       TEXT NOT NULL,
          last_attempt_at  TEXT NOT NULL DEFAULT (datetime('now')),
          first_failed_at  TEXT NOT NULL DEFAULT (datetime('now')),
          status           TEXT NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','parked'))
        );
        CREATE INDEX IF NOT EXISTS idx_sync_failures_status ON sync_failures(status);
      `);

      db.exec(
        `INSERT OR REPLACE INTO cortex_meta(key, value) VALUES('schema_version', '3')`
      );
    })();

    log("info", "Schema migration v3 applied (sync_failures table)");
  }
}
