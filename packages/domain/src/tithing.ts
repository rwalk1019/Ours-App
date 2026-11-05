import { formatPercentFromBps, formatUsd, tithingDueCents } from './money.js';

export type TithingState = 'unconfigured' | 'nothing_due' | 'still_to_pay' | 'paid' | 'covered';

export type TithingModel = {
  state: TithingState;
  weekStart: string;
  weekLabel: string;
  earnedCents: number;
  bps: number | null;
  percentLabel: string | null;
  dueCents: number | null;
  paidCents: number;
  remainingCents: number | null;
  markedCovered: boolean;
  withheldCount: number;
};

export function resolveTithing(input: {
  weekStart: string;
  weekLabel: string;
  earnedCents: number;
  bps: number | null;
  paidCents: number;
  markedCovered: boolean;
  withheldCount: number;
}): TithingModel {
  const paidCents = Math.max(0, input.paidCents);
  if (input.bps === null) {
    return {
      state: 'unconfigured',
      weekStart: input.weekStart,
      weekLabel: input.weekLabel,
      earnedCents: input.earnedCents,
      bps: null,
      percentLabel: null,
      dueCents: null,
      paidCents,
      remainingCents: null,
      markedCovered: false,
      withheldCount: input.withheldCount,
    };
  }

  const dueCents = tithingDueCents(input.earnedCents, input.bps);
  const percentLabel = formatPercentFromBps(input.bps);
  const base = {
    weekStart: input.weekStart,
    weekLabel: input.weekLabel,
    earnedCents: input.earnedCents,
    bps: input.bps,
    percentLabel,
    dueCents,
    paidCents,
    markedCovered: input.markedCovered,
    withheldCount: input.withheldCount,
  };

  if (input.markedCovered || paidCents > dueCents) {
    return { ...base, state: 'covered', remainingCents: 0 };
  }
  if (dueCents === 0 && paidCents === 0) {
    return { ...base, state: 'nothing_due', remainingCents: 0 };
  }
  if (paidCents === dueCents && dueCents > 0) {
    return { ...base, state: 'paid', remainingCents: 0 };
  }
  const remainingCents = dueCents - paidCents;
  return { ...base, state: 'still_to_pay', remainingCents };
}

/** The single primary-card sentence. Unconfigured is not one of the four settled statuses. */
export function tithingStatusLabel(model: TithingModel): string {
  switch (model.state) {
    case 'unconfigured':
      return 'Set a percent';
    case 'nothing_due':
      return 'Nothing due yet';
    case 'still_to_pay':
      return `Still to pay ${formatUsd(model.remainingCents ?? 0)}`;
    case 'paid':
      return 'Paid';
    case 'covered':
      return 'Covered';
  }
}
