const authUrl = import.meta.env.VITE_OURS_AUTH_URL || '/functions/v1/ours-auth';
const rpcBase = import.meta.env.VITE_OURS_RPC_BASE || '/rest/v1/rpc';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

let sessionToken: string | null = null;

export function currentSession(): string | null {
  return sessionToken;
}

export function rememberSession(token: string | null): void {
  sessionToken = token;
}

function headers(): HeadersInit {
  const result: Record<string, string> = { 'content-type': 'application/json' };
  if (anonKey) {
    result.apikey = anonKey;
    result.authorization = `Bearer ${anonKey}`;
  }
  return result;
}

export async function authAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(authUrl, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Sign-in failed.');
  return data;
}

export async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${rpcBase}/${name}`, { method: 'POST', headers: headers(), body: JSON.stringify(args) });
  if (response.status === 404) {
    const missing = new Error('missing_rpc');
    throw missing;
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof data.message === 'string' ? data.message : 'The household request failed.';
    const error = new Error(message);
    throw error;
  }
  return data;
}
