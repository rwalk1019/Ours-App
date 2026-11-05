import {
  COMPLETED_SNAPSHOTS_TO_KEEP,
  classifyTransactions,
  denverToday,
  fingerprintSnapshot,
  isMonday,
  parseCivilDate,
  type AccountKind,
  type CanonicalSnapshot,
  type HouseholdView,
  type PeriodKind,
  type ProviderKind,
  type TxKind,
  buildHouseholdView,
} from '@ours/domain';
import { formatCode, generateCode, hmacCode, sha256Text } from './crypto.js';
import type { Db } from './db.js';
import { asBool, asDay, asIso, asNumber, asStrings } from './values.js';
import { PublicError } from './errors.js';

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

type TxRow = {
  id: string;
  external_id: string;
  posted_on: unknown;
  amount_cents: unknown;
  direction: 'inflow' | 'outflow';
  pending: unknown;
  voided: unknown;
  merchant_label: string | null;
  description: string | null;
  provider_kind: ProviderKind | null;
  kind: TxKind;
  category_id: string | null;
  user_locked: unknown;
  account_external_id: string;
};

export async function issueDeviceSetupCode(db: Db, pepper: string, ttlSeconds: number, now: Date): Promise<string> {
  const raw = generateCode(12);
  const hash = await hmacCode(pepper, 'device_setup', raw);
  const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  await db.query(`INSERT INTO ours_setup_codes (code_hash, purpose, expires_at) VALUES ($1, 'device_setup', $2)`, [hash, expires]);
  return formatCode(raw, 4);
}

export async function issueImportToken(db: Db): Promise<string> {
  const { randomBytes, base64url } = await import('./crypto.js');
  const token = base64url(randomBytes(32));
  await db.query(`INSERT INTO ours_import_credentials (token_hash) VALUES ($1)`, [await sha256Text(token)]);
  return token;
}

export async function issueReportToken(db: Db): Promise<string> {
  const { randomBytes, base64url } = await import('./crypto.js');
  const token = base64url(randomBytes(32));
  await db.query(`INSERT INTO ours_report_credentials (token_hash) VALUES ($1)`, [await sha256Text(token)]);
  return token;
}

export async function tooManyFailures(db: Db, purpose: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS).toISOString();
  const result = await db.query<{ count: unknown }>(
    `SELECT count(*)::int AS count FROM ours_auth_attempts WHERE purpose = $1 AND succeeded = false AND created_at > $2`,
    [purpose, since],
  );
  return asNumber(result.rows[0]?.count ?? 0) >= MAX_FAILURES;
}

export async function recordAttempt(db: Db, purpose: string, succeeded: boolean, now: Date): Promise<void> {
  await db.query(`INSERT INTO ours_auth_attempts (purpose, succeeded, created_at) VALUES ($1, $2, $3)`, [
    purpose,
    succeeded,
    now.toISOString(),
  ]);
}

export async function reserveCode(db: Db, hash: string, purpose: string, now: Date, reserveMs: number): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `UPDATE ours_setup_codes
     SET reserved_until = $2
     WHERE code_hash = $1 AND purpose = $3 AND consumed_at IS NULL
       AND (expires_at IS NULL OR expires_at > $4)
       AND (reserved_until IS NULL OR reserved_until <= $4)
     RETURNING id`,
    [hash, new Date(now.getTime() + reserveMs).toISOString(), purpose, now.toISOString()],
  );
  return result.rows[0]?.id ?? null;
}

