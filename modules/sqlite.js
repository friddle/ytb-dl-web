// SQLite handle shim.
//
// The container runs Node 22, which ships a built-in SQLite driver
// (node:sqlite) — no native compilation needed during docker build. Local
// development machines may run Node 20 (no node:sqlite), so we fall back to
// better-sqlite3 when the builtin is unavailable. Both expose the same
// prepare()/run/get/all surface; this wrapper also mimics the small
// better-sqlite3 extras db.js relies on (pragma(), transaction()).
import fs from "fs";
import path from "path";

let DatabaseImpl;

try {
  const { DatabaseSync } = await import("node:sqlite");

  DatabaseImpl = class Database {
    constructor(filePath) {
      this._db = new DatabaseSync(filePath);
    }
    exec(sql) {
      this._db.exec(sql);
    }
    pragma(statement) {
      this._db.exec(`PRAGMA ${statement}`);
    }
    prepare(sql) {
      const stmt = this._db.prepare(sql);
      return {
        run: (...args) => stmt.run(...args),
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args)
      };
    }
    transaction(fn) {
      return (...args) => {
        this._db.exec("BEGIN");
        try {
          const result = fn(...args);
          this._db.exec("COMMIT");
          return result;
        } catch (err) {
          this._db.exec("ROLLBACK");
          throw err;
        }
      };
    }
    close() {
      this._db.close();
    }
  };
} catch {
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  DatabaseImpl = BetterSqlite3;
}

// Ensures the database directory exists before opening the file.
export function ensureDbDir(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

export default DatabaseImpl;
