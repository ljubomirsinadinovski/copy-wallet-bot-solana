import { describe, expect, it, vi } from 'vitest';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { DirectExecutor, LiveExecutor, recoverSwap, type Submission, type SwapParams } from '../src/executor/executors.js';
import { WSOL_MINT } from '../src/solana/constants.js';

const submission: Submission = { signature: 'sig', blockhash: 'hash', route: 'pumpfun', tip: 10_000, sentAt: 1 };
const params: SwapParams = { wallet: 'wallet', inputMint: WSOL_MINT, outputMint: 'mint', amount: 100_000_000n, slippageBps: null };

function chainTransaction(err: unknown = null) {
  return {
    slot: 1, transaction: { signatures: ['sig'], message: { accountKeys: ['wallet', 'ata'] } },
    meta: {
      err, fee: 5000, preBalances: [1_000_000_000, 0], postBalances: [897_945_720, 2_039_280],
      preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: 'mint', owner: 'wallet', uiTokenAmount: { amount: '1000', decimals: 6 } }],
    },
  };
}

describe('transaction recovery', () => {
  it('reconstructs exact fill amounts excluding rent, network fee and tip', async () => {
    const rpc = { call: vi.fn().mockResolvedValue(chainTransaction()) };
    const fill = await recoverSwap(rpc as any, params, submission);
    expect(fill?.inAmount).toBe(100_000_000n);
    expect(fill?.outAmount).toBe(1000n);
    expect(fill?.feeLamports).toBe(15_000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing transaction unresolved while its blockhash can land', async () => {
    const rpc = { call: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ value: true }) };
    expect(await recoverSwap(rpc as any, params, submission)).toBeNull();
  });

  it('does not treat delayed readback as failure if the historical signature exists', async () => {
    const rpc = { call: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ value: [{ err: null }] }) };
    expect(await recoverSwap(rpc as any, params, submission)).toBeNull();
  });

  it('declares expiry only after finalized blockhash expiry and a historical status check', async () => {
    const rpc = { call: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ value: [null] }) };
    await expect(recoverSwap(rpc as any, params, submission)).rejects.toMatchObject({ definitive: true });
    expect(rpc.call.mock.calls[1][1][1].commitment).toBe('finalized');
    expect(rpc.call.mock.calls[2][1][1].searchTransactionHistory).toBe(true);
  });

  it('distinguishes on-chain failure from unavailable RPC', async () => {
    await expect(recoverSwap({ call: async () => chainTransaction({ InstructionError: [1, 'failure'] }) } as any, params, submission))
      .rejects.toMatchObject({ definitive: true });
    await expect(recoverSwap({ call: async () => { throw new Error('HTTP 429'); } } as any, params, submission))
      .rejects.toThrow('HTTP 429');
  });
});

describe('write-ahead submission', () => {
  const keypair = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions: [] }).compileToV0Message());

  it('persists the locally derived Jupiter signature before execute, including transport failure', async () => {
    const events: string[] = [];
    let saved: Submission | undefined;
    const jupiter = {
      order: async () => ({ transaction: Buffer.from(tx.serialize()).toString('base64'), requestId: 'request' }),
      execute: vi.fn(async (signed: string) => {
        events.push('execute');
        expect(saved?.signature).toBe(bs58.encode(VersionedTransaction.deserialize(Buffer.from(signed, 'base64')).signatures[0]));
        throw new Error('connection lost');
      }),
    };
    const executor = new LiveExecutor(jupiter as any, { getKeypair: () => keypair } as any, {} as any, { get: () => ({ verifyJupiterTx: false }) } as any);
    await expect(executor.swap({ ...params, wallet: keypair.publicKey.toBase58(), onSubmit: (s) => { saved = s; events.push('persist'); } })).rejects.toThrow('connection lost');
    expect(events).toEqual(['persist', 'execute']);
    expect(saved?.blockhash).toBe(blockhash);
  });

  it('never submits Jupiter or direct swaps if persistence fails', async () => {
    const jupiter = { order: async () => ({ transaction: Buffer.from(tx.serialize()).toString('base64') }), execute: vi.fn() };
    const keys = { getKeypair: () => keypair };
    const settings = { get: () => ({ verifyJupiterTx: false, tipSol: 0.00001, priorityFeeSol: 0.0002, senderRoute: 'swqos' }) };
    const live = new LiveExecutor(jupiter as any, keys as any, {} as any, settings as any);
    const sender = { send: vi.fn() };
    const direct = new DirectExecutor({ buildBuy: async () => ({ instructions: [], computeUnits: 100_000, route: 'pumpfun' }) } as any,
      { connection: { getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }) } } as any,
      sender as any, keys as any, settings as any);
    const p = { ...params, wallet: keypair.publicKey.toBase58(), onSubmit: () => { throw new Error('disk full'); } };
    await expect(live.swap(p)).rejects.toThrow('disk full');
    await expect(direct.swap(p)).rejects.toThrow('disk full');
    expect(jupiter.execute).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
