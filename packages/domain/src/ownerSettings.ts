import { classifyTransactions, type ClassifiableTx, type FixRuleInput } from './classify.js';
import { denverToday } from './denver.js';
import { tithingDueCents } from './money.js';
import { inRange, weekContaining } from './periods.js';
import { resolveTithing, tithingStatusLabel, type TithingModel } from './tithing.js';

export type SettingsPresence = {
  weekly_target: number | null;
  tithing_percent: number | null;
  tithing_category: string | null;
};

/**
 * Saved settings are whatever rows exist. The server's 150 / 10 / "Tithing" fallbacks
 * are not treated as the owner's choices when the rows are missing or the presence
 * check is unavailable.
 */
export function confirmedOwnerSettings(presence: SettingsPresence | 'unavailable'): {
  weeklyTarget: number | null;
  tithingPercent: number | null;
  tithingCategory: string | null;
  confirmationAvailable: boolean;
} {
  if (presence === 'unavailable') {
    return { weeklyTarget: null, tithingPercent: null, tithingCategory: null, confirmationAvailable: false };
  }
  return {
    weeklyTarget: numberOrNull(presence.weekly_target),
    tithingPercent: numberOrNull(presence.tithing_percent),
    tithingCategory: typeof presence.tithing_category === 'string' && presence.tithing_category.trim() ? presence.tithing_category : null,
    confirmationAvailable: true,
  };
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
  weeklyTarget: number | null;
  transactions: ClassifiableTx[] | null;
  rules: { match: string; category: string }[];
}): {
  tithing: { state: string; label: string };
  weekNetSpendCents: number | null;
} {
  if (!input.transactions) {
    return {
      tithing: input.tithingPercent == null
        ? { state: 'unknown_earnings', label: 'Set a percent' }
        : { state: 'unknown_earnings', label: 'Earnings not in this snapshot' },
      weekNetSpendCents: null,
    };
  }
  const rules: FixRuleInput[] = input.rules.map((rule) => ({
    id: rule.match,
    pattern: rule.match,
    matchField: 'merchant',
    categoryId: rule.category,
    kindOverride: null,
    priority: 1,
  }));
  const classified = classifyTransactions({
    accounts: [{ externalId: 'account', kind: 'depository' }, { externalId: 'credit', kind: 'credit' }],
    transactions: input.transactions,
    rules,
    locks: [],
  });
  const week = weekContaining(denverToday(input.now));
  let earned = 0;
  let expense = 0;
  let refund = 0;
  for (const tx of classified) {
    if (tx.voided || tx.pending || !inRange(tx.postedOn, week)) continue;
    if (tx.kind === 'income' && tx.direction === 'inflow') earned += tx.amountCents;
    if (tx.kind === 'expense' && tx.direction === 'outflow') expense += tx.amountCents;
    if (tx.kind === 'refund' && tx.direction === 'inflow') refund += tx.amountCents;
  }
  const tithing = input.tithingPercent == null
    ? resolveTithing({ weekStart: week.start, weekLabel: week.start, earnedCents: earned, bps: null, paidCents: 0, markedCovered: false, withheldCount: 0 })
    : resolveTithing({
        weekStart: week.start,
        weekLabel: week.start,
        earnedCents: earned,
        bps: Math.round(input.tithingPercent * 100),
        paidCents: 0,
        markedCovered: false,
        withheldCount: 0,
      });
  return {
    tithing: { ...tithing, label: tithingStatusLabel(tithing) },
    weekNetSpendCents: expense - refund,
  };
}

export function tithingDueFromPercent(earnedCents: number, percent: number): number {
  return tithingDueCents(earnedCents, Math.round(percent * 100));
}
