import { createServer, type IncomingMessage } from 'node:http';
import { handleLiveRequest } from './live/http.js';
import { applyLiveFixture } from './live/apply.js';
import { openDatabase } from './db.js';

if (process.env.OURS_ENV === 'production') {
  console.error('This local server is a fixture. The live project already serves ours-auth and must not be replaced from here.');
  process.exit(1);
}

const origins = (process.env.OURS_ORIGINS ?? 'http://localhost:41773,http://127.0.0.1:41773')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const rpId = process.env.OURS_RP_ID?.trim() || 'localhost';
const port = Number(process.env.OURS_API_PORT ?? 41774);
const db = await openDatabase(process.env.OURS_DATA_DIR ?? '.data/live', { pgcrypto: true });
const created = await applyLiveFixture(db);
if (created === 'existing') console.log('Using the existing local Ours tables. Nothing was dropped.');

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
    const response = await handleLiveRequest(request, db, { rpId, origins }, new Date());
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.statusCode = 500;
    res.end('{"error":"server error"}');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Ours local contract http://127.0.0.1:${port}`);
});
