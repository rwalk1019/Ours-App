const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalCode(code: unknown, group: number): string {
  const normalized = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.match(new RegExp(`.{1,${group}}`, 'g'))?.join('-') ?? '';
}

export function randomGroupedCode(groups: number, size: number): string {
  const parts: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  for (let group = 0; group < groups; group += 1) {
    let text = '';
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
  return parts.join('-');
}
