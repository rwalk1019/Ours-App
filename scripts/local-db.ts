import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { base64url, randomBytes } from '../packages/server/src/crypto.ts';
import { loadConfigFromEnv } from '../packages/server/src/config.ts';
import { migrate, openDatabase } from '../packages/server/src/db.ts';

export async function openLocal() {
  if (process.env.OURS_ENV === 'production') {
    throw new Error('Refusing to open the local development database with OURS_ENV=production');
  }
  mkdirSync('.data', { recursive: true });
  const pepperPath = '.data/pepper';
  if (!process.env.OURS_CODE_PEPPER) {
    if (!existsSync(pepperPath)) writeFileSync(pepperPath, base64url(randomBytes(32)), { mode: 0o600 });
    process.env.OURS_CODE_PEPPER = readFileSync(pepperPath, 'utf8').trim();
  }
  const config = loadConfigFromEnv({ ...process.env, OURS_ENV: 'development' });
  const db = await openDatabase('.data/pglite');
  await migrate(db);
  return { db, config };
}
