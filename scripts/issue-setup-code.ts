import { openDatabase } from '../packages/server/src/db.ts';
import { applyLiveFixture } from '../packages/server/src/live/apply.ts';
import { randomGroupedCode, sha256Hex } from '../packages/server/src/live/codes.ts';

if (process.env.OURS_ENV === 'production') {
  console.error('Refusing to write a setup code into a production database from this command.');
  process.exit(1);
}

const db = await openDatabase('.data/live', { pgcrypto: true });
await applyLiveFixture(db);
const code = randomGroupedCode(3, 4);
const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
await db.query(`insert into ours_device_setup_codes (code_hash, expires_at) values ($1, $2)`, [await sha256Hex(code), expires]);
process.stdout.write(`${code}\n`);
