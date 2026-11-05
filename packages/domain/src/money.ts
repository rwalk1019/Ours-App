/** Household amounts are integer cents. Nothing in this file uses binary floating point. */

export const MAX_CENTS = 10_000_000_000;

export function isSafeCents(cents: number): boolean {
  return Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_CENTS;
}

export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatUsd(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${negative ? '-' : ''}$${groupDigits(dollars)}.${String(rem).padStart(2, '0')}`;
}

/**
 * Parse a decimal dollar string into cents.
 * Accepts "-12", "12", or "12.30" — never a one-decimal float and never a JSON number.
 */
export function decimalStringToCents(value: string): number | null {
  if (typeof value !== 'string') return null;
  if (!/^-?\d+(\.\d{2})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const raw = negative ? value.slice(1) : value;
  const [dollars, frac = '00'] = raw.split('.');
  if (dollars === undefined) return null;
  const cents = Number(dollars) * 100 + Number(frac);
  if (!isSafeCents(cents)) return null;
  return negative ? -cents : cents;
}

/** Half-up division for a non-negative numerator. */
export function tithingDueCents(earnedCents: number, bps: number): number {
  if (!Number.isSafeInteger(earnedCents) || earnedCents <= 0) return 0;
  if (!Number.isSafeInteger(bps) || bps <= 0) return 0;
  return Math.floor((earnedCents * bps + 5_000) / 10_000);
}

export function formatPercentFromBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return `${whole}%`;
  if (frac % 10 === 0) return `${whole}.${frac / 10}%`;
  return `${whole}.${String(frac).padStart(2, '0')}%`;
}
