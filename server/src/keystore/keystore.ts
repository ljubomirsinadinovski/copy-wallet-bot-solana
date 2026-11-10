import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { myWallets, type MyWallet } from '../db/schema.js';
import type { SettingsStore } from '../settings.js';
import { decrypt, deriveKey, encrypt, newSalt } from './crypto.js';

const META_KEY = 'keystore';
const VERIFIER = Buffer.from('copy-wallet-keystore-v1');
export const MIN_PASSPHRASE = 10;

interface KeystoreMeta {
  salt: string;
  verifier: string;
}

/**
 * Holds the trading wallets' private keys. On disk they are encrypted with a key derived from your
 * passphrase; after unlocking, the decrypted keypairs live only in memory so trades can be signed
 * automatically.
 */
export class Keystore {
  private key: Buffer | null = null;
  private keypairs = new Map<string, Keypair>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
  ) {}

  get isSetup(): boolean {
    return Boolean(this.settings.getJson<KeystoreMeta>(META_KEY));
  }

  get isUnlocked(): boolean {
    return this.key !== null;
  }

  setup(passphrase: string): void {
    if (this.isSetup) throw new Error('Passphrase already set');
    if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
    const salt = newSalt();
    const key = deriveKey(passphrase, salt);
    this.settings.setJson(META_KEY, { salt, verifier: encrypt(key, VERIFIER) } satisfies KeystoreMeta);
    this.key = key;
  }

  /** Returns false if the passphrase is wrong. */
  verify(passphrase: string): boolean {
    const meta = this.settings.getJson<KeystoreMeta>(META_KEY);
    if (!meta) return false;
    try {
      return decrypt(deriveKey(passphrase, meta.salt), meta.verifier).equals(VERIFIER);
    } catch {
      return false;
    }
  }

  unlock(passphrase: string): boolean {
    const meta = this.settings.getJson<KeystoreMeta>(META_KEY);
    if (!meta) return false;
    const key = deriveKey(passphrase, meta.salt);
    try {
      if (!decrypt(key, meta.verifier).equals(VERIFIER)) return false;
    } catch {
      return false;
    }
    this.key = key;
    this.keypairs.clear();
    for (const w of this.db.select().from(myWallets).all()) {
      this.keypairs.set(w.pubkey, Keypair.fromSecretKey(decrypt(key, w.secretCipher)));
    }
    return true;
  }

  lock(): void {
    this.key = null;
    this.keypairs.clear();
  }

  getKeypair(pubkey: string): Keypair {
    const kp = this.keypairs.get(pubkey);
    if (!kp) throw new Error(this.isUnlocked ? `No key for wallet ${pubkey}` : 'Keystore is locked');
    return kp;
  }

  generate(label: string): MyWallet {
    return this.store(label, Keypair.generate(), 'generated');
  }

  /** Accepts a base58 secret key (Phantom export) or a JSON byte array (Solana CLI keypair file). */
  import(label: string, secret: string): MyWallet {
    const kp = parseSecret(secret);
    const existing = this.db.select().from(myWallets).where(eq(myWallets.pubkey, kp.publicKey.toBase58())).get();
    if (existing) throw new Error('This wallet is already in the app');
    return this.store(label, kp, 'imported');
  }

  exportSecret(walletId: number, passphrase: string): string {
    if (!this.verify(passphrase)) throw new Error('Wrong passphrase');
    const w = this.db.select().from(myWallets).where(eq(myWallets.id, walletId)).get();
    if (!w) throw new Error('Wallet not found');
    const key = deriveKey(passphrase, this.settings.getJson<KeystoreMeta>(META_KEY)!.salt);
    return bs58.encode(decrypt(key, w.secretCipher));
  }

  changePassphrase(current: string, next: string): void {
    if (next.length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
    const meta = this.settings.getJson<KeystoreMeta>(META_KEY);
    if (!meta || !this.verify(current)) throw new Error('Wrong passphrase');
    const oldKey = deriveKey(current, meta.salt);
    const salt = newSalt();
    const newKey = deriveKey(next, salt);
    const wallets = this.db.select().from(myWallets).all();
    this.db.transaction((tx) => {
      for (const w of wallets) {
        const secret = decrypt(oldKey, w.secretCipher);
        tx.update(myWallets).set({ secretCipher: encrypt(newKey, secret) }).where(eq(myWallets.id, w.id)).run();
      }
    });
    this.settings.setJson(META_KEY, { salt, verifier: encrypt(newKey, VERIFIER) } satisfies KeystoreMeta);
    this.key = newKey;
  }

  private store(label: string, kp: Keypair, source: 'generated' | 'imported'): MyWallet {
    if (!this.key) throw new Error('Keystore is locked');
    const row = this.db
      .insert(myWallets)
      .values({
        label: label.trim() || 'Wallet',
        pubkey: kp.publicKey.toBase58(),
        secretCipher: encrypt(this.key, Buffer.from(kp.secretKey)),
        source,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    this.keypairs.set(row.pubkey, kp);
    return row;
  }
}

export function parseSecret(secret: string): Keypair {
  const s = secret.trim();
  let bytes: Uint8Array;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('Invalid key format');
    bytes = Uint8Array.from(arr);
  } else {
    try {
      bytes = bs58.decode(s);
    } catch {
      throw new Error('Invalid key: expected a base58 private key or a JSON byte array');
    }
  }
  if (bytes.length !== 64) throw new Error(`Invalid key length (${bytes.length} bytes, expected 64)`);
  return Keypair.fromSecretKey(bytes);
}
