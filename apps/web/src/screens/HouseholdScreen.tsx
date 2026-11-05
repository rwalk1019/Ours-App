import { decimalStringToCents, formatUsd, type PeriodKind } from '@ours/domain';
import { Home, Landmark, List, Settings } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { SamplePayload } from '@/demo/sample';

type Tab = 'home' | 'activity' | 'worth' | 'settings';

export type HouseholdActions = {
  setTithing: (bps: number | null) => Promise<void>;
  saveTarget: (categoryId: string, amountDollars: string) => Promise<void>;
  deleteTarget: (id: string) => Promise<void>;
  saveRule: (pattern: string, categoryId: string) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  saveItem: (input: { name: string; kind: 'asset' | 'liability'; role: 'house' | 'car' | 'loan' | 'other'; amountDollars: string; asOf: string }) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  classify: (id: string, kind: string, categoryId: string | null) => Promise<void>;
  refresh: () => Promise<string | void>;
  setCovered: (weekStart: string, covered: boolean) => Promise<void>;
  addPayment: (weekStart: string, amountDollars: string) => Promise<void>;
  signOut?: () => Promise<void>;
};

const kindLabel: Record<string, string> = {
  income: 'Earnings',
  expense: 'Spending',
  refund: 'Refund',
  transfer: 'Transfer',
  debt_payment: 'Debt payment',
  unreviewed: 'Needs a look',
};

