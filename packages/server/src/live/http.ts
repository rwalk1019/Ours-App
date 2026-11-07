import type { Db } from '../db.js';
import { AuthError, handleAuthAction, type LiveAuthConfig } from './auth.js';

const RPCS: Record<string, { sql: string; args: string[] }> = {
  ours_get_state: { sql: 'select ours_get_state($1) as result', args: ['p_token'] },
  ours_request_refresh: { sql: 'select ours_request_refresh($1) as result', args: ['p_token'] },
  ours_save_custom_item: { sql: 'select ours_save_custom_item($1, $2::jsonb) as result', args: ['p_token', 'p_item'] },
  ours_delete_custom_item: { sql: 'select ours_delete_custom_item($1, $2::uuid) as result', args: ['p_token', 'p_id'] },
  ours_save_fix_rule: { sql: 'select ours_save_fix_rule($1, $2, $3) as result', args: ['p_token', 'p_match', 'p_category'] },
  ours_delete_fix_rule: { sql: 'select ours_delete_fix_rule($1, $2::uuid) as result', args: ['p_token', 'p_id'] },
  ours_delete_passkey: { sql: 'select ours_delete_passkey($1, $2) as result', args: ['p_token', 'p_id'] },
  ours_save_settings: { sql: 'select ours_save_settings($1, $2::jsonb) as result', args: ['p_token', 'p_settings'] },
  ours_sign_out: { sql: 'select ours_sign_out($1) as result', args: ['p_token'] },
  ours_settings_presence: { sql: 'select ours_settings_presence($1) as result', args: ['p_token'] },
  ours_admin_upload_snapshot: {
    sql: 'select ours_admin_upload_snapshot($1, $2::timestamptz, $3::jsonb, $4::jsonb) as result',
    args: ['p_key', 'p_as_of', 'p_data', 'p_report'],
  },
  ours_admin_close_requests: { sql: 'select ours_admin_close_requests($1, $2, $3) as result', args: ['p_key', 'p_status', 'p_note'] },
  ours_admin_get_config: { sql: 'select ours_admin_get_config($1) as result', args: ['p_key'] },
  ours_admin_latest_report: { sql: 'select ours_admin_latest_report($1) as result', args: ['p_key'] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function liveCors(request: Request, origins: string[]): Headers {
  const headers = new Headers({
    'access-control-allow-headers': 'content-type, apikey, authorization, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    'cache-control': 'no-store',
    vary: 'origin',
  });
  const origin = request.headers.get('origin');
  if (origin && origins.includes(origin)) headers.set('access-control-allow-origin', origin);
  return headers;
}

function json(request: Request, origins: string[], status: number, body: unknown): Response {
  const headers = liveCors(request, origins);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleLiveRequest(request: Request, db: Db, config: LiveAuthConfig, now: Date): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: liveCors(request, config.origins) });
  if (request.method !== 'POST') return json(request, config.origins, 405, { error: 'POST only' });
  const text = await request.text();
  if (text.length > 2_000_000) return json(request, config.origins, 413, { error: 'payload too large' });
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return json(request, config.origins, 400, { error: 'invalid json' });
    }
  }
  const record = isRecord(body) ? body : {};
  try {
    if (url.pathname.endsWith('/ours-auth')) {
      const result = await handleAuthAction(db, config, record, request.headers.get('origin') ?? '', now);
      return json(request, config.origins, 200, result);
    }
    const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
    if (!rpc) return json(request, config.origins, 404, { error: 'not found' });
    const spec = RPCS[rpc[1] ?? ''];
    if (!spec) return json(request, config.origins, 404, { message: 'function not found', code: 'PGRST202' });
    const params = spec.args.map((name) => record[name] ?? null);
    const result = await db.query<{ result: unknown }>(spec.sql, params);
    return json(request, config.origins, 200, result.rows[0]?.result ?? null);
  } catch (error) {
    if (error instanceof AuthError) return json(request, config.origins, error.status, { error: error.message });
    const message = error instanceof Error ? error.message : '';
    const code = message.includes('not signed in') || message.includes('bad uploader key') ? '28000' : 'P0001';
    const safe = [
      'not signed in',
      'bad uploader key',
      'item not found',
      'cannot remove the only passkey',
      'weekly target out of range',
      'tithing percent must be 0-100',
      'bad tithing category',
      'snapshot has no accounts; refusing to replace real data',
      'bad status',
    ].find((item) => message.includes(item));
    if (!safe) return json(request, config.origins, 500, { message: 'server error', code: 'XX000' });
    const status = code === '28000' ? 401 : 400;
    return json(request, config.origins, status, { message: safe, code });
  }
}
