import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle, type AppContext } from '../src/app.ts';
import { loadConfigFromEnv } from '../src/config.ts';
import { migrate, openDatabase, type Db } from '../src/db.ts';
import { issueDeviceSetupCode, issueImportToken, issueReportToken } from '../src/repository.ts';
import { SoftwareAuthenticator } from './authenticator.ts';

const ORIGIN = 'http://localhost:41773';
const PEPPER = 'dev-only-test-pepper-0123456789abcd';
let db: Db;
let now = new Date('2026-11-05T18:00:00Z');

const ctx: AppContext = {
  get db() {
    return db;
  },
  config: loadConfigFromEnv({
    OURS_ENV: 'development',
    OURS_CODE_PEPPER: PEPPER,
    OURS_RP_ID: 'localhost',
    OURS_ORIGINS: ORIGIN,
    OURS_COOKIE_SECURE: 'false',
    OURS_APP_ORIGIN: 'https://ours.example',
  }),
  now: () => now,
};

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
});

beforeEach(async () => {
  now = new Date('2026-11-05T18:00:00Z');
  await db.query(
    `UPDATE ours_settings SET tithing_bps = NULL, webauthn_user_handle = NULL, current_snapshot_id = NULL,
     last_import_completed_at = NULL, last_failure_at = NULL, last_failure_code = NULL`,
  );
  await db.exec(`
    DELETE FROM ours_sessions;
    DELETE FROM ours_challenges;
    DELETE FROM ours_balances;
    DELETE FROM ours_transactions;
    DELETE FROM ours_refresh_requests;
    DELETE FROM ours_targets;
    DELETE FROM ours_fix_rules;
    DELETE FROM ours_custom_items;
    DELETE FROM ours_tithing_payments;
    DELETE FROM ours_tithing_coverage;
    DELETE FROM ours_report_runs;
    DELETE FROM ours_auth_attempts;
    DELETE FROM ours_credentials;
    DELETE FROM ours_setup_codes;
    DELETE FROM ours_import_credentials;
    DELETE FROM ours_report_credentials;
    DELETE FROM ours_accounts;
    DELETE FROM ours_snapshots;
  `);
});

