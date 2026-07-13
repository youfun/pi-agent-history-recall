/**
 * Minimal SQLite adapter that works under Bun (bun:sqlite) and Node (node:sqlite).
 */
import { createRequire } from "node:module";

export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

const require = createRequire(import.meta.url);

export function openDatabase(path: string): SqlDatabase {
  // Prefer bun:sqlite when Bun runtime is present.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    try {
      const bunSqlite = require("bun:sqlite") as {
        Database: new (
          path: string,
          opts?: { create?: boolean },
        ) => {
          exec(sql: string): void;
          prepare(sql: string): {
            run(...params: unknown[]): unknown;
            get(...params: unknown[]): unknown;
            all(...params: unknown[]): unknown[];
          };
          close(): void;
        };
      };
      const db = new bunSqlite.Database(path, { create: true });
      return wrap(db);
    } catch {
      // fall through to node:sqlite
    }
  }

  try {
    const nodeSqlite = require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
          get(...params: unknown[]): unknown;
          all(...params: unknown[]): unknown[];
        };
        close(): void;
      };
    };
    const db = new nodeSqlite.DatabaseSync(path);
    return wrap(db);
  } catch (err) {
    throw new Error(
      `No SQLite backend available (need bun:sqlite or node:sqlite): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function wrap(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}): SqlDatabase {
  return {
    exec: (sql: string) => {
      db.exec(sql);
    },
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params) as unknown[],
      };
    },
    close: () => {
      db.close();
    },
  };
}
