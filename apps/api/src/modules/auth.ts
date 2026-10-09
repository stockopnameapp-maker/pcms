import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { anonymous } from '../core/db.js';
import { config } from '../core/config.js';
import { authenticate, db, parse } from '../core/http.js';
import { AppError, badRequest, unauthorized } from '../core/errors.js';
import {
  assertPasswordPolicy, decryptField, dummyVerify, encryptField, hashPassword, newRefreshToken, sha256, signAccessToken, verifyPassword,
} from '../core/security.js';

const ttl = `${config.refreshDays} days`;
const idle = `${config.idleMinutes} minutes`;

async function issueTokens(tx: any, user: { user_id: string; tenant_id: string }, req: FastifyRequest) {
  const refresh = newRefreshToken();
  const sid = await tx.val('SELECT app.session_create($1, $2, $3, $4, $5::interval)', [user.user_id, sha256(refresh), req.ip, String(req.headers['user-agent'] ?? ''), ttl]);
  const access = await signAccessToken({ sub: user.user_id, tid: user.tenant_id, sid });
  return { accessToken: access, refreshToken: refresh, expiresIn: config.accessTtl };
}

async function checkTotp(secretEnc: string | null, code?: string) {
  if (!secretEnc || !code) return false;
  const secret = decryptField(secretEnc);
  if (!secret) return false;
  try { return (await verifyTotp({ secret, token: code.replace(/\s/g, ''), epochTolerance: 30 } as any)).valid; } catch { return false; }
}

