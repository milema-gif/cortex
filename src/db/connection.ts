import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { log } from "../lib/logger.js";

/**
 * Open the SQLite database with WAL mode verification and required pragmas.
 * Loads the sqlite-vec extension for vector table support.
 * Throws if WAL mode cannot be enabled.
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Load sqlite-vec extension (needed for vector table operations)
  sqliteVec.load(db);

  // Set pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 500");

  // Verify WAL mode is actually enabled
  const journalMode = db.pragma("journal_mode", { simple: true });
  if (journalMode !== "wal") {
    db.close();
    throw new Error(
      `WAL mode required but got '${journalMode}'. Another process may have locked the DB.`
    );
  }

  log("info", `Database opened: ${dbPath} (WAL mode verified)`);
  return db;
}
