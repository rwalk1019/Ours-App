import { ACCOUNT_KINDS, PROVIDER_KINDS, type AccountKind, type ProviderKind } from './classify.js';
import { ContractError, denverCivilFromInstant, formatCivilDate, parseCivilDate } from './denver.js';
import { decimalStringToCents, isSafeCents } from './money.js';

export const SNAPSHOT_VERSION = 1;
export const COMPLETED_SNAPSHOTS_TO_KEEP = 5;
export const MAX_TRANSACTIONS = 20_000;
export const MAX_ACCOUNTS = 100;

const FORBIDDEN_KEYS = new Set([
  'accountnumber',
  'account_number',
  'routingnumber',
  'routing_number',
  'iban',
  'secret',
  'accesstoken',
  'access_token',
  'password',
  'passwd',
  'email',
  'owneremail',
  'owner_email',
  'ssn',
  'token',
  'mask',
  'plaid',
  'client_id',
  'secret_key',
]);

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

export type CanonicalAccount = {
  externalId: string;
  label: string;
  kind: AccountKind;
  currency: 'USD';
};

export type CanonicalBalance = {
  accountExternalId: string;
  asOf: string;
  assetCents: number;
  owedCents: number;
  availableCents: number | null;
  note: string | null;
};

export type CanonicalTransaction = {
  externalId: string;
  accountExternalId: string;
  postedOn: string;
  postedAt: string | null;
  amountCents: number;
  direction: 'inflow' | 'outflow';
  pending: boolean;
  voided: boolean;
  merchantLabel: string | null;
  description: string | null;
  providerKind: ProviderKind | null;
  replacesExternalId: string | null;
};

export type CanonicalSnapshot = {
  format: 'ours.snapshot';
  version: 1;
  balancesAsOf: string;
  accounts: CanonicalAccount[];
  balances: CanonicalBalance[];
  transactions: CanonicalTransaction[];
};

export type ParsedSnapshot = {
  snapshot: CanonicalSnapshot;
  dateOnlyCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectForbidden(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbidden(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new ContractError('forbidden_field', key);
    rejectForbidden(child);
  }
}

export function containsAccountNumber(value: string): boolean {
  const runs = value.match(/\d[\d\s-]{10,}\d/g);
  return Boolean(runs?.some((run) => run.replace(/\D/g, '').length >= 12));
}

export function isUnsafeLabel(value: string): boolean {
  return containsAccountNumber(value) || /https?:|www\.|@/i.test(value);
}

function cleanLabel(value: unknown, field: string, max = 80): string {
  if (typeof value !== 'string') throw new ContractError('invalid_shape', field);
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < 1 || text.length > max) throw new ContractError('invalid_shape', field);
  if (containsAccountNumber(text)) throw new ContractError('unsafe_account_number', field);
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value == null || value === '') return null;
  return cleanLabel(value, field, max);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new ContractError('invalid_shape', field);
  if (containsAccountNumber(value)) throw new ContractError('unsafe_account_number', field);
  return value;
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
    throw new ContractError('invalid_timestamp', field);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new ContractError('invalid_timestamp', field);
  return instant.toISOString();
}

function requireAccountKind(value: unknown): AccountKind {
  if (typeof value !== 'string' || !ACCOUNT_KINDS.includes(value as AccountKind)) {
    throw new ContractError('invalid_shape', 'kind');
  }
  return value as AccountKind;
}

function requireProviderKind(value: unknown): ProviderKind | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !PROVIDER_KINDS.includes(value as ProviderKind)) {
    throw new ContractError('invalid_shape', 'providerKind');
  }
  return value as ProviderKind;
}

function requireDirection(value: unknown): 'inflow' | 'outflow' {
  if (value !== 'inflow' && value !== 'outflow') throw new ContractError('invalid_shape', 'direction');
  return value;
}

function requireNonNegativeCents(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !isSafeCents(value)) {
    throw new ContractError('amount_not_cents', field);
  }
  return value;
}

