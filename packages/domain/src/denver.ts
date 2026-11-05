export const HOUSEHOLD_TIME_ZONE = 'America/Denver';

export type CivilDate = { year: number; month: number; day: number };

export class ContractError extends Error {
  readonly field: string | undefined;
  constructor(
    readonly code: string,
    field?: string,
  ) {
    super(code);
    this.name = 'ContractError';
    this.field = field;
  }
}

export function parseCivilDate(value: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ContractError('invalid_date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new ContractError('invalid_date');
  }
  return { year, month, day };
}

export function formatCivilDate(date: CivilDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

export function daysBetween(a: CivilDate, b: CivilDate): number {
  const left = Date.UTC(a.year, a.month - 1, a.day);
  const right = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((right - left) / 86_400_000);
}

/** 0 Sunday … 6 Saturday, for the civil date itself (not a zoned instant). */
export function weekdayIndex(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function mondayOnOrBefore(date: CivilDate): CivilDate {
  const weekday = weekdayIndex(date);
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return addDays(date, delta);
}

function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes) => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error('missing_date_part');
    return Number(found.value);
  };
  let hour = pick('hour');
  if (hour === 24) hour = 0;
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour,
    minute: pick('minute'),
    second: pick('second'),
  };
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

export function denverCivilFromInstant(instant: Date): CivilDate {
  const parts = zonedParts(instant, HOUSEHOLD_TIME_ZONE);
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function denverToday(now: Date): string {
  return formatCivilDate(denverCivilFromInstant(now));
}

/** UTC instant of a civil clock time in America/Denver. */
export function denverInstant(date: CivilDate, hour = 0, minute = 0, second = 0): Date {
  const utcGuess = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second);
  let offset = timeZoneOffsetMs(new Date(utcGuess), HOUSEHOLD_TIME_ZONE);
  let result = utcGuess - offset;
  offset = timeZoneOffsetMs(new Date(result), HOUSEHOLD_TIME_ZONE);
  result = utcGuess - offset;
  return new Date(result);
}

export function formatDenverTimestamp(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: HOUSEHOLD_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}

export function formatCivilPretty(value: string, options: Intl.DateTimeFormatOptions): string {
  const date = parseCivilDate(value);
  const noon = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(noon);
}
