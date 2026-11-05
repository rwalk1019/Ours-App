import { describe, expect, it } from 'vitest';
import {
  denverCivilFromInstant,
  denverInstant,
  formatCivilDate,
  lastCompletedMonth,
  lastCompletedWeek,
  lastCompletedYear,
  parseCivilDate,
  reportIdempotencyKey,
  weekContaining,
} from '../src/index.ts';

describe('America/Denver periods', () => {
  it('keeps civil dates on the Denver side of midnight, including the November fallback', () => {
    expect(formatCivilDate(denverCivilFromInstant(new Date('2026-11-09T06:59:00Z')))).toBe('2026-11-08');
    expect(formatCivilDate(denverCivilFromInstant(new Date('2026-11-09T07:00:00Z')))).toBe('2026-11-09');
    const midnight = denverInstant(parseCivilDate('2026-11-05'));
    expect(formatCivilDate(denverCivilFromInstant(midnight))).toBe('2026-11-05');
  });

  it('keeps the March spring-forward week boundary', () => {
    expect(formatCivilDate(denverCivilFromInstant(new Date('2026-03-09T05:59:00Z')))).toBe('2026-03-08');
    expect(formatCivilDate(denverCivilFromInstant(new Date('2026-03-09T06:00:00Z')))).toBe('2026-03-09');
    expect(weekContaining('2026-03-08')).toEqual({ start: '2026-03-02', end: '2026-03-08' });
  });

  it('uses the last finished Monday–Sunday, calendar month, and year', () => {
    const thursday = new Date('2026-11-05T18:00:00Z');
    expect(lastCompletedWeek(thursday)).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(reportIdempotencyKey('week', lastCompletedWeek(thursday))).toBe('week:2026-10-26');
    expect(lastCompletedMonth(thursday)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(reportIdempotencyKey('month', lastCompletedMonth(thursday))).toBe('month:2026-10');
    expect(lastCompletedYear(thursday)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(reportIdempotencyKey('year', lastCompletedYear(thursday))).toBe('year:2025');

    const newYears = new Date('2026-01-01T07:30:00Z');
    expect(lastCompletedYear(newYears).start).toBe('2025-01-01');
    expect(lastCompletedMonth(newYears)).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    expect(lastCompletedWeek(newYears)).toEqual({ start: '2025-12-22', end: '2025-12-28' });

    const mondayMorning = new Date('2026-11-09T07:05:00Z');
    expect(lastCompletedWeek(mondayMorning)).toEqual({ start: '2026-11-02', end: '2026-11-08' });
  });
});
