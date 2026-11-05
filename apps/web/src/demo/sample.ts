import {
  addDays,
  buildHouseholdView,
  classifyTransactions,
  denverToday,
  formatCivilDate,
  parseCivilDate,
  weekContaining,
  type FixRuleInput,
  type HouseholdView,
  type PeriodKind,
  type TxKind,
} from '@ours/domain';

export const SAMPLE_CATEGORIES = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Groceries', archived: false },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Household', archived: false },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Transport', archived: false },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Utilities', archived: false },
  { id: '00000000-0000-4000-8000-000000000005', name: 'Health', archived: false },
  { id: '00000000-0000-4000-8000-000000000006', name: 'Other', archived: false },
];

const GROCERIES = SAMPLE_CATEGORIES[0]!.id;
const TRANSPORT = SAMPLE_CATEGORIES[2]!.id;

export type SampleSituation = 'ready' | 'unconfigured' | 'empty' | 'stale';

export type SampleFacts = {
  situation: SampleSituation;
  now: Date;
  tithingBps: number | null;
  rules: FixRuleInput[];
  locks: { externalId: string; kind: TxKind; categoryId: string | null }[];
  payments: { id: string; weekStart: string; amountCents: number; paidOn: string }[];
  coveredWeeks: string[];
  targets: { id: string; categoryId: string; period: 'week' | 'month' | 'year'; amountCents: number }[];
  customItems: HouseholdView['netWorth']['customItems'];
};

export type SamplePayload = HouseholdView & {
  categoryChoices: { id: string; name: string }[];
  fixRules: { id: string; pattern: string; matchField: 'merchant' | 'description'; categoryId: string; kindOverride: TxKind | null; priority: number }[];
};

export function initialFacts(situation: SampleSituation, now = new Date()): SampleFacts {
  const base: SampleFacts = {
    situation,
    now,
    tithingBps: situation === 'ready' || situation === 'stale' ? 1000 : null,
    rules:
      situation === 'empty'
        ? []
        : [
            { id: 'rule-market', pattern: 'north market', matchField: 'merchant', categoryId: GROCERIES, kindOverride: null, priority: 1 },
            { id: 'rule-transit', pattern: 'river transit', matchField: 'merchant', categoryId: TRANSPORT, kindOverride: null, priority: 2 },
          ],
    locks: [],
    payments: [],
    coveredWeeks: [],
    targets:
      situation === 'ready' || situation === 'stale'
        ? [
            { id: 'target-groceries', categoryId: GROCERIES, period: 'week', amountCents: 15_000 },
            { id: 'target-transport', categoryId: TRANSPORT, period: 'week', amountCents: 4_000 },
          ]
        : [],
    customItems:
      situation === 'empty'
        ? []
        : [
            { id: 'sample-house', name: 'Sample house', kind: 'asset', role: 'house', valueCents: 42_000_000, asOf: denverToday(now), note: null },
            { id: 'sample-car', name: 'Sample car', kind: 'asset', role: 'car', valueCents: 1_800_000, asOf: denverToday(now), note: null },
            { id: 'sample-loan', name: 'Sample loan', kind: 'liability', role: 'loan', valueCents: 21_000_000, asOf: denverToday(now), note: null },
          ],
  };
  return base;
}

export function presentSample(facts: SampleFacts, periodKind: PeriodKind = 'week', anchor = denverToday(facts.now)): SamplePayload {
  const today = denverToday(facts.now);
  const week = weekContaining(today);
  const tuesday = formatCivilDate(addDays(parseCivilDate(week.start), 1));
  const wednesday = formatCivilDate(addDays(parseCivilDate(week.start), 2));
  const asOf = new Date(facts.now.getTime() - 36 * 60 * 60 * 1000).toISOString();
  const imported = new Date(facts.now.getTime() - 30 * 60 * 60 * 1000).toISOString();
  const failed = new Date(facts.now.getTime() - 60 * 60 * 1000).toISOString();
  const accounts = [
    { externalId: 'checking', kind: 'depository' as const },
    { externalId: 'savings', kind: 'depository' as const },
    { externalId: 'credit', kind: 'credit' as const },
  ];
  const raw =
    facts.situation === 'empty'
      ? []
      : [
          tx('pay', 'checking', week.start, 240_000, 'inflow', 'income', 'Sample Payroll'),
          tx('market', 'credit', tuesday, 4_200, 'outflow', 'expense', 'North Market'),
          tx('refund', 'credit', tuesday, 600, 'inflow', 'refund', 'North Market'),
          tx('transit', 'checking', wednesday, 800, 'outflow', 'expense', 'River Transit'),
          tx('move-out', 'checking', wednesday, 10_000, 'outflow', null, 'To savings'),
          tx('move-in', 'savings', wednesday, 10_000, 'inflow', null, 'From checking'),
          tx('card-out', 'checking', wednesday, 5_000, 'outflow', null, 'Card payment'),
          tx('card-in', 'credit', wednesday, 5_000, 'inflow', null, 'Payment'),
          tx('mystery', 'checking', wednesday, 1_500, 'inflow', null, 'Sample deposit'),
        ];
  const classified = classifyTransactions({ accounts, transactions: raw, rules: facts.rules, locks: facts.locks });
  const targets = facts.targets;
  const balances =
    facts.situation === 'empty'
      ? []
      : [
          { accountId: 'checking', label: 'Sample Checking', kind: 'depository' as const, assetCents: 482_000, owedCents: 0, asOf, note: null },
          { accountId: 'savings', label: 'Sample Savings', kind: 'depository' as const, assetCents: 220_000, owedCents: 0, asOf, note: null },
          { accountId: 'credit', label: 'Sample Credit', kind: 'credit' as const, assetCents: 0, owedCents: 64_000, asOf, note: null },
        ];
  const view = buildHouseholdView({
    now: facts.now,
    periodKind,
    anchor,
    tithingBps: facts.tithingBps,
    categories: SAMPLE_CATEGORIES,
    targets,
    transactions: classified.map((row) => ({ ...row, id: row.externalId })),
    balances,
    customItems: facts.customItems,
    payments: facts.payments,
    coveredWeeks: facts.coveredWeeks,
    freshness:
      facts.situation === 'empty'
        ? { balancesAsOf: null, lastImportedAt: null, lastFailureAt: null, lastFailureCode: null, pendingRefreshRequestedAt: null }
        : facts.situation === 'stale'
          ? {
              balancesAsOf: asOf,
              lastImportedAt: imported,
              lastFailureAt: failed,
              lastFailureCode: 'import_failed',
              pendingRefreshRequestedAt: failed,
            }
          : {
              balancesAsOf: asOf,
              lastImportedAt: imported,
              lastFailureAt: null,
              lastFailureCode: null,
              pendingRefreshRequestedAt: null,
            },
  });
  return {
    ...view,
    categoryChoices: SAMPLE_CATEGORIES.map(({ id, name }) => ({ id, name })),
    fixRules: facts.rules.map((rule) => ({
      id: rule.id,
      pattern: rule.pattern,
      matchField: rule.matchField,
      categoryId: rule.categoryId,
      kindOverride: rule.kindOverride,
      priority: rule.priority,
    })),
  };
}

function tx(
  externalId: string,
  accountExternalId: string,
  postedOn: string,
  amountCents: number,
  direction: 'inflow' | 'outflow',
  providerKind: 'income' | 'expense' | 'refund' | null,
  merchantLabel: string,
) {
  return {
    externalId,
    accountExternalId,
    postedOn,
    amountCents,
    direction,
    pending: false,
    voided: false,
    merchantLabel,
    description: null,
    providerKind,
  };
}
