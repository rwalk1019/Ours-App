const base = import.meta.env.VITE_API_BASE ?? '';

export async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'include',
      headers: {
        'x-ours-request': '1',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { ok: false, status: 0, data: { error: 'offline' } };
  }
  const data = (await response.json().catch(() => ({ error: 'bad_response' }))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}
