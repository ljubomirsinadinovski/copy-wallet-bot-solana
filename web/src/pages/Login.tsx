import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Field } from '../components/ui';
import { Mark } from '../components/Layout';

export function Login({ firstRun, minLength }: { firstRun: boolean; minLength: number }) {
  const qc = useQueryClient();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (firstRun) {
      if (pass.length < minLength) return setError(`Use at least ${minLength} characters.`);
      if (pass !== confirm) return setError('The two passphrases don’t match.');
    }
    setBusy(true);
    try {
      await api(firstRun ? '/auth/setup' : '/auth/login', { body: { passphrase: pass } });
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Mark size={34} />
          <div>
            <div className="font-display text-2xl leading-none font-bold tracking-tight">copy-wallet</div>
            <div className="eyebrow mt-1">solana copy trading</div>
          </div>
        </div>
        <div className="rounded-lg border border-rule bg-panel p-5">
          <h1 className="font-display text-lg font-semibold">{firstRun ? 'Create your passphrase' : 'Log in'}</h1>
          <p className="mt-1 mb-5 text-muted">
            {firstRun
              ? 'It encrypts your trading wallets’ private keys on this computer and logs you in to this page. There is no reset – if you lose it, export your keys first.'
              : 'Logging in also unlocks your trading wallets so the bot can sign trades.'}
          </p>
          <div className="flex flex-col gap-3.5">
            <Field label="Passphrase">
              <input type="password" autoComplete={firstRun ? 'new-password' : 'current-password'} value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
            </Field>
            {firstRun && (
              <Field label="Repeat passphrase">
                <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            )}
            {error && <div className="text-loss">{error}</div>}
            <Button variant="primary" type="submit" busy={busy} className="mt-1">
              {firstRun ? 'Create passphrase' : 'Log in'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
