import { describe, expect, it } from 'vitest';
import { formatUsd, resolveTithing, tithingDueCents, tithingStatusLabel } from '../src/index.ts';

const base = {
  weekStart: '2026-11-02',
  weekLabel: 'Nov 2 – Nov 8, 2026',
  withheldCount: 0,
};

describe('tithing', () => {
  it('rounds half-up on exact cents and never invents a percent', () => {
    expect(tithingDueCents(240_000, 1000)).toBe(24_000);
    expect(tithingDueCents(1005, 1000)).toBe(101);
    expect(tithingDueCents(0, 1000)).toBe(0);
    expect(tithingDueCents(50_000, 0)).toBe(0);
  });

  it('has exactly one settled status, and unconfigured is separate', () => {
    const cases = [
      { earnedCents: 0, bps: null, paidCents: 0, markedCovered: false, label: 'Set a percent', state: 'unconfigured' },
      { earnedCents: 240_000, bps: null, paidCents: 0, markedCovered: false, label: 'Set a percent', state: 'unconfigured' },
      { earnedCents: 0, bps: 1000, paidCents: 0, markedCovered: false, label: 'Nothing due yet', state: 'nothing_due' },
      { earnedCents: 240_000, bps: 1000, paidCents: 0, markedCovered: false, label: 'Still to pay $240.00', state: 'still_to_pay' },
      { earnedCents: 240_000, bps: 1000, paidCents: 10_000, markedCovered: false, label: 'Still to pay $140.00', state: 'still_to_pay' },
      { earnedCents: 240_000, bps: 1000, paidCents: 24_000, markedCovered: false, label: 'Paid', state: 'paid' },
      { earnedCents: 240_000, bps: 1000, paidCents: 30_000, markedCovered: false, label: 'Covered', state: 'covered' },
      { earnedCents: 240_000, bps: 1000, paidCents: 0, markedCovered: true, label: 'Covered', state: 'covered' },
      { earnedCents: 0, bps: 1000, paidCents: 500, markedCovered: false, label: 'Covered', state: 'covered' },
      { earnedCents: 0, bps: 0, paidCents: 0, markedCovered: false, label: 'Nothing due yet', state: 'nothing_due' },
    ] as const;
    for (const item of cases) {
      const model = resolveTithing({ ...base, ...item });
      expect(model.state, item.label).toBe(item.state);
      expect(tithingStatusLabel(model)).toBe(item.label);
      if (item.state === 'unconfigured') {
        expect(model.dueCents).toBeNull();
        expect(model.percentLabel).toBeNull();
      }
    }
  });

  it('formats grouped currency from integer cents', () => {
    expect(formatUsd(240_000)).toBe('$2,400.00');
    expect(formatUsd(-125)).toBe('-$1.25');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
