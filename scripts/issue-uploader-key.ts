import { openDatabase } from '../packages/server/src/db.ts';
import { applyLiveFixture } from '../packages/server/src/live/apply.ts';
import { sha256Hex } from '../packages/server/src/live/codes.ts';
import { randomBytes, base64url } from '../packages/server/src/crypto.ts';

if (process.env.OURS_ENV === 'production') {
  console.error('Refusing to rotate the live uploader key from this command.');
  process.exit(1);
}

const db = await openDatabase('.data/live', { pgcrypto: true });
await applyLiveFixture(db);
const key = base64url(randomBytes(32));
await db.query(
  `insert into ours_settings(key, value) values ('uploader_key_hash', to_jsonb($1::text))
   on conflict (key) do update set value = excluded.value, updated_at = now()`,
  [await sha256Hex(key)],
);
process.stdout.write(`${key}\n`);