export async function consumeCode(db: Db, id: string, now: Date): Promise<boolean> {
  const result = await db.query(`UPDATE ours_setup_codes SET consumed_at = $2, reserved_until = NULL WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [
    id,
    now.toISOString(),
  ]);
  return result.rows.length > 0;
}

export async function usableCredentialCount(db: Db): Promise<number> {
  const result = await db.query<{ count: unknown }>(`SELECT count(*)::int AS count FROM ours_credentials WHERE clone_suspected_at IS NULL`);
  return asNumber(result.rows[0]?.count ?? 0);
}

export async function ensureUserHandle(db: Db): Promise<string> {
  const existing = await db.query<{ webauthn_user_handle: string | null }>(`SELECT webauthn_user_handle FROM ours_settings WHERE id = 1`);
  const handle = existing.rows[0]?.webauthn_user_handle;
  if (handle) return handle;
  const { randomBytes, base64url } = await import('./crypto.js');
  const created = base64url(randomBytes(32));
  await db.query(`UPDATE ours_settings SET webauthn_user_handle = $1 WHERE id = 1 AND webauthn_user_handle IS NULL`, [created]);
  const again = await db.query<{ webauthn_user_handle: string }>(`SELECT webauthn_user_handle FROM ours_settings WHERE id = 1`);
  const stored = again.rows[0]?.webauthn_user_handle;
  if (!stored) throw new Error('missing_user_handle');
  return stored;
}

export async function listCredentialIds(db: Db): Promise<{ credentialId: string; transports: string[] }[]> {
  const result = await db.query<{ credential_id: string; transports: unknown }>(
    `SELECT credential_id, transports FROM ours_credentials WHERE clone_suspected_at IS NULL ORDER BY created_at`,
  );
  return result.rows.map((row) => ({ credentialId: row.credential_id, transports: asStrings(row.transports) }));
}

export async function insertChallenge(
  db: Db,
  input: { challenge: string; kind: 'registration' | 'authentication'; rpId: string; origin: string; setupCodeId: string | null; expiresAt: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO ours_challenges (challenge, kind, rp_id, origin, setup_code_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.challenge, input.kind, input.rpId, input.origin, input.setupCodeId, input.expiresAt.toISOString()],
  );
}

export type ChallengeRow = {
  id: string;
  kind: 'registration' | 'authentication';
  rpId: string;
  origin: string;
  setupCodeId: string | null;
};

export async function takeChallenge(db: Db, challenge: string, now: Date): Promise<ChallengeRow | null> {
  const result = await db.query<{ id: string; kind: 'registration' | 'authentication'; rp_id: string; origin: string; setup_code_id: string | null }>(
    `UPDATE ours_challenges SET consumed_at = $2
     WHERE challenge = $1 AND consumed_at IS NULL AND expires_at > $2
     RETURNING id, kind, rp_id, origin, setup_code_id`,
    [challenge, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, rpId: row.rp_id, origin: row.origin, setupCodeId: row.setup_code_id };
}

export async function insertCredential(
  db: Db,
  input: { credentialId: string; publicKeyB64: string; counter: number; transports: string[]; deviceLabel: string },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO ours_credentials (credential_id, public_key_b64, counter, transports, device_label)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [input.credentialId, input.publicKeyB64, input.counter, JSON.stringify(input.transports), input.deviceLabel],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('missing_credential');
  return id;
}

export async function findCredential(db: Db, credentialId: string): Promise<{
  id: string;
  publicKeyB64: string;
  counter: number;
  cloneSuspected: boolean;
} | null> {
  const result = await db.query<{ id: string; public_key_b64: string; counter: unknown; clone_suspected_at: unknown }>(
    `SELECT id, public_key_b64, counter, clone_suspected_at FROM ours_credentials WHERE credential_id = $1`,
    [credentialId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    publicKeyB64: row.public_key_b64,
    counter: asNumber(row.counter),
    cloneSuspected: row.clone_suspected_at != null,
  };
}

export async function markClone(db: Db, credentialRowId: string, now: Date): Promise<void> {
  await db.query(`UPDATE ours_credentials SET clone_suspected_at = $2 WHERE id = $1 AND clone_suspected_at IS NULL`, [credentialRowId, now.toISOString()]);
  await db.query(`UPDATE ours_sessions SET revoked_at = $2 WHERE credential_id = $1 AND revoked_at IS NULL`, [credentialRowId, now.toISOString()]);
}

export async function updateCounter(db: Db, credentialRowId: string, counter: number, now: Date): Promise<void> {
  await db.query(`UPDATE ours_credentials SET counter = $2, last_used_at = $3 WHERE id = $1`, [credentialRowId, counter, now.toISOString()]);
}

export async function createSession(db: Db, credentialRowId: string, ttlSeconds: number, now: Date): Promise<string> {
  const { randomBytes, base64url } = await import('./crypto.js');
  const token = base64url(randomBytes(32));
  const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  await db.query(`INSERT INTO ours_sessions (token_hash, credential_id, expires_at) VALUES ($1, $2, $3)`, [
    await sha256Text(token),
    credentialRowId,
    expires,
  ]);
  return token;
}

export async function readSession(db: Db, token: string, now: Date): Promise<{ id: string } | null> {
  const result = await db.query<{ id: string; expires_at: unknown; revoked_at: unknown; clone_suspected_at: unknown }>(
    `SELECT s.id, s.expires_at, s.revoked_at, c.clone_suspected_at
     FROM ours_sessions s JOIN ours_credentials c ON c.id = s.credential_id
     WHERE s.token_hash = $1`,
    [await sha256Text(token)],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || row.clone_suspected_at) return null;
  const expires = asIso(row.expires_at);
  if (!expires || expires <= now.toISOString()) return null;
  return { id: row.id };
}

export async function revokeSession(db: Db, token: string, now: Date): Promise<void> {
  await db.query(`UPDATE ours_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`, [await sha256Text(token), now.toISOString()]);
}

export async function unusedRecoveryCount(db: Db): Promise<number> {
  const result = await db.query<{ count: unknown }>(
    `SELECT count(*)::int AS count FROM ours_setup_codes WHERE purpose = 'recovery' AND consumed_at IS NULL`,
  );
  return asNumber(result.rows[0]?.count ?? 0);
}

export async function issueRecoveryCodes(db: Db, pepper: string): Promise<string[]> {
  const codes: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const raw = generateCode(10);
    await db.query(`INSERT INTO ours_setup_codes (code_hash, purpose) VALUES ($1, 'recovery')`, [await hmacCode(pepper, 'recovery', raw)]);
    codes.push(formatCode(raw, 5));
  }
  return codes;
}

export async function rotateRecoveryCodes(db: Db, pepper: string, now: Date): Promise<string[]> {
  await db.query(`UPDATE ours_setup_codes SET consumed_at = $1 WHERE purpose = 'recovery' AND consumed_at IS NULL`, [now.toISOString()]);
  return issueRecoveryCodes(db, pepper);
}

export async function tokenMatches(db: Db, table: 'ours_import_credentials' | 'ours_report_credentials', token: string): Promise<boolean> {
  const result = await db.query(`SELECT id FROM ${table} WHERE token_hash = $1 AND revoked_at IS NULL`, [await sha256Text(token)]);
  return result.rows.length > 0;
}

async function settings(db: Db) {
  const result = await db.query<{
    tithing_bps: unknown;
    current_snapshot_id: string | null;
    last_import_completed_at: unknown;
    last_failure_at: unknown;
    last_failure_code: string | null;
  }>(`SELECT tithing_bps, current_snapshot_id, last_import_completed_at, last_failure_at, last_failure_code FROM ours_settings WHERE id = 1`);
  const row = result.rows[0];
  if (!row) throw new Error('missing_settings');
  return {
    tithingBps: row.tithing_bps == null ? null : asNumber(row.tithing_bps),
    currentSnapshotId: row.current_snapshot_id,
    lastImportCompletedAt: asIso(row.last_import_completed_at),
    lastFailureAt: asIso(row.last_failure_at),
    lastFailureCode: row.last_failure_code,
  };
}

async function transactionRows(db: Db): Promise<TxRow[]> {
  const result = await db.query<TxRow>(
    `SELECT t.id, t.external_id, t.posted_on, t.amount_cents, t.direction, t.pending, t.voided,
            t.merchant_label, t.description, t.provider_kind, t.kind, t.category_id, t.user_locked,
            a.external_id AS account_external_id
     FROM ours_transactions t JOIN ours_accounts a ON a.id = t.account_id`,
  );
  return result.rows;
}

export async function syncClassification(db: Db, now: Date): Promise<void> {
  const accounts = await db.query<{ external_id: string; kind: AccountKind }>(`SELECT external_id, kind FROM ours_accounts`);
  const rules = await db.query<{ id: string; pattern: string; match_field: 'merchant' | 'description'; category_id: string; kind_override: TxKind | null; priority: number }>(
    `SELECT id, pattern, match_field, category_id, kind_override, priority FROM ours_fix_rules`,
  );
  const rows = await transactionRows(db);
  const classified = classifyTransactions({
    accounts: accounts.rows.map((account) => ({ externalId: account.external_id, kind: account.kind })),
    rules: rules.rows.map((rule) => ({
      id: rule.id,
      pattern: rule.pattern,
      matchField: rule.match_field,
      categoryId: rule.category_id,
      kindOverride: rule.kind_override,
      priority: rule.priority,
    })),
    locks: rows
      .filter((row) => asBool(row.user_locked))
      .map((row) => ({ externalId: row.external_id, kind: row.kind, categoryId: row.category_id })),
    transactions: rows.map((row) => ({
      externalId: row.external_id,
      accountExternalId: row.account_external_id,
      postedOn: asDay(row.posted_on),
      amountCents: asNumber(row.amount_cents),
      direction: row.direction,
      pending: asBool(row.pending),
      voided: asBool(row.voided),
      merchantLabel: row.merchant_label,
      description: row.description,
      providerKind: row.provider_kind,
    })),
  });
  const byExternal = new Map(rows.map((row) => [row.external_id, row]));
  for (const tx of classified) {
    const row = byExternal.get(tx.externalId);
    if (!row || asBool(row.user_locked)) continue;
    await db.query(
      `UPDATE ours_transactions
       SET kind = $2, kind_source = $3, category_id = $4, category_source = $5, review_reasons = $6::jsonb, updated_at = $7
       WHERE id = $1 AND user_locked = false`,
      [row.id, tx.kind, tx.kindSource, tx.categoryId, tx.categorySource, JSON.stringify(tx.reviewReasons), now.toISOString()],
    );
  }
}

export async function loadHousehold(db: Db, now: Date, periodKind: PeriodKind, anchor = denverToday(now)): Promise<HouseholdView> {
  parseCivilDate(anchor);
  const current = await settings(db);
  const categories = await db.query<{ id: string; name: string; archived: unknown }>(`SELECT id, name, archived FROM ours_categories ORDER BY sort_order, name`);
  const targets = await db.query<{ id: string; category_id: string; period: PeriodKind; amount_cents: unknown }>(
    `SELECT id, category_id, period, amount_cents FROM ours_targets`,
  );
  const rules = await db.query<{ id: string; pattern: string; match_field: 'merchant' | 'description'; category_id: string; kind_override: TxKind | null; priority: number }>(
    `SELECT id, pattern, match_field, category_id, kind_override, priority FROM ours_fix_rules`,
  );
  const custom = await db.query<{ id: string; name: string; kind: 'asset' | 'liability'; role: 'house' | 'car' | 'loan' | 'other'; value_cents: unknown; as_of: unknown; note: string | null }>(
    `SELECT id, name, kind, role, value_cents, as_of, note FROM ours_custom_items ORDER BY created_at`,
  );
  const payments = await db.query<{ id: string; week_start: unknown; amount_cents: unknown; paid_on: unknown }>(
    `SELECT id, week_start, amount_cents, paid_on FROM ours_tithing_payments`,
  );
  const covered = await db.query<{ week_start: unknown }>(`SELECT week_start FROM ours_tithing_coverage`);
  const accounts = await db.query<{ external_id: string; kind: AccountKind }>(`SELECT external_id, kind FROM ours_accounts`);
  const rows = await transactionRows(db);
  const classified = classifyTransactions({
    accounts: accounts.rows.map((account) => ({ externalId: account.external_id, kind: account.kind })),
    rules: rules.rows.map((rule) => ({
      id: rule.id,
      pattern: rule.pattern,
      matchField: rule.match_field,
      categoryId: rule.category_id,
      kindOverride: rule.kind_override,
      priority: asNumber(rule.priority),
    })),
    locks: rows.filter((row) => asBool(row.user_locked)).map((row) => ({ externalId: row.external_id, kind: row.kind, categoryId: row.category_id })),
    transactions: rows.map((row) => ({
      externalId: row.external_id,
      accountExternalId: row.account_external_id,
      postedOn: asDay(row.posted_on),
      amountCents: asNumber(row.amount_cents),
      direction: row.direction,
      pending: asBool(row.pending),
      voided: asBool(row.voided),
      merchantLabel: row.merchant_label,
      description: row.description,
      providerKind: row.provider_kind,
    })),
  });
  const idByExternal = new Map(rows.map((row) => [row.external_id, row.id]));
  let balances: HouseholdView['netWorth']['accounts'] = [];
  let balancesAsOf: string | null = null;
  if (current.currentSnapshotId) {
    const snapshot = await db.query<{ balances_as_of: unknown }>(`SELECT balances_as_of FROM ours_snapshots WHERE id = $1 AND status = 'completed'`, [
      current.currentSnapshotId,
    ]);
    balancesAsOf = asIso(snapshot.rows[0]?.balances_as_of ?? null);
    const balanceRows = await db.query<{ account_id: string; label: string; kind: AccountKind; asset_cents: unknown; owed_cents: unknown; as_of: unknown; note: string | null }>(
      `SELECT a.id AS account_id, a.label, a.kind, b.asset_cents, b.owed_cents, b.as_of, b.note
       FROM ours_balances b JOIN ours_accounts a ON a.id = b.account_id WHERE b.snapshot_id = $1`,
      [current.currentSnapshotId],
    );
    balances = balanceRows.rows.map((row) => ({
      accountId: row.account_id,
      label: row.label,
      kind: row.kind,
      assetCents: asNumber(row.asset_cents),
      owedCents: asNumber(row.owed_cents),
      asOf: asIso(row.as_of) ?? balancesAsOf ?? now.toISOString(),
      asOfLabel: '',
      note: row.note,
    }));
  }
  const pending = await db.query<{ requested_at: unknown }>(
    `SELECT requested_at FROM ours_refresh_requests WHERE status = 'pending' ORDER BY requested_at LIMIT 1`,
  );
  return buildHouseholdView({
    now,
    periodKind,
    anchor,
    tithingBps: current.tithingBps,
    categories: categories.rows.filter((category) => !asBool(category.archived)).map((category) => ({ id: category.id, name: category.name, archived: false })),
    targets: targets.rows.map((target) => ({ id: target.id, categoryId: target.category_id, period: target.period, amountCents: asNumber(target.amount_cents) })),
    transactions: classified.map((tx) => ({ ...tx, id: idByExternal.get(tx.externalId) ?? tx.externalId })),
    balances,
    customItems: custom.rows.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      role: item.role,
      valueCents: asNumber(item.value_cents),
      asOf: asDay(item.as_of),
      note: item.note,
    })),
    payments: payments.rows.map((payment) => ({
      id: payment.id,
      weekStart: asDay(payment.week_start),
      amountCents: asNumber(payment.amount_cents),
      paidOn: asDay(payment.paid_on),
    })),
    coveredWeeks: covered.rows.map((row) => asDay(row.week_start)),
    freshness: {
      balancesAsOf,
      lastImportedAt: current.lastImportCompletedAt,
      lastFailureAt: current.lastFailureAt,
      lastFailureCode: current.lastFailureCode,
      pendingRefreshRequestedAt: asIso(pending.rows[0]?.requested_at ?? null),
    },
  });
}

export async function listCategoryChoices(db: Db): Promise<{ id: string; name: string }[]> {
  const result = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM ours_categories WHERE archived = false ORDER BY sort_order, name`,
  );
  return result.rows;
}

