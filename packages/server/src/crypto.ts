const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function generateCode(length: number): string {
  let out = '';
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    const byte = randomBytes(1)[0];
    if (byte === undefined || byte >= limit) continue;
    const char = ALPHABET[byte % ALPHABET.length];
    if (char) out += char;
  }
  return out;
}

export function formatCode(code: string, group: number): string {
  return code.match(new RegExp(`.{1,${group}}`, 'g'))?.join('-') ?? code;
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

export async function hmacCode(pepper: string, purpose: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${purpose}\0${normalizeCode(code)}`),
  );
  return base64url(new Uint8Array(signature));
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}
