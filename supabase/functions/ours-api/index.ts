import postgres from 'npm:postgres@3.4.7';
import { handle } from '../../../packages/server/src/app.ts';
import { loadConfigFromEnv } from '../../../packages/server/src/config.ts';
import type { Db } from '../../../packages/server/src/db.ts';

declare const Deno: {
  env: { toObject(): Record<string, string | undefined> };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

const env = Deno.env.toObject();
const databaseUrl = env.OURS_DATABASE_URL;
if (!databaseUrl) throw new Error('OURS_DATABASE_URL is required');
if (env.OURS_ENV !== 'production') throw new Error('OURS_ENV must be production for the edge function');

const sql = postgres(databaseUrl, { prepare: false, max: 1, ssl: 'require' });
const database: Db = {
  async query(text, params) {
    const rows = await sql.unsafe(text, (params ?? []) as never[]);
    return { rows: rows as never[] };
  },
  async exec(text) {
    await sql.unsafe(text);
  },
  async tx(fn) {
    return sql.begin(async (transaction) => {
      const scoped: Db = {
        async query(text, params) {
          const rows = await transaction.unsafe(text, (params ?? []) as never[]);
          return { rows: rows as never[] };
        },
        async exec(text) {
          await transaction.unsafe(text);
        },
        tx(inner) {
          return inner(scoped);
        },
      };
      return fn(scoped);
    });
  },
};

const config = loadConfigFromEnv(env);
Deno.serve((request) => handle(request, { db: database, config, now: () => new Date() }));
