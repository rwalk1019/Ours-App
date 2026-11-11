import { classifyTransactions, type ClassifiableTx, type ClassifiedTx, type FixRuleInput } from './classify.js';
import { denverToday } from './denver.js';
import { tithingDueCents } from './money.js';
import { inRange, monthContaining, weekContaining } from './periods.js';
import { resolveTithing, tithingStatusLabel } from './tithing.js';

export type SettingsPresence = {
  weekly_target?: unknown;
  tithing_percent?: unknown;
  tithing_category?: unknown;
  tithing_period?: unknown;
  tithing_income_sources?: unknown;
  tithing_payment_match?: unknown;
};

export type ConfirmedOwnerSettings = {
  weeklyTarget: number | null;
  tithingPercent: number | null;
  tithingCategory: string | null;
  /** Set only when the saved period is monthly. A missing key is not treated as weekly. */
  tithingPeriod: 'month' | null;
  incomeSources: string[] | null;
  paymentMatches: string[] | null;
  filtersReadable: boolean;
  confirmationAvailable: boolean;
};

const unconfirmed: ConfirmedOwnerSettings = {
  weeklyTarget: null,
  tithingPercent: null,
  tithingCategory: null,
  tithingPeriod: null,
  incomeSources: null,
  paymentMatches: null,
  filtersReadable: true,
  confirmationAvailable: false,
};

/**
 * Saved settings are whatever rows exist. The server's 150 / 10 / "Tithing" fallbacks
 * are not treated as the owner's choices when the rows are missing or the presence
 * check is unavailable.
 */
export function confirmedOwnerSettings(presence: SettingsPresence | 'unavailable'): ConfirmedOwnerSettings {
  if (presence === 'unavailable') return { ...unconfirmed };
  const period = readPeriod(presence.tithing_period);
  const income = readMatchers(presence.tithing_income_sources);
  const payments = readMatchers(presence.tithing_payment_match);
  return {
    weeklyTarget: numberOrNull(presence.weekly_target),
    tithingPercent: numberOrNull(presence.tithing_percent),
    tithingCategory: typeof presence.tithing_category === 'string' && presence.tithing_category.trim() ? presence.tithing_category : null,
    tithingPeriod: period === 'month' ? 'month' : null,
    incomeSources: income.kind === 'list' ? income.values : null,
    paymentMatches: payments.kind === 'list' ? payments.values : null,
    filtersReadable: period !== 'unreadable' && income.kind !== 'unreadable' && payments.kind !== 'unreadable',
    confirmationAvailable: true,
  };
}

function readPeriod(value: unknown): 'month' | 'missing' | 'unreadable' {
  if (value == null) return 'missing';
  const text = typeof value === 'string'
    ? value
    : isRecord(value) && typeof value.period === 'string'
      ? value.period
      : null;
  if (!text) return 'unreadable';
  const normalized = text.trim().toLowerCase();
  if (normalized === 'month' || normalized === 'monthly') return 'month';
  return 'unreadable';
}

function readMatchers(value: unknown): { kind: 'missing' } | { kind: 'list'; values: string[] } | { kind: 'unreadable' } {
  if (value == null) return { kind: 'missing' };
  if (typeof value === 'string') return { kind: 'list', values: value.trim() ? [value.trim()] : [] };
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        values.push(item.trim());
        continue;
      }
      if (isRecord(item)) {
        const text = ['match', 'key', 'name', 'label', 'source', 'pattern']
          .map((key) => item[key])
          .find((entry) => typeof entry === 'string' && entry.trim());
        if (typeof text === 'string') {
          values.push(text.trim());
          continue;
        }
      }
      return { kind: 'unreadable' };
    }
    return { kind: 'list', values };
  }
  if (isRecord(value)) {
    for (const key of ['sources', 'matches', 'keys', 'patterns', 'values']) {
      if (key in value) return readMatchers(value[key]);
    }
  }
  return { kind: 'unreadable' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export type LooseAccount = { label: string; amount: number | null; kind: string | null };

export function readLooseSnapshot(data: unknown): { recognizedTransactions: ClassifiableTx[] | null; accounts: LooseAccount[] } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { recognizedTransactions: null, accounts: [] };
  const record = data as Record<string, unknown>;
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const account = item as Record<string, unknown>;
        const label = typeof account.label === 'string' ? account.label : typeof account.name === 'string' ? account.name : null;
        if (!label) return [];
        const amount = typeof account.balance === 'number' ? account.balance : typeof account.current === 'number' ? account.current : null;
        const kind = typeof account.kind === 'string' ? account.kind : typeof account.type === 'string' ? account.type : null;
        return [{ label, amount, kind }];
      })
    : [];
  if (!Array.isArray(record.transactions)) return { recognizedTransactions: null, accounts };
  const transactions: ClassifiableTx[] = [];
  for (const item of record.transactions) {
    if (!item || typeof item !== 'object') return { recognizedTransactions: null, accounts };
    const tx = item as Record<string, unknown>;
    const externalId = typeof tx.externalId === 'string' ? tx.externalId : typeof tx.id === 'string' ? tx.id : null;
    const postedOn = typeof tx.postedOn === 'string' ? tx.postedOn : null;
    const direction = tx.direction === 'inflow' || tx.direction === 'outflow' ? tx.direction : null;
    const amountCents = typeof tx.amountCents === 'number' && Number.isInteger(tx.amountCents) ? tx.amountCents : null;
    if (!externalId || !postedOn || !direction || amountCents == null || amountCents < 0) {
      return { recognizedTransactions: null, accounts };
    }
    const providerKind = tx.providerKind === 'income' || tx.providerKind === 'expense' || tx.providerKind === 'refund' || tx.providerKind === 'transfer' || tx.providerKind === 'debt_payment'
      ? tx.providerKind
      : null;
    transactions.push({
      externalId,
      accountExternalId: typeof tx.accountExternalId === 'string' ? tx.accountExternalId : 'account',
      postedOn,
      amountCents,
      direction,
      pending: tx.pending === true,
      voided: tx.voided === true,
      merchantLabel: typeof tx.merchantLabel === 'string' ? tx.merchantLabel : null,
      description: typeof tx.description === 'string' ? tx.description : null,
      providerKind,
    });
  }
  return { recognizedTransactions: transactions, accounts };
}

