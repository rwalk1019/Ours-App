import { confirmedOwnerSettings, formatDenverTimestamp, ownerMoney, readLooseSnapshot, type SettingsPresence } from '@ours/domain';
import { useState } from 'react';
import { createPasskey, usePasskey } from '@/passkey';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { looksLikeSetupCode } from './codes';
import { authAction, currentSession, rememberSession, rpc } from './client';

type LiveState = {
  snapshot: { id?: number; as_of?: string; uploaded_at?: string; data?: unknown } | null;
  fix_rules: { id: string; match: string; category: string }[];
  custom_items: { id: string; name: string; kind: 'asset' | 'liability'; value: number | string; note: string | null }[];
  refresh: { status?: string; requested_at?: string; closed_at?: string | null; note?: string | null } | null;
  devices: { id: string; device_name: string; created_at: string }[];
  backup_codes_left: number;
  server_time: string;
};

export function LiveApp({ onDemo }: { onDemo: () => void }) {
  const [state, setState] = useState<LiveState | null>(null);
  const [presence, setPresence] = useState<SettingsPresence | 'unavailable'>('unavailable');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<{ title: string; lines: string[] } | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  async function load(token: string) {
    let nextPresence: SettingsPresence | 'unavailable' = 'unavailable';
    try {
      nextPresence = normalizePresence(await rpc('ours_settings_presence', { p_token: token }));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'missing_rpc') throw error;
    }
    const next = (await rpc('ours_get_state', { p_token: token })) as LiveState;
    setPresence(nextPresence);
    setState(next);
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await task();
    } catch (error) {
      const text = error instanceof Error ? error.message : 'That did not work.';
      if (text === 'not signed in' || text === 'Not signed in') {
        rememberSession(null);
        setState(null);
      }
      setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <LockedLive
        busy={busy}
        message={message}
        onDemo={onDemo}
        onUnlock={() => run(async () => {
          const started = await authAction({ action: 'auth_options' });
          const credential = await usePasskey(started.options);
          const signed = await authAction({ action: 'auth_verify', challengeId: started.challengeId, credential });
          const session = signed.session as { token: string };
          rememberSession(session.token);
          await load(session.token);
        })}
        onBackup={(code) => run(async () => {
          const signed = await authAction({ action: 'backup_login', code });
          const session = signed.session as { token: string };
          rememberSession(session.token);
          await load(session.token);
        })}
        onSetup={(code, deviceName) => run(async () => {
          const started = await authAction({ action: 'reg_options', code });
          const credential = await createPasskey(started.options);
          const signed = await authAction({ action: 'reg_verify', challengeId: started.challengeId, credential, deviceName });
          const session = signed.session as { token: string };
          rememberSession(session.token);
          await load(session.token);
        })}
      />
    );
  }

  const settings = confirmedOwnerSettings(presence);
  const loose = readLooseSnapshot(state.snapshot?.data);
  const money = ownerMoney({
    now: new Date(state.server_time),
    tithingPercent: settings.tithingPercent,
    tithingPeriod: settings.tithingPeriod,
    incomeSources: settings.incomeSources,
    paymentMatches: settings.paymentMatches,
    filtersReadable: settings.filtersReadable,
    weeklyTarget: settings.weeklyTarget,
    transactions: loose.recognizedTransactions,
    rules: state.fix_rules.map((rule) => ({ match: rule.match, category: rule.category })),
  });
  const token = currentSession() ?? '';

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md space-y-4 bg-paper px-4 py-6 pb-16 lg:my-6 lg:rounded-[32px] lg:shadow-card">
      <header>
        <p className="text-xs uppercase tracking-[0.18em] text-[#8a7363]">Ours</p>
        <h1 className="font-display text-4xl">This household</h1>
      </header>
      {message ? <p className="rounded-2xl bg-[#f3e2d4] px-4 py-3 text-sm">{message}</p> : null}
      {codes ? (
        <section className="rounded-3xl bg-ink p-4 text-[#f6f1e8]">
          <p className="text-sm">{codes.title}</p>
          <ul className="mt-3 space-y-1 font-mono text-sm">{codes.lines.map((code) => <li key={code}>{code}</li>)}</ul>
          <Button className="mt-3" variant="secondary" onClick={() => setCodes(null)}>I wrote them down</Button>
        </section>
      ) : null}
      <p className="text-sm text-[#6d5c4d]">
        {state.snapshot?.as_of
          ? `Balances as of ${formatDenverTimestamp(state.snapshot.as_of)}. Imported ${state.snapshot.uploaded_at ? formatDenverTimestamp(state.snapshot.uploaded_at) : 'earlier'}.`
          : 'No bank snapshot yet. Nothing here is bank-verified.'}
      </p>
      <section className={`rounded-[28px] p-5 ${settings.tithingPeriod === 'month' ? 'bg-clay text-[#fffaf3]' : 'bg-white'}`}>
        <p className="text-xs uppercase tracking-[0.16em]">Tithing{settings.tithingPeriod === 'month' ? ' · this month' : ''}</p>
        <p className="font-display mt-3 text-4xl">{money.tithing.label}</p>
        {settings.tithingPercent == null ? (
          <p className="mt-2 text-sm">No saved percent. A server fallback is not your setting until you save one.</p>
        ) : settings.tithingPeriod === 'month' ? (
          <p className="mt-2 text-sm">{settings.tithingPercent}% of this month’s matching income. Status is Paid, Still to pay, Covered, or Nothing due yet.</p>
        ) : (
          <p className="mt-2 text-sm">{settings.tithingPercent}% is saved. The month stays hidden until the settings response includes it.</p>
        )}
        {!settings.confirmationAvailable ? <p className="mt-2 text-sm">Saved and unsaved settings cannot be told apart until the presence check is installed. Nothing is treated as confirmed.</p> : null}
      </section>
      <section className="rounded-3xl bg-white p-4 text-sm">
        <p>Weekly spending target: {settings.weeklyTarget == null ? 'not saved' : `$${settings.weeklyTarget}`}</p>
        <p className="mt-1">This week’s recognized spending: {money.weekNetSpendCents == null ? 'not in this snapshot' : `$${(money.weekNetSpendCents / 100).toFixed(2)}`}</p>
        {state.refresh?.status === 'open' ? <p className="mt-2">Refresh requested {state.refresh.requested_at ? formatDenverTimestamp(state.refresh.requested_at) : ''}. Waiting for the next import.</p> : null}
        {state.refresh?.status === 'done' ? <p className="mt-2">The last refresh was closed{state.refresh.closed_at ? ` ${formatDenverTimestamp(state.refresh.closed_at)}` : ''}. {state.refresh.note ? 'The import left a note that new bank data was stored.' : ''}</p> : null}
      </section>
      {loose.accounts.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {loose.accounts.map((account) => (
            <li key={account.label} className="rounded-2xl bg-white px-4 py-3">{account.label}{account.amount == null ? '' : ` · $${account.amount}`}</li>
          ))}
        </ul>
      ) : null}
      <Button variant="secondary" disabled={busy} onClick={() => run(async () => { await rpc('ours_request_refresh', { p_token: token }); await load(token); })}>Request a bank refresh</Button>
      <SettingsForms
        token={token}
        settings={settings}
        items={state.custom_items}
        rules={state.fix_rules}
        devices={state.devices}
        onMessage={setMessage}
        onReload={() => load(token)}
        onCodes={(lines, title) => setCodes({ title, lines })}
        onReplace={() => setConfirmReplace(true)}
        onSignOut={() => run(async () => { await rpc('ours_sign_out', { p_token: token }); rememberSession(null); setState(null); })}
      />
      <Dialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        {confirmReplace ? (
          <DialogContent title="Replace backup codes">
            <p className="text-sm">This signs you in as the owner and then deletes every current backup code. The new list is shown once.</p>
            <Button className="mt-4" disabled={busy} onClick={() => run(async () => {
              const result = await authAction({ action: 'new_backup_codes', token, confirm: true }) as { codes?: string[] };
              setCodes({ title: 'Write these down. They are shown once, and the previous backup codes no longer work.', lines: result.codes ?? [] });
              setConfirmReplace(false);
              await load(token);
            })}>Replace codes</Button>
          </DialogContent>
        ) : null}
      </Dialog>
    </main>
  );
}

