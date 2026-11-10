import crypto from 'node:crypto';

// scrypt parameters: N=2^15 (~32 MB, ~100 ms) – slow enough to make guessing expensive.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function newSalt(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function deriveKey(passphrase: string, saltB64: string): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), Buffer.from(saltB64, 'base64'), 32, SCRYPT);
}

/** AES-256-GCM. Output: "v1:<iv>:<tag>:<ciphertext>" (base64 parts). */
export function encrypt(key: Buffer, plaintext: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Throws if the key is wrong or the data was tampered with. */
export function decrypt(key: Buffer, payload: string): Buffer {
  const [version, ivB64, tagB64, ctB64] = payload.split(':');
  if (version !== 'v1') throw new Error('Unknown keystore format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
}
