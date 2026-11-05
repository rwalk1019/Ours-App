import {
  ContractError,
  isSafeCents,
  isUnsafeLabel,
  lastCompletedRange,
  reportIdempotencyKey,
  parseCivilDate,
  parseSnapshotDocument,
  renderEmailReport,
  type PeriodKind,
  type TxKind,
} from '@ours/domain';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { beginAuthentication, beginPossession, finishAuthentication, finishRegistration } from './authFlow.js';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { PublicError } from './errors.js';
import { redact } from './redact.js';
import {
  addTithingPayment,
  classifyOwnedTransaction,
  deleteCustomItem,
  deleteFixRule,
  deleteTarget,
  deleteTithingPayment,
  importCanonical,
  insertCategory,
  insertCustomItem,
  insertFixRule,
  listCategoryChoices,
  listFixRules,
  loadHousehold,
  readReport,
  readSession,
  recordImportFailure,
  reportCount,
  requestRefresh,
  revokeSession,
  rotateRecoveryCodes,
  saveReport,
  setCoverage,
  setTithingBps,
  tokenMatches,
  updateCustomItem,
  upsertTarget,
} from './repository.js';

export type AppContext = {
  db: Db;
  config: AppConfig;
  now: () => Date;
};

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cache-control': 'no-store',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cors(request: Request, config: AppConfig): Headers {
  const headers = new Headers(SECURITY);
  const origin = request.headers.get('origin');
  if (origin && config.origins.includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('vary', 'origin');
  }
  headers.set('access-control-allow-headers', 'content-type, authorization, x-ours-request');
  headers.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  return headers;
}

function json(request: Request, config: AppConfig, status: number, body: unknown, cookie?: string): Response {
  const headers = cors(request, config);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function sessionCookie(token: string, config: AppConfig, maxAge: number): string {
  const parts = [`ours_session=${token}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAge}`, `SameSite=${config.cookieSameSite}`];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'ours_session') return rest.join('=') || null;
  }
  return null;
}

function routeOf(url: URL): string {
  const index = url.pathname.indexOf('/api/');
  return (index >= 0 ? url.pathname.slice(index) : url.pathname).replace(/\/$/, '') || '/';
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 2_000_000) throw new PublicError(413, 'payload_too_large');
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublicError(400, 'invalid_json');
  }
}

function assertOrigin(request: Request, config: AppConfig): string {
  const origin = request.headers.get('origin');
  if (!origin || !config.origins.includes(origin)) throw new PublicError(403, 'origin_rejected');
  return origin;
}

function allowOriginIfPresent(request: Request, config: AppConfig): void {
  const origin = request.headers.get('origin');
  if (origin && !config.origins.includes(origin)) throw new PublicError(403, 'origin_rejected');
}

async function requireSession(request: Request, ctx: AppContext): Promise<void> {
  const token = bearer(request) ?? cookieToken(request);
  if (!token || !(await readSession(ctx.db, token, ctx.now()))) throw new PublicError(401, 'locked');
}

function periodOf(value: unknown): PeriodKind {
  if (value === 'week' || value === 'month' || value === 'year') return value;
  throw new ContractError('invalid_shape', 'period');
}

function cents(value: unknown, allowZero = true): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !isSafeCents(value)) throw new ContractError('amount_not_cents');
  if (value < 0 || (!allowZero && value === 0)) throw new ContractError('amount_not_cents');
  return value;
}

function labelOf(value: unknown, max = 80): string {
  if (typeof value !== 'string') throw new ContractError('invalid_shape');
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < 1 || text.length > max || isUnsafeLabel(text)) throw new ContractError('invalid_shape');
  return text;
}

function civil(value: unknown): string {
  if (typeof value !== 'string') throw new ContractError('invalid_date');
  parseCivilDate(value);
  return value;
}

function txKind(value: unknown): TxKind {
  if (value === 'income' || value === 'expense' || value === 'refund' || value === 'transfer' || value === 'debt_payment' || value === 'unreviewed') {
    return value;
  }
  throw new ContractError('invalid_shape', 'kind');
}

function uuidParam(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new PublicError(404, 'not_found');
  return value;
}

function deviceLabel(value: unknown): string {
  if (typeof value !== 'string') return 'This device';
  const text = value.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!text || isUnsafeLabel(text)) return 'This device';
  return text;
}

