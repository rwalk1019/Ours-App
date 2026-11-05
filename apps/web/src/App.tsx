import { shiftAnchor, type PeriodKind } from '@ours/domain';
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from './api';
import { createPasskey, usePasskey } from './passkey';
import { dollarsToCents, HouseholdScreen, type HouseholdActions } from './screens/HouseholdScreen';
import { LockedScreen } from './screens/LockedScreen';
import type { SamplePayload } from './demo/sample';

const DemoApp = lazy(() => import('./demo/DemoApp').then((mod) => ({ default: mod.DemoApp })));

type Phase =
  | { kind: 'loading' }
  | { kind: 'locked'; setupRequired: boolean; notice?: string }
  | { kind: 'error' }
  | { kind: 'home'; payload: SamplePayload; period: PeriodKind; anchor?: string }
  | { kind: 'demo' };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  async function loadHousehold(period: PeriodKind = 'week', anchor?: string) {
    const params = new URLSearchParams({ period });
    if (anchor) params.set('anchor', anchor);
    const result = await api(`/api/household?${params}`);
    if (result.status === 401) {
      setPhase({ kind: 'locked', setupRequired: false });
      return;
    }
    if (!result.ok) {
      setPhase({ kind: 'error' });
      return;
    }
    setPhase({ kind: 'home', payload: result.data as SamplePayload, period, anchor });
  }

  useEffect(() => {
    void (async () => {
      const status = await api('/api/auth/status');
      if (!status.ok) {
        setPhase({ kind: 'error' });
        return;
      }
      if (status.data.state !== 'ready') {
        setPhase({ kind: 'locked', setupRequired: true });
        return;
      }
      await loadHousehold();
    })();
  }, []);

  if (phase.kind === 'loading') {
    return <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center bg-paper text-sm text-[#6d5c4d] lg:my-8 lg:rounded-[32px]">Opening Ours…</main>;
  }
  if (phase.kind === 'error') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center bg-paper px-6 lg:my-8 lg:rounded-[32px]">
        <h1 className="font-display text-5xl">Ours can’t reach the server</h1>
        <p className="mt-4 text-[#5c4d40]">Nothing from the household is shown until the connection works.</p>
        <button className="mt-6 text-sm underline" type="button" onClick={() => window.location.reload()}>Try again</button>
      </main>
    );
  }
  if (phase.kind === 'demo') {
    return (
      <Suspense fallback={<main className="mx-auto min-h-dvh max-w-md bg-paper" />}>
        <DemoApp onLeave={() => setPhase({ kind: 'locked', setupRequired: true })} />
      </Suspense>
    );
  }
  if (phase.kind === 'locked') {
    return (
      <div className="min-h-dvh bg-[#e7d5c3]">
        <LockedScreen
          setupRequired={phase.setupRequired}
          notice={phase.notice}
          onDemo={() => setPhase({ kind: 'demo' })}
          onSetup={async (code) => {
            const result = await api('/api/auth/setup/begin', { body: { code } });
            if (!result.ok) throw new Error('That code isn’t valid.');
            return (result.data as { options: unknown }).options;
          }}
          onRecovery={async (code) => {
            const result = await api('/api/auth/recovery/begin', { body: { code } });
            if (!result.ok) throw new Error('That code isn’t valid.');
            return (result.data as { options: unknown }).options;
          }}
          onCreate={async (options) => {
            const response = await createPasskey(options);
            const result = await api('/api/auth/register/finish', { body: { response } });
            if (!result.ok) throw new Error('The passkey could not be saved.');
            const codes = (result.data as { recoveryCodes?: string[] | null }).recoveryCodes;
            if (codes?.length) window.alert(`Write these recovery codes down. They are shown once.\n\n${codes.join('\n')}`);
            await loadHousehold();
          }}
          onUnlock={async () => {
            const begin = await api('/api/auth/authenticate/begin', { body: {} });
            if (!begin.ok) throw new Error('Unlock isn’t available.');
            const response = await usePasskey((begin.data as { options: unknown }).options);
            const finish = await api('/api/auth/authenticate/finish', { body: { response } });
            if (!finish.ok) throw new Error('That passkey was not accepted.');
            await loadHousehold();
          }}
        />
      </div>
    );
  }

  const payload = phase.payload;
  const reload = (period = phase.period, anchor = phase.anchor) => loadHousehold(period, anchor);
  const actions: HouseholdActions = {
    async setTithing(bps) {
      const result = await api('/api/settings/tithing', { method: 'PUT', body: { bps } });
      if (!result.ok) throw new Error('The percent was not saved.');
      await reload();
    },
    async saveTarget(categoryId, amountDollars) {
      const result = await api('/api/targets', { method: 'PUT', body: { categoryId, period: phase.period, amountCents: dollarsToCents(amountDollars) } });
      if (!result.ok) throw new Error('The target was not saved.');
      await reload();
    },
    async deleteTarget(id) {
      const result = await api(`/api/targets/${id}`, { method: 'DELETE' });
      if (!result.ok) throw new Error('The target was not removed.');
      await reload();
    },
    async saveRule(pattern, categoryId) {
      const result = await api('/api/fix-rules', { body: { pattern, matchField: 'merchant', categoryId, kindOverride: null, priority: 100 } });
      if (!result.ok) throw new Error('The rule was not saved.');
      await reload();
    },
    async deleteRule(id) {
      const result = await api(`/api/fix-rules/${id}`, { method: 'DELETE' });
      if (!result.ok) throw new Error('The rule was not removed.');
      await reload();
    },
    async saveItem(input) {
      const result = await api('/api/custom-items', {
        body: { name: input.name, kind: input.kind, role: input.role, valueCents: dollarsToCents(input.amountDollars), asOf: input.asOf, note: null },
      });
      if (!result.ok) throw new Error('The item was not saved.');
      await reload();
    },
    async deleteItem(id) {
      const result = await api(`/api/custom-items/${id}`, { method: 'DELETE' });
      if (!result.ok) throw new Error('The item was not removed.');
      await reload();
    },
    async classify(id, kind) {
      const result = await api(`/api/transactions/${id}/classification`, { body: { kind, categoryId: null } });
      if (!result.ok) throw new Error('That classification was not saved.');
      await reload();
    },
    async refresh() {
      const result = await api('/api/refresh-requests', { body: {} });
      if (!result.ok) throw new Error('The refresh request was not saved.');
      await reload();
      return 'Refresh requested. This phone does not connect to the bank.';
    },
    async setCovered(weekStart, covered) {
      const result = await api('/api/tithing/coverage', { body: { weekStart, covered } });
      if (!result.ok) throw new Error('That status was not saved.');
      await reload();
    },
    async addPayment(weekStart, amountDollars) {
      const result = await api('/api/tithing/payments', { body: { weekStart, amountCents: dollarsToCents(amountDollars), paidOn: payload.period.start } });
      if (!result.ok) throw new Error('The payment was not saved.');
      await reload();
    },
    async signOut() {
      await api('/api/auth/logout', { body: {} });
      setPhase({ kind: 'locked', setupRequired: false });
    },
  };

  return (
    <div className="min-h-dvh bg-[#e7d5c3]">
      <HouseholdScreen
        payload={payload}
        onPeriod={(period) => void reload(period, undefined)}
        onShift={(direction) => void reload(phase.period, shiftAnchor(phase.period, phase.anchor ?? payload.period.start, direction))}
        actions={actions}
      />
    </div>
  );
}
