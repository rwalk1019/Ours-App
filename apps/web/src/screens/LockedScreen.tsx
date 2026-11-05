import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function LockedScreen({
  setupRequired,
  notice,
  onSetup,
  onCreate,
  onUnlock,
  onRecovery,
  onDemo,
}: {
  setupRequired: boolean;
  notice?: string;
  onSetup: (code: string) => Promise<unknown>;
  onCreate: (options: unknown) => Promise<void>;
  onUnlock: () => Promise<void>;
  onRecovery: (code: string) => Promise<unknown>;
  onDemo: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(notice ?? '');
  const [options, setOptions] = useState<unknown>(null);
  const [recovery, setRecovery] = useState(false);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await task();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-between bg-paper px-6 py-10 lg:my-8 lg:min-h-[760px] lg:rounded-[32px] lg:shadow-card">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[#8a7363]">Household</p>
        <h1 className="font-display mt-3 text-6xl leading-none">Ours</h1>
        <p className="mt-4 max-w-xs text-lg leading-snug text-[#5c4d40]">A private ledger for one household. Locked until this device is recognized.</p>
      </div>
      <div className="space-y-3">
        {message ? <p className="rounded-2xl bg-[#f3e2d4] px-4 py-3 text-sm">{message}</p> : null}
        {options ? (
          <Button className="w-full" disabled={busy} onClick={() => run(() => onCreate(options))}>
            Create a passkey
          </Button>
        ) : recovery ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => setOptions(await onRecovery(code)));
            }}
          >
            <label className="block text-sm" htmlFor="recovery-code">Recovery code</label>
            <Input id="recovery-code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
            <Button className="w-full" type="submit" disabled={busy}>Continue</Button>
          </form>
        ) : setupRequired ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => setOptions(await onSetup(code)));
            }}
          >
            <label className="block text-sm" htmlFor="setup-code">One-time setup code</label>
            <Input id="setup-code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="XXXX-XXXX-XXXX" />
            <Button className="w-full" type="submit" disabled={busy}>Continue</Button>
          </form>
        ) : (
          <Button className="w-full" disabled={busy} onClick={() => run(onUnlock)}>Unlock</Button>
        )}
        {!options ? (
          <button className="w-full text-sm text-[#6d5c4d] underline-offset-4 hover:underline" type="button" onClick={() => setRecovery((value) => !value)}>
            {recovery ? 'Use a passkey instead' : 'Use a recovery code'}
          </button>
        ) : (
          <p className="text-center text-sm text-[#6d5c4d]">The phone will offer Face ID, Touch ID, or a PIN if it has one. Not every device uses Face ID.</p>
        )}
        <Button variant="outline" className="w-full" type="button" onClick={onDemo}>Preview sample household</Button>
      </div>
    </main>
  );
}
