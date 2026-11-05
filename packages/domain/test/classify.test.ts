import { describe, expect, it } from 'vitest';
import {
  buildHouseholdView,
  classifyTransactions,
  emailCategoryTotals,
  netWorthFigures,
  type ClassifiableTx,
} from '../src/index.ts';

const GROCERIES = '00000000-0000-4000-8000-000000000001';
const accounts = [
  { externalId: 'checking', kind: 'depository' as const },
  { externalId: 'savings', kind: 'depository' as const },
  { externalId: 'credit', kind: 'credit' as const },
  { externalId: 'loan', kind: 'loan' as const },
];

function tx(partial: Partial<ClassifiableTx> & Pick<ClassifiableTx, 'externalId' | 'amountCents' | 'direction'>): ClassifiableTx {
  return {
    accountExternalId: 'checking',
    postedOn: '2026-11-04',
    pending: false,
    voided: false,
    merchantLabel: null,
    description: null,
    providerKind: null,
    ...partial,
  };
}

describe('classification and reporting boundaries', () => {
  it('keeps earnings, refunds, transfers, and debt payments from double counting', () => {
    const classified = classifyTransactions({
      accounts,
      rules: [{ id: 'r1', pattern: 'north market', matchField: 'merchant', categoryId: GROCERIES, kindOverride: null, priority: 1 }],
      locks: [],
      transactions: [
        tx({ externalId: 'pay', amountCents: 240_000, direction: 'inflow', providerKind: 'income', merchantLabel: 'Sample Payroll' }),
        tx({ externalId: 'rent', amountCents: 180_000, direction: 'outflow', providerKind: 'expense', merchantLabel: 'Sample Rent' }),
        tx({ externalId: 'market', accountExternalId: 'credit', amountCents: 4_000, direction: 'outflow', providerKind: 'expense', merchantLabel: 'North Market' }),
        tx({ externalId: 'refund', accountExternalId: 'credit', amountCents: 1_500, direction: 'inflow', providerKind: 'refund', merchantLabel: 'North Market' }),
        tx({ externalId: 'move-out', amountCents: 10_000, direction: 'outflow', providerKind: 'expense', merchantLabel: 'To savings' }),
        tx({ externalId: 'move-in', accountExternalId: 'savings', amountCents: 10_000, direction: 'inflow', providerKind: 'income', merchantLabel: 'From checking' }),
        tx({ externalId: 'pay-card', amountCents: 50_000, direction: 'outflow', providerKind: 'expense', merchantLabel: 'Card payment' }),
        tx({ externalId: 'card-in', accountExternalId: 'credit', amountCents: 50_000, direction: 'inflow', merchantLabel: 'Payment' }),
        tx({ externalId: 'mystery', amountCents: 2_000, direction: 'inflow', merchantLabel: 'Unknown deposit' }),
        tx({ externalId: 'pending-pay', amountCents: 100, direction: 'inflow', pending: true, providerKind: 'income' }),
      ],
    });
    const byId = new Map(classified.map((row) => [row.externalId, row]));
    expect(byId.get('move-out')?.kind).toBe('transfer');
    expect(byId.get('move-in')?.kind).toBe('transfer');
    expect(byId.get('pay-card')?.kind).toBe('debt_payment');
    expect(byId.get('card-in')?.kind).toBe('debt_payment');
    expect(byId.get('mystery')?.kind).toBe('unreviewed');
    expect(byId.get('market')?.categoryId).toBe(GROCERIES);
    expect(byId.get('refund')?.categoryId).toBe(GROCERIES);

    const view = buildHouseholdView({
      now: new Date('2026-11-05T18:00:00Z'),
      periodKind: 'week',
      anchor: '2026-11-05',
      tithingBps: 1000,
      categories: [{ id: GROCERIES, name: 'Groceries', archived: false }],
      targets: [{ id: 't1', categoryId: GROCERIES, period: 'week', amountCents: 20_000 }],
      transactions: classified.map((row) => ({ ...row, id: row.externalId })),
      balances: [
        { accountId: 'checking', label: 'Sample Checking', kind: 'depository', assetCents: 300_000, owedCents: 0, asOf: '2026-11-03T18:00:00Z', note: null },
        { accountId: 'credit', label: 'Sample Credit', kind: 'credit', assetCents: 0, owedCents: 20_000, asOf: '2026-11-03T18:00:00Z', note: null },
      ],
      customItems: [
        { id: 'house', name: 'Sample house', kind: 'asset', role: 'house', valueCents: 42_000_000, asOf: '2026-11-01' },
        { id: 'loan', name: 'Sample loan', kind: 'liability', role: 'loan', valueCents: 21_000_000, asOf: '2026-11-01' },
      ],
      payments: [],
      coveredWeeks: [],
      freshness: {
        balancesAsOf: '2026-11-03T18:00:00Z',
        lastImportedAt: '2026-11-05T15:00:00Z',
        lastFailureAt: null,
        lastFailureCode: null,
        pendingRefreshRequestedAt: null,
      },
    });

    expect(view.earningsCents).toBe(240_000);
    expect(view.spending.expenseCents).toBe(184_000);
    expect(view.spending.refundCents).toBe(1_500);
    expect(view.spending.netCents).toBe(182_500);
    expect(view.spending.transferOutflowCents).toBe(10_000);
    expect(view.spending.transferInflowCents).toBe(10_000);
    expect(view.spending.debtOutflowCents).toBe(50_000);
    expect(view.tithing.state).toBe('still_to_pay');
    expect(view.tithing.remainingCents).toBe(24_000);
    expect(view.tithing.label).toBe('Still to pay $240.00');
    expect(view.tithing.withheldCount).toBe(2);
    const groceries = view.spending.byCategory.find((row) => row.categoryId === GROCERIES);
    expect(groceries?.netCents).toBe(2_500);
    expect(groceries?.target?.amountCents).toBe(20_000);
    expect(view.netWorth.netCents).toBe(300_000 - 20_000 + 42_000_000 - 21_000_000);
    expect(view.spending.netCents).not.toBe(view.netWorth.netCents);

    const emailed = emailCategoryTotals({
      transactions: classified,
      categories: [{ id: GROCERIES, name: 'Groceries' }],
      range: { start: '2026-11-02', end: '2026-11-08' },
    });
    expect(emailed.find((row) => row.name === 'Groceries')?.totalCents).toBe(2_500);
    expect(emailed.some((row) => row.name.includes('Payroll'))).toBe(false);
  });

  it('does not let a user lock get rewritten, and refuses an ambiguous pair', () => {
    const locked = classifyTransactions({
      accounts,
      rules: [{ id: 'r', pattern: 'payroll', matchField: 'merchant', categoryId: GROCERIES, kindOverride: 'expense', priority: 1 }],
      locks: [{ externalId: 'pay', kind: 'income', categoryId: null }],
      transactions: [tx({ externalId: 'pay', amountCents: 100, direction: 'inflow', merchantLabel: 'Payroll', providerKind: 'expense' })],
    });
    expect(locked[0]?.kind).toBe('income');
    expect(locked[0]?.userLocked).toBe(true);
    expect(locked[0]?.categoryId).toBeNull();

    const ambiguous = classifyTransactions({
      accounts: [...accounts, { externalId: 'cash', kind: 'depository' }],
      rules: [],
      locks: [],
      transactions: [
        tx({ externalId: 'out', amountCents: 5_000, direction: 'outflow', providerKind: 'expense' }),
        tx({ externalId: 'in-b', accountExternalId: 'savings', amountCents: 5_000, direction: 'inflow', providerKind: 'income' }),
        tx({ externalId: 'in-c', accountExternalId: 'cash', amountCents: 5_000, direction: 'inflow', providerKind: 'income' }),
      ],
    });
    expect(ambiguous.every((row) => row.kind === 'unreviewed')).toBe(true);
    expect(ambiguous.reduce((sum, row) => sum + (row.kind === 'income' ? row.amountCents : 0), 0)).toBe(0);
  });

  it('does not double count an overdraft as both a negative asset and a liability', () => {
    const worth = netWorthFigures(
      [{ accountId: 'c', label: 'Sample Checking', kind: 'depository', assetCents: -5_000, owedCents: 0, asOf: '2026-11-03T18:00:00Z', note: 'overdraft' }],
      [],
    );
    expect(worth.netCents).toBe(-5_000);
    expect(worth.liabilitiesCents).toBe(0);
  });

  it('keeps a later failure from pretending balances were re-verified', () => {
    const view = buildHouseholdView({
      now: new Date('2026-11-05T18:00:00Z'),
      periodKind: 'month',
      anchor: '2026-11-05',
      tithingBps: null,
      categories: [],
      targets: [],
      transactions: [],
      balances: [],
      customItems: [],
      payments: [],
      coveredWeeks: [],
      freshness: {
        balancesAsOf: '2026-11-03T18:00:00Z',
        lastImportedAt: '2026-11-03T18:10:00Z',
        lastFailureAt: '2026-11-05T16:00:00Z',
        lastFailureCode: 'invalid_shape',
        pendingRefreshRequestedAt: '2026-11-05T15:00:00Z',
      },
    });
    expect(view.freshness.status).toBe('unchanged_after_failure');
    expect(view.freshness.balancesAsOf).toBe('2026-11-03T18:00:00Z');
    expect(view.tithing.state).toBe('unconfigured');
    expect(view.tithing.dueCents).toBeNull();
    expect(view.spending.targetsConfigured).toBe(false);
    expect(view.period.start).toBe('2026-11-01');
    expect(view.period.end).toBe('2026-11-30');
  });
});
