import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodType } from 'zod';
import { withContext, Tx } from './db.js';
import { AppError, badRequest, forbidden, unauthorized } from './errors.js';
import { verifyAccessToken } from './security.js';
import { addDays, today } from './time.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; tenantId: string; sessionId: string };
  }
}

/** preHandler: validates the bearer access token. */
export async function authenticate(req: FastifyRequest) {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.query as any)?.access_token; // query token only for file downloads/SSE
  if (!token) throw unauthorized('Token akses diperlukan');
  try {
    const c = await verifyAccessToken(token);
    req.auth = { userId: c.sub, tenantId: c.tid, sessionId: c.sid };
  } catch {
    throw unauthorized('Token akses tidak valid atau kedaluwarsa');
  }
}

/** Run the handler inside the user's security context (one DB transaction). */
export function db<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>) {
  if (!req.auth) throw unauthorized();
  return withContext(
    { userId: req.auth.userId, sessionId: req.auth.sessionId, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400), requestId: req.id },
    fn,
  );
}

/** Friendly early permission check; RLS remains the authoritative enforcement. */
export async function requirePerm(tx: Tx, module: string, action: string, unitId?: string | null) {
  const ok = unitId
    ? await tx.val<boolean>('SELECT app.can($1, $2, $3)', [module, action, unitId])
    : await tx.val<boolean>('SELECT app.has_perm($1, $2)', [module, action]);
  if (!ok) throw forbidden(`Izin ${module}:${action} diperlukan${unitId ? ' pada unit ini' : ''}`);
}

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw badRequest(`Validasi gagal: ${issues.map((i) => `${i.field || 'input'} — ${i.message}`).join('; ')}`, issues);
  }
  return r.data;
}

export const zUuid = z.string().uuid({ message: 'harus berupa UUID yang valid' });
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format tanggal YYYY-MM-DD');

export function page(q: any) {
  const pageNo = Math.max(1, Number(q.page) || 1);
  const size = Math.min(200, Math.max(1, Number(q.pageSize) || 25));
  return { page: pageNo, pageSize: size, offset: (pageNo - 1) * size };
}

export function dateRange(q: any, defaultDays = 30) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : today();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : addDays(to, -(defaultDays - 1));
  if (from > to) throw badRequest('Tanggal awal harus sebelum tanggal akhir');
  return { from, to };
}

export function sendFile(reply: FastifyReply, buf: Buffer, mime: string, filename: string) {
  reply.header('Content-Type', mime);
  reply.header('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  reply.header('Cache-Control', 'no-store');
  return reply.send(buf);
}

export { AppError };
