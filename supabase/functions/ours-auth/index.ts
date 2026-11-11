// Updated ours-auth source for the owner to deploy. This repo does not deploy it.
//
// Function secrets, set in Supabase and not committed here:
//   OURS_DATABASE_URL   Postgres URL for the existing database. SUPABASE_DB_URL is used if that is unset.
//   OURS_RP_ID          rwalk1019.github.io
//   OURS_ORIGINS        https://rwalk1019.github.io
// The two passkey values below are the GitHub Pages site. A secret overrides them.
// A disallowed Origin is rejected and is never replaced with the first allowed origin.
// Passkey verifier failures return "Passkey check failed." with no exception text.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@13.2.2";
import { isoBase64URL } from "npm:@simplewebauthn/server@13.2.2/helpers";
import postgres from "npm:postgres@3.4.7";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "npm:@simplewebauthn/server@13.2.2";

const RP_ID = Deno.env.get("OURS_RP_ID")?.trim() || "rwalk1019.github.io";
const ORIGINS = (Deno.env.get("OURS_ORIGINS") ?? "https://rwalk1019.github.io")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const HOUR_MS = 60 * 60 * 1000;
const SESSION_MS = 30 * 24 * HOUR_MS;
const SETUP_MS = 24 * HOUR_MS;
const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_FAILS = 20;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

let sql: ReturnType<typeof postgres> | null = null;

function database(): ReturnType<typeof postgres> {
  if (sql) return sql;
  const url = Deno.env.get("OURS_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new AuthError(500, "Auth is not configured.");
  sql = postgres(url, { max: 1, prepare: false, ssl: "require" });
  return sql;
}

async function query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const rows = await database().unsafe(text, params as never[]);
  return [...rows] as T[];
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
    "cache-control": "no-store",
  });
  const origin = request.headers.get("origin");
  if (origin && ORIGINS.includes(origin)) headers.set("access-control-allow-origin", origin);
  return headers;
}

