import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { AppConfig } from './config.js';
import { base64urlToBytes, hmacCode } from './crypto.js';
import type { Db } from './db.js';
import { PublicError } from './errors.js';
import {
  consumeCode,
  createSession,
  ensureUserHandle,
  findCredential,
  insertChallenge,
  insertCredential,
  issueRecoveryCodes,
  listCredentialIds,
  markClone,
  recordAttempt,
  reserveCode,
  takeChallenge,
  tooManyFailures,
  unusedRecoveryCount,
  updateCounter,
  usableCredentialCount,
} from './repository.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function challengeFromClientData(response: unknown): string | null {
  if (!isRecord(response) || !isRecord(response.response) || typeof response.response.clientDataJSON !== 'string') return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(isoBase64URL.toBuffer(response.response.clientDataJSON))) as { challenge?: unknown };
    return typeof decoded.challenge === 'string' ? decoded.challenge : null;
  } catch {
    return null;
  }
}

async function registrationOptions(db: Db, config: AppConfig) {
  const handle = await ensureUserHandle(db);
  const existing = await listCredentialIds(db);
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: 'owner',
    userDisplayName: 'Ours',
    userID: base64urlToBytes(handle) as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    },
    preferredAuthenticatorType: 'localDevice',
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as ('internal' | 'hybrid')[],
    })),
  });
}

export async function beginPossession(
  db: Db,
  config: AppConfig,
  now: Date,
  origin: string,
  code: string,
  purpose: 'device_setup' | 'recovery',
): Promise<{ options: Awaited<ReturnType<typeof generateRegistrationOptions>> }> {
  if (await tooManyFailures(db, purpose, now)) throw new PublicError(429, 'try_later');
  const reserved = await reserveCode(db, await hmacCode(config.pepper, purpose, code), purpose, now, config.challengeTtlSeconds * 1000);
  if (!reserved) {
    await recordAttempt(db, purpose, false, now);
    throw new PublicError(401, 'invalid_code');
  }
  const options = await registrationOptions(db, config);
  await insertChallenge(db, {
    challenge: options.challenge,
    kind: 'registration',
    rpId: config.rpId,
    origin,
    setupCodeId: reserved,
    expiresAt: new Date(now.getTime() + config.challengeTtlSeconds * 1000),
  });
  return { options };
}

export async function finishRegistration(
  db: Db,
  config: AppConfig,
  now: Date,
  origin: string,
  response: RegistrationResponseJSON,
  deviceLabel: string,
): Promise<{ token: string; recoveryCodes?: string[] }> {
  const challengeValue = challengeFromClientData(response);
  const challenge = challengeValue ? await takeChallenge(db, challengeValue, now) : null;
  const burn = async () => {
    if (challenge?.setupCodeId) await consumeCode(db, challenge.setupCodeId, now);
    await recordAttempt(db, 'registration', false, now);
  };
  if (!challenge || challenge.kind !== 'registration' || !challenge.setupCodeId || challenge.rpId !== config.rpId || challenge.origin !== origin) {
    await burn();
    throw new PublicError(401, 'invalid_ceremony');
  }
  try {
    const verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeValue ?? '',
      expectedOrigin: origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
    if (!verified.verified) throw new Error('unverified');
    const credential = verified.registrationInfo.credential;
    const transports = Array.isArray(response.response.transports) && response.response.transports.length > 0 ? response.response.transports : ['internal'];
    const consumed = await consumeCode(db, challenge.setupCodeId, now);
    if (!consumed) throw new Error('code_consumed');
    const credentialRowId = await insertCredential(db, {
      credentialId: credential.id,
      publicKeyB64: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports,
      deviceLabel,
    });
    const recoveryCodes = (await unusedRecoveryCount(db)) === 0 ? await issueRecoveryCodes(db, config.pepper) : undefined;
    const token = await createSession(db, credentialRowId, config.sessionTtlSeconds, now);
    await recordAttempt(db, 'registration', true, now);
    return { token, recoveryCodes };
  } catch (error) {
    if (error instanceof PublicError) throw error;
    await burn();
    throw new PublicError(401, 'invalid_ceremony');
  }
}

export async function beginAuthentication(db: Db, config: AppConfig, now: Date, origin: string) {
  if (await tooManyFailures(db, 'authentication', now)) throw new PublicError(429, 'try_later');
  if ((await usableCredentialCount(db)) === 0) throw new PublicError(400, 'setup_required');
  const credentials = await listCredentialIds(db);
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as ('internal' | 'hybrid')[],
    })),
  });
  await insertChallenge(db, {
    challenge: options.challenge,
    kind: 'authentication',
    rpId: config.rpId,
    origin,
    setupCodeId: null,
    expiresAt: new Date(now.getTime() + config.challengeTtlSeconds * 1000),
  });
  return { options };
}

export async function finishAuthentication(
  db: Db,
  config: AppConfig,
  now: Date,
  origin: string,
  response: AuthenticationResponseJSON,
): Promise<{ token: string }> {
  const challengeValue = challengeFromClientData(response);
  const challenge = challengeValue ? await takeChallenge(db, challengeValue, now) : null;
  if (!challenge || challenge.kind !== 'authentication' || challenge.rpId !== config.rpId || challenge.origin !== origin) {
    await recordAttempt(db, 'authentication', false, now);
    throw new PublicError(401, 'invalid_challenge');
  }
  const credential = await findCredential(db, response.id);
  if (!credential || credential.cloneSuspected) {
    await recordAttempt(db, 'authentication', false, now);
    throw new PublicError(401, 'invalid_ceremony');
  }
  try {
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeValue ?? '',
      expectedOrigin: origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: response.id,
        publicKey: isoBase64URL.toBuffer(credential.publicKeyB64),
        counter: credential.counter,
      },
    });
    if (!verified.verified) throw new Error('unverified');
    await updateCounter(db, credential.id, verified.authenticationInfo.newCounter, now);
    const token = await createSession(db, credential.id, config.sessionTtlSeconds, now);
    await recordAttempt(db, 'authentication', true, now);
    return { token };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('counter value')) {
      await markClone(db, credential.id, now);
      await recordAttempt(db, 'authentication', false, now);
      throw new PublicError(401, 'credential_unusable');
    }
    await recordAttempt(db, 'authentication', false, now);
    throw new PublicError(401, 'invalid_ceremony');
  }
}
