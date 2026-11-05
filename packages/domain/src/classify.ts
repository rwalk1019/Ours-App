import { daysBetween, parseCivilDate } from './denver.js';

export const ACCOUNT_KINDS = ['depository', 'credit', 'loan', 'investment', 'other'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const TX_KINDS = ['income', 'expense', 'refund', 'transfer', 'debt_payment', 'unreviewed'] as const;
export type TxKind = (typeof TX_KINDS)[number];

export const PROVIDER_KINDS = ['income', 'expense', 'refund', 'transfer', 'debt_payment'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type Direction = 'inflow' | 'outflow';

export type ClassifiableTx = {
  externalId: string;
  accountExternalId: string;
  postedOn: string;
  amountCents: number;
  direction: Direction;
  pending: boolean;
  voided: boolean;
  merchantLabel: string | null;
  description: string | null;
  providerKind: ProviderKind | null;
};

export type FixRuleInput = {
  id: string;
  pattern: string;
  matchField: 'merchant' | 'description';
  categoryId: string;
  kindOverride: TxKind | null;
  priority: number;
};

export type TxLock = {
  externalId: string;
  kind: TxKind;
  categoryId: string | null;
};

export type ClassifiedTx = ClassifiableTx & {
  kind: TxKind;
  kindSource: 'user' | 'rule' | 'provider' | 'matcher' | 'unreviewed';
  categoryId: string | null;
  categorySource: 'user' | 'rule' | null;
  reviewReasons: string[];
  userLocked: boolean;
};

const PAIR_WINDOW_DAYS = 4;

function pushReason(reasons: string[], reason: string): string[] {
  return reasons.includes(reason) ? reasons : [...reasons, reason];
}

function matchRule(tx: ClassifiableTx, rules: FixRuleInput[]): FixRuleInput | null {
  for (const rule of rules) {
    const haystack = (rule.matchField === 'merchant' ? tx.merchantLabel : tx.description) ?? '';
    if (haystack.toLowerCase().includes(rule.pattern.trim().toLowerCase())) return rule;
  }
  return null;
}

/**
 * Classify bank rows without inventing a category or an earnings label.
 * Internal pairs and explicit provider kinds are used. Anything else stays unreviewed.
 * User locks and Fix rules win over the matcher.
 */
export function classifyTransactions(args: {
  accounts: { externalId: string; kind: AccountKind }[];
  transactions: ClassifiableTx[];
  rules: FixRuleInput[];
  locks: TxLock[];
}): ClassifiedTx[] {
  const accountKind = new Map(args.accounts.map((account) => [account.externalId, account.kind]));
  const locks = new Map(args.locks.map((lock) => [lock.externalId, lock]));
  const rules = [...args.rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  type Work = ClassifiedTx & { paired: boolean };
  const work: Work[] = args.transactions.map((tx) => {
    const lock = locks.get(tx.externalId);
    if (lock) {
      return {
        ...tx,
        kind: lock.kind,
        kindSource: 'user',
        categoryId: lock.categoryId,
        categorySource: lock.categoryId ? 'user' : null,
        reviewReasons: [],
        userLocked: true,
        paired: false,
      };
    }
    return {
      ...tx,
      kind: tx.providerKind ?? 'unreviewed',
      kindSource: tx.providerKind ? 'provider' : 'unreviewed',
      categoryId: null,
      categorySource: null,
      reviewReasons: tx.providerKind ? [] : ['no_confident_kind'],
      userLocked: false,
      paired: false,
    };
  });

  const byAmount = new Map<number, Work[]>();
  for (const tx of work) {
    if (tx.userLocked || tx.pending || tx.voided) continue;
    const list = byAmount.get(tx.amountCents) ?? [];
    list.push(tx);
    byAmount.set(tx.amountCents, list);
  }

  for (const group of byAmount.values()) {
    const used = new Set<string>();
    const outflows = group
      .filter((tx) => tx.direction === 'outflow')
      .sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.externalId.localeCompare(b.externalId));
    const inflows = group
      .filter((tx) => tx.direction === 'inflow')
      .sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.externalId.localeCompare(b.externalId));

    for (const outflow of outflows) {
      if (used.has(outflow.externalId)) continue;
      const outKind = accountKind.get(outflow.accountExternalId);
      const scored = inflows
        .filter((inflow) => !used.has(inflow.externalId))
        .map((inflow) => {
          const days = Math.abs(daysBetween(parseCivilDate(outflow.postedOn), parseCivilDate(inflow.postedOn)));
          const inKind = accountKind.get(inflow.accountExternalId);
          const debt =
            (outKind === 'depository' || outKind === 'investment') && (inKind === 'credit' || inKind === 'loan');
          return {
            inflow,
            days,
            debt,
            sameHousehold: outflow.accountExternalId !== inflow.accountExternalId,
          };
        })
        .filter((candidate) => candidate.sameHousehold && candidate.days <= PAIR_WINDOW_DAYS);

      if (scored.length === 0) continue;
      scored.sort((a, b) => {
        if (a.debt !== b.debt) return a.debt ? -1 : 1;
        if (a.days !== b.days) return a.days - b.days;
        return a.inflow.externalId.localeCompare(b.inflow.externalId);
      });
      const best = scored[0];
      if (!best) continue;
      const tied = scored.filter((candidate) => candidate.debt === best.debt && candidate.days === best.days);
      if (tied.length > 1) {
        const parties = [outflow, ...tied.map((candidate) => candidate.inflow)];
        for (const party of parties) {
          party.kind = 'unreviewed';
          party.kindSource = 'unreviewed';
          party.reviewReasons = pushReason(party.reviewReasons, 'ambiguous_transfer_match');
          used.add(party.externalId);
        }
        continue;
      }

      const pairKind: TxKind = best.debt ? 'debt_payment' : 'transfer';
      const reason = pairKind === 'debt_payment' ? 'paired_debt_payment' : 'paired_transfer';
      for (const side of [outflow, best.inflow]) {
        side.kind = pairKind;
        side.kindSource = 'matcher';
        side.paired = true;
        side.reviewReasons = pushReason(
          side.reviewReasons.filter((item) => item !== 'no_confident_kind'),
          reason,
        );
        used.add(side.externalId);
      }
    }
  }

  for (const tx of work) {
    if (tx.userLocked || tx.voided) continue;
    if (!tx.paired && tx.providerKind === 'transfer') {
      tx.reviewReasons = pushReason(tx.reviewReasons, 'unpaired_provider_transfer');
    }
    if (!tx.paired && tx.providerKind === 'debt_payment') {
      tx.reviewReasons = pushReason(tx.reviewReasons, 'unpaired_provider_debt_payment');
    }
    const rule = matchRule(tx, rules);
    if (!rule) continue;
    tx.categoryId = rule.categoryId;
    tx.categorySource = 'rule';
    if (rule.kindOverride) {
      tx.kind = rule.kindOverride;
      tx.kindSource = 'rule';
      tx.reviewReasons = tx.reviewReasons.filter((reason) => reason !== 'no_confident_kind');
    }
  }

  return work.map(({ paired: _paired, ...tx }) => tx);
}
