import type { AccountKind, ClassifiedTx, TxKind } from './classify.js';
import { denverToday, formatDenverTimestamp } from './denver.js';
import { formatUsd } from './money.js';
import { formatPeriodLabel, inRange, rangeForAnchor, weekContaining, type DateRange, type PeriodKind } from './periods.js';
import { resolveTithing, tithingStatusLabel, type TithingModel } from './tithing.js';

export type FreshnessStatus = 'missing' | 'verified' | 'unchanged_after_failure';

export type FreshnessInput = {
  balancesAsOf: string | null;
  lastImportedAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  pendingRefreshRequestedAt: string | null;
};

export type CategoryInput = { id: string; name: string; archived: boolean };
export type TargetInput = { id: string; categoryId: string; period: PeriodKind; amountCents: number };
export type CustomItemInput = {
  id: string;
  name: string;
  kind: 'asset' | 'liability';
  role: 'house' | 'car' | 'loan' | 'other';
  valueCents: number;
  asOf: string;
  note?: string | null;
};
export type BalanceInput = {
  accountId: string;
  label: string;
  kind: AccountKind;
  assetCents: number;
  owedCents: number;
  asOf: string;
  note: string | null;
};
export type PaymentInput = { id: string; weekStart: string; amountCents: number; paidOn: string };

export type HouseholdViewInput = {
  now: Date;
  periodKind: PeriodKind;
  anchor: string;
  tithingBps: number | null;
  categories: CategoryInput[];
  targets: TargetInput[];
  transactions: (ClassifiedTx & { id: string })[];
  balances: BalanceInput[];
  customItems: CustomItemInput[];
  payments: PaymentInput[];
  coveredWeeks: string[];
  freshness: FreshnessInput;
};

export type HouseholdView = ReturnType<typeof buildHouseholdView>;

function labelOrNull(iso: string | null): string | null {
  return iso ? formatDenverTimestamp(iso) : null;
}

function freshnessStatus(input: FreshnessInput): FreshnessStatus {
  if (!input.balancesAsOf) return 'missing';
  if (input.lastFailureAt && (!input.lastImportedAt || input.lastFailureAt > input.lastImportedAt)) {
    return 'unchanged_after_failure';
  }
  return 'verified';
}

export function netWorthFigures(balances: BalanceInput[], customItems: CustomItemInput[]) {
  let assetsCents = 0;
  let liabilitiesCents = 0;
  for (const balance of balances) {
    assetsCents += balance.assetCents;
    liabilitiesCents += balance.owedCents;
  }
  for (const item of customItems) {
    if (item.kind === 'asset') assetsCents += item.valueCents;
    else liabilitiesCents += item.valueCents;
  }
  return { assetsCents, liabilitiesCents, netCents: assetsCents - liabilitiesCents };
}

function countsToward(tx: ClassifiedTx, kind: TxKind, direction: 'inflow' | 'outflow'): boolean {
  return !tx.voided && !tx.pending && tx.kind === kind && tx.direction === direction;
}

