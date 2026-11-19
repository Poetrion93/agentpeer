import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storeFromSql, type SqlExec, type Store } from "./db.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function openSchemaSql(): string {
  return readFileSync(join(here, "..", "schema.sql"), "utf8");
}

export function memoryStore(schema = openSchemaSql()): Store {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return storeFromSql(sqliteExec(db));
}

export function sqliteExec(db: DatabaseSync): SqlExec {
  return {
    async run(sql, ...params) {
      const result = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes ?? 0) };
    },
    async first(sql, ...params) {
      const row = db.prepare(sql).get(...(params as never[]));
      return (row as never) ?? null;
    },
    async all(sql, ...params) {
      return db.prepare(sql).all(...(params as never[])) as never;
    },
  };
}
