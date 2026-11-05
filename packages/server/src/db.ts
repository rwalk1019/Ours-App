import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

export { asBool, asDay, asIso, asNumber, asStrings } from './values.js';

export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
};

function lockedDb(client: PGlite): Db {
  let chain = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const inner = (queryable: Queryable, transactional: boolean): Db => ({
    query: (sql, params) =>
      transactional
        ? queryable.query(sql, params).then((result) => ({ rows: result.rows as never[] }))
        : lock(() => queryable.query(sql, params).then((result) => ({ rows: result.rows as never[] }))),
    exec: (sql) => (transactional ? queryable.exec(sql).then(() => undefined) : lock(() => queryable.exec(sql).then(() => undefined))),
    tx: (fn) =>
      transactional
        ? fn(inner(queryable, true))
        : lock(() => client.transaction((tx) => fn(inner(tx, true)))),
  });
  return inner(client, false);
}

export async function openDatabase(dataDir?: string): Promise<Db> {
  const client = new PGlite(dataDir);
  await client.waitReady;
  return lockedDb(client);
}

export async function migrate(db: Db): Promise<void> {
  const existing = await db.query<{ name: string | null }>(`SELECT to_regclass('public.ours_schema_migrations') AS name`);
  if (existing.rows[0]?.name) return;
  const sqlPath = join(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations/0001_ours.sql');
  await db.exec(readFileSync(sqlPath, 'utf8'));
}

