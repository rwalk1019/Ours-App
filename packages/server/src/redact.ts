const SENSITIVE = /token|code|pepper|cookie|authorization|merchant|amount|balance|email|secret|payload|description|publickey|credential/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE.test(key) ? '[redacted]' : redact(child);
    }
    return out;
  }
  return value;
}
