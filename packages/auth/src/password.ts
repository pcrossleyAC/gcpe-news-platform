import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 16384,
  R = 8,
  P = 1,
  KEYLEN = 64;
const scrypt = (pw: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export const PASSWORD_HASH_FORMAT = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

// Scrypt cost-parameter policy. N must be a power of two in [2^14, 2^20] (the lower bound
// keeps the hash at least as strong as hashPassword's own default; the upper bound keeps a
// single verification from being able to demand unbounded memory/CPU). r and p are bounded
// the same way libsodium/OpenSSL document as sane ranges. Salt/key minimums rule out
// degenerate or truncated hashes.
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;
const MIN_R = 1;
const MAX_R = 32;
const MIN_P = 1;
const MAX_P = 16;
const MIN_SALT_BYTES = 16;
const MIN_KEY_BYTES = 32;
// N and r are each individually bounded above, but scrypt's memory cost is ~128*N*r bytes,
// and the two bounds combine to allow up to 4 GiB (2^20 * 32). Cap the combination
// explicitly: our own hashes need 128 * 16384 * 8 = 16 MiB, so 256 MiB leaves ample headroom
// without letting a single verification demand gigabytes.
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export interface ParsedPasswordHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
  /** 128 * n * r — the approximate scrypt memory cost in bytes; always <= MAX_MEMORY_BYTES. */
  memoryBytes: number;
}

/**
 * Parses and validates a stored `scrypt$N$r$p$salt$hash` string. Returns null for anything
 * that doesn't match the shape, or whose cost parameters/salt/key fall outside the policy
 * above — never throws, so callers (startup validation and `verifyPassword`) can treat any
 * rejection the same way.
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  if (!PASSWORD_HASH_FORMAT.test(stored)) return null;
  const [, nStr, rStr, pStr, saltB64, hashB64] = stored.split("$");
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!isPowerOfTwo(n) || n < MIN_N || n > MAX_N) return null;
  if (!Number.isInteger(r) || r < MIN_R || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < MIN_P || p > MAX_P) return null;
  // N and r are each in range individually, but their product's memory cost might not be --
  // e.g. N=2^20 and r=32 are both allowed alone, yet together demand ~4 GiB.
  const memoryBytes = 128 * n * r;
  if (memoryBytes > MAX_MEMORY_BYTES) return null;
  const salt = Buffer.from(saltB64!, "base64url");
  const hash = Buffer.from(hashB64!, "base64url");
  if (salt.length < MIN_SALT_BYTES) return null;
  if (hash.length < MIN_KEY_BYTES) return null;
  return { n, r, p, salt, hash, memoryBytes };
}

export function isValidPasswordHash(stored: string): boolean {
  return parsePasswordHash(stored) !== null;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  try {
    const actual = await scrypt(pw, parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      // Safe because parsePasswordHash already rejected anything whose memoryBytes exceeds
      // this cap -- maxmem never needs to (and must not) be set any higher.
      maxmem: MAX_MEMORY_BYTES,
    });
    return timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}