function json(request: Request, status: number, body: unknown): Response {
  const headers = corsHeaders(request);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  throw new AuthError(500, "Auth is not configured.");
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalCode(code: unknown, group: number): string {
  const normalized = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.match(new RegExp(`.{1,${group}}`, "g"))?.join("-") ?? "";
}

function randomGroupedCode(groups: number, size: number): string {
  const parts: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  for (let group = 0; group < groups; group += 1) {
    let text = "";
    while (text.length < size) {
      const bytes = crypto.getRandomValues(new Uint8Array(size));
      for (const byte of bytes) {
        if (byte >= limit) continue;
        const char = ALPHABET[byte % ALPHABET.length];
        if (char) text += char;
        if (text.length === size) break;
      }
    }
    parts.push(text);
  }
  return parts.join("-");
}

async function throttle(now: Date): Promise<void> {
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const rows = await query<{ count: unknown }>(
    `select count(*)::int as count from ours_auth_attempts where ok = false and at >= $1`,
    [since],
  );
  if (asNumber(rows[0]?.count ?? 0) >= MAX_FAILS) throw new AuthError(429, "Too many failed attempts. Try again in an hour.");
}

async function logAttempt(kind: string, ok: boolean): Promise<void> {
  await query(`insert into ours_auth_attempts (kind, ok) values ($1, $2)`, [kind, ok]);
}

async function newSession(via: string, now: Date): Promise<{ token: string; expires_at: string }> {
  const token = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(now.getTime() + SESSION_MS).toISOString();
  await query(`insert into ours_sessions (token_hash, expires_at, via) values ($1, $2, $3)`, [await sha256Hex(token), expires, via]);
  return { token, expires_at: expires };
}

async function requireSession(token: unknown, now: Date): Promise<void> {
  if (typeof token !== "string" || token.length < 30) throw new AuthError(401, "Not signed in");
  const rows = await query(
    `select token_hash from ours_sessions where token_hash = $1 and expires_at > $2`,
    [await sha256Hex(token), now.toISOString()],
  );
  if (rows.length === 0) throw new AuthError(401, "Not signed in");
}

async function findSetupCode(code: unknown, now: Date): Promise<number | null> {
  const rows = await query<{ id: unknown }>(
    `select id from ours_device_setup_codes where code_hash = $1 and used_at is null and expires_at > $2`,
    [await sha256Hex(canonicalCode(code, 4)), now.toISOString()],
  );
  return rows[0]?.id == null ? null : asNumber(rows[0].id);
}

async function saveChallenge(kind: "reg" | "auth", challenge: string, setupCodeId: number | null, now: Date): Promise<string> {
  const expires = new Date(now.getTime() + CHALLENGE_MS).toISOString();
  await query(`delete from ours_challenges where expires_at < $1`, [new Date(now.getTime() - 24 * HOUR_MS).toISOString()]);
  const rows = await query<{ id: string }>(
    `insert into ours_challenges (kind, challenge, setup_code_id, expires_at) values ($1, $2, $3, $4) returning id`,
    [kind, challenge, setupCodeId, expires],
  );
  const id = rows[0]?.id;
  if (!id) throw new AuthError(500, "Auth is not configured.");
  return id;
}

async function takeChallenge(id: unknown, kind: "reg" | "auth", now: Date): Promise<{ challenge: string; setup_code_id: number | null }> {
  const rows = await query<{ challenge: string; setup_code_id: unknown }>(
    `update ours_challenges set used_at = $3::timestamptz
     where id = $1::uuid and kind = $2 and used_at is null and expires_at > $3::timestamptz
     returning challenge, setup_code_id`,
    [String(id), kind, now.toISOString()],
  );
  const row = rows[0];
  if (!row) throw new AuthError(400, "This sign-in attempt expired. Please try again.");
  return { challenge: row.challenge, setup_code_id: row.setup_code_id == null ? null : asNumber(row.setup_code_id) };
}

async function existingCreds(): Promise<{ id: string; transports: string[] }[]> {
  const rows = await query<{ id: string; transports: unknown }>(`select id, transports from ours_passkey_credentials`);
  return rows.map((row) => ({ id: row.id, transports: asStrings(row.transports) }));
}

async function handle(body: Record<string, unknown>, now: Date): Promise<unknown> {
  const action = String(body.action ?? "");
  if (action === "reg_options") {
    let setupId: number | null = null;
    if (body.token) await requireSession(body.token, now);
    else {
      await throttle(now);
      setupId = await findSetupCode(body.code, now);
      if (!setupId) {
        await logAttempt("setup_code", false);
        throw new AuthError(403, "That setup code isn't valid or was already used.");
      }
    }
    const options = await generateRegistrationOptions({
      rpName: "Ours",
      rpID: RP_ID,
      userName: "Ours",
      userDisplayName: "Ours",
      userID: new TextEncoder().encode("ours-owner"),
      attestationType: "none",
      excludeCredentials: (await existingCreds()).map((credential) => ({ id: credential.id, transports: credential.transports as ("internal" | "hybrid")[] })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return { challengeId: await saveChallenge("reg", options.challenge, setupId, now), options };
  }
  if (action === "reg_verify") {
    const challenge = await takeChallenge(body.challengeId, "reg", now);
    if (challenge.setup_code_id == null) await requireSession(body.token, now);
    try {
      const result = await verifyRegistrationResponse({
        response: body.credential as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) throw new AuthError(400, "Passkey check failed.");
      if (challenge.setup_code_id != null) {
        const used = await query(
          `update ours_device_setup_codes set used_at = $2 where id = $1 and used_at is null returning id`,
          [challenge.setup_code_id, now.toISOString()],
        );
        if (used.length === 0) throw new AuthError(403, "That setup code was already used.");
        await logAttempt("setup_code", true);
      }
      const created = result.registrationInfo.credential;
      await query(
        `insert into ours_passkey_credentials (id, public_key, counter, transports, device_name)
         values ($1, $2, $3, $4, $5)`,
        [
          created.id,
          isoBase64URL.fromBuffer(created.publicKey),
          created.counter,
          created.transports ?? [],
          String(body.deviceName ?? "Passkey").slice(0, 40) || "Passkey",
        ],
      );
      return { ok: true, session: await newSession("enroll", now) };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(400, "Passkey check failed.");
    }
  }
  if (action === "auth_options") {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required", allowCredentials: [] });
    return { challengeId: await saveChallenge("auth", options.challenge, null, now), options };
  }
  if (action === "auth_verify") {
    await throttle(now);
    const challenge = await takeChallenge(body.challengeId, "auth", now);
    const credentialId = isRecord(body.credential) ? String(body.credential.id ?? "") : "";
    const cred = await query<{ id: string; public_key: string; counter: unknown; transports: unknown }>(
      `select id, public_key, counter, transports from ours_passkey_credentials where id = $1`,
      [credentialId],
    );
    const row = cred[0];
    if (!row) {
      await logAttempt("passkey", false);
      throw new AuthError(403, "This passkey isn't set up for Ours. Use a setup code to add this device.");
    }
    try {
      const result = await verifyAuthenticationResponse({
        response: body.credential as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: row.id,
          publicKey: isoBase64URL.toBuffer(row.public_key),
          counter: asNumber(row.counter),
          transports: asStrings(row.transports) as ("internal" | "hybrid")[],
        },
      });
      if (!result.verified) throw new AuthError(403, "Passkey check failed.");
      await query(`update ours_passkey_credentials set counter = $2, last_used_at = $3 where id = $1`, [
        row.id,
        result.authenticationInfo.newCounter,
        now.toISOString(),
      ]);
      await logAttempt("passkey", true);
      return { ok: true, session: await newSession("passkey", now) };
    } catch (error) {
      if (!(error instanceof AuthError)) await logAttempt("passkey", false);
      if (error instanceof AuthError) throw error;
      throw new AuthError(403, "Passkey check failed.");
    }
  }
  if (action === "backup_login") {
    await throttle(now);
    const used = await query(
      `update ours_backup_codes set used_at = $2 where code_hash = $1 and used_at is null returning id`,
      [await sha256Hex(canonicalCode(body.code, 5)), now.toISOString()],
    );
    if (used.length === 0) {
      await logAttempt("backup_code", false);
      throw new AuthError(403, "That backup code isn't valid or was already used.");
    }
    await logAttempt("backup_code", true);
    const left = await query<{ count: unknown }>(`select count(*)::int as count from ours_backup_codes where used_at is null`);
    return { ok: true, session: await newSession("backup_code", now), backup_codes_left: asNumber(left[0]?.count ?? 0) };
  }
  if (action === "new_setup_code") {
    await requireSession(body.token, now);
    const code = randomGroupedCode(3, 4);
    const expires = new Date(now.getTime() + SETUP_MS).toISOString();
    await query(`insert into ours_device_setup_codes (code_hash, expires_at) values ($1, $2)`, [await sha256Hex(code), expires]);
    return { code, expires_at: expires };
  }
  if (action === "new_backup_codes") {
    await requireSession(body.token, now);
    if (body.confirm !== true) throw new AuthError(400, "Confirm that the current backup codes should be replaced.");
    const codes = Array.from({ length: 10 }, () => randomGroupedCode(2, 5));
    await query(`delete from ours_backup_codes where id >= 0`);
    for (const code of codes) await query(`insert into ours_backup_codes (code_hash) values ($1)`, [await sha256Hex(code)]);
    return { codes };
  }
  if (action === "check") {
    await requireSession(body.token, now);
    return { ok: true };
  }
  throw new AuthError(400, "Unknown action");
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !ORIGINS.includes(origin)) {
    return json(request, 403, { error: "This site is not allowed to sign in." });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, 405, { error: "POST only" });
  const text = await request.text();
  if (text.length > 2_000_000) return json(request, 413, { error: "payload too large" });
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return json(request, 400, { error: "invalid json" });
    }
  }
  try {
    return json(request, 200, await handle(isRecord(body) ? body : {}, new Date()));
  } catch (error) {
    if (error instanceof AuthError) return json(request, error.status, { error: error.message });
    return json(request, 500, { error: "Auth is not configured." });
  }
});