function requireSignedCents(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !isSafeCents(value)) {
    throw new ContractError('amount_not_cents', field);
  }
  return value;
}

function assertPostedOn(postedOn: string, postedAt: string | null): void {
  parseCivilDate(postedOn);
  if (!postedAt) return;
  const derived = formatCivilDate(denverCivilFromInstant(new Date(postedAt)));
  if (derived !== postedOn) throw new ContractError('posted_on_timezone_mismatch', 'postedOn');
}

function normalizeBalances(accounts: CanonicalAccount[], balances: CanonicalBalance[], balancesAsOf: string): string {
  if (balances.length !== accounts.length) throw new ContractError('missing_balance');
  const seen = new Set<string>();
  let earliest: string | null = null;
  for (const balance of balances) {
    if (!accounts.some((account) => account.externalId === balance.accountExternalId)) {
      throw new ContractError('unknown_account', 'balances');
    }
    if (seen.has(balance.accountExternalId)) throw new ContractError('invalid_shape', 'balances');
    seen.add(balance.accountExternalId);
    if (earliest === null || balance.asOf < earliest) earliest = balance.asOf;
  }
  if (earliest !== balancesAsOf) throw new ContractError('balances_as_of_mismatch');
  return balancesAsOf;
}

function finish(snapshot: CanonicalSnapshot, dateOnlyCount: number): ParsedSnapshot {
  normalizeBalances(snapshot.accounts, snapshot.balances, snapshot.balancesAsOf);
  const txIds = new Set<string>();
  for (const tx of snapshot.transactions) {
    if (txIds.has(tx.externalId)) throw new ContractError('duplicate_external_id');
    txIds.add(tx.externalId);
    if (!snapshot.accounts.some((account) => account.externalId === tx.accountExternalId)) {
      throw new ContractError('unknown_account', 'transactions');
    }
    if (tx.replacesExternalId && tx.replacesExternalId === tx.externalId) {
      throw new ContractError('invalid_shape', 'replacesExternalId');
    }
  }
  return { snapshot, dateOnlyCount };
}

function parseCanonical(input: Record<string, unknown>): ParsedSnapshot {
  if (input.version !== SNAPSHOT_VERSION) throw new ContractError('unsupported_version');
  const balancesAsOf = requireIso(input.balancesAsOf, 'balancesAsOf');
  if (!Array.isArray(input.accounts) || !Array.isArray(input.balances) || !Array.isArray(input.transactions)) {
    throw new ContractError('invalid_shape');
  }
  if (input.accounts.length < 1 || input.accounts.length > MAX_ACCOUNTS) throw new ContractError('invalid_shape', 'accounts');
  if (input.transactions.length > MAX_TRANSACTIONS) throw new ContractError('too_many_transactions');

  const accounts: CanonicalAccount[] = input.accounts.map((raw) => {
    if (!isRecord(raw)) throw new ContractError('invalid_shape', 'accounts');
    if (raw.currency !== 'USD') throw new ContractError('invalid_shape', 'currency');
    return {
      externalId: requireId(raw.externalId, 'externalId'),
      label: cleanLabel(raw.label, 'label'),
      kind: requireAccountKind(raw.kind),
      currency: 'USD',
    };
  });
  if (new Set(accounts.map((account) => account.externalId)).size !== accounts.length) {
    throw new ContractError('duplicate_external_id');
  }

  const balances: CanonicalBalance[] = input.balances.map((raw) => {
    if (!isRecord(raw)) throw new ContractError('invalid_shape', 'balances');
    const assetCents = requireSignedCents(raw.assetCents, 'assetCents');
    const owedCents = requireNonNegativeCents(raw.owedCents, 'owedCents');
    if (assetCents !== 0 && owedCents !== 0) throw new ContractError('invalid_shape', 'balances');
    let availableCents: number | null = null;
    if (raw.availableCents != null) availableCents = requireSignedCents(raw.availableCents, 'availableCents');
    return {
      accountExternalId: requireId(raw.accountExternalId, 'accountExternalId'),
      asOf: requireIso(raw.asOf, 'asOf'),
      assetCents,
      owedCents,
      availableCents,
      note: optionalText(raw.note, 'note', 80),
    };
  });

  let dateOnlyCount = 0;
  const transactions: CanonicalTransaction[] = input.transactions.map((raw) => {
    if (!isRecord(raw)) throw new ContractError('invalid_shape', 'transactions');
    const postedOn = typeof raw.postedOn === 'string' ? raw.postedOn : '';
    parseCivilDate(postedOn);
    const postedAt = raw.postedAt == null || raw.postedAt === '' ? null : requireIso(raw.postedAt, 'postedAt');
    if (!postedAt) dateOnlyCount += 1;
    assertPostedOn(postedOn, postedAt);
    return {
      externalId: requireId(raw.externalId, 'externalId'),
      accountExternalId: requireId(raw.accountExternalId, 'accountExternalId'),
      postedOn,
      postedAt,
      amountCents: requireNonNegativeCents(raw.amountCents, 'amountCents'),
      direction: requireDirection(raw.direction),
      pending: raw.pending === true,
      voided: raw.voided === true,
      merchantLabel: optionalText(raw.merchantLabel, 'merchantLabel', 120),
      description: optionalText(raw.description, 'description', 500),
      providerKind: requireProviderKind(raw.providerKind),
      replacesExternalId:
        raw.replacesExternalId == null || raw.replacesExternalId === ''
          ? null
          : requireId(raw.replacesExternalId, 'replacesExternalId'),
    };
  });

  return finish({ format: 'ours.snapshot', version: 1, balancesAsOf, accounts, balances, transactions }, dateOnlyCount);
}

