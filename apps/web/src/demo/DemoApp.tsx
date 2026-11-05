import { denverToday, shiftAnchor, type PeriodKind, type TxKind } from '@ours/domain';
import { useMemo, useState } from 'react';
import { HouseholdScreen, dollarsToCents, type HouseholdActions } from '@/screens/HouseholdScreen';
import { initialFacts, presentSample, type SampleFacts, type SampleSituation } from './sample';

export function DemoApp({ onLeave }: { onLeave: () => void }) {
  const [situation, setSituation] = useState<SampleSituation | 'error'>('ready');
  const [facts, setFacts] = useState<SampleFacts>(() => initialFacts('ready'));
  const [period, setPeriod] = useState<PeriodKind>('week');
  const [anchor, setAnchor] = useState(() => denverToday(new Date()));
  const payload = useMemo(() => presentSample(facts, period, anchor), [facts, period, anchor]);

  function update(change: (current: SampleFacts) => SampleFacts) {
    setFacts((current) => change(current));
  }

  const actions: HouseholdActions = {
    async setTithing(bps) {
      update((current) => ({ ...current, tithingBps: bps }));
    },
    async saveTarget(categoryId, amountDollars) {
      const amountCents = dollarsToCents(amountDollars);
      update((current) => ({
        ...current,
        targets: [
          ...current.targets.filter((target) => !(target.categoryId === categoryId && target.period === period)),
          { id: `target-${categoryId}-${period}`, categoryId, period, amountCents },
        ],
      }));
    },
    async deleteTarget(id) {
      update((current) => ({ ...current, targets: current.targets.filter((target) => target.id !== id) }));
    },
    async saveRule(pattern, categoryId) {
      update((current) => ({
        ...current,
        rules: [...current.rules, { id: `rule-${current.rules.length + 1}`, pattern, matchField: 'merchant', categoryId, kindOverride: null, priority: 10 }],
      }));
    },
    async deleteRule(id) {
      update((current) => ({ ...current, rules: current.rules.filter((rule) => rule.id !== id) }));
    },
    async saveItem(input) {
      update((current) => ({
        ...current,
        customItems: [
          ...current.customItems,
          { id: `item-${current.customItems.length + 1}`, name: input.name, kind: input.kind, role: input.role, valueCents: dollarsToCents(input.amountDollars), asOf: input.asOf, note: null },
        ],
      }));
    },
    async deleteItem(id) {
      update((current) => ({ ...current, customItems: current.customItems.filter((item) => item.id !== id) }));
    },
    async classify(id, kind) {
      update((current) => ({
        ...current,
        locks: [...current.locks.filter((lock) => lock.externalId !== id), { externalId: id, kind: kind as TxKind, categoryId: null }],
      }));
    },
    async refresh() {
      return 'Refresh requested in the sample. This preview does not contact a bank.';
    },
    async setCovered(weekStart, covered) {
      update((current) => ({
        ...current,
        coveredWeeks: covered ? [...new Set([...current.coveredWeeks, weekStart])] : current.coveredWeeks.filter((week) => week !== weekStart),
      }));
    },
    async addPayment(weekStart, amountDollars) {
      update((current) => ({
        ...current,
        payments: [...current.payments, { id: `pay-${current.payments.length + 1}`, weekStart, amountCents: dollarsToCents(amountDollars), paidOn: denverToday(current.now) }],
      }));
    },
  };

  if (situation === 'error') {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md bg-paper px-6 py-10 lg:my-8 lg:rounded-[32px]">
        <p className="rounded-full bg-ink px-4 py-2 text-center text-xs text-[#f6f1e8]">Sample preview of an error. No household figures.</p>
        <h1 className="font-display mt-10 text-5xl leading-none">Ours can’t reach the server</h1>
        <p className="mt-4 text-[#5c4d40]">Nothing from the household is shown until the connection works.</p>
        <button className="mt-8 text-sm underline" type="button" onClick={() => setSituation('ready')}>Back to the sample</button>
      </main>
    );
  }

  return (
    <HouseholdScreen
      payload={payload}
      banner="Sample household. These figures are fictional."
      footnote="Edits in this preview are forgotten when you leave. A signed-in household keeps them on the server."
      onLeave={onLeave}
      onPeriod={(next) => {
        setPeriod(next);
        setAnchor(denverToday(facts.now));
      }}
      onShift={(direction) => setAnchor(shiftAnchor(period, anchor, direction))}
      situations={{
        value: situation,
        onChange: (value) => {
          const next = value as SampleSituation | 'error';
          setSituation(next);
          if (next !== 'error') setFacts(initialFacts(next));
        },
      }}
      actions={actions}
    />
  );
}
