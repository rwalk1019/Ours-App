import { readFileSync } from 'node:fs';
import { parseSnapshotDocument } from '@ours/domain';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const useStdin = args.includes('--stdin');
const fileIndex = args.indexOf('--file');
if (!useStdin && fileIndex === -1) {
  process.stderr.write('Usage: import-snapshot --file <path> | --stdin [--dry-run]\n');
  process.exit(2);
}
const raw = useStdin ? readFileSync(0, 'utf8') : readFileSync(args[fileIndex + 1] ?? '', 'utf8');
let parsed;
try {
  parsed = parseSnapshotDocument(JSON.parse(raw) as unknown);
} catch (error) {
  const code = error instanceof Error ? error.message : 'invalid_json';
  process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exit(1);
}
const summary = {
  accounts: parsed.snapshot.accounts.length,
  transactions: parsed.snapshot.transactions.length,
  balancesAsOf: parsed.snapshot.balancesAsOf,
  dateOnlyTransactions: parsed.dateOnlyCount,
};
if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, ...summary })}\n`);
  process.exit(0);
}
const base = process.env.OURS_API_BASE;
const token = process.env.OURS_IMPORT_TOKEN;
if (!base || !token) {
  process.stderr.write('Set OURS_API_BASE and OURS_IMPORT_TOKEN in the environment, not as arguments.\n');
  process.exit(2);
}
const response = await fetch(new URL('/api/import/snapshots', base), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-ours-request': '1',
  },
  body: JSON.stringify(parsed.snapshot),
});
const body = await response.json();
process.stdout.write(`${JSON.stringify(body)}\n`);
process.exit(response.ok ? 0 : 1);