export async function listFixRules(db: Db): Promise<{ id: string; pattern: string; matchField: 'merchant' | 'description'; categoryId: string; kindOverride: TxKind | null; priority: number }[]> {
  const result = await db.query<{ id: string; pattern: string; match_field: 'merchant' | 'description'; category_id: string; kind_override: TxKind | null; priority: number }>(
    `SELECT id, pattern, match_field, category_id, kind_override, priority FROM ours_fix_rules ORDER BY priority, created_at`,
  );
  return result.rows.map((rule) => ({
    id: rule.id,
    pattern: rule.pattern,
    matchField: rule.match_field,
    categoryId: rule.category_id,
    kindOverride: rule.kind_override,
    priority: asNumber(rule.priority),
  }));
}

export async function setTithingBps(db: Db, bps: number | null, now: Date): Promise<void> {
  await db.query(`UPDATE ours_settings SET tithing_bps = $1, updated_at = $2 WHERE id = 1`, [bps, now.toISOString()]);
}

export async function insertCategory(db: Db, name: string): Promise<string> {
  const count = await db.query<{ count: unknown }>(`SELECT count(*)::int AS count FROM ours_categories WHERE system = false AND archived = false`);
  if (asNumber(count.rows[0]?.count ?? 0) >= 40) throw new PublicError(400, 'too_many');
  const result = await db.query<{ id: string }>(
    `INSERT INTO ours_categories (id, name, system, sort_order) VALUES (gen_random_uuid(), $1, false, 100) RETURNING id`,
    [name],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('missing_category');
  return id;
}

export async function assertCategory(db: Db, id: string): Promise<void> {
  const result = await db.query(`SELECT id FROM ours_categories WHERE id = $1 AND archived = false`, [id]);
  if (result.rows.length === 0) throw new PublicError(400, 'unknown_category');
}

export async function upsertTarget(db: Db, categoryId: string, period: PeriodKind, amountCents: number, now: Date): Promise<void> {
  await assertCategory(db, categoryId);
  await db.query(
    `INSERT INTO ours_targets (category_id, period, amount_cents, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (category_id, period) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, updated_at = EXCLUDED.updated_at`,
    [categoryId, period, amountCents, now.toISOString()],
  );
}

export async function deleteTarget(db: Db, id: string): Promise<void> {
  const result = await db.query(`DELETE FROM ours_targets WHERE id = $1 RETURNING id`, [id]);
  if (result.rows.length === 0) throw new PublicError(404, 'not_found');
}

export async function insertFixRule(
  db: Db,
  input: { pattern: string; matchField: 'merchant' | 'description'; categoryId: string; kindOverride: TxKind | null; priority: number },
  now: Date,
): Promise<string> {
  await assertCategory(db, input.categoryId);
  const result = await db.query<{ id: string }>(
    `INSERT INTO ours_fix_rules (pattern, match_field, category_id, kind_override, priority) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.pattern, input.matchField, input.categoryId, input.kindOverride, input.priority],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('missing_rule');
  await syncClassification(db, now);
  return id;
}

export async function deleteFixRule(db: Db, id: string, now: Date): Promise<void> {
  const result = await db.query(`DELETE FROM ours_fix_rules WHERE id = $1 RETURNING id`, [id]);
  if (result.rows.length === 0) throw new PublicError(404, 'not_found');
  await syncClassification(db, now);
}

export async function insertCustomItem(
  db: Db,
  input: { name: string; kind: 'asset' | 'liability'; role: 'house' | 'car' | 'loan' | 'other'; valueCents: number; asOf: string; note: string | null },
): Promise<string> {
  const count = await db.query<{ count: unknown }>(`SELECT count(*)::int AS count FROM ours_custom_items`);
  if (asNumber(count.rows[0]?.count ?? 0) >= 100) throw new PublicError(400, 'too_many');
  const result = await db.query<{ id: string }>(
    `INSERT INTO ours_custom_items (name, kind, role, value_cents, as_of, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.name, input.kind, input.role, input.valueCents, input.asOf, input.note],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('missing_item');
  return id;
}

export async function updateCustomItem(
  db: Db,
  id: string,
  input: { name: string; kind: 'asset' | 'liability'; role: 'house' | 'car' | 'loan' | 'other'; valueCents: number; asOf: string; note: string | null },
  now: Date,
): Promise<void> {
  const result = await db.query(
    `UPDATE ours_custom_items SET name = $2, kind = $3, role = $4, value_cents = $5, as_of = $6, note = $7, updated_at = $8 WHERE id = $1 RETURNING id`,
    [id, input.name, input.kind, input.role, input.valueCents, input.asOf, input.note, now.toISOString()],
  );
  if (result.rows.length === 0) throw new PublicError(404, 'not_found');
}

export async function deleteCustomItem(db: Db, id: string): Promise<void> {
  const result = await db.query(`DELETE FROM ours_custom_items WHERE id = $1 RETURNING id`, [id]);
  if (result.rows.length === 0) throw new PublicError(404, 'not_found');
}

export async function addTithingPayment(db: Db, input: { weekStart: string; amountCents: number; paidOn: string }, now: Date): Promise<string> {
  if (!isMonday(input.weekStart)) throw new PublicError(400, 'invalid_date');
  const today = denverToday(now);
  if (input.paidOn > today || input.weekStart > today) throw new PublicError(400, 'invalid_date');
  const result = await db.query<{ id: string }>(
    `INSERT INTO ours_tithing_payments (week_start, amount_cents, paid_on) VALUES ($1, $2, $3) RETURNING id`,
    [input.weekStart, input.amountCents, input.paidOn],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('missing_payment');
  return id;
}

export async function deleteTithingPayment(db: Db, id: string): Promise<void> {
  const result = await db.query(`DELETE FROM ours_tithing_payments WHERE id = $1 RETURNING id`, [id]);
  if (result.rows.length === 0) throw new PublicError(404, 'not_found');
}

export async function setCoverage(db: Db, weekStart: string, covered: boolean, now: Date): Promise<void> {
  if (!isMonday(weekStart)) throw new PublicError(400, 'invalid_date');
  if (weekStart > denverToday(now)) throw new PublicError(400, 'invalid_date');
  if (covered) await db.query(`INSERT INTO ours_tithing_coverage (week_start) VALUES ($1) ON CONFLICT DO NOTHING`, [weekStart]);
  else await db.query(`DELETE FROM ours_tithing_coverage WHERE week_start = $1`, [weekStart]);
}

export async function classifyOwnedTransaction(db: Db, id: string, kind: TxKind, categoryId: string | null, now: Date): Promise<void> {
  if (categoryId) await assertCategory(db, categoryId);
  const result = await db.query(
    `UPDATE ours_transactions
     SET kind = $2, kind_source = 'user', category_id = $3, category_source = CASE WHEN $3::uuid IS NULL THEN NULL ELSE 'user' END,
         user_locked = true, review_reasons = '[]'::jsonb, updated_at = $4
     WHERE id = $1 RETURNING id`,
    [id, kind, categoryId, now.toISOString()],
  );
  if (result.rows.length === 0) throw new PublicError(404, 'not_found');
}

export async function requestRefresh(db: Db): Promise<string> {
  const result = await db.query<{ requested_at: unknown }>(`INSERT INTO ours_refresh_requests (status) VALUES ('pending') RETURNING requested_at`);
  return asIso(result.rows[0]?.requested_at) ?? new Date(0).toISOString();
}

async function fulfillPending(db: Db, snapshotId: string, now: Date): Promise<number> {
  const result = await db.query(
    `UPDATE ours_refresh_requests SET status = 'fulfilled', fulfilled_at = $2, snapshot_id = $1 WHERE status = 'pending' RETURNING id`,
    [snapshotId, now.toISOString()],
  );
  return result.rows.length;
}

function safeErrorCode(code: string): string {
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : 'import_failed';
}

export async function recordImportFailure(db: Db, code: string, now: Date): Promise<void> {
  const errorCode = safeErrorCode(code);
  await db.query(
    `INSERT INTO ours_snapshots (fingerprint, schema_version, status, error_code) VALUES ($1, 1, 'failed', $2)`,
    [`failed:${crypto.randomUUID()}`, errorCode],
  );
  await db.query(`UPDATE ours_settings SET last_failure_at = $1, last_failure_code = $2, updated_at = $1 WHERE id = 1`, [now.toISOString(), errorCode]);
  await db.exec(`DELETE FROM ours_snapshots WHERE status = 'failed' AND id NOT IN (
    SELECT id FROM ours_snapshots WHERE status = 'failed' ORDER BY created_at DESC LIMIT 5
  )`);
}

export type ImportResult = {
  ok: true;
  duplicate: boolean;
  snapshotId: string;
  accounts: number;
  transactions: number;
  refreshRequestsFulfilled: number;
  balancesAsOf: string;
};

export async function importCanonical(db: Db, snapshot: CanonicalSnapshot, now: Date): Promise<ImportResult> {
  const fingerprint = await fingerprintSnapshot(snapshot);
  return db.tx(async (tx) => {
    const existing = await tx.query<{ id: string; balances_as_of: unknown }>(
      `SELECT id, balances_as_of FROM ours_snapshots WHERE fingerprint = $1 AND status = 'completed'`,
      [fingerprint],
    );
    const prior = existing.rows[0];
    if (prior) {
      const fulfilled = await fulfillPending(tx, prior.id, now);
      return {
        ok: true as const,
        duplicate: true,
        snapshotId: prior.id,
        accounts: snapshot.accounts.length,
        transactions: snapshot.transactions.length,
        refreshRequestsFulfilled: fulfilled,
        balancesAsOf: asIso(prior.balances_as_of) ?? snapshot.balancesAsOf,
      };
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO ours_snapshots (fingerprint, schema_version, status, balances_as_of, transaction_count, account_count, completed_at)
       VALUES ($1, 1, 'completed', $2, $3, $4, $5) RETURNING id`,
      [fingerprint, snapshot.balancesAsOf, snapshot.transactions.length, snapshot.accounts.length, now.toISOString()],
    );
    const snapshotId = inserted.rows[0]?.id;
    if (!snapshotId) throw new Error('missing_snapshot');
    const accountIds = new Map<string, string>();
    for (const account of snapshot.accounts) {
      const row = await tx.query<{ id: string }>(
        `INSERT INTO ours_accounts (external_id, label, kind) VALUES ($1, $2, $3)
         ON CONFLICT (external_id) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind
         RETURNING id`,
        [account.externalId, account.label, account.kind],
      );
      const id = row.rows[0]?.id;
      if (!id) throw new Error('missing_account');
      accountIds.set(account.externalId, id);
    }
    for (const balance of snapshot.balances) {
      const accountId = accountIds.get(balance.accountExternalId);
      if (!accountId) throw new Error('missing_account');
      await tx.query(
        `INSERT INTO ours_balances (snapshot_id, account_id, as_of, asset_cents, owed_cents, available_cents, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshotId, accountId, balance.asOf, balance.assetCents, balance.owedCents, balance.availableCents, balance.note],
      );
    }
    for (const transaction of snapshot.transactions) {
      const accountId = accountIds.get(transaction.accountExternalId);
      if (!accountId) throw new Error('missing_account');
      await tx.query(
        `INSERT INTO ours_transactions (
           external_id, account_id, posted_on, posted_at, amount_cents, direction, pending, voided,
           merchant_label, description, provider_kind, kind, kind_source, user_locked, first_snapshot_id, last_snapshot_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unreviewed','unreviewed',false,$12,$12)
         ON CONFLICT (external_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           posted_on = EXCLUDED.posted_on,
           posted_at = EXCLUDED.posted_at,
           amount_cents = EXCLUDED.amount_cents,
           direction = EXCLUDED.direction,
           pending = EXCLUDED.pending,
           voided = ours_transactions.voided OR EXCLUDED.voided,
           merchant_label = EXCLUDED.merchant_label,
           description = EXCLUDED.description,
           provider_kind = EXCLUDED.provider_kind,
           last_snapshot_id = EXCLUDED.last_snapshot_id,
           updated_at = now()`,
        [
          transaction.externalId,
          accountId,
          transaction.postedOn,
          transaction.postedAt,
          transaction.amountCents,
          transaction.direction,
          transaction.pending,
          transaction.voided,
          transaction.merchantLabel,
          transaction.description,
          transaction.providerKind,
          snapshotId,
        ],
      );
      if (transaction.replacesExternalId) {
        await tx.query(`UPDATE ours_transactions SET voided = true, updated_at = now() WHERE external_id = $1`, [transaction.replacesExternalId]);
      }
    }
    await syncClassification(tx, now);
    await tx.query(
      `UPDATE ours_settings SET current_snapshot_id = $1, last_import_completed_at = $2, updated_at = $2 WHERE id = 1`,
      [snapshotId, now.toISOString()],
    );
    await tx.query(
      `DELETE FROM ours_snapshots
       WHERE status = 'completed'
         AND id <> $1::uuid
         AND id NOT IN (
           SELECT id FROM ours_snapshots
           WHERE status = 'completed' AND id <> $1::uuid
           ORDER BY completed_at DESC NULLS LAST, created_at DESC
           LIMIT ${COMPLETED_SNAPSHOTS_TO_KEEP - 1}
         )`,
      [snapshotId],
    );
    const fulfilled = await fulfillPending(tx, snapshotId, now);
    return {
      ok: true as const,
      duplicate: false,
      snapshotId,
      accounts: snapshot.accounts.length,
      transactions: snapshot.transactions.length,
      refreshRequestsFulfilled: fulfilled,
      balancesAsOf: snapshot.balancesAsOf,
    };
  });
}

export async function saveReport(db: Db, input: { key: string; kind: PeriodKind; start: string; end: string; payload: unknown }): Promise<{ duplicate: boolean }> {
  const inserted = await db.query(
    `INSERT INTO ours_report_runs (idempotency_key, period_kind, period_start, period_end, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.key, input.kind, input.start, input.end, JSON.stringify(input.payload)],
  );
  return { duplicate: inserted.rows.length === 0 };
}

export async function readReport(db: Db, key: string): Promise<unknown | null> {
  const result = await db.query<{ payload: unknown }>(`SELECT payload FROM ours_report_runs WHERE idempotency_key = $1`, [key]);
  return result.rows[0]?.payload ?? null;
}

export async function reportCount(db: Db): Promise<number> {
  const result = await db.query<{ count: unknown }>(`SELECT count(*)::int AS count FROM ours_report_runs`);
  return asNumber(result.rows[0]?.count ?? 0);
}
