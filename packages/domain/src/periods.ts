import {
  addDays,
  denverCivilFromInstant,
  formatCivilDate,
  formatCivilPretty,
  mondayOnOrBefore,
  parseCivilDate,
  type CivilDate,
} from './denver.js';

export type PeriodKind = 'week' | 'month' | 'year';

export type DateRange = { start: string; end: string };

export function weekContaining(date: string): DateRange {
  const monday = mondayOnOrBefore(parseCivilDate(date));
  return { start: formatCivilDate(monday), end: formatCivilDate(addDays(monday, 6)) };
}

export function monthContaining(date: string): DateRange {
  const civil = parseCivilDate(date);
  const start: CivilDate = { year: civil.year, month: civil.month, day: 1 };
  const next: CivilDate =
    civil.month === 12
      ? { year: civil.year + 1, month: 1, day: 1 }
      : { year: civil.year, month: civil.month + 1, day: 1 };
  return { start: formatCivilDate(start), end: formatCivilDate(addDays(next, -1)) };
}

export function yearContaining(date: string): DateRange {
  const civil = parseCivilDate(date);
  return { start: `${civil.year}-01-01`, end: `${civil.year}-12-31` };
}

export function rangeForAnchor(kind: PeriodKind, anchor: string): DateRange {
  if (kind === 'week') return weekContaining(anchor);
  if (kind === 'month') return monthContaining(anchor);
  return yearContaining(anchor);
}

export function shiftAnchor(kind: PeriodKind, anchor: string, direction: -1 | 1): string {
  if (kind === 'week') return formatCivilDate(addDays(parseCivilDate(weekContaining(anchor).start), direction * 7));
  if (kind === 'year') {
    const year = parseCivilDate(anchor).year + direction;
    return `${year}-06-01`;
  }
  const civil = parseCivilDate(monthContaining(anchor).start);
  const index = civil.year * 12 + (civil.month - 1) + direction;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return formatCivilDate({ year, month, day: 1 });
}

export function inRange(postedOn: string, range: DateRange): boolean {
  return postedOn >= range.start && postedOn <= range.end;
}

/** The Monday–Sunday week that most recently finished before `now` in Denver. */
export function lastCompletedWeek(now: Date): DateRange {
  const today = formatCivilDate(denverCivilFromInstant(now));
  const thisWeek = weekContaining(today);
  const start = addDays(parseCivilDate(thisWeek.start), -7);
  return { start: formatCivilDate(start), end: formatCivilDate(addDays(start, 6)) };
}

/** The calendar month before the Denver month that contains `now`. */
export function lastCompletedMonth(now: Date): DateRange {
  const today = denverCivilFromInstant(now);
  const index = today.year * 12 + (today.month - 1) - 1;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return monthContaining(formatCivilDate({ year, month, day: 1 }));
}

/** The calendar year before the Denver year that contains `now`. */
export function lastCompletedYear(now: Date): DateRange {
  const today = denverCivilFromInstant(now);
  const year = today.year - 1;
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

export function lastCompletedRange(kind: PeriodKind, now: Date): DateRange {
  if (kind === 'week') return lastCompletedWeek(now);
  if (kind === 'month') return lastCompletedMonth(now);
  return lastCompletedYear(now);
}

export function reportIdempotencyKey(kind: PeriodKind, range: DateRange): string {
  if (kind === 'week') return `week:${range.start}`;
  if (kind === 'month') return `month:${range.start.slice(0, 7)}`;
  return `year:${range.start.slice(0, 4)}`;
}

export function formatPeriodLabel(kind: PeriodKind, range: DateRange): string {
  if (kind === 'year') return range.start.slice(0, 4);
  if (kind === 'month') return formatCivilPretty(range.start, { month: 'long', year: 'numeric' });
  const start = formatCivilPretty(range.start, { month: 'short', day: 'numeric' });
  const end = formatCivilPretty(range.end, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${start} – ${end}`;
}

export function isMonday(date: string): boolean {
  return mondayOnOrBefore(parseCivilDate(date)).day === parseCivilDate(date).day &&
    formatCivilDate(mondayOnOrBefore(parseCivilDate(date))) === date;
}
