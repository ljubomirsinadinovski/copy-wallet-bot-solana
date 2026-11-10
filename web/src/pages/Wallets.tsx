import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type WalletRow } from '../lib/api';
import { ago, sol, solPrice, tokens, usd, usdToSol } from '../lib/format';
import { Address, Badge, Button, CopyButton, Empty, Field, ModeBadge, Modal, Panel, toast } from '../components/ui';
import { useStatus } from '../components/Layout';

function useAction<T>(fn: (v: T) => Promise<unknown>, ok?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (ok) toast(ok);
      void qc.invalidateQueries();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const m = useAction(() => api('/wallets/import', { body: { label: label || 'Imported', secret } }), 'Wallet imported');
  return (
    <Modal open={open} onClose={onClose} title="Import a wallet">
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate(undefined, {
            onSuccess: () => {
              setSecret('');
              setLabel('');
              onClose();
            },
          });
        }}
      >
        <p className="text-muted">
          Use a dedicated trading wallet, never your main one. The key is encrypted with your passphrase and stays on this computer. Paste it only here –
          never into a chat or an AI tool.
        </p>
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. frank copy wallet" />
        </Field>
        <Field label="Private key" hint="Base58 key (Phantom: Settings → Manage accounts → Show private key) or a Solana CLI keypair file’s [..] array.">
          <textarea value={secret} onChange={(e) => setSecret(e.target.value)} rows={3} className="num text-[12px]" autoComplete="off" spellCheck={false} required />
        </Field>
        {m.error && <div className="text-loss">{(m.error as Error).message}</div>}
        <Button variant="primary" type="submit" busy={m.isPending}>
          Import wallet
        </Button>
      </form>
    </Modal>
  );
}

function ExportModal({ w, open, onClose }: { w: WalletRow; open: boolean; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api<{ secret: string }>(`/wallets/${w.id}/export`, { body: { passphrase: pass } }),
    onSuccess: (d) => {
      setSecret(d.secret);
      setPass('');
    },
  });
  const close = () => {
    setSecret(null);
    setPass('');
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title={`Export key · ${w.label}`}>
      {secret ? (
        <div className="flex flex-col gap-3">
          <p className="text-warn">Anyone with this key controls the wallet. Import it into Phantom, then close this window.</p>
          <div className="num flex items-start gap-2 rounded-md border border-rule bg-panel-2 p-3 text-[12px] break-all">
            <span className="flex-1">{secret}</span>
            <CopyButton value={secret} label="private key" />
          </div>
          <Button onClick={close}>Done</Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <p className="text-muted">Shows the private key so you can import this wallet into Phantom to watch it or withdraw.</p>
          <Field label="Passphrase">
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
          </Field>
          {m.error && <div className="text-loss">{(m.error as Error).message}</div>}
          <Button variant="primary" type="submit" busy={m.isPending}>
            Show private key
          </Button>
        </form>
      )}
    </Modal>
  );
}

function DepositModal({ w, open, onClose }: { w: WalletRow; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={`Fund ${w.label}`}>
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-lg bg-white p-3">
          <QRCodeSVG value={w.pubkey} size={196} />
        </div>
        <div className="num flex items-center gap-2 text-center text-[12.5px] break-all">
          {w.pubkey} <CopyButton value={w.pubkey} label="address" />
        </div>
        <p className="text-center text-muted">Send SOL on the Solana network only. Keep at least the group’s reserve (default ≈ {usd(0.02 * (solPrice() ?? 0))}) for fees.</p>
      </div>
    </Modal>
  );
}