function normalizePresence(value: unknown): SettingsPresence {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    weekly_target: record.weekly_target ?? null,
    tithing_percent: record.tithing_percent ?? null,
    tithing_category: record.tithing_category ?? null,
    tithing_period: record.tithing_period ?? null,
    tithing_income_sources: record.tithing_income_sources ?? null,
    tithing_payment_match: record.tithing_payment_match ?? null,
  };
}

function LockedLive({ busy, message, onDemo, onUnlock, onBackup, onSetup }: {
  busy: boolean;
  message: string;
  onDemo: () => void;
  onUnlock: () => void;
  onBackup: (code: string) => void;
  onSetup: (code: string, deviceName: string) => void;
}) {
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('This phone');
  const [mode, setMode] = useState<'unlock' | 'setup' | 'backup'>('unlock');
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-between bg-paper px-6 py-10 lg:my-8 lg:min-h-[760px] lg:rounded-[32px] lg:shadow-card">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[#8a7363]">Household</p>
        <h1 className="font-display mt-3 text-6xl">Ours</h1>
        <p className="mt-4 max-w-xs text-lg text-[#5c4d40]">Locked until this device is recognized. The first time, use your setup code. After that, the phone can unlock with a passkey.</p>
      </div>
      <div className="space-y-3">
        {message ? <p className="rounded-2xl bg-[#f3e2d4] px-4 py-3 text-sm">{message}</p> : null}
        {mode === 'unlock' ? (
          <>
            <Button className="w-full" disabled={busy} onClick={onUnlock}>Unlock</Button>
            <Button className="w-full" variant="outline" type="button" disabled={busy} onClick={() => setMode('setup')}>Set up this device</Button>
          </>
        ) : null}
        {mode === 'backup' ? (
          <form className="space-y-3" onSubmit={(event) => {
            event.preventDefault();
            if (looksLikeSetupCode(code)) {
              setMode('setup');
              onSetup(code, deviceName);
              return;
            }
            onBackup(code);
          }}>
            <label htmlFor="backup">Backup code</label>
            <Input id="backup" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" />
            <Button className="w-full" type="submit" disabled={busy}>Sign in</Button>
          </form>
        ) : null}
        {mode === 'setup' ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); onSetup(code, deviceName); }}>
            <label htmlFor="setup">Setup code</label>
            <Input id="setup" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX" />
            <Input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} aria-label="Device name" />
            <Button className="w-full" type="submit" disabled={busy}>Create a passkey</Button>
          </form>
        ) : null}
        {mode !== 'setup' ? <button className="w-full text-sm text-[#6d5c4d]" type="button" onClick={() => setMode(mode === 'backup' ? 'unlock' : 'backup')}>{mode === 'backup' ? 'Use a passkey' : 'Use a backup code'}</button> : null}
        {mode !== 'unlock' ? <button className="w-full text-sm text-[#6d5c4d]" type="button" onClick={() => setMode(mode === 'setup' ? 'unlock' : 'setup')}>{mode === 'setup' ? 'Cancel setup' : 'Set up this device'}</button> : null}
        <Button variant="outline" className="w-full" type="button" onClick={onDemo}>Preview sample household</Button>
      </div>
    </main>
  );
}

