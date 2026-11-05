import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('snapshot importer', () => {
  it('dry-runs a sample file without printing merchants', () => {
    const stdout = execFileSync('npx', ['tsx', 'scripts/import-snapshot.ts', '--dry-run', '--file', 'contracts/examples/sample.snapshot.json'], {
      encoding: 'utf8',
    });
    const summary = JSON.parse(stdout) as { ok: boolean; dryRun: boolean; accounts: number; transactions: number };
    expect(summary).toMatchObject({ ok: true, dryRun: true, accounts: 2, transactions: 1 });
    expect(stdout).not.toMatch(/Sample Payroll|sample-checking/);
  });
});
