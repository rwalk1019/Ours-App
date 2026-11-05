import { describe, expect, it } from 'vitest';
import {
  ContractError,
  fingerprintSnapshot,
  lastCompletedWeek,
  parseSnapshotDocument,
  renderEmailReport,
  validateAppOrigin,
  visibleEmailText,
} from '../src/index.ts';

const asOf = '2026-11-03T18:00:00.000Z';

function canonical() {
  return {
    format: 'ours.snapshot',
    version: 1,
    balancesAsOf: asOf,
    accounts: [
      { externalId: 'checking', label: 'Sample Checking', kind: 'depository', currency: 'USD' },
      { externalId: 'credit', label: 'Sample Credit', kind: 'credit', currency: 'USD' },
    ],
    balances: [
      { accountExternalId: 'checking', asOf, assetCents: 250_000, owedCents: 0, availableCents: 240_000, note: null },
      { accountExternalId: 'credit', asOf, assetCents: 0, owedCents: 32_000, availableCents: null, note: null },
    ],
    transactions: [
      {
        externalId: 'pay',
        accountExternalId: 'checking',
        postedOn: '2026-11-03',
        postedAt: '2026-11-03T15:00:00Z',
        amountCents: 240_000,
        direction: 'inflow',
        pending: false,
        voided: false,
        merchantLabel: 'Sample Payroll',
        description: null,
        providerKind: 'income',
        replacesExternalId: null,
      },
    ],
  };
}

describe('snapshot contract', () => {
  it('accepts a canonical snapshot and ignores key order in the fingerprint', async () => {
    const first = parseSnapshotDocument(canonical()).snapshot;
    const flipped = canonical();
    flipped.accounts.reverse();
    const second = parseSnapshotDocument(flipped).snapshot;
    expect(await fingerprintSnapshot(first)).toBe(await fingerprintSnapshot(second));
    const moved = canonical();
    moved.balancesAsOf = '2026-11-04T18:00:00.000Z';
    moved.balances = moved.balances.map((balance) => ({ ...balance, asOf: moved.balancesAsOf }));
    expect(await fingerprintSnapshot(parseSnapshotDocument(moved).snapshot)).not.toBe(await fingerprintSnapshot(first));
  });

  it('converts Plaid signs without treating JSON floats as money', () => {
    const parsed = parseSnapshotDocument({
      format: 'finance-connector-export',
      version: 1,
      signConvention: 'plaid',
      balancesAsOf: asOf,
      accounts: [
        { id: 'checking', name: 'Sample Checking', type: 'depository' },
        { id: 'credit', name: 'Sample Credit', type: 'credit' },
        { id: 'loan', name: 'Sample Loan', type: 'loan' },
      ],
      balances: [
        { accountId: 'checking', current: '2500.00', available: '2400.00', asOf },
        { accountId: 'credit', current: '-15.00', asOf },
        { accountId: 'loan', current: '1000.00', asOf },
      ],
      transactions: [
        { id: 'out', accountId: 'checking', amount: '12.50', date: '2026-11-03', providerKind: 'expense', name: 'North Market' },
        { id: 'in', accountId: 'checking', amount: '-2400.00', date: '2026-11-03', providerKind: 'income', name: 'Sample Payroll' },
        { id: 'charge', accountId: 'credit', amount: '40.00', postedAt: '2026-11-04T18:30:00Z', providerKind: 'expense', name: 'Elm Hardware' },
        { id: 'payment', accountId: 'credit', amount: '-500.00', date: '2026-11-04', name: 'Payment' },
      ],
    });
    const byId = new Map(parsed.snapshot.transactions.map((tx) => [tx.externalId, tx]));
    expect(byId.get('out')).toMatchObject({ direction: 'outflow', amountCents: 1250 });
    expect(byId.get('in')).toMatchObject({ direction: 'inflow', amountCents: 240_000 });
    expect(byId.get('charge')).toMatchObject({ direction: 'outflow', amountCents: 4000, postedOn: '2026-11-04' });
    expect(byId.get('payment')).toMatchObject({ direction: 'inflow', amountCents: 50_000 });
    const credit = parsed.snapshot.balances.find((balance) => balance.accountExternalId === 'credit');
    expect(credit).toMatchObject({ assetCents: 1500, owedCents: 0, note: 'credit_balance_in_favor' });
    const loan = parsed.snapshot.balances.find((balance) => balance.accountExternalId === 'loan');
    expect(loan).toMatchObject({ owedCents: 100_000, assetCents: 0 });
    expect(parsed.dateOnlyCount).toBe(3);
  });

  it('rejects secrets, account numbers, bad versions, and inexact amounts', () => {
    const bad = canonical() as Record<string, unknown>;
    expect(() => parseSnapshotDocument({ ...bad, version: 2 })).toThrow(ContractError);
    expect(() => parseSnapshotDocument({ format: 'finance-connector-export', version: 1, accounts: [], balances: [], transactions: [] })).toThrow(
      /sign_convention_required/,
    );
    const withNumber = canonical();
    (withNumber.transactions[0] as { amountCents: unknown }).amountCents = 12.5;
    expect(() => parseSnapshotDocument(withNumber)).toThrow(/amount_not_cents/);
    const leaked = canonical() as { accounts: { accountNumber?: string }[] };
    leaked.accounts[0]!.accountNumber = '123456789';
    expect(() => parseSnapshotDocument(leaked)).toThrow(/forbidden_field/);
    const pan = canonical();
    pan.accounts[0]!.label = 'ACCT 4111-1111-1111-1111';
    expect(() => parseSnapshotDocument(pan)).toThrow(/unsafe_account_number/);
    const mismatch = canonical();
    mismatch.transactions[0]!.postedOn = '2026-11-04';
    expect(() => parseSnapshotDocument(mismatch)).toThrow(/posted_on_timezone_mismatch/);
  });
});