function SettingsForms({ token, settings, items, rules, devices, onMessage, onReload, onCodes, onReplace, onSignOut }: {
  token: string;
  settings: ReturnType<typeof confirmedOwnerSettings>;
  items: LiveState['custom_items'];
  rules: LiveState['fix_rules'];
  devices: LiveState['devices'];
  onMessage: (value: string) => void;
  onReload: () => Promise<void>;
  onCodes: (lines: string[], title: string) => void;
  onReplace: () => void;
  onSignOut: () => void;
}) {
  const [percent, setPercent] = useState(settings.tithingPercent == null ? '' : String(settings.tithingPercent));
  const [target, setTarget] = useState(settings.weeklyTarget == null ? '' : String(settings.weeklyTarget));
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<'asset' | 'liability'>('asset');
  const [match, setMatch] = useState('');
  const [category, setCategory] = useState('');
  return (
    <div className="space-y-4">
      <form className="space-y-2 rounded-3xl bg-white p-4" onSubmit={(event) => {
        event.preventDefault();
        const body: Record<string, number> = {};
        if (percent.trim() !== '') body.tithing_percent = Number(percent);
        if (target.trim() !== '') body.weekly_target = Number(target);
        if (Object.keys(body).length === 0) { onMessage('Enter a percent or a weekly target to save. Blank fields stay unsaved.'); return; }
        void rpc('ours_save_settings', { p_token: token, p_settings: body }).then(() => onReload()).catch((error: Error) => onMessage(error.message));
      }}>
        <label className="text-sm" htmlFor="percent">Tithing percent</label>
        <Input id="percent" value={percent} onChange={(event) => setPercent(event.target.value)} placeholder="Leave blank until you decide" inputMode="decimal" />
        <label className="text-sm" htmlFor="target">Weekly spending target</label>
        <Input id="target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Dollars, only if you want one" inputMode="decimal" />
        <Button type="submit" variant="secondary">Save settings</Button>
      </form>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between rounded-2xl bg-white px-4 py-3 text-sm">
            <span>{item.name} · {item.kind} · ${item.value}</span>
            <button type="button" onClick={() => void rpc('ours_delete_custom_item', { p_token: token, p_id: item.id }).then(() => onReload())}>Remove</button>
          </li>
        ))}
      </ul>
      <form className="space-y-2 rounded-3xl bg-white p-4" onSubmit={(event) => {
        event.preventDefault();
        void rpc('ours_save_custom_item', { p_token: token, p_item: { name, kind, value: Number(value) } }).then(() => onReload()).catch((error: Error) => onMessage(error.message));
      }}>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="House, car, or loan" aria-label="Item name" />
        <select className="h-11 w-full rounded-2xl border border-[#e0d0bd] bg-white px-3" value={kind} onChange={(event) => setKind(event.target.value as 'asset' | 'liability')}>
          <option value="asset">Asset</option>
          <option value="liability">Liability</option>
        </select>
        <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Value in dollars" inputMode="decimal" aria-label="Item value" />
        <Button type="submit" variant="secondary">Save item</Button>
      </form>
      <ul className="space-y-2">
        {rules.map((rule) => (
          <li key={rule.id} className="flex justify-between rounded-2xl bg-white px-4 py-3 text-sm">
            <span>“{rule.match}” → {rule.category}</span>
            <button type="button" onClick={() => void rpc('ours_delete_fix_rule', { p_token: token, p_id: rule.id }).then(() => onReload())}>Remove</button>
          </li>
        ))}
      </ul>
      <form className="space-y-2 rounded-3xl bg-white p-4" onSubmit={(event) => {
        event.preventDefault();
        void rpc('ours_save_fix_rule', { p_token: token, p_match: match, p_category: category }).then(() => onReload()).catch((error: Error) => onMessage(error.message));
      }}>
        <Input value={match} onChange={(event) => setMatch(event.target.value)} placeholder="Merchant text" aria-label="Fix rule match" />
        <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Category" aria-label="Fix rule category" />
        <Button type="submit" variant="secondary">Save fix rule</Button>
      </form>
      <section className="rounded-3xl bg-white p-4 text-sm">
        <p>{devices.length} passkey{devices.length === 1 ? '' : 's'} on the household.</p>
        <Button className="mt-3" variant="outline" onClick={() => void authAction({ action: 'new_setup_code', token }).then((result) => onCodes([String(result.code)], 'Setup code, shown once. It expires in 24 hours.')).catch((error: Error) => onMessage(error.message))}>Create a setup code</Button>
        <Button className="mt-2" variant="outline" onClick={onReplace}>Replace backup codes</Button>
      </section>
      <Button variant="ghost" onClick={onSignOut}>Sign out</Button>
    </div>
  );
}