function ManualBuyModal({ w, open, onClose }: { w: WalletRow; open: boolean; onClose: () => void }) {
  const [mint, setMint] = useState('');
  const [amount, setAmount] = useState('5');
  const [paper, setPaper] = useState(w.group?.paper ?? true);
  const m = useAction(() => api('/positions/buy', { body: { myWalletId: w.id, mint: mint.trim(), sol: usdToSol(Number(amount)), paper } }), 'Bought');
  return (
    <Modal open={open} onClose={onClose} title={`Buy a token · ${w.label}`}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate(undefined, { onSuccess: onClose });
        }}
      >
        <Field label="Token contract address (CA)">
          <input value={mint} onChange={(e) => setMint(e.target.value)} className="num" required />
        </Field>
        <Field label="Amount ($)" hint="Paid in SOL from this wallet.">
          <input type="number" step="any" min="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
        </Field>
        <Field label="Mode">
          <select value={paper ? 'paper' : 'live'} onChange={(e) => setPaper(e.target.value === 'paper')}>
            <option value="paper">Paper – simulated</option>
            <option value="live">Live – real SOL</option>
          </select>
        </Field>
        {m.error && <div className="text-loss">{(m.error as Error).message}</div>}
        <Button variant={paper ? 'primary' : 'danger'} type="submit" busy={m.isPending}>
          {paper ? 'Paper buy' : `Buy for $${amount}`}
        </Button>
      </form>
    </Modal>
  );
}

