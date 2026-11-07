import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db.js';

const dir = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

/** Creates the live-shaped fixture only when those tables are absent. */
export async function applyLiveFixture(db: Db): Promise<'created' | 'existing'> {
  const passkeys = await db.query<{ name: string | null }>(`select to_regclass('public.ours_passkey_credentials') as name`);
  if (passkeys.rows[0]?.name) return 'existing';
  const settings = await db.query<{ name: string | null }>(`select to_regclass('public.ours_settings') as name`);
  if (settings.rows[0]?.name) {
    throw new Error('refusing to build the live fixture over a different Ours schema');
  }
  await db.exec(read('schema.sql'));
  await db.exec(read('functions.sql'));
  await db.exec(read('../../../../supabase/additive/ours_settings_presence.sql'));
  return 'created';
}