function customInput(body: Record<string, unknown>): {
  name: string;
  kind: 'asset' | 'liability';
  role: 'house' | 'car' | 'loan' | 'other';
  valueCents: number;
  asOf: string;
  note: string | null;
} {
  const kind: 'asset' | 'liability' | null = body.kind === 'asset' || body.kind === 'liability' ? body.kind : null;
  const role: 'house' | 'car' | 'loan' | 'other' | null =
    body.role === 'house' || body.role === 'car' || body.role === 'loan' || body.role === 'other' ? body.role : null;
  if (!kind || !role) throw new ContractError('invalid_shape');
  return {
    name: labelOf(body.name),
    kind,
    role,
    valueCents: cents(body.valueCents),
    asOf: civil(body.asOf),
    note: body.note == null || body.note === '' ? null : labelOf(body.note, 200),
  };
}

async function householdPayload(ctx: AppContext, period: PeriodKind, anchor: string | undefined) {
  const view = await loadHousehold(ctx.db, ctx.now(), period, anchor);
  return { ...view, categoryChoices: await listCategoryChoices(ctx.db), fixRules: await listFixRules(ctx.db) };
}

export async function handle(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const path = routeOf(url);
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, ctx.config) });
    if (path === '/api/health' && request.method === 'GET') return json(request, ctx.config, 200, { ok: true });
    if (request.headers.get('x-ours-request') !== '1') throw new PublicError(400, 'missing_header');
    allowOriginIfPresent(request, ctx.config);
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      const type = request.headers.get('content-type') ?? '';
      if (request.headers.get('content-length') !== '0' && !type.startsWith('application/json')) {
        throw new PublicError(415, 'unsupported_media');
      }
    }
    const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await readJson(request);
    const record = isRecord(body) ? body : {};

    if (path === '/api/auth/status' && request.method === 'GET') {
      const { usableCredentialCount } = await import('./repository.js');
      const count = await usableCredentialCount(ctx.db);
      return json(request, ctx.config, 200, { state: count === 0 ? 'setup_required' : 'ready' });
    }

    if (path === '/api/auth/setup/begin' && request.method === 'POST') {
      const origin = assertOrigin(request, ctx.config);
      if (typeof record.code !== 'string') throw new PublicError(401, 'invalid_code');
      const result = await beginPossession(ctx.db, ctx.config, ctx.now(), origin, record.code, 'device_setup');
      return json(request, ctx.config, 200, result);
    }
    if (path === '/api/auth/recovery/begin' && request.method === 'POST') {
      const origin = assertOrigin(request, ctx.config);
      if (typeof record.code !== 'string') throw new PublicError(401, 'invalid_code');
      const result = await beginPossession(ctx.db, ctx.config, ctx.now(), origin, record.code, 'recovery');
      return json(request, ctx.config, 200, result);
    }
    if (path === '/api/auth/register/finish' && request.method === 'POST') {
      const origin = assertOrigin(request, ctx.config);
      const finished = await finishRegistration(ctx.db, ctx.config, ctx.now(), origin, record.response as RegistrationResponseJSON, deviceLabel(record.deviceLabel));
      return json(
        request,
        ctx.config,
        200,
        { ok: true, recoveryCodes: finished.recoveryCodes ?? null },
        sessionCookie(finished.token, ctx.config, ctx.config.sessionTtlSeconds),
      );
    }
    if (path === '/api/auth/authenticate/begin' && request.method === 'POST') {
      const origin = assertOrigin(request, ctx.config);
      return json(request, ctx.config, 200, await beginAuthentication(ctx.db, ctx.config, ctx.now(), origin));
    }
    if (path === '/api/auth/authenticate/finish' && request.method === 'POST') {
      const origin = assertOrigin(request, ctx.config);
      const finished = await finishAuthentication(ctx.db, ctx.config, ctx.now(), origin, record.response as AuthenticationResponseJSON);
      return json(request, ctx.config, 200, { ok: true }, sessionCookie(finished.token, ctx.config, ctx.config.sessionTtlSeconds));
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      const token = bearer(request) ?? cookieToken(request);
      if (token) await revokeSession(ctx.db, token, ctx.now());
      return json(request, ctx.config, 200, { ok: true }, sessionCookie('expired', ctx.config, 0));
    }
    if (path === '/api/auth/recovery-codes' && request.method === 'POST') {
      await requireSession(request, ctx);
      const codes = await rotateRecoveryCodes(ctx.db, ctx.config.pepper, ctx.now());
      return json(request, ctx.config, 200, { recoveryCodes: codes });
    }

    if (path === '/api/import/snapshots' && request.method === 'POST') {
      const token = bearer(request);
      if (!token || !(await tokenMatches(ctx.db, 'ours_import_credentials', token))) throw new PublicError(401, 'locked');
      try {
        const parsed = parseSnapshotDocument(body);
        const result = await importCanonical(ctx.db, parsed.snapshot, ctx.now());
        return json(request, ctx.config, 200, { ...result, dateOnlyTransactions: parsed.dateOnlyCount });
      } catch (error) {
        const code = error instanceof ContractError ? error.code : 'import_failed';
        await recordImportFailure(ctx.db, code, ctx.now());
        if (error instanceof ContractError) return json(request, ctx.config, 400, { error: code });
        throw error;
      }
    }

    if (path === '/api/reports/generate' && request.method === 'POST') {
      const token = bearer(request);
      const sessionOk = token ? await readSession(ctx.db, token, ctx.now()) : await (async () => {
        const cookie = cookieToken(request);
        return cookie ? readSession(ctx.db, cookie, ctx.now()) : null;
      })();
      const reportOk = token ? await tokenMatches(ctx.db, 'ours_report_credentials', token) : false;
      if (!sessionOk && !reportOk) throw new PublicError(401, 'locked');
      const kind = periodOf(record.kind);
      const range = lastCompletedRange(kind, ctx.now());
      const existing = await readReport(ctx.db, reportIdempotencyKey(kind, range));
      if (existing && isRecord(existing)) return json(request, ctx.config, 200, { ...existing, duplicate: true });
      const view = await loadHousehold(ctx.db, ctx.now(), kind, range.start);
      const document = renderEmailReport({
        kind,
        range,
        categories: view.spending.byCategory.filter((category) => category.netCents !== 0).map((category) => ({ name: category.name, totalCents: category.netCents })),
        openOursOrigin: ctx.config.appOrigin,
      });
      const saved = await saveReport(ctx.db, {
        key: document.idempotencyKey,
        kind,
        start: range.start,
        end: range.end,
        payload: document,
      });
      const stored = saved.duplicate ? await readReport(ctx.db, document.idempotencyKey) : document;
      return json(request, ctx.config, 200, { ...(isRecord(stored) ? stored : document), duplicate: saved.duplicate });
    }

    await requireSession(request, ctx);

    if (path === '/api/household' && request.method === 'GET') {
      const period = url.searchParams.get('period') ? periodOf(url.searchParams.get('period')) : 'week';
      const anchor = url.searchParams.get('anchor') ?? undefined;
      if (anchor) civil(anchor);
      return json(request, ctx.config, 200, await householdPayload(ctx, period, anchor));
    }
    if (path === '/api/settings/tithing' && request.method === 'PUT') {
      const bps = record.bps === null ? null : cents(record.bps);
      if (bps !== null && bps > 10000) throw new ContractError('invalid_shape', 'bps');
      await setTithingBps(ctx.db, bps, ctx.now());
      return json(request, ctx.config, 200, { ok: true });
    }
    if (path === '/api/categories' && request.method === 'POST') {
      return json(request, ctx.config, 200, { id: await insertCategory(ctx.db, labelOf(record.name)) });
    }
    if (path === '/api/targets' && request.method === 'PUT') {
      if (typeof record.categoryId !== 'string') throw new ContractError('invalid_shape');
      await upsertTarget(ctx.db, uuidParam(record.categoryId), periodOf(record.period), cents(record.amountCents), ctx.now());
      return json(request, ctx.config, 200, { ok: true });
    }
    const targetDelete = /^\/api\/targets\/([^/]+)$/.exec(path);
    if (targetDelete && request.method === 'DELETE') {
      await deleteTarget(ctx.db, uuidParam(targetDelete[1] ?? ''));
      return json(request, ctx.config, 200, { ok: true });
    }
    if (path === '/api/fix-rules' && request.method === 'POST') {
      const matchField = record.matchField === 'merchant' || record.matchField === 'description' ? record.matchField : null;
      if (!matchField || typeof record.categoryId !== 'string') throw new ContractError('invalid_shape');
      const id = await insertFixRule(
        ctx.db,
        {
          pattern: labelOf(record.pattern),
          matchField,
          categoryId: uuidParam(record.categoryId),
          kindOverride: record.kindOverride == null ? null : txKind(record.kindOverride),
          priority: typeof record.priority === 'number' && Number.isInteger(record.priority) ? record.priority : 100,
        },
        ctx.now(),
      );
      return json(request, ctx.config, 200, { id });
    }
    const ruleDelete = /^\/api\/fix-rules\/([^/]+)$/.exec(path);
    if (ruleDelete && request.method === 'DELETE') {
      await deleteFixRule(ctx.db, uuidParam(ruleDelete[1] ?? ''), ctx.now());
      return json(request, ctx.config, 200, { ok: true });
    }
    if (path === '/api/custom-items' && request.method === 'POST') {
      return json(request, ctx.config, 200, { id: await insertCustomItem(ctx.db, customInput(record)) });
    }
    const customPatch = /^\/api\/custom-items\/([^/]+)$/.exec(path);
    if (customPatch && request.method === 'PATCH') {
      await updateCustomItem(ctx.db, uuidParam(customPatch[1] ?? ''), customInput(record), ctx.now());
      return json(request, ctx.config, 200, { ok: true });
    }
    if (customPatch && request.method === 'DELETE') {
      await deleteCustomItem(ctx.db, uuidParam(customPatch[1] ?? ''));
      return json(request, ctx.config, 200, { ok: true });
    }
    if (path === '/api/tithing/payments' && request.method === 'POST') {
      const id = await addTithingPayment(ctx.db, { weekStart: civil(record.weekStart), amountCents: cents(record.amountCents, false), paidOn: civil(record.paidOn) }, ctx.now());
      return json(request, ctx.config, 200, { id });
    }
    const paymentDelete = /^\/api\/tithing\/payments\/([^/]+)$/.exec(path);
    if (paymentDelete && request.method === 'DELETE') {
      await deleteTithingPayment(ctx.db, uuidParam(paymentDelete[1] ?? ''));
      return json(request, ctx.config, 200, { ok: true });
    }
    if (path === '/api/tithing/coverage' && request.method === 'POST') {
      await setCoverage(ctx.db, civil(record.weekStart), record.covered !== false, ctx.now());
      return json(request, ctx.config, 200, { ok: true });
    }
    const classifyMatch = /^\/api\/transactions\/([^/]+)\/classification$/.exec(path);
    if (classifyMatch && request.method === 'POST') {
      await classifyOwnedTransaction(
        ctx.db,
        uuidParam(classifyMatch[1] ?? ''),
        txKind(record.kind),
        record.categoryId == null ? null : uuidParam(String(record.categoryId)),
        ctx.now(),
      );
      return json(request, ctx.config, 200, { ok: true });
    }
    if (path === '/api/refresh-requests' && request.method === 'POST') {
      const requestedAt = await requestRefresh(ctx.db);
      return json(request, ctx.config, 200, { ok: true, requestedAt });
    }
    if (path === '/api/reports/preview' && request.method === 'GET') {
      const kind = periodOf(url.searchParams.get('kind') ?? 'week');
      const before = await reportCount(ctx.db);
      const range = lastCompletedRange(kind, ctx.now());
      const view = await loadHousehold(ctx.db, ctx.now(), kind, range.start);
      const document = renderEmailReport({
        kind,
        range,
        categories: view.spending.byCategory.filter((category) => category.netCents !== 0).map((category) => ({ name: category.name, totalCents: category.netCents })),
        openOursOrigin: ctx.config.appOrigin,
      });
      if ((await reportCount(ctx.db)) !== before) throw new Error('preview_persisted');
      return json(request, ctx.config, 200, document);
    }
    throw new PublicError(404, 'not_found');
  } catch (error) {
    if (error instanceof PublicError) return json(request, ctx.config, error.status, { error: error.code });
    if (error instanceof ContractError) return json(request, ctx.config, 400, { error: error.code });
    console.error(JSON.stringify(redact({ name: error instanceof Error ? error.name : 'Error' })));
    return json(request, ctx.config, 500, { error: 'server_error' });
  }
}
