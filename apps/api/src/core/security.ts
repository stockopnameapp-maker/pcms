import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { badRequest } from './errors.js';

// ----------------------------------------------------------------- passwords (argon2id, OWASP parameters)
const ARGON = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => hash(pw, ARGON);
export const verifyPassword = async (h: string, pw: string) => { try { return await verify(h, pw); } catch { return false; } };
// constant-time dummy verification so unknown usernames take as long as wrong passwords
const DUMMY = await hash('timing-equaliser-' + randomBytes(8).toString('hex'), ARGON);
export const dummyVerify = (pw: string) => verifyPassword(DUMMY, pw);

export function assertPasswordPolicy(pw: string, username?: string) {
  const problems: string[] = [];
  if (pw.length < 10) problems.push('minimal 10 karakter');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) problems.push('kombinasi minimal 3 dari: huruf kecil, huruf besar, angka, simbol');
  if (username && pw.toLowerCase().includes(username.toLowerCase().split('.')[0])) problems.push('tidak boleh mengandung username');
  if (/^(password|admin|12345|qwerty)/i.test(pw)) problems.push('terlalu mudah ditebak');
  if (problems.length) throw badRequest(`Password tidak memenuhi kebijakan: ${problems.join(', ')}`);
}

// ----------------------------------------------------------------- tokens
const key = new TextEncoder().encode(config.jwtSecret);
export interface AccessClaims { sub: string; tid: string; sid: string; }

export async function signAccessToken(c: AccessClaims) {
  return new SignJWT({ tid: c.tid, sid: c.sid }).setProtectedHeader({ alg: 'HS256' }).setSubject(c.sub)
    .setIssuedAt().setIssuer('pcms').setAudience('pcms-api').setExpirationTime(config.accessTtl).sign(key);
}
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key, { issuer: 'pcms', audience: 'pcms-api', algorithms: ['HS256'] });
  return { sub: String(payload.sub), tid: String(payload.tid), sid: String(payload.sid) };
}
export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ----------------------------------------------------------------- field-level encryption (AES-256-GCM)
// Used for confidential free text (doctor notes) and MFA secrets. Values are
// stored as  enc:v1:<base64 iv|tag|ciphertext>. Legacy plaintext passes through.
const fieldKey = config.fieldKey ? Buffer.from(config.fieldKey, 'base64') : null;
if (fieldKey && fieldKey.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must decode to 32 bytes');
const PREFIX = 'enc:v1:';

export function encryptField(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return plain ?? null;
  if (!fieldKey) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', fieldKey, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptField(stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith(PREFIX)) return stored ?? null;
  if (!fieldKey) return '[terenkripsi]';
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', fieldKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '[gagal dekripsi]';
  }
}
