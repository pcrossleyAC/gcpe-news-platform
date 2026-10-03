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

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (!PASSWORD_HASH_FORMAT.test(stored)) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split("$");
  const expected = Buffer.from(hashB64!, "base64url");
  if (expected.length === 0) return false;
  try {
    const actual = await scrypt(pw, Buffer.from(saltB64!, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