function call(path: string, init: { method?: string; body?: unknown; cookie?: string; token?: string; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-ours-request': '1' });
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  if (init.cookie) headers.set('cookie', `ours_session=${init.cookie}`);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return handle(
    new Request(`http://127.0.0.1:41774${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    ctx,
  );
}

function sessionOf(response: Response): string {
  const match = /ours_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '');
  if (!match?.[1]) throw new Error('missing session cookie');
  return match[1];
}

async function registerDevice(code?: string) {
  const setupCode = code ?? (await issueDeviceSetupCode(db, PEPPER, 1800, now));
  const begin = await call('/api/auth/setup/begin', { body: { code: setupCode } });
  expect(begin.status).toBe(200);
  const started = (await begin.json()) as { options: Parameters<SoftwareAuthenticator['register']>[0] };
  const authenticator = new SoftwareAuthenticator();
  const registration = await authenticator.register(started.options, ORIGIN);
  const finish = await call('/api/auth/register/finish', { body: { response: registration, deviceLabel: 'Test phone' } });
  expect(finish.status, JSON.stringify(await finish.clone().json())).toBe(200);
  const body = (await finish.json()) as { recoveryCodes: string[] | null };
  return { authenticator, cookie: sessionOf(finish), recoveryCodes: body.recoveryCodes ?? [] };
}

function snapshot(asOf: string, transactions: Record<string, unknown>[]) {
  return {
    format: 'ours.snapshot',
    version: 1,
    balancesAsOf: asOf,
    accounts: [
      { externalId: 'checking', label: 'Sample Checking', kind: 'depository', currency: 'USD' },
      { externalId: 'savings', label: 'Sample Savings', kind: 'depository', currency: 'USD' },
      { externalId: 'credit', label: 'Sample Credit', kind: 'credit', currency: 'USD' },
    ],
    balances: [
      { accountExternalId: 'checking', asOf, assetCents: 300_000, owedCents: 0, availableCents: null, note: null },
      { accountExternalId: 'savings', asOf, assetCents: 100_000, owedCents: 0, availableCents: null, note: null },
      { accountExternalId: 'credit', asOf, assetCents: 0, owedCents: 20_000, availableCents: null, note: null },
    ],
    transactions,
  };
}

const payroll = {
  externalId: 'pay',
  accountExternalId: 'checking',
  postedOn: '2026-11-04',
  postedAt: '2026-11-04T16:00:00Z',
  amountCents: 240_000,
  direction: 'inflow',
  pending: false,
  voided: false,
  merchantLabel: 'Sample Payroll',
  description: null,
  providerKind: 'income',
  replacesExternalId: null,
};

describe('passkeys, authorization, and replay', () => {
  it('rejects locked reads, setup reuse, challenge replay, bad origins, and cloned counters', async () => {
    const locked = await call('/api/household');
    expect(locked.status).toBe(401);
    const lockedBody = await locked.json();
    expect(lockedBody).toEqual({ error: 'locked' });
    expect(JSON.stringify(lockedBody)).not.toMatch(/Sample|Payroll|\$|balance/i);

    const status = await call('/api/auth/status');
    expect(await status.json()).toEqual({ state: 'setup_required' });

    const { authenticator, cookie, recoveryCodes } = await registerDevice();
    expect(recoveryCodes).toHaveLength(8);
    expect((await call('/api/auth/status')).status).toBe(200);

    const again = await call('/api/auth/setup/begin', { body: { code: 'not-a-real-code' } });
    expect(again.status).toBe(401);

    const household = await call('/api/household', { cookie });
    expect(household.status).toBe(200);
    const home = await household.json();
    expect(home.tithing.state).toBe('unconfigured');
    expect(home.tithing.dueCents).toBeNull();
    expect(JSON.stringify(home.tithing)).not.toMatch(/Still to pay/);

    const begin = await call('/api/auth/authenticate/begin', { body: {} });
    const started = (await begin.json()) as { options: Parameters<SoftwareAuthenticator['authenticate']>[0] };
    expect(JSON.stringify(started)).not.toMatch(/publicKey|merchant|balance|amountCents/i);
    const assertion = await authenticator.authenticate(started.options, ORIGIN);
    const first = await call('/api/auth/authenticate/finish', { body: { response: assertion } });
    expect(first.status).toBe(200);
    const replay = await call('/api/auth/authenticate/finish', { body: { response: assertion } });
    expect(replay.status).toBe(401);

    const evilBegin = await call('/api/auth/authenticate/begin', { body: {} });
    const evilOptions = (await evilBegin.json()) as { options: Parameters<SoftwareAuthenticator['authenticate']>[0] };
    const evilAssertion = await authenticator.authenticate(evilOptions.options, 'https://evil.example');
    const evil = await call('/api/auth/authenticate/finish', { body: { response: evilAssertion }, origin: 'https://evil.example' });
    expect(evil.status).toBe(403);

    const staleBegin = await call('/api/auth/authenticate/begin', { body: {} });
    const staleOptions = (await staleBegin.json()) as { options: Parameters<SoftwareAuthenticator['authenticate']>[0] };
    const staleAssertion = await authenticator.authenticate(staleOptions.options, ORIGIN);
    now = new Date(now.getTime() + 5 * 60 * 1000);
    const stale = await call('/api/auth/authenticate/finish', { body: { response: staleAssertion } });
    expect(stale.status).toBe(401);
    now = new Date('2026-11-05T18:00:00Z');

    const cloneBegin = await call('/api/auth/authenticate/begin', { body: {} });
    const cloneOptions = (await cloneBegin.json()) as { options: Parameters<SoftwareAuthenticator['authenticate']>[0] };
    const cloned = await authenticator.authenticate(cloneOptions.options, ORIGIN, 1);
    const cloneResponse = await call('/api/auth/authenticate/finish', { body: { response: cloned } });
    expect(cloneResponse.status).toBe(401);
    expect(await cloneResponse.json()).toEqual({ error: 'credential_unusable' });

    const recoveryCode = recoveryCodes[0] ?? '';
    const recoveryBegin = await call('/api/auth/recovery/begin', { body: { code: recoveryCode } });
    expect(recoveryBegin.status).toBe(200);
    const recoveryOptions = (await recoveryBegin.json()) as { options: Parameters<SoftwareAuthenticator['register']>[0] };
    const second = new SoftwareAuthenticator();
    const secondRegistration = await second.register(recoveryOptions.options, ORIGIN);
    const secondFinish = await call('/api/auth/register/finish', { body: { response: secondRegistration } });
    expect(secondFinish.status).toBe(200);
    const reused = await call('/api/auth/recovery/begin', { body: { code: recoveryCode } });
    expect(reused.status).toBe(401);

    const importToken = await issueImportToken(db);
    const denied = await call('/api/household', { token: importToken });
    expect(denied.status).toBe(401);
    const sessionImport = await call('/api/import/snapshots', { cookie, body: { format: 'ours.snapshot', version: 1 } });
    expect(sessionImport.status).toBe(401);
  });

  it('expires a setup code without consuming it and refuses a second begin while it is reserved', async () => {
    const code = await issueDeviceSetupCode(db, PEPPER, 60, now);
    const first = await call('/api/auth/setup/begin', { body: { code } });
    expect(first.status).toBe(200);
    const second = await call('/api/auth/setup/begin', { body: { code } });
    expect(second.status).toBe(401);
    now = new Date(now.getTime() + 10 * 60 * 1000);
    const expired = await issueDeviceSetupCode(db, PEPPER, 60, new Date(now.getTime() - 120_000));
    now = new Date(now.getTime());
    const late = await call('/api/auth/setup/begin', { body: { code: expired } });
    expect(late.status).toBe(401);
    const row = await db.query<{ consumed_at: unknown }>(`SELECT consumed_at FROM ours_setup_codes ORDER BY created_at DESC LIMIT 1`);
    expect(row.rows[0]?.consumed_at ?? null).toBeNull();
  });
});

describe('snapshots, customization, and reports', () => {
  it('keeps custom data, deduplicates, retains five snapshots, and does not restamp a failed refresh', async () => {
    const { cookie } = await registerDevice();
    const importToken = await issueImportToken(db);
    const reportToken = await issueReportToken(db);
    const groceries = '00000000-0000-4000-8000-000000000001';

    const created = await call('/api/custom-items', {
      cookie,
      body: { name: 'Sample house', kind: 'asset', role: 'house', valueCents: 42_000_000, asOf: '2026-11-01', note: null },
    });
    expect(created.status).toBe(200);
    const rule = await call('/api/fix-rules', {
      cookie,
      body: { pattern: 'north market', matchField: 'merchant', categoryId: groceries, kindOverride: 'expense', priority: 1 },
    });
    expect(rule.status).toBe(200);
    expect((await call('/api/settings/tithing', { method: 'PUT', cookie, body: { bps: 1000 } })).status).toBe(200);
    expect((await call('/api/targets', { method: 'PUT', cookie, body: { categoryId: groceries, period: 'week', amountCents: 20_000 } })).status).toBe(200);
    const refresh = await call('/api/refresh-requests', { cookie, body: {} });
    expect(refresh.status).toBe(200);

    const failed = await call('/api/import/snapshots', { token: importToken, body: { format: 'ours.snapshot', version: 2 } });
    expect(failed.status).toBe(400);
    const stillPending = await call('/api/household', { cookie });
    const pendingBody = await stillPending.json();
    expect(pendingBody.freshness.status).toBe('missing');
    expect(pendingBody.freshness.pendingRefreshRequestedAt).toBeTruthy();
    expect(pendingBody.freshness.balancesAsOf).toBeNull();
    expect(pendingBody.netWorth.customItems).toHaveLength(1);

    const asOf = '2026-11-03T18:00:00.000Z';
    const good = snapshot(asOf, [
      payroll,
      {
        externalId: 'market',
        accountExternalId: 'credit',
        postedOn: '2026-11-04',
        postedAt: null,
        amountCents: 4_000,
        direction: 'outflow',
        pending: false,
        voided: false,
        merchantLabel: 'North Market',
        description: null,
        providerKind: null,
        replacesExternalId: null,
      },
      {
        externalId: 'move-out',
        accountExternalId: 'checking',
        postedOn: '2026-11-04',
        postedAt: null,
        amountCents: 10_000,
        direction: 'outflow',
        pending: false,
        voided: false,
        merchantLabel: 'To savings',
        description: null,
        providerKind: null,
        replacesExternalId: null,
      },
      {
        externalId: 'move-in',
        accountExternalId: 'savings',
        postedOn: '2026-11-04',
        postedAt: null,
        amountCents: 10_000,
        direction: 'inflow',
        pending: false,
        voided: false,
        merchantLabel: 'From checking',
        description: null,
        providerKind: null,
        replacesExternalId: null,
      },
      {
        externalId: 'card-out',
        accountExternalId: 'checking',
        postedOn: '2026-11-04',
        postedAt: null,
        amountCents: 50_000,
        direction: 'outflow',
        pending: false,
        voided: false,
        merchantLabel: 'Card payment',
        description: null,
        providerKind: null,
        replacesExternalId: null,
      },
      {
        externalId: 'card-in',
        accountExternalId: 'credit',
        postedOn: '2026-11-04',
        postedAt: null,
        amountCents: 50_000,
        direction: 'inflow',
        pending: false,
        voided: false,
        merchantLabel: 'Payment',
        description: null,
        providerKind: null,
        replacesExternalId: null,
      },
    ]);
    const imported = await call('/api/import/snapshots', { token: importToken, body: good });
    expect(imported.status, JSON.stringify(await imported.clone().json())).toBe(200);
    const importBody = await imported.json();
    expect(importBody.duplicate).toBe(false);
    expect(importBody.refreshRequestsFulfilled).toBe(1);
    expect(importBody.balancesAsOf).toBe('2026-11-03T18:00:00.000Z');

    const home = await (await call('/api/household', { cookie })).json();
    expect(home.earningsCents).toBe(240_000);
    expect(home.spending.transferOutflowCents).toBe(10_000);
    expect(home.spending.debtOutflowCents).toBe(50_000);
    expect(home.spending.netCents).toBe(4_000);
    expect(home.tithing.state).toBe('still_to_pay');
    expect(home.tithing.remainingCents).toBe(24_000);
    expect(home.freshness.balancesAsOf).toBe('2026-11-03T18:00:00.000Z');
    expect(home.freshness.status).toBe('verified');
    expect(home.netWorth.customItems[0].name).toBe('Sample house');
    expect(home.fixRules).toHaveLength(1);

    const pay = home.recent.find((row: { merchantLabel: string }) => row.merchantLabel === 'Sample Payroll');
    const classified = await call(`/api/transactions/${pay.id}/classification`, {
      cookie,
      body: { kind: 'income', categoryId: groceries },
    });
    expect(classified.status).toBe(200);

    const renamedAt = '2026-11-04T18:00:00.000Z';
    const renamed = snapshot(renamedAt, [{ ...payroll, merchantLabel: 'Payroll renamed', providerKind: 'expense' }]);
    renamed.balances = renamed.balances.map((balance) => ({ ...balance, asOf: renamedAt }));
    const second = await call('/api/import/snapshots', { token: importToken, body: renamed });
    expect(second.status).toBe(200);
    const after = await (await call('/api/household', { cookie })).json();
    const renamedPay = after.recent.find((row: { id: string }) => row.id === pay.id);
    expect(renamedPay.merchantLabel).toBe('Payroll renamed');
    expect(renamedPay.kind).toBe('income');
    expect(renamedPay.categoryId).toBe(groceries);
    expect(after.netWorth.customItems).toHaveLength(1);
    expect(after.fixRules).toHaveLength(1);
    expect(after.spending.targetsConfigured).toBe(true);

    const duplicate = await call('/api/import/snapshots', { token: importToken, body: renamed });
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.duplicate).toBe(true);
    expect(duplicateBody.balancesAsOf).toBe(renamedAt);

    for (let index = 1; index <= 4; index += 1) {
      const stamp = `2026-11-04T18:10:0${index}.000Z`;
      const extra = snapshot(stamp, [{ ...payroll, externalId: `extra-${index}`, postedOn: '2026-10-15', postedAt: null }]);
      extra.balances = extra.balances.map((balance) => ({ ...balance, asOf: stamp }));
      expect((await call('/api/import/snapshots', { token: importToken, body: extra })).status).toBe(200);
    }
    const retained = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ours_snapshots WHERE status = 'completed'`);
    expect(retained.rows[0]?.count).toBe(5);
    const oldPay = await db.query(`SELECT id FROM ours_transactions WHERE external_id = 'pay'`);
    expect(oldPay.rows).toHaveLength(1);
    const custom = await db.query(`SELECT id FROM ours_custom_items`);
    expect(custom.rows).toHaveLength(1);

    now = new Date(now.getTime() + 1000);
    const broken = await call('/api/import/snapshots', { token: importToken, body: { format: 'nope' } });
    expect(broken.status).toBe(400);
    const stale = await (await call('/api/household', { cookie })).json();
    expect(stale.freshness.status).toBe('unchanged_after_failure');
    expect(stale.freshness.balancesAsOf).not.toBe(stale.freshness.lastFailureAt);
    expect(stale.netWorth.netCents).toBe(300_000 + 100_000 - 20_000 + 42_000_000);

    const previewBefore = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ours_report_runs`);
    const preview = await call('/api/reports/preview?kind=week', { cookie });
    const previewBody = await preview.json();
    expect(previewBody.text).not.toMatch(/https?:|Sample Payroll|Sample Checking|net worth/i);
    expect(previewBody.html.match(/href="/g)).toHaveLength(1);
    expect((await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ours_report_runs`)).rows[0]?.count).toBe(previewBefore.rows[0]?.count);

    const generated = await call('/api/reports/generate', { token: reportToken, body: { kind: 'week' } });
    expect(generated.status).toBe(200);
    const firstReport = await generated.json();
    expect(firstReport.duplicate).toBe(false);
    expect(firstReport.idempotencyKey).toBe('week:2026-10-26');
    expect(JSON.stringify(firstReport)).not.toMatch(/Sample Payroll|accountNumber|netWorth/);
    const secondReport = await (await call('/api/reports/generate', { token: reportToken, body: { kind: 'week' } })).json();
    expect(secondReport.duplicate).toBe(true);
    expect(secondReport.html).toBe(firstReport.html);
    const runs = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ours_report_runs`);
    expect(runs.rows[0]?.count).toBe(1);
  });
});

describe('configuration guardrails', () => {
  it('refuses production defaults and redacts sensitive log fields', async () => {
    expect(() => loadConfigFromEnv({ OURS_ENV: 'production', OURS_CODE_PEPPER: PEPPER, OURS_RP_ID: 'ours.example', OURS_ORIGINS: 'https://ours.example' })).toThrow(/not usable/);
    expect(() => loadConfigFromEnv({ OURS_ENV: 'production', OURS_CODE_PEPPER: 'x'.repeat(32), OURS_RP_ID: 'localhost', OURS_ORIGINS: 'https://ours.example' })).toThrow(/loopback/);
    expect(() => loadConfigFromEnv({ OURS_ENV: 'production' })).toThrow(/OURS_CODE_PEPPER/);
    const { redact } = await import('../src/redact.ts');
    expect(JSON.stringify(redact({ merchant: 'North Market', amount: 12, ok: true }))).not.toContain('North Market');
  });
});