function Holdings({ w }: { w: WalletRow }) {
  const q = useQuery({
    queryKey: ['wallets', w.id, 'holdings'],
    queryFn: () => api<Array<{ mint: string; raw: string; decimals: number; symbol: string | null; priceUsd: number | null }>>(`/wallets/${w.id}/holdings`),
  });
  if (q.isLoading) return <div className="px-4 py-3 text-muted">Loading…</div>;
  if (q.error) return <div className="px-4 py-3 text-loss">{(q.error as Error).message}</div>;
  const list = q.data ?? [];
  const nonEmpty = list.filter((h) => h.raw !== '0');
  const empty = list.length - nonEmpty.length;
  return (
    <div className="border-t border-rule px-4 py-3">
      {nonEmpty.length === 0 ? (
        <div className="text-muted">No tokens on-chain.</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {nonEmpty.map((h) => (
            <li key={h.mint} className="num flex items-center justify-between gap-3 text-[12.5px]">
              <span className="flex items-center gap-2">
                <span className="font-sans font-medium">{h.symbol ?? 'Unknown'}</span>
                <span className="text-muted">{h.mint.slice(0, 4)}…{h.mint.slice(-4)}</span>
                <CopyButton value={h.mint} label="contract address" />
              </span>
              <span>
                {tokens(h.raw, h.decimals)}
                {h.priceUsd != null && <span className="ml-2 text-muted">{usd((Number(h.raw) / 10 ** h.decimals) * h.priceUsd)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {empty > 0 && <div className="mt-2 text-[12px] text-muted">{empty} empty token account{empty > 1 ? 's' : ''} holding ~{usd(empty * 0.00204 * (solPrice() ?? 0))} of rent.</div>}
    </div>
  );
}

function WalletCard({ w }: { w: WalletRow }) {
  const { data: status } = useStatus();
  const [modal, setModal] = useState<'deposit' | 'export' | 'buy' | null>(null);
  const [showHoldings, setShowHoldings] = useState(false);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(w.label);
  const rename = useAction(() => api(`/wallets/${w.id}`, { method: 'PATCH', body: { label } }));
  const closeEmpty = useAction(() => api<{ closed: number }>(`/wallets/${w.id}/close-empty`, { body: {} }), 'Empty token accounts closed – rent returned');
  const archive = useAction(() => api(`/wallets/${w.id}`, { method: 'DELETE' }), 'Wallet hidden');

  return (
    <Panel flush>
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  rename.mutate(undefined, { onSuccess: () => setEditing(false) });
                }}
              >
                <input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus onBlur={() => setEditing(false)} aria-label="Wallet label" />
              </form>
            ) : (
              <>
                <Link to={`/wallets/${w.id}`} className="font-display text-lg font-semibold hover:underline" title="Open this wallet’s trades">
                  {w.label}
                </Link>
                <button className="text-[11px] text-faint hover:text-text" onClick={() => setEditing(true)} aria-label="Rename wallet">
                  rename
                </button>
              </>
            )}
            <Badge>{w.source}</Badge>
            {w.group && <ModeBadge paper={w.group.paper} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <Address value={w.pubkey} />
            <span>{w.group ? `copies ${w.group.name}` : 'not assigned to a trader'}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="num text-xl">{sol(w.solLamports)}</div>
          <div className="text-[11.5px] text-muted">
            {w.balanceAt ? `on-chain · ${ago(w.balanceAt)} ago` : 'on-chain · not read yet'}
            {w.group?.paper ? <> · paper balance <span className="num">{sol(w.paperCashLamports)}</span></> : null}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-rule px-4 py-2.5">
        <Link to={`/wallets/${w.id}`} className="inline-flex h-7 items-center rounded-md border border-you/40 bg-you-soft px-2.5 text-[12.5px] font-medium text-you hover:border-you">
          Trades &amp; positions
        </Link>
        <Button size="sm" onClick={() => setModal('deposit')}>
          Fund
        </Button>
        <Button size="sm" onClick={() => setShowHoldings((v) => !v)}>
          {showHoldings ? 'Hide tokens' : 'Show tokens'}
        </Button>
        <Button size="sm" onClick={() => setModal('buy')}>
          Buy a token
        </Button>
        <Button
          size="sm"
          disabled={!status?.liveTrading}
          title={status?.liveTrading ? '' : 'Needs LIVE_TRADING=true in .env'}
          onClick={() => closeEmpty.mutate(undefined)}
          busy={closeEmpty.isPending}
        >
          Reclaim rent
        </Button>
        <Button size="sm" onClick={() => setModal('export')}>
          Export key
        </Button>
        {!w.group && (
          <Button size="sm" variant="ghost" onClick={() => confirm(`Hide ${w.label}? The encrypted key is kept and can’t be lost.`) && archive.mutate(undefined)}>
            Hide
          </Button>
        )}
      </div>
      {showHoldings && <Holdings w={w} />}
      <DepositModal w={w} open={modal === 'deposit'} onClose={() => setModal(null)} />
      <ExportModal w={w} open={modal === 'export'} onClose={() => setModal(null)} />
      {modal === 'buy' && <ManualBuyModal w={w} open onClose={() => setModal(null)} />}
    </Panel>
  );
}

export function WalletsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['wallets'], queryFn: () => api<WalletRow[]>('/wallets') });
  // Balances are read from chain only here: once when the page opens, and when you press Refresh.
  const refresh = useMutation({
    mutationFn: () => api<WalletRow[]>('/wallets?refresh=1'),
    onSuccess: (rows) => {
      qc.setQueryData(['wallets'], rows);
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  useEffect(() => {
    refresh.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [importOpen, setImportOpen] = useState(false);
  const generate = useAction(() => api('/wallets/generate', { body: { label: 'Trading wallet' } }), 'New wallet generated');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">My wallets</h1>
          <p className="mt-1 max-w-2xl text-muted">
            Hot wallets the bot trades from. Generating them here is safest: the key is created on this computer and never travels through your
            clipboard. Fund each one yourself, only with what you’re willing to risk.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => refresh.mutate()} busy={refresh.isPending}>
            Refresh balances
          </Button>
          <Button onClick={() => setImportOpen(true)}>Import</Button>
          <Button variant="you" onClick={() => generate.mutate(undefined)} busy={generate.isPending}>
            Generate wallet
          </Button>
        </div>
      </div>
      {data && data.length === 0 && (
        <Panel>
          <Empty title="No wallets yet">Generate one here, or let the Traders page create one when you add a trader.</Empty>
        </Panel>
      )}
      <div className="grid gap-4 xl:grid-cols-2">{data?.map((w) => <WalletCard key={w.id} w={w} />)}</div>
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