function plaidDirection(cents: number): { amountCents: number; direction: 'inflow' | 'outflow' } {
  if (cents === 0) return { amountCents: 0, direction: 'outflow' };
  if (cents > 0) return { amountCents: cents, direction: 'outflow' };
  return { amountCents: -cents, direction: 'inflow' };
}

function plaidBalance(kind: AccountKind, currentCents: number, availableRaw: unknown): Pick<CanonicalBalance, 'assetCents' | 'owedCents' | 'availableCents' | 'note'> {
  let availableCents: number | null = null;
  if (typeof availableRaw === 'string') {
    const parsed = decimalStringToCents(availableRaw);
    if (parsed === null) throw new ContractError('amount_not_cents', 'available');
    availableCents = parsed;
  } else if (availableRaw != null) {
    throw new ContractError('amount_not_cents', 'available');
  }
  if (kind === 'credit' || kind === 'loan') {
    if (currentCents >= 0) return { assetCents: 0, owedCents: currentCents, availableCents, note: null };
    return { assetCents: -currentCents, owedCents: 0, availableCents, note: 'credit_balance_in_favor' };
  }
  return { assetCents: currentCents, owedCents: 0, availableCents, note: currentCents < 0 ? 'overdraft' : null };
}

function parseConnector(input: Record<string, unknown>): ParsedSnapshot {
  if (input.version !== 1) throw new ContractError('unsupported_version');
  if (input.signConvention !== 'plaid') throw new ContractError('sign_convention_required');
  if (!Array.isArray(input.accounts) || !Array.isArray(input.balances) || !Array.isArray(input.transactions)) {
    throw new ContractError('invalid_shape');
  }
  const balancesAsOf = requireIso(input.balancesAsOf, 'balancesAsOf');
  if (input.accounts.length < 1 || input.accounts.length > MAX_ACCOUNTS) throw new ContractError('invalid_shape', 'accounts');
  if (input.transactions.length > MAX_TRANSACTIONS) throw new ContractError('too_many_transactions');

  const accounts: CanonicalAccount[] = input.accounts.map((raw) => {
    if (!isRecord(raw)) throw new ContractError('invalid_shape', 'accounts');
    const id = requireId(raw.id, 'id');
    return {
      externalId: id,
      label: cleanLabel(raw.name ?? raw.label, 'name'),
      kind: requireAccountKind(raw.type ?? raw.kind),
      currency: 'USD',
    };
  });

  const balances: CanonicalBalance[] = input.balances.map((raw) => {
    if (!isRecord(raw)) throw new ContractError('invalid_shape', 'balances');
    const accountExternalId = requireId(raw.accountId ?? raw.accountExternalId, 'accountId');
    const account = accounts.find((item) => item.externalId === accountExternalId);
    if (!account) throw new ContractError('unknown_account', 'balances');
    if (typeof raw.current !== 'string') throw new ContractError('amount_not_cents', 'current');
    const current = decimalStringToCents(raw.current);
    if (current === null) throw new ContractError('amount_not_cents', 'current');
    const asOf = raw.asOf == null ? balancesAsOf : requireIso(raw.asOf, 'asOf');
    return {
      accountExternalId,
      asOf,
      ...plaidBalance(account.kind, current, raw.available),
    };
  });

  let dateOnlyCount = 0;
  const transactions: CanonicalTransaction[] = input.transactions.map((raw) => {
    if (!isRecord(raw)) throw new ContractError('invalid_shape', 'transactions');
    if (typeof raw.amount !== 'string') throw new ContractError('amount_not_cents', 'amount');
    const signed = decimalStringToCents(raw.amount);
    if (signed === null) throw new ContractError('amount_not_cents', 'amount');
    const { amountCents, direction } = plaidDirection(signed);
    let postedOn: string;
    let postedAt: string | null = null;
    if (typeof raw.postedAt === 'string') {
      postedAt = requireIso(raw.postedAt, 'postedAt');
      postedOn = formatCivilDate(denverCivilFromInstant(new Date(postedAt)));
    } else if (typeof raw.date === 'string') {
      postedOn = raw.date;
      parseCivilDate(postedOn);
      dateOnlyCount += 1;
    } else {
      throw new ContractError('invalid_date', 'date');
    }
    const accountExternalId = requireId(raw.accountId ?? raw.accountExternalId, 'accountId');
    return {
      externalId: requireId(raw.id ?? raw.externalId, 'id'),
      accountExternalId,
      postedOn,
      postedAt,
      amountCents,
      direction,
      pending: raw.pending === true,
      voided: raw.voided === true,
      merchantLabel: optionalText(raw.name ?? raw.merchantLabel, 'name', 120),
      description: optionalText(raw.description, 'description', 500),
      providerKind: requireProviderKind(raw.providerKind),
      replacesExternalId:
        raw.replacesExternalId == null || raw.replacesExternalId === ''
          ? null
          : requireId(raw.replacesExternalId, 'replacesExternalId'),
    };
  });

  const earliest = balances.reduce<string | null>((min, balance) => (min === null || balance.asOf < min ? balance.asOf : min), null);
  return finish(
    {
      format: 'ours.snapshot',
      version: 1,
      balancesAsOf: earliest ?? balancesAsOf,
      accounts,
      balances,
      transactions,
    },
    dateOnlyCount,
  );
}

export function parseSnapshotDocument(input: unknown): ParsedSnapshot {
  rejectForbidden(input);
  if (!isRecord(input)) throw new ContractError('invalid_shape');
  if (input.format === 'ours.snapshot') return parseCanonical(input);
  if (input.format === 'finance-connector-export') return parseConnector(input);
  throw new ContractError('unsupported_version');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

export async function fingerprintSnapshot(snapshot: CanonicalSnapshot): Promise<string> {
  const core = {
    version: snapshot.version,
    balancesAsOf: snapshot.balancesAsOf,
    accounts: [...snapshot.accounts].sort((a, b) => a.externalId.localeCompare(b.externalId)),
    balances: [...snapshot.balances].sort((a, b) => a.accountExternalId.localeCompare(b.accountExternalId)),
    transactions: [...snapshot.transactions].sort((a, b) => a.externalId.localeCompare(b.externalId)),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(sortValue(core)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
