import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: prepare-live-upload <snapshot.json>\n');
  process.exit(2);
}
const parsed = JSON.parse(readFileSync(file, 'utf8')) as { accounts?: unknown; as_of?: unknown; report?: unknown };
const accounts = Array.isArray(parsed.accounts) ? parsed.accounts.length : 0;
if (accounts < 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'snapshot has no accounts' })}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, accounts, hasReport: parsed.report != null })}\n`);
if (process.env.OURS_UPLOAD === 'apply') {
  process.stderr.write('Refusing to upload. The existing ours_admin_upload_snapshot path stays with the coordinator.\n');
  process.exit(2);
}
