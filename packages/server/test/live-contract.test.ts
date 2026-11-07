import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { confirmedOwnerSettings, readLooseSnapshot, ownerMoney } from '../../domain/src/index.ts';
import { migrate, openDatabase } from '../src/db.ts';
import { handleAuthAction } from '../src/live/auth.ts';
import { applyLiveFixture } from '../src/live/apply.ts';
import { canonicalCode, sha256Hex } from '../src/live/codes.ts';
import { handleLiveRequest } from '../src/live/http.ts';
import { SoftwareAuthenticator } from './authenticator.ts';

const ORIGIN = 'http://localhost:41773';
const config = { rpId: 'localhost', origins: [ORIGIN] };

async function fixture() {
  const db = await openDatabase(undefined, { pgcrypto: true });
  expect(await applyLiveFixture(db)).toBe('created');
  expect(await applyLiveFixture(db)).toBe('existing');
  return db;
}

async function session(db: Awaited<ReturnType<typeof fixture>>, token = 'session-token-with-enough-length-0001') {
  await db.query(`insert into ours_sessions (token_hash, expires_at, via) values ($1, now() + interval '2 days', 'test')`, [await sha256Hex(token)]);
  return token;
}

describe('live contract', () => {
  it('does not treat server fallbacks as saved settings', () => {
    expect(confirmedOwnerSettings('unavailable')).toEqual({
      weeklyTarget: null,
      tithingPercent: null,
      tithingCategory: null,
      confirmationAvailable: false,
    });
    expect(confirmedOwnerSettings({ weekly_target: null, tithing_percent: null, tithing_category: null }).tithingPercent).toBeNull();
    expect(confirmedOwnerSettings({ weekly_target: 80, tithing_percent: 8, tithing_category: 'Giving' })).toMatchObject({
      weeklyTarget: 80,
      tithingPercent: 8,
      tithingCategory: 'Giving',
    });
    const unknown = ownerMoney({ now: new Date('2026-11-05T18:00:00Z'), tithingPercent: null, weeklyTarget: null, transactions: null, rules: [] });
    expect(unknown.tithing.label).toBe('Set a percent');
    expect(unknown.weekNetSpendCents).toBeNull();
  });

  it('rejects an unrecognized snapshot instead of inventing earnings', () => {
    const loose = readLooseSnapshot({ accounts: [{ name: 'Sample Checking', balance: 10 }], transactions: [{ name: 'Payroll', amount: 2400 }] });
    expect(loose.accounts).toEqual([{ label: 'Sample Checking', amount: 10, kind: null }]);
    expect(loose.recognizedTransactions).toBeNull();
    const recognized = readLooseSnapshot({
      accounts: [{ label: 'Sample Checking' }],
      transactions: [{ externalId: 'pay', postedOn: '2026-11-04', amountCents: 240000, direction: 'inflow', providerKind: 'income', merchantLabel: 'Sample Payroll' }],
    });
    const money = ownerMoney({
      now: new Date('2026-11-05T18:00:00Z'),
      tithingPercent: 10,
      weeklyTarget: 80,
      transactions: recognized.recognizedTransactions,
      rules: [],
    });
    expect(money.tithing.label).toBe('Still to pay $240.00');
    expect(money.weekNetSpendCents).toBe(0);
  });

  it('keeps custom data, retains five snapshots, and closes only open refresh requests', async () => {
    const db = await fixture();
    const token = await session(db);
    const key = 'fixture-uploader-key-not-a-secret';
    await db.query(`insert into ours_settings(key, value) values ('uploader_key_hash', to_jsonb($1::text))`, [await sha256Hex(key)]);
    await db.query(`select ours_save_custom_item($1, $2::jsonb)`, [token, JSON.stringify({ name: 'Sample bicycle', kind: 'asset', value: 120 })]);
    await db.query(`select ours_save_fix_rule($1, $2, $3)`, [token, 'north market', 'Groceries']);
    await db.query(`select ours_request_refresh($1)`, [token]);
    await expect(db.query(`select ours_admin_upload_snapshot($1, now(), '{"accounts":[]}'::jsonb, '{}'::jsonb)`, [key])).rejects.toThrow(/no accounts/);
    const presence = await db.query<{ result: { tithing_percent: unknown; weekly_target: unknown } }>(`select ours_settings_presence($1) as result`, [token]);
    expect(presence.rows[0]?.result.tithing_percent).toBeNull();
    expect(presence.rows[0]?.result.weekly_target).toBeNull();
    const state = await db.query<{ result: { settings: { tithing_percent: number } } }>(`select ours_get_state($1) as result`, [token]);
    expect(state.rows[0]?.result.settings.tithing_percent).toBe(10);

    for (let index = 0; index < 6; index += 1) {
      await db.query(
        `select ours_admin_upload_snapshot($1, $2::timestamptz, $3::jsonb, '{"ok":true}'::jsonb)`,
        [key, new Date(Date.UTC(2026, 10, index + 1)).toISOString(), JSON.stringify({ accounts: [{ label: 'Sample Checking' }], marker: index })],
      );
    }
    const kept = await db.query<{ count: number; oldest: number }>(`select count(*)::int as count, min(id)::int as oldest from ours_snapshots`);
    expect(kept.rows[0]?.count).toBe(5);
    expect(kept.rows[0]?.oldest).toBe(2);
    const custom = await db.query(`select name from ours_custom_items`);
    expect(custom.rows).toEqual([{ name: 'Sample bicycle' }]);
    const open = await db.query(`select id from ours_refresh_requests where status = 'open'`);
    expect(open.rows).toHaveLength(0);
    const done = await db.query<{ note: string }>(`select note from ours_refresh_requests where status = 'done'`);
    expect(done.rows[0]?.note).toMatch(/^snapshot /);

    await db.query(`select ours_save_settings($1, '{"tithing_percent":8}'::jsonb)`, [token]);
    const saved = await db.query<{ result: { tithing_percent: number; weekly_target: unknown } }>(`select ours_settings_presence($1) as result`, [token]);
    expect(saved.rows[0]?.result.tithing_percent).toBe(8);
    expect(saved.rows[0]?.result.weekly_target).toBeNull();
  });

  it('requires a session for destructive backup replacement and cleans expired sessions on sign-out', async () => {
    const db = await fixture();
    const token = await session(db);
    await db.query(`insert into ours_backup_codes (code_hash) values ($1)`, [await sha256Hex(canonicalCode('ABCDE-FGHIJ', 5))]);
    await expect(handleAuthAction(db, config, { action: 'new_backup_codes', confirm: true }, ORIGIN, new Date())).rejects.toThrow(/Not signed in/);
    const still = await db.query(`select id from ours_backup_codes`);
    expect(still.rows).toHaveLength(1);
    const replaced = await handleAuthAction(db, config, { action: 'new_backup_codes', token, confirm: true }, ORIGIN, new Date()) as { codes: string[] };
    expect(replaced.codes).toHaveLength(10);
    const old = await db.query(`select id from ours_backup_codes where code_hash = $1`, [await sha256Hex(canonicalCode('ABCDE-FGHIJ', 5))]);
    expect(old.rows).toHaveLength(0);

    const login = await handleAuthAction(db, config, { action: 'backup_login', code: replaced.codes[0] }, ORIGIN, new Date()) as { session: { token: string } };
    await expect(handleAuthAction(db, config, { action: 'backup_login', code: replaced.codes[0] }, ORIGIN, new Date())).rejects.toThrow(/already used/);
    await db.query(`insert into ours_sessions (token_hash, expires_at, via) values ($1, now() - interval '1 hour', 'old')`, [await sha256Hex('expired-session-token-with-enough-length')]);
    await db.query(`select ours_sign_out($1)`, [login.session.token]);
    const sessions = await db.query(`select via from ours_sessions order by via`);
    expect(sessions.rows.map((row) => row.via)).toEqual(['test']);
  });

  it('binds passkey enrollment to a setup code or session and rejects replay and a bad origin', async () => {
    const db = await fixture();
    const now = new Date('2026-11-05T18:00:00Z');
    const code = 'ABCD-EFGH-JKMN';
    await db.query(`insert into ours_device_setup_codes (code_hash, expires_at) values ($1, $2)`, [await sha256Hex(code), new Date(now.getTime() + 86_400_000).toISOString()]);
    await expect(handleAuthAction(db, config, { action: 'reg_options' }, ORIGIN, now)).rejects.toThrow(/isn't valid/);
    await expect(handleAuthAction(db, config, { action: 'auth_options' }, 'https://evil.example', now)).rejects.toThrow(/not allowed/);

    const started = await handleAuthAction(db, config, { action: 'reg_options', code }, ORIGIN, now) as { challengeId: string; options: Parameters<SoftwareAuthenticator['register']>[0] };
    const authenticator = new SoftwareAuthenticator();
    const credential = await authenticator.register(started.options, ORIGIN);
    const enrolled = await handleAuthAction(db, config, { action: 'reg_verify', challengeId: started.challengeId, credential, deviceName: 'Test phone' }, ORIGIN, now) as { session: { token: string } };
    expect(enrolled.session.token.length).toBeGreaterThan(30);
    await expect(handleAuthAction(db, config, { action: 'reg_verify', challengeId: started.challengeId, credential }, ORIGIN, now)).rejects.toThrow(/expired/);

    const authStart = await handleAuthAction(db, config, { action: 'auth_options' }, ORIGIN, now) as { challengeId: string; options: Parameters<SoftwareAuthenticator['authenticate']>[0] };
    const unverified = await authenticator.authenticate(authStart.options, ORIGIN, undefined, false);
    await expect(handleAuthAction(db, config, { action: 'auth_verify', challengeId: authStart.challengeId, credential: unverified }, ORIGIN, now)).rejects.toThrow(/Passkey check failed/);
    const again = await handleAuthAction(db, config, { action: 'auth_options' }, ORIGIN, now) as { challengeId: string; options: Parameters<SoftwareAuthenticator['authenticate']>[0] };
    const assertion = await authenticator.authenticate(again.options, ORIGIN);
    const signedIn = await handleAuthAction(db, config, { action: 'auth_verify', challengeId: again.challengeId, credential: assertion }, ORIGIN, now) as { ok: boolean };
    expect(signedIn.ok).toBe(true);
    await expect(handleAuthAction(db, config, { action: 'auth_verify', challengeId: again.challengeId, credential: assertion }, ORIGIN, now)).rejects.toThrow(/expired/);

    const creds = await db.query(`select id from ours_passkey_credentials`);
    expect(creds.rows).toHaveLength(1);
    await expect(db.query(`select ours_delete_passkey($1, $2)`, [enrolled.session.token, (creds.rows[0] as { id: string }).id])).rejects.toThrow(/only passkey/);
  });

  it('hides tables from anon and does not let the greenfield script replace a live-shaped database', async () => {
    const db = await fixture();
    await db.query(`insert into ours_snapshots (as_of, data, report) values (now(), '{"accounts":[{"label":"Sample"}]}'::jsonb, '{}'::jsonb)`);
    await db.exec(`grant anon to current_user`);
    await db.exec('set role anon');
    await expect(db.query('select id from ours_snapshots')).rejects.toThrow();
    await expect(db.query(`select ours_get_state('nope')`)).rejects.toThrow(/not signed in/);
    await db.exec('reset role');
    await expect(migrate(db)).rejects.toThrow(/left untouched/);
    const still = await db.query(`select data->>'accounts' is not null as ok from ours_snapshots`);
    expect(still.rows).toEqual([{ ok: true }]);
  });

  it('does not echo a foreign origin and does not return household data without a session', async () => {
    const db = await fixture();
    const denied = await handleLiveRequest(new Request('http://127.0.0.1/rest/v1/rpc/ours_get_state', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ p_token: 'x'.repeat(40) }),
    }), db, config, new Date());
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(denied.status).toBe(401);
    const body = await denied.json();
    expect(JSON.stringify(body)).not.toMatch(/balance|merchant|Sample/);
    const preflight = await handleLiveRequest(new Request('http://127.0.0.1/functions/v1/ours-auth', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN },
    }), db, config, new Date());
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('deployed function review notes stay out of the client bundle source', () => {
  it('does not embed a redacted host or the service role header name as a secret store', () => {
    const app = readFileSync(new URL('../../../apps/web/src/App.tsx', import.meta.url), 'utf8');
    expect(app).not.toMatch(/REDACTED|github\.io|SERVICE_ROLE/);
    const sql = readFileSync(new URL('../src/live/functions.sql', import.meta.url), 'utf8');
    for (const name of ['ours_get_state', 'ours_save_custom_item', 'ours_save_fix_rule', 'ours_save_settings', 'ours_admin_upload_snapshot', 'ours_delete_passkey']) {
      const body = sql.slice(sql.indexOf(`function public.${name}`));
      expect(body.slice(0, 800)).toMatch(/ours__require_session|ours__require_uploader/);
    }
    expect(sql).toMatch(/set search_path = public, pg_temp/);
    expect(sql).toMatch(/revoke all on function public\.ours__require_session/);
  });
});
