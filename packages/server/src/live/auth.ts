import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Db } from '../db.js';
import { asNumber, asStrings } from '../values.js';
import { canonicalCode, randomGroupedCode, sha256Hex } from './codes.js';

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export type LiveAuthConfig = { rpId: string; origins: string[] };

const HOUR_MS = 60 * 60 * 1000;
const SESSION_MS = 30 * 24 * HOUR_MS;
const SETUP_MS = 24 * HOUR_MS;
const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_FAILS = 20;

function assertOrigin(origin: string, config: LiveAuthConfig): void {
  if (origin && !config.origins.includes(origin)) throw new AuthError(403, 'This site is not allowed to sign in.');
}

async function throttle(db: Db, now: Date): Promise<void> {
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const result = await db.query<{ count: unknown }>(
    `select count(*)::int as count from ours_auth_attempts where ok = false and at >= $1`,
    [since],
  );
  if (asNumber(result.rows[0]?.count ?? 0) >= MAX_FAILS) throw new AuthError(429, 'Too many failed attempts. Try again in an hour.');
}

async function logAttempt(db: Db, kind: string, ok: boolean): Promise<void> {
  await db.query(`insert into ours_auth_attempts (kind, ok) values ($1, $2)`, [kind, ok]);
}

async function newSession(db: Db, via: string, now: Date): Promise<{ token: string; expires_at: string }> {
  const token = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(now.getTime() + SESSION_MS).toISOString();
  await db.query(`insert into ours_sessions (token_hash, expires_at, via) values ($1, $2, $3)`, [await sha256Hex(token), expires, via]);
  return { token, expires_at: expires };
}

async function requireSession(db: Db, token: unknown, now: Date): Promise<void> {
  if (typeof token !== 'string' || token.length < 30) throw new AuthError(401, 'Not signed in');
  const result = await db.query(
    `select token_hash from ours_sessions where token_hash = $1 and expires_at > $2`,
    [await sha256Hex(token), now.toISOString()],
  );
  if (result.rows.length === 0) throw new AuthError(401, 'Not signed in');
}

async function findSetupCode(db: Db, code: unknown, now: Date): Promise<number | null> {
  const result = await db.query<{ id: unknown }>(
    `select id from ours_device_setup_codes where code_hash = $1 and used_at is null and expires_at > $2`,
    [await sha256Hex(canonicalCode(code, 4)), now.toISOString()],
  );
  const id = result.rows[0]?.id;
  return id == null ? null : asNumber(id);
}

