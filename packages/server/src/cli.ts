import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { handle } from './app.js';
import { loadConfigFromEnv } from './config.js';
import { randomBytes, base64url } from './crypto.js';
import { migrate, openDatabase } from './db.js';

if (process.env.OURS_ENV === 'production') {
  console.error('This local server is for development. Production requests belong on the ours-api edge function.');
  process.exit(1);
}

const env: Record<string, string | undefined> = { ...process.env, OURS_ENV: 'development' };
if (!env.OURS_CODE_PEPPER) {
  mkdirSync('.data', { recursive: true });
  const pepperPath = '.data/pepper';
  if (!existsSync(pepperPath)) writeFileSync(pepperPath, base64url(randomBytes(32)), { mode: 0o600 });
  env.OURS_CODE_PEPPER = readFileSync(pepperPath, 'utf8').trim();
}

const config = loadConfigFromEnv(env);
const port = Number(process.env.OURS_API_PORT ?? 41774);
const db = await openDatabase('.data/pglite');
await migrate(db);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
      method: req.method,
      headers,
      body: body && body.length > 0 ? new Uint8Array(body) : undefined,
    });
    const response = await handle(request, { db, config, now: () => new Date() });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key === 'set-cookie') res.setHeader('Set-Cookie', value);
      else res.setHeader(key, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.statusCode = 500;
    res.end('{"error":"server_error"}');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Ours API http://127.0.0.1:${port}`);
});