export default async function authRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- login (rate-limited separately in server.ts)
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200), otp: z.string().max(10).optional() }), req.body);
    // Failures are returned (not thrown) from the transaction so that the failed-attempt
    // counter, lockout and audit row COMMIT; the HTTP error is raised afterwards.
    const out = await anonymous(async (tx): Promise<{ fail?: AppError; ok?: any }> => {
      const u = await tx.one('SELECT * FROM app.auth_lookup($1)', [b.username.trim()]);
      if (!u) { await dummyVerify(b.password); return { fail: unauthorized('Username atau password salah') }; }
      if (u.status !== 'ACTIVE') return { fail: unauthorized('Akun dinonaktifkan. Hubungi administrator.') };
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        return { fail: new AppError(423, 'ACCOUNT_LOCKED', `Akun terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi setelah ${new Date(u.locked_until).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })}.`) };
      }
      const ok = await verifyPassword(u.password_hash, b.password);
      if (!ok) {
        await tx.q('SELECT app.auth_record_attempt($1, false, $2, $3)', [u.user_id, req.ip, String(req.headers['user-agent'] ?? '')]);
        return { fail: unauthorized('Username atau password salah') };
      }
      if (u.mfa_enabled) {
        if (!b.otp) return { ok: { mfaRequired: true } };
        const secret = await tx.val('SELECT app.auth_mfa_secret($1)', [u.user_id]);
        if (!(await checkTotp(secret, b.otp))) {
          await tx.q('SELECT app.auth_record_attempt($1, false, $2, $3)', [u.user_id, req.ip, 'MFA failed']);
          return { fail: unauthorized('Kode autentikator salah') };
        }
      }
      await tx.q('SELECT app.auth_record_attempt($1, true, $2, $3)', [u.user_id, req.ip, String(req.headers['user-agent'] ?? '')]);
      const tokens = await issueTokens(tx, u, req);
      return { ok: { ...tokens, mustChangePassword: u.must_change_password } };
    });
    if (out.fail) throw out.fail;
    return out.ok;
  });

  app.post('/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    return anonymous(async (tx) => {
      const next = newRefreshToken();
      const r = await tx.one('SELECT * FROM app.session_rotate($1, $2, $3::interval, $4::interval)', [sha256(b.refreshToken), sha256(next), ttl, idle]);
      if (r!.outcome !== 'OK') return { fail: r!.outcome as string };
      const owner = await tx.one('SELECT * FROM app.session_owner($1)', [r!.session_id]);
      const access = await signAccessToken({ sub: owner.user_id, tid: owner.tenant_id, sid: r!.session_id });
      return { accessToken: access, refreshToken: next, expiresIn: config.accessTtl };
    }).then((res: any) => {
      // revocations (reuse detection, expiry) have been committed at this point
      if (res.fail) throw unauthorized(res.fail === 'REUSE_DETECTED' ? 'Sesi dicabut karena token digunakan ulang. Silakan masuk kembali.' : 'Sesi berakhir. Silakan masuk kembali.');
      return res;
    });
  });

  app.post('/auth/logout', async (req) => {
    const b = parse(z.object({ refreshToken: z.string().max(200).optional() }), req.body ?? {});
    if (b.refreshToken) await anonymous((tx) => tx.q('SELECT app.session_revoke_by_token($1)', [sha256(b.refreshToken!)]));
    return { ok: true };
  });

  // ---------------------------------------------------------------- authenticated
  app.register(async (a) => {
    a.addHook('preHandler', authenticate);

    a.get('/auth/me', async (req) => db(req, async (tx) => {
      const user = await tx.one(`SELECT u.id, u.username, u.full_name, u.email, u.phone, u.locale, u.mfa_enabled, u.must_change_password, u.employee_id, u.home_unit_id,
                                        h.name AS home_unit_name, t.code AS tenant_code, t.name AS tenant_name,
                                        (SELECT jsonb_build_object('id', s.id, 'staff_type', s.staff_type, 'home_clinic_id', s.home_clinic_id) FROM medical_staff s WHERE s.user_id = u.id AND s.status = 'ACTIVE') AS staff
                                   FROM app_user u JOIN org_unit h ON h.id = u.home_unit_id JOIN tenant t ON t.id = u.tenant_id WHERE u.id = app.current_user_id()`);
      const perms = await tx.q('SELECT module, action, scope_unit_id, scope_unit_type, scope_unit_name, role_code FROM app.my_permissions()');
      const roles = await tx.q(`SELECT DISTINCT r.code, r.name, s.id AS scope_id, s.name AS scope_name, s.unit_type AS scope_type
                                  FROM user_role_assignment a JOIN role r ON r.id = a.role_id JOIN org_unit s ON s.id = a.scope_unit_id
                                 WHERE a.user_id = app.current_user_id() AND a.revoked_at IS NULL AND a.deleted_at IS NULL ORDER BY r.code`);
      // scope picker: assignment scopes and every unit below them (structural units only)
      const scopes = await tx.q(`SELECT DISTINCT u.id, u.name, u.unit_type, u.code, u.depth, u.parent_id
                                   FROM user_role_assignment a JOIN org_unit s ON s.id = a.scope_unit_id
                                   JOIN org_unit u ON u.path <@ s.path AND u.unit_type IN ('GROUP','COMPANY','REGION','ESTATE','MILL','CLINIC','WAREHOUSE')
                                  WHERE a.user_id = app.current_user_id() AND a.revoked_at IS NULL AND u.deleted_at IS NULL
                                  ORDER BY u.depth, u.name`);
      const modules: Record<string, string[]> = {};
      for (const p of perms) (modules[p.module] ??= []).includes(p.action) || modules[p.module].push(p.action);
      const unread = await tx.val('SELECT count(*)::int FROM notification WHERE recipient_id = app.current_user_id() AND read_at IS NULL');
      return { user, roles, permissions: modules, scopes, unreadNotifications: unread };
    }));

    a.post('/auth/password', async (req) => {
      const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) }), req.body);
      return db(req, async (tx) => {
        const username = await tx.val<string>('SELECT username FROM app_user WHERE id = app.current_user_id()');
        const u = await tx.one('SELECT * FROM app.auth_lookup($1)', [username]);
        if (!(await verifyPassword(u.password_hash, b.currentPassword))) throw badRequest('Password saat ini salah');
        if (b.currentPassword === b.newPassword) throw badRequest('Password baru harus berbeda');
        assertPasswordPolicy(b.newPassword, username);
        await tx.q('SELECT app.change_own_password($1)', [await hashPassword(b.newPassword)]);
        return { ok: true };
      });
    });

    a.post('/auth/mfa/setup', async (req) => db(req, async (tx) => {
      const username = await tx.val<string>('SELECT username FROM app_user WHERE id = app.current_user_id()');
      const enabled = await tx.val<boolean>('SELECT mfa_enabled FROM app_user WHERE id = app.current_user_id()');
      if (enabled) throw badRequest('MFA sudah aktif');
      const secret = generateSecret();
      await tx.q('SELECT app.set_own_mfa($1, false)', [encryptField(secret)]);
      const uri = generateURI({ issuer: 'Palmora Health', label: username!, secret } as any);
      return { secret, otpauthUrl: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    }));

    a.post('/auth/mfa/enable', async (req) => {
      const b = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
      return db(req, async (tx) => {
        const secret = await tx.val('SELECT app.own_mfa_secret()');
        if (!(await checkTotp(secret, b.code))) throw badRequest('Kode tidak valid. Pastikan jam perangkat sesuai.');
        await tx.q('SELECT app.set_own_mfa($1, true)', [secret]);
        await tx.q(`SELECT app.log_access('STATUS_CHANGE', 'app_user', app.current_user_id(), 'USER_ADMIN', 'MFA enabled')`);
        return { ok: true };
      });
    });

    a.post('/auth/mfa/disable', async (req) => {
      const b = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
      return db(req, async (tx) => {
        const secret = await tx.val('SELECT app.own_mfa_secret()');
        if (!(await checkTotp(secret, b.code))) throw badRequest('Kode tidak valid');
        await tx.q('SELECT app.set_own_mfa(NULL, false)');
        await tx.q(`SELECT app.log_access('STATUS_CHANGE', 'app_user', app.current_user_id(), 'USER_ADMIN', 'MFA disabled')`);
        return { ok: true };
      });
    });

    a.get('/auth/sessions', async (req) => db(req, async (tx) => ({ data: await tx.q('SELECT * FROM app.my_sessions()') })));
    a.delete('/auth/sessions/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => db(req, async (tx) => {
      await tx.q(`SELECT app.session_revoke($1, 'REVOKED_BY_USER')`, [req.params.id]);
      return { ok: true };
    }));
    a.post('/auth/logout-all', async (req) => db(req, async (tx) => {
      const sessions = await tx.q('SELECT id FROM app.my_sessions()');
      for (const s of sessions) await tx.q(`SELECT app.session_revoke($1, 'LOGOUT_ALL')`, [s.id]);
      return { ok: true, revoked: sessions.length };
    }));
  });
}