async function saveChallenge(db: Db, kind: 'reg' | 'auth', challenge: string, setupCodeId: number | null, now: Date): Promise<string> {
  const expires = new Date(now.getTime() + CHALLENGE_MS).toISOString();
  await db.query(`delete from ours_challenges where expires_at < $1`, [new Date(now.getTime() - 24 * HOUR_MS).toISOString()]);
  const result = await db.query<{ id: string }>(
    `insert into ours_challenges (kind, challenge, setup_code_id, expires_at) values ($1, $2, $3, $4) returning id`,
    [kind, challenge, setupCodeId, expires],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('missing challenge');
  return id;
}

async function takeChallenge(db: Db, id: unknown, kind: 'reg' | 'auth', now: Date): Promise<{ challenge: string; setup_code_id: number | null }> {
  const result = await db.query<{ challenge: string; setup_code_id: unknown }>(
    `update ours_challenges set used_at = $3::timestamptz
     where id = $1::uuid and kind = $2 and used_at is null and expires_at > $3::timestamptz
     returning challenge, setup_code_id`,
    [String(id), kind, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) throw new AuthError(400, 'This sign-in attempt expired. Please try again.');
  return { challenge: row.challenge, setup_code_id: row.setup_code_id == null ? null : asNumber(row.setup_code_id) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handleAuthAction(db: Db, config: LiveAuthConfig, body: Record<string, unknown>, origin: string, now: Date): Promise<unknown> {
  assertOrigin(origin, config);
  const action = String(body.action ?? '');
  if (action === 'reg_options') {
    let setupId: number | null = null;
    if (body.token) await requireSession(db, body.token, now);
    else {
      await throttle(db, now);
      setupId = await findSetupCode(db, body.code, now);
      if (!setupId) {
        await logAttempt(db, 'setup_code', false);
        throw new AuthError(403, "That setup code isn't valid or was already used.");
      }
    }
    const options = await generateRegistrationOptions({
      rpName: 'Ours',
      rpID: config.rpId,
      userName: 'Ours',
      userDisplayName: 'Ours',
      userID: new TextEncoder().encode('ours-owner'),
      attestationType: 'none',
      excludeCredentials: (await existingCreds(db)).map((credential) => ({ id: credential.id, transports: credential.transports as ('internal' | 'hybrid')[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { challengeId: await saveChallenge(db, 'reg', options.challenge, setupId, now), options };
  }
  if (action === 'reg_verify') {
    const challenge = await takeChallenge(db, body.challengeId, 'reg', now);
    if (challenge.setup_code_id == null) await requireSession(db, body.token, now);
    const credential = body.credential as RegistrationResponseJSON;
    try {
      const result = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpId,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) throw new AuthError(400, 'Passkey check failed.');
      if (challenge.setup_code_id != null) {
        const used = await db.query(
          `update ours_device_setup_codes set used_at = $2 where id = $1 and used_at is null returning id`,
          [challenge.setup_code_id, now.toISOString()],
        );
        if (used.rows.length === 0) throw new AuthError(403, 'That setup code was already used.');
        await logAttempt(db, 'setup_code', true);
      }
      const created = result.registrationInfo.credential;
      await db.query(
        `insert into ours_passkey_credentials (id, public_key, counter, transports, device_name)
         values ($1, $2, $3, $4, $5)`,
        [
          created.id,
          isoBase64URL.fromBuffer(created.publicKey),
          created.counter,
          created.transports ?? [],
          String(body.deviceName ?? 'Passkey').slice(0, 40) || 'Passkey',
        ],
      );
      return { ok: true, session: await newSession(db, 'enroll', now) };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(400, 'Passkey check failed.');
    }
  }
  if (action === 'auth_options') {
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', allowCredentials: [] });
    return { challengeId: await saveChallenge(db, 'auth', options.challenge, null, now), options };
  }
  if (action === 'auth_verify') {
    await throttle(db, now);
    const challenge = await takeChallenge(db, body.challengeId, 'auth', now);
    const credentialId = isRecord(body.credential) ? String(body.credential.id ?? '') : '';
    const cred = await db.query<{ id: string; public_key: string; counter: unknown; transports: unknown }>(
      `select id, public_key, counter, transports from ours_passkey_credentials where id = $1`,
      [credentialId],
    );
    const row = cred.rows[0];
    if (!row) {
      await logAttempt(db, 'passkey', false);
      throw new AuthError(403, "This passkey isn't set up for Ours. Use a setup code to add this device.");
    }
    try {
      const result = await verifyAuthenticationResponse({
        response: body.credential as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpId,
        requireUserVerification: true,
        credential: {
          id: row.id,
          publicKey: isoBase64URL.toBuffer(row.public_key),
          counter: asNumber(row.counter),
          transports: asStrings(row.transports) as ('internal' | 'hybrid')[],
        },
      });
      if (!result.verified) throw new AuthError(403, 'Passkey check failed.');
      await db.query(`update ours_passkey_credentials set counter = $2, last_used_at = $3 where id = $1`, [
        row.id,
        result.authenticationInfo.newCounter,
        now.toISOString(),
      ]);
      await logAttempt(db, 'passkey', true);
      return { ok: true, session: await newSession(db, 'passkey', now) };
    } catch (error) {
      if (!(error instanceof AuthError)) await logAttempt(db, 'passkey', false);
      if (error instanceof AuthError) throw error;
      throw new AuthError(403, 'Passkey check failed.');
    }
  }
  if (action === 'backup_login') {
    await throttle(db, now);
    const used = await db.query(
      `update ours_backup_codes set used_at = $2 where code_hash = $1 and used_at is null returning id`,
      [await sha256Hex(canonicalCode(body.code, 5)), now.toISOString()],
    );
    if (used.rows.length === 0) {
      await logAttempt(db, 'backup_code', false);
      throw new AuthError(403, "That backup code isn't valid or was already used.");
    }
    await logAttempt(db, 'backup_code', true);
    const left = await db.query<{ count: unknown }>(`select count(*)::int as count from ours_backup_codes where used_at is null`);
    return { ok: true, session: await newSession(db, 'backup_code', now), backup_codes_left: asNumber(left.rows[0]?.count ?? 0) };
  }
  if (action === 'new_setup_code') {
    await requireSession(db, body.token, now);
    const code = randomGroupedCode(3, 4);
    const expires = new Date(now.getTime() + SETUP_MS).toISOString();
    await db.query(`insert into ours_device_setup_codes (code_hash, expires_at) values ($1, $2)`, [await sha256Hex(code), expires]);
    return { code, expires_at: expires };
  }
  if (action === 'new_backup_codes') {
    await requireSession(db, body.token, now);
    if (body.confirm !== true) throw new AuthError(400, 'Confirm that the current backup codes should be replaced.');
    const codes = Array.from({ length: 10 }, () => randomGroupedCode(2, 5));
    await db.query(`delete from ours_backup_codes where id >= 0`);
    for (const code of codes) {
      await db.query(`insert into ours_backup_codes (code_hash) values ($1)`, [await sha256Hex(code)]);
    }
    return { codes };
  }
  if (action === 'check') {
    await requireSession(db, body.token, now);
    return { ok: true };
  }
  throw new AuthError(400, 'Unknown action');
}

async function existingCreds(db: Db): Promise<{ id: string; transports: string[] }[]> {
  const result = await db.query<{ id: string; transports: unknown }>(`select id, transports from ours_passkey_credentials`);
  return result.rows.map((row) => ({ id: row.id, transports: asStrings(row.transports) }));
}