describe('email report', () => {
  const range = lastCompletedWeek(new Date('2026-11-09T15:00:00Z'));

  it('renders category totals and a button href only when an origin is configured', () => {
    const withButton = renderEmailReport({
      kind: 'week',
      range,
      categories: [
        { name: 'Groceries', totalCents: 1800, merchantLabel: 'North Market', balance: 99 } as {
          name: string;
          totalCents: number;
        },
      ],
      openOursOrigin: 'https://ours.example',
    });
    expect(withButton.idempotencyKey).toBe('week:2026-11-02');
    expect(withButton.subject).not.toMatch(/\$|http|net worth|balance/i);
    const visible = visibleEmailText(withButton.html);
    expect(visible).toContain('Groceries');
    expect(visible).toContain('$18.00');
    expect(visible).not.toContain('North Market');
    expect(visible).not.toMatch(/https?:/i);
    expect(visible).not.toMatch(/net worth|account number|balance/i);
    expect(withButton.html.match(/href="/g)).toHaveLength(1);
    expect(withButton.html).toContain('href="https://ours.example/"');
    expect(withButton.text).not.toMatch(/https?:/i);
    expect(withButton.text).not.toContain('Open Ours');

    const plain = renderEmailReport({ kind: 'week', range, categories: [], openOursOrigin: null });
    expect(plain.html.includes('href=')).toBe(false);
    expect(plain.text).toContain('No category totals');
    expect(visibleEmailText(plain.html)).not.toContain('Open Ours');
  });

  it('rejects app origins that are not a bare https origin', () => {
    expect(validateAppOrigin('https://ours.example', 'production')).toBe('https://ours.example');
    expect(validateAppOrigin(null, 'production')).toBeNull();
    expect(() => validateAppOrigin('https://ours.example/household', 'production')).toThrow(/invalid_app_origin/);
    expect(() => validateAppOrigin('https://user:pass@ours.example', 'production')).toThrow(/invalid_app_origin/);
    expect(() => validateAppOrigin('http://ours.example', 'production')).toThrow(/invalid_app_origin/);
    expect(validateAppOrigin('http://localhost:41773', 'development')).toBe('http://localhost:41773');
  });
});