export function ownerMoney(input: {
  now: Date;
  tithingPercent: number | null;
  tithingPeriod: 'month' | null;
  incomeSources: string[] | null;
  paymentMatches: string[] | null;
  filtersReadable: boolean;
  weeklyTarget: number | null;
  transactions: ClassifiableTx[] | null;
  rules: { match: string; category: string }[];
}): {
  tithing: { state: string; label: string };
  weekNetSpendCents: number | null;
} {
  const week = weekContaining(denverToday(input.now));
  if (!input.filtersReadable) {
    return { tithing: { state: 'unreadable', label: 'Saved tithing filters aren’t readable yet.' }, weekNetSpendCents: null };
  }
  if (input.tithingPercent == null) {
    return { tithing: { state: 'unconfigured', label: 'Set a percent' }, weekNetSpendCents: spendCents(input, week) };
  }
  if (input.tithingPeriod !== 'month') {
    return { tithing: { state: 'period_unconfirmed', label: 'Monthly period isn’t in the response yet.' }, weekNetSpendCents: spendCents(input, week) };
  }
  if (!input.transactions) {
    return { tithing: { state: 'unknown_earnings', label: 'Earnings not in this snapshot' }, weekNetSpendCents: null };
  }
  const classified = classifyForRules(input.transactions, input.rules);
  const month = monthContaining(denverToday(input.now));
  let earned = 0;
  let paid = 0;
  for (const tx of classified) {
    if (tx.voided || tx.pending || !inRange(tx.postedOn, month)) continue;
    if (tx.kind === 'income' && tx.direction === 'inflow' && listed(tx, input.incomeSources, true)) earned += tx.amountCents;
    if (tx.direction === 'outflow' && listed(tx, input.paymentMatches, false)) paid += tx.amountCents;
  }
  const tithing = resolveTithing({
    weekStart: month.start,
    weekLabel: month.start,
    earnedCents: earned,
    bps: Math.round(input.tithingPercent * 100),
    paidCents: paid,
    markedCovered: false,
    withheldCount: 0,
  });
  return {
    tithing: { state: tithing.state, label: tithingStatusLabel(tithing) },
    weekNetSpendCents: spendCents(input, week),
  };
}

function classifyForRules(transactions: ClassifiableTx[], rules: { match: string; category: string }[]): ClassifiedTx[] {
  const mapped: FixRuleInput[] = rules.map((rule) => ({
    id: rule.match,
    pattern: rule.match,
    matchField: 'merchant',
    categoryId: rule.category,
    kindOverride: null,
    priority: 1,
  }));
  return classifyTransactions({
    accounts: [{ externalId: 'account', kind: 'depository' }, { externalId: 'credit', kind: 'credit' }],
    transactions,
    rules: mapped,
    locks: [],
  });
}

function spendCents(input: { transactions: ClassifiableTx[] | null; rules: { match: string; category: string }[] }, week: { start: string; end: string }): number | null {
  if (!input.transactions) return null;
  let expense = 0;
  let refund = 0;
  for (const tx of classifyForRules(input.transactions, input.rules)) {
    if (tx.voided || tx.pending || !inRange(tx.postedOn, week)) continue;
    if (tx.kind === 'expense' && tx.direction === 'outflow') expense += tx.amountCents;
    if (tx.kind === 'refund' && tx.direction === 'inflow') refund += tx.amountCents;
  }
  return expense - refund;
}

/** Null income sources count every income row. Null payment matches count none. */
function listed(tx: ClassifiedTx, keys: string[] | null, whenMissing: boolean): boolean {
  if (keys == null) return whenMissing;
  if (keys.length === 0) return false;
  const haystack = [tx.merchantLabel, tx.description, tx.categoryId, tx.accountExternalId].filter(Boolean).join(' ').toLowerCase();
  return keys.some((key) => haystack.includes(key.toLowerCase()));
}

export function tithingDueFromPercent(earnedCents: number, percent: number): number {
  return tithingDueCents(earnedCents, Math.round(percent * 100));
}