export function HouseholdScreen({
  payload,
  banner,
  footnote,
  situations,
  onPeriod,
  onShift,
  onLeave,
  actions,
}: {
  payload: SamplePayload;
  banner?: string;
  footnote?: string;
  situations?: { value: string; onChange: (value: string) => void };
  onPeriod: (period: PeriodKind) => void;
  onShift: (direction: -1 | 1) => void;
  onLeave?: () => void;
  actions: HouseholdActions;
}) {
  const [tab, setTab] = useState<Tab>('home');
  const [tithingOpen, setTithingOpen] = useState(false);
  const [message, setMessage] = useState('');
  const tithing = payload.tithing;
  const clay = tithing.state === 'still_to_pay';
  const calm = tithing.state === 'paid' || tithing.state === 'covered';

  return (
    <div className="mx-auto min-h-dvh w-full max-w-md bg-paper lg:my-6 lg:min-h-[820px] lg:rounded-[32px] lg:shadow-card">
      {banner ? <p className="bg-ink px-4 py-2 text-center text-xs tracking-wide text-[#f6f1e8] lg:rounded-t-[32px]">{banner}</p> : null}
      <div className="space-y-5 px-4 pb-24 pt-5">
        <header className="flex items-end justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[#8a7363]">Ours</p>
            <h1 className="font-display text-4xl leading-none">{tab === 'home' ? 'This household' : tab === 'activity' ? 'Activity' : tab === 'worth' ? 'Worth' : 'Settings'}</h1>
          </div>
          <PeriodSwitch kind={payload.period.kind} onPeriod={onPeriod} />
        </header>
        <div className="flex items-center justify-between text-sm text-[#6d5c4d]">
          <button type="button" onClick={() => onShift(-1)} aria-label="Previous period">Previous</button>
          <span>{payload.period.label}</span>
          <button type="button" onClick={() => onShift(1)} aria-label="Next period">Next</button>
        </div>
        {message ? <p className="rounded-2xl bg-[#f3e2d4] px-4 py-3 text-sm">{message}</p> : null}
        <Freshness payload={payload} />
        {tab === 'home' ? <HomeTab payload={payload} clay={clay} calm={calm} onOpen={() => setTithingOpen(true)} actions={actions} setMessage={setMessage} /> : null}
        {tab === 'activity' ? <ActivityTab payload={payload} actions={actions} setMessage={setMessage} /> : null}
        {tab === 'worth' ? <WorthTab payload={payload} actions={actions} setMessage={setMessage} /> : null}
        {tab === 'settings' ? <SettingsTab payload={payload} actions={actions} setMessage={setMessage} onLeave={onLeave} footnote={footnote} situations={situations} /> : null}
      </div>
      <nav className="fixed bottom-0 left-1/2 z-30 flex w-full max-w-md -translate-x-1/2 justify-around border-t border-line bg-[#fbf7f1] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
        <NavButton label="Home" active={tab === 'home'} onClick={() => setTab('home')} icon={<Home className="h-4 w-4" />} />
        <NavButton label="Activity" active={tab === 'activity'} onClick={() => setTab('activity')} icon={<List className="h-4 w-4" />} />
        <NavButton label="Worth" active={tab === 'worth'} onClick={() => setTab('worth')} icon={<Landmark className="h-4 w-4" />} />
        <NavButton label="Settings" active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Settings className="h-4 w-4" />} />
      </nav>
      <Dialog open={tithingOpen} onOpenChange={setTithingOpen}>
        {tithingOpen ? (
          <DialogContent title="Tithing">
            <TithingDetail payload={payload} actions={actions} setMessage={setMessage} />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function PeriodSwitch({ kind, onPeriod }: { kind: PeriodKind; onPeriod: (period: PeriodKind) => void }) {
  return (
    <div className="flex rounded-full bg-[#efe4d4] p-1 text-xs">
      {(['week', 'month', 'year'] as const).map((period) => (
        <button key={period} type="button" className={`rounded-full px-2.5 py-1 capitalize ${kind === period ? 'bg-white shadow-sm' : ''}`} onClick={() => onPeriod(period)}>
          {period}
        </button>
      ))}
    </div>
  );
}

function NavButton({ label, active, onClick, icon }: { label: string; active: boolean; onClick: () => void; icon: ReactNode }) {
  return (
    <button type="button" className={`flex min-h-11 min-w-16 flex-col items-center text-[11px] ${active ? 'text-clay' : 'text-[#8a7363]'}`} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function Freshness({ payload }: { payload: SamplePayload }) {
  const fresh = payload.freshness;
  if (fresh.status === 'missing') {
    return <p className="rounded-2xl bg-[#efe6d8] px-4 py-3 text-sm">No bank snapshot yet. Nothing here is bank-verified.</p>;
  }
  return (
    <div className="space-y-2">
      {fresh.status === 'unchanged_after_failure' ? (
        <p className="rounded-2xl bg-[#f3e1c8] px-4 py-3 text-sm">
          A later import failed {fresh.lastFailureLabel}. These figures stay at the {fresh.balancesAsOfLabel} bank verification.
        </p>
      ) : (
        <p className="text-sm text-[#6d5c4d]">Balances as of {fresh.balancesAsOfLabel}</p>
      )}
      {fresh.lastImportedLabel ? <p className="text-xs text-[#8a7363]">Imported {fresh.lastImportedLabel}. That is not a new bank timestamp.</p> : null}
      {fresh.pendingRefreshLabel ? <p className="text-sm">Refresh requested {fresh.pendingRefreshLabel}. Waiting for the next bank import.</p> : null}
    </div>
  );
}

function HomeTab({ payload, clay, calm, onOpen, actions, setMessage }: { payload: SamplePayload; clay: boolean; calm: boolean; onOpen: () => void; actions: HouseholdActions; setMessage: (value: string) => void }) {
  const tithing = payload.tithing;
  const targets = payload.spending.byCategory.filter((row) => row.target);
  const rest = payload.spending.byCategory.filter((row) => !row.target && row.netCents !== 0);
  const nothingCounted =
    payload.earningsCents === 0 &&
    payload.spending.netCents === 0 &&
    payload.spending.transferOutflowCents === 0 &&
    payload.spending.debtOutflowCents === 0 &&
    payload.spending.unreviewedCount === 0;
  return (
    <>
      <button type="button" onClick={onOpen} className={`w-full rounded-[28px] p-5 text-left shadow-card ${clay ? 'bg-clay text-[#fffaf3]' : calm ? 'bg-sage text-[#f5fff8]' : 'bg-white'}`}>
        <p className="text-xs uppercase tracking-[0.16em] opacity-80">Tithing · {tithing.weekLabel}</p>
        <p className="font-display mt-4 text-4xl leading-none">{tithing.label}</p>
        {tithing.state === 'unconfigured' ? (
          <p className="mt-3 text-sm opacity-80">Choose a percent and this week’s counted earnings will calculate it. Nothing is assumed.</p>
        ) : (
          <p className="mt-3 text-sm opacity-90">
            {formatUsd(tithing.earnedCents)} counted · {tithing.percentLabel}
          </p>
        )}
        <p className="mt-4 text-xs uppercase tracking-wide opacity-70">Tap for the breakdown</p>
      </button>
      {nothingCounted ? null : (
      <section className="grid grid-cols-2 gap-3">
        <figure className="rounded-3xl bg-white p-4">
          <figcaption className="text-xs uppercase tracking-wide text-[#8a7363]">Earned</figcaption>
          <p className="font-display mt-2 text-2xl">{formatUsd(payload.earningsCents)}</p>
        </figure>
        <figure className="rounded-3xl bg-white p-4">
          <figcaption className="text-xs uppercase tracking-wide text-[#8a7363]">Spent</figcaption>
          <p className="font-display mt-2 text-2xl">{formatUsd(payload.spending.netCents)}</p>
        </figure>
      </section>
      )}
      <section className="space-y-3">
        <h2 className="text-sm uppercase tracking-[0.14em] text-[#8a7363]">Spending</h2>
        {!payload.spending.targetsConfigured ? <p className="rounded-2xl bg-white px-4 py-3 text-sm">No spending targets yet.</p> : null}
        {targets.map((row) => (
          <div key={row.name} className="rounded-3xl bg-white p-4">
            <div className="flex justify-between text-sm">
              <span>{row.name}</span>
              <span>{formatUsd(row.netCents)} of {formatUsd(row.target?.amountCents ?? 0)}</span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-[#efe4d4]">
              <div className="h-2 rounded-full bg-clay" style={{ width: `${Math.min(100, Math.round((row.netCents / Math.max(row.target?.amountCents ?? 1, 1)) * 100))}%` }} />
            </div>
          </div>
        ))}
        {rest.length > 0 ? (
          <div className="rounded-3xl bg-white p-4 text-sm">
            <p className="text-[#8a7363]">Without a target</p>
            {rest.map((row) => (
              <p key={row.name} className="mt-2 flex justify-between"><span>{row.name}</span><span>{formatUsd(row.netCents)}</span></p>
            ))}
          </div>
        ) : null}
        {nothingCounted ? null : (
          <p className="text-xs leading-relaxed text-[#6d5c4d]">
            Not counted as spending: transfers {formatUsd(payload.spending.transferOutflowCents)} out / {formatUsd(payload.spending.transferInflowCents)} in, debt payments {formatUsd(payload.spending.debtOutflowCents)} out. Refunds {formatUsd(payload.spending.refundCents)} reduce the category. {payload.spending.unreviewedCount} item{payload.spending.unreviewedCount === 1 ? '' : 's'} still need a look.
          </p>
        )}
      </section>
      <section className="rounded-[28px] bg-ink p-5 text-[#f6f1e8]">
        <p className="text-xs uppercase tracking-[0.16em] text-[#e4d2c0]">Net worth</p>
        <p className="font-display mt-3 text-4xl">{payload.freshness.status === 'missing' && payload.netWorth.customItems.length === 0 ? 'No figure yet' : formatUsd(payload.netWorth.netCents)}</p>
        <p className="mt-2 text-sm text-[#e4d2c0]">{payload.netWorth.hasBankBalances ? 'Bank balances plus custom items.' : 'Custom items only. No bank snapshot.'}</p>
      </section>
      <Button variant="secondary" className="w-full" onClick={() => actions.refresh().then((note) => setMessage(typeof note === 'string' ? note : 'Refresh requested. This phone does not connect to the bank.')).catch((error: Error) => setMessage(error.message))}>
        Request a bank refresh
      </Button>
    </>
  );
}

function ActivityTab({ payload, actions, setMessage }: { payload: SamplePayload; actions: HouseholdActions; setMessage: (value: string) => void }) {
  const rows = [
    ...payload.reviewQueue.map((row) => ({ ...row, kind: 'unreviewed' as const, categoryName: null as string | null })),
    ...payload.recent.filter((row) => !payload.reviewQueue.some((item) => item.id === row.id)),
  ];
  if (rows.length === 0) return <p className="rounded-3xl bg-white p-5 text-sm">No activity in this view.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.id} className="rounded-3xl bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">{row.merchantLabel ?? 'Untitled'}</p>
              <p className="text-xs text-[#8a7363]">{row.postedOn} · {kindLabel[row.kind] ?? row.kind}{row.categoryName ? ` · ${row.categoryName}` : ''}</p>
            </div>
            <p className="font-medium">{row.direction === 'outflow' ? '−' : ''}{formatUsd(row.amountCents)}</p>
          </div>
          {'reviewReasons' in row && row.reviewReasons.length > 0 ? <p className="mt-2 text-xs text-[#8d3f32]">{row.reviewReasons.join(', ')}</p> : null}
          {row.kind === 'unreviewed' ? (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => actions.classify(row.id, 'income', null).then(() => setMessage('Saved as earnings.')).catch((error: Error) => setMessage(error.message))}>Earnings</Button>
              <Button size="sm" variant="secondary" onClick={() => actions.classify(row.id, 'expense', null).then(() => setMessage('Saved as spending.')).catch((error: Error) => setMessage(error.message))}>Spending</Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function WorthTab({ payload, actions, setMessage }: { payload: SamplePayload; actions: HouseholdActions; setMessage: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      {payload.netWorth.accounts.map((account) => (
        <article key={account.accountId} className="rounded-3xl bg-white p-4">
          <p className="font-medium">{account.label}</p>
          <p className="text-sm text-[#6d5c4d]">{account.owedCents > 0 ? `${formatUsd(account.owedCents)} owed` : formatUsd(account.assetCents)}</p>
          <p className="text-xs text-[#8a7363]">As of {account.asOfLabel}{account.note ? ` · ${account.note}` : ''}</p>
        </article>
      ))}
      {payload.netWorth.customItems.map((item) => (
        <article key={item.id} className="rounded-3xl bg-white p-4">
          <div className="flex justify-between gap-3">
            <div>
              <p className="font-medium">{item.name}</p>
              <p className="text-xs text-[#8a7363]">{item.role[0]?.toUpperCase()}{item.role.slice(1)} · {item.kind} · as of {item.asOf}</p>
            </div>
            <p>{item.kind === 'liability' ? '−' : ''}{formatUsd(item.valueCents)}</p>
          </div>
          <Button className="mt-3" size="sm" variant="ghost" onClick={() => actions.deleteItem(item.id).catch((error: Error) => setMessage(error.message))}>Remove</Button>
        </article>
      ))}
      <Button variant="secondary" onClick={() => setOpen(true)}>Add a house, car, or loan</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <DialogContent title="Custom item"><ItemForm actions={actions} onDone={() => setOpen(false)} setMessage={setMessage} /></DialogContent> : null}
      </Dialog>
    </div>
  );
}

function SettingsTab({ payload, actions, setMessage, onLeave, footnote, situations }: { payload: SamplePayload; actions: HouseholdActions; setMessage: (value: string) => void; onLeave?: () => void; footnote?: string; situations?: { value: string; onChange: (value: string) => void } }) {
  const [percent, setPercent] = useState(payload.settings.tithingBps == null ? '' : String(payload.settings.tithingBps / 100));
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState(payload.categoryChoices[0]?.id ?? '');
  const [targetAmount, setTargetAmount] = useState('');
  return (
    <div className="space-y-4">
      {situations ? (
        <label className="block text-sm">
          Sample situation
          <select className="mt-1 h-11 w-full rounded-2xl border border-[#e0d0bd] bg-white px-3" value={situations.value} onChange={(event) => situations.onChange(event.target.value)}>
            <option value="ready">Ready sample</option>
            <option value="unconfigured">Percent and targets not set</option>
            <option value="empty">No bank snapshot</option>
            <option value="stale">Import failed, old balances kept</option>
            <option value="error">Can’t reach Ours</option>
          </select>
        </label>
      ) : null}
      <form className="space-y-2 rounded-3xl bg-white p-4" onSubmit={(event) => { event.preventDefault(); const bps = percent.trim() === '' ? null : Math.round(Number(percent) * 100); if (bps != null && (!Number.isInteger(bps) || bps < 0 || bps > 10000)) { setMessage('Enter a percent from 0 to 100, or leave it blank.'); return; } void actions.setTithing(bps).then(() => setMessage(bps == null ? 'Tithing percent cleared.' : 'Tithing percent saved.')).catch((error: Error) => setMessage(error.message)); }}>
        <label htmlFor="percent" className="text-sm">Tithing percent</label>
        <Input id="percent" inputMode="decimal" placeholder="Leave blank until you decide" value={percent} onChange={(event) => setPercent(event.target.value)} />
        <Button type="submit" variant="secondary">Save percent</Button>
      </form>
      <form className="space-y-2 rounded-3xl bg-white p-4" onSubmit={(event) => { event.preventDefault(); void actions.saveTarget(categoryId, targetAmount).then(() => setMessage('Target saved.')).catch((error: Error) => setMessage(error.message)); }}>
        <p className="text-sm">Spending target for this {payload.period.kind}</p>
        <select className="h-11 w-full rounded-2xl border border-[#e0d0bd] bg-white px-3" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          {payload.categoryChoices.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <Input inputMode="decimal" placeholder="Amount, like 150.00" value={targetAmount} onChange={(event) => setTargetAmount(event.target.value)} />
        <Button type="submit" variant="secondary">Save target</Button>
        {payload.spending.byCategory.filter((row) => row.target).map((row) => (
          <button key={row.target?.id} type="button" className="block text-left text-xs text-[#8d3f32]" onClick={() => row.target && actions.deleteTarget(row.target.id).catch((error: Error) => setMessage(error.message))}>Remove {row.name} target</button>
        ))}
      </form>
      <form className="space-y-2 rounded-3xl bg-white p-4" onSubmit={(event) => { event.preventDefault(); void actions.saveRule(pattern, categoryId).then(() => { setPattern(''); setMessage('Fix rule saved.'); }).catch((error: Error) => setMessage(error.message)); }}>
        <label className="text-sm" htmlFor="rule">Fix rule</label>
        <Input id="rule" placeholder="Merchant text, like north market" value={pattern} onChange={(event) => setPattern(event.target.value)} />
        <Button type="submit" variant="secondary">Save rule</Button>
        {payload.fixRules.map((rule) => (
          <p key={rule.id} className="flex justify-between text-sm"><span>“{rule.pattern}”</span><button type="button" onClick={() => actions.deleteRule(rule.id).catch((error: Error) => setMessage(error.message))}>Remove</button></p>
        ))}
      </form>
      {footnote ? <p className="text-xs text-[#6d5c4d]">{footnote}</p> : null}
      {onLeave ? <Button variant="outline" className="w-full" onClick={onLeave}>Leave sample</Button> : null}
      {actions.signOut ? <Button variant="outline" className="w-full" onClick={() => actions.signOut?.()}>Sign out</Button> : null}
    </div>
  );
}

function TithingDetail({ payload, actions, setMessage }: { payload: SamplePayload; actions: HouseholdActions; setMessage: (value: string) => void }) {
  const tithing = payload.tithing;
  const [amount, setAmount] = useState('');
  const [percent, setPercent] = useState('');
  return (
    <div className="space-y-3 text-sm">
      <p>Week of {tithing.weekLabel}</p>
      <p className="flex justify-between"><span>Counted earnings</span><span>{formatUsd(tithing.earnedCents)}</span></p>
      <p className="flex justify-between"><span>Percent</span><span>{tithing.percentLabel ?? 'Not set'}</span></p>
      <p className="flex justify-between"><span>Calculated</span><span>{tithing.dueCents == null ? 'Not calculated' : formatUsd(tithing.dueCents)}</span></p>
      <p className="flex justify-between"><span>Recorded payments</span><span>{formatUsd(tithing.paidCents)}</span></p>
      {tithing.withheldCount > 0 ? <p>{tithing.withheldCount} deposit{tithing.withheldCount === 1 ? '' : 's'} this week {tithing.withheldCount === 1 ? 'is' : 'are'} still pending or unreviewed, and {tithing.withheldCount === 1 ? 'is' : 'are'} not included.</p> : null}
      <p className="font-display text-3xl">{tithing.label}</p>
      {tithing.state === 'unconfigured' ? (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); const bps = Math.round(Number(percent) * 100); if (!Number.isInteger(bps) || bps < 0 || bps > 10000) { setMessage('Enter a percent from 0 to 100.'); return; } void actions.setTithing(bps); }}>
          <Input value={percent} onChange={(event) => setPercent(event.target.value)} placeholder="Percent" inputMode="decimal" />
          <Button type="submit">Set percent</Button>
        </form>
      ) : (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void actions.addPayment(tithing.weekStart, amount).then(() => setMessage('Payment recorded.')).catch((error: Error) => setMessage(error.message)); }}>
          <Input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Payment amount" inputMode="decimal" />
          <Button type="submit" variant="secondary">Record a payment</Button>
          <Button type="button" variant="outline" onClick={() => actions.setCovered(tithing.weekStart, !tithing.markedCovered).catch((error: Error) => setMessage(error.message))}>{tithing.markedCovered ? 'Clear covered' : 'Mark covered'}</Button>
        </form>
      )}
    </div>
  );
}

function ItemForm({ actions, onDone, setMessage }: { actions: HouseholdActions; onDone: () => void; setMessage: (value: string) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'house' | 'car' | 'loan' | 'other'>('house');
  const [amount, setAmount] = useState('');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const kind = role === 'loan' ? 'liability' : 'asset';
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (decimalStringToCents(amount) == null) { setMessage('Use a dollar amount like 420000.00'); return; } void actions.saveItem({ name, kind, role, amountDollars: amount, asOf }).then(() => { setMessage('Saved.'); onDone(); }).catch((error: Error) => setMessage(error.message)); }}>
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, like Sample house" />
      <select className="h-11 w-full rounded-2xl border border-[#e0d0bd] bg-white px-3" value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
        <option value="house">House</option>
        <option value="car">Car</option>
        <option value="loan">Loan</option>
        <option value="other">Other</option>
      </select>
      <Input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Value" inputMode="decimal" />
      <Input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
      <Button type="submit">Save item</Button>
    </form>
  );
}

export function dollarsToCents(value: string): number {
  const cents = decimalStringToCents(value.trim());
  if (cents == null || cents < 0) throw new Error('Use a dollar amount like 150.00');
  return cents;
}