export function buildHouseholdView(input: HouseholdViewInput) {
  const range = rangeForAnchor(input.periodKind, input.anchor);

  const active = input.transactions.filter((tx) => !tx.voided && inRange(tx.postedOn, range));
  let expenseCents = 0;
  let refundCents = 0;
  let earningsCents = 0;
  let transferOutflowCents = 0;
  let transferInflowCents = 0;
  let debtOutflowCents = 0;
  let debtInflowCents = 0;
  let unreviewedCount = 0;
  let pendingCount = 0;
  const categoryNets = new Map<string | null, number>();

  for (const tx of active) {
    if (tx.pending) {
      pendingCount += 1;
      continue;
    }
    if (countsToward(tx, 'income', 'inflow')) earningsCents += tx.amountCents;
    else if (countsToward(tx, 'expense', 'outflow')) {
      expenseCents += tx.amountCents;
      categoryNets.set(tx.categoryId, (categoryNets.get(tx.categoryId) ?? 0) + tx.amountCents);
    } else if (countsToward(tx, 'refund', 'inflow')) {
      refundCents += tx.amountCents;
      categoryNets.set(tx.categoryId, (categoryNets.get(tx.categoryId) ?? 0) - tx.amountCents);
    } else if (tx.kind === 'transfer') {
      if (tx.direction === 'outflow') transferOutflowCents += tx.amountCents;
      else transferInflowCents += tx.amountCents;
    } else if (tx.kind === 'debt_payment') {
      if (tx.direction === 'outflow') debtOutflowCents += tx.amountCents;
      else debtInflowCents += tx.amountCents;
    } else unreviewedCount += 1;
  }

  const names = new Map(input.categories.map((category) => [category.id, category.name]));
  const periodTargets = input.targets.filter((target) => target.period === input.periodKind);
  const targetByCategory = new Map(periodTargets.map((target) => [target.categoryId, target]));
  const categoryIds = new Set<string | null>([...categoryNets.keys(), ...periodTargets.map((target) => target.categoryId)]);
  const byCategory = [...categoryIds]
    .map((categoryId) => {
      const target = categoryId ? targetByCategory.get(categoryId) : undefined;
      return {
        categoryId,
        name: categoryId ? (names.get(categoryId) ?? 'Category') : 'Uncategorized',
        netCents: categoryNets.get(categoryId) ?? 0,
        target: target ? { id: target.id, amountCents: target.amountCents } : null,
      };
    })
    .filter((row) => row.netCents !== 0 || row.target)
    .sort((a, b) => {
      if (a.target && !b.target) return -1;
      if (!a.target && b.target) return 1;
      return Math.abs(b.netCents) - Math.abs(a.netCents) || a.name.localeCompare(b.name);
    });

  const currentWeek = weekContaining(denverToday(input.now));
  let weekEarnings = 0;
  let withheldCount = 0;
  for (const tx of input.transactions) {
    if (tx.voided || !inRange(tx.postedOn, currentWeek) || tx.direction !== 'inflow') continue;
    if (tx.pending || tx.kind === 'unreviewed') {
      withheldCount += 1;
      continue;
    }
    if (tx.kind === 'income') weekEarnings += tx.amountCents;
  }
  const paidCents = input.payments
    .filter((payment) => payment.weekStart === currentWeek.start)
    .reduce((sum, payment) => sum + payment.amountCents, 0);
  const tithing: TithingModel = resolveTithing({
    weekStart: currentWeek.start,
    weekLabel: formatPeriodLabel('week', currentWeek),
    earnedCents: weekEarnings,
    bps: input.tithingBps,
    paidCents,
    markedCovered: input.coveredWeeks.includes(currentWeek.start),
    withheldCount,
  });

  const worth = netWorthFigures(input.balances, input.customItems);
  const status = freshnessStatus(input.freshness);
  const recent = [...input.transactions]
    .filter((tx) => !tx.voided)
    .sort((a, b) => b.postedOn.localeCompare(a.postedOn) || b.id.localeCompare(a.id))
    .slice(0, 40)
    .map((tx) => ({
      id: tx.id,
      postedOn: tx.postedOn,
      merchantLabel: tx.merchantLabel,
      amountCents: tx.amountCents,
      direction: tx.direction,
      kind: tx.kind,
      categoryId: tx.categoryId,
      categoryName: tx.categoryId ? (names.get(tx.categoryId) ?? null) : null,
      pending: tx.pending,
      reviewReasons: tx.reviewReasons,
    }));

  return {
    timezone: 'America/Denver' as const,
    generatedAt: input.now.toISOString(),
    period: {
      kind: input.periodKind,
      start: range.start,
      end: range.end,
      label: formatPeriodLabel(input.periodKind, range),
    },
    freshness: {
      status,
      balancesAsOf: input.freshness.balancesAsOf,
      balancesAsOfLabel: labelOrNull(input.freshness.balancesAsOf),
      lastImportedAt: input.freshness.lastImportedAt,
      lastImportedLabel: labelOrNull(input.freshness.lastImportedAt),
      lastFailureAt: input.freshness.lastFailureAt,
      lastFailureLabel: labelOrNull(input.freshness.lastFailureAt),
      lastFailureCode: input.freshness.lastFailureCode,
      pendingRefreshRequestedAt: input.freshness.pendingRefreshRequestedAt,
      pendingRefreshLabel: labelOrNull(input.freshness.pendingRefreshRequestedAt),
    },
    tithing: { ...tithing, label: tithingStatusLabel(tithing) },
    earningsCents,
    spending: {
      expenseCents,
      refundCents,
      netCents: expenseCents - refundCents,
      transferOutflowCents,
      transferInflowCents,
      debtOutflowCents,
      debtInflowCents,
      unreviewedCount,
      pendingCount,
      byCategory,
      targetsConfigured: periodTargets.length > 0,
    },
    netWorth: {
      ...worth,
      hasBankBalances: input.balances.length > 0,
      accounts: input.balances.map((balance) => ({
        ...balance,
        asOfLabel: formatDenverTimestamp(balance.asOf),
      })),
      customItems: input.customItems,
    },
    recent,
    reviewQueue: input.transactions
      .filter((tx) => !tx.voided && !tx.pending && (tx.kind === 'unreviewed' || (tx.kind === 'income' && tx.direction !== 'inflow') || (tx.kind === 'expense' && tx.direction !== 'outflow') || (tx.kind === 'refund' && tx.direction !== 'inflow')))
      .sort((a, b) => b.postedOn.localeCompare(a.postedOn) || b.id.localeCompare(a.id))
      .slice(0, 20)
      .map((tx) => ({
        id: tx.id,
        postedOn: tx.postedOn,
        merchantLabel: tx.merchantLabel,
        amountCents: tx.amountCents,
        direction: tx.direction,
        reviewReasons: tx.reviewReasons,
      })),
    settings: { tithingBps: input.tithingBps },
    payments: input.payments.filter((payment) => payment.weekStart === currentWeek.start),
    display: {
      earnings: formatUsd(earningsCents),
      netSpend: formatUsd(expenseCents - refundCents),
      netWorth: formatUsd(worth.netCents),
    },
  };
}

export function emailCategoryTotals(input: {
  transactions: ClassifiedTx[];
  categories: { id: string; name: string }[];
  range: DateRange;
}): { name: string; totalCents: number }[] {
  const names = new Map(input.categories.map((category) => [category.id, category.name]));
  const totals = new Map<string, number>();
  for (const tx of input.transactions) {
    if (tx.voided || tx.pending || !inRange(tx.postedOn, input.range)) continue;
    const key = tx.categoryId ? (names.get(tx.categoryId) ?? 'Category') : 'Uncategorized';
    if (tx.kind === 'expense' && tx.direction === 'outflow') totals.set(key, (totals.get(key) ?? 0) + tx.amountCents);
    else if (tx.kind === 'refund' && tx.direction === 'inflow') totals.set(key, (totals.get(key) ?? 0) - tx.amountCents);
  }
  return [...totals.entries()]
    .filter(([, total]) => total !== 0)
    .map(([name, totalCents]) => ({ name, totalCents }))
    .sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents) || a.name.localeCompare(b.name));
}
