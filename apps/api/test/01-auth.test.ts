import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, login, one, q, rawLogin, server } from './helpers.js';

after(close);

test('login issues tokens; wrong password and unknown user get the same 401', async () => {
  const ok = await rawLogin('kas.corporate');
  assert.equal(ok.statusCode, 200);
  const b = ok.json();
  assert.ok(b.accessToken && b.refreshToken);
  const bad = await rawLogin('kas.corporate', 'wrong-password');
  const unknown = await rawLogin('nobody.here', 'wrong-password');
  assert.equal(bad.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(bad.json().error.message, unknown.json().error.message, 'no username enumeration');
});

test('five failed logins lock the account, even for the correct password', async () => {
  const user = 'kas.hseofficer.bcpa-rb';
  try {
    for (let i = 0; i < 5; i++) assert.equal((await rawLogin(user, 'Wrong-pass-123!')).statusCode, 401);
    const locked = await rawLogin(user);
    assert.equal(locked.statusCode, 423);
    assert.equal(locked.json().error.code, 'ACCOUNT_LOCKED');
    const audit = await one(`SELECT count(*)::int AS n FROM audit.audit_log l JOIN app_user u ON u.id = l.user_id WHERE u.username = $1 AND l.action = 'LOGIN_FAILED' AND l.occurred_at > now() - interval '1 minute'`, [user]);
    assert.ok(audit.n >= 5, 'failed attempts are audited');
  } finally {
    await q(`UPDATE app_user SET failed_attempts = 0, locked_until = NULL WHERE username = $1`, [user]);
  }
});

test('unauthenticated and tampered tokens are rejected', async () => {
  const s = await server();
  assert.equal((await s.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode, 401);
  const c = await login('kas.corporate');
  const forged = c.token.slice(0, -4) + (c.token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal((await s.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${forged}` } })).statusCode, 401);
});

test('refresh tokens rotate; replaying an old token revokes the whole session', async () => {
  const s = await server();
  const c = await login('kas.corporate');
  const r1 = await s.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: c.refreshToken }, headers: { 'x-forwarded-for': '10.99.0.1' } });
  assert.equal(r1.statusCode, 200);
  const t2 = r1.json().refreshToken;
  assert.notEqual(t2, c.refreshToken);
  const replay = await s.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: c.refreshToken }, headers: { 'x-forwarded-for': '10.99.0.1' } });
  assert.equal(replay.statusCode, 401, 'old token is refused');
  const after = await s.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: t2 }, headers: { 'x-forwarded-for': '10.99.0.1' } });
  assert.equal(after.statusCode, 401, 'reuse detection revoked the rotated token as well');
});

test('logout revokes the refresh token', async () => {
  const s = await server();
  const c = await login('kas.meddirector');
  assert.equal((await c.post('/auth/logout', { refreshToken: c.refreshToken })).status, 200);
  const r = await s.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: c.refreshToken }, headers: { 'x-forwarded-for': '10.99.0.2' } });
  assert.equal(r.statusCode, 401);
});

test('/auth/me returns effective permissions and scopes from the database', async () => {
  const hr = await login('kas.hrmanager.bcpj');
  const me = (await hr.get('/auth/me')).body;
  assert.ok(me.permissions.EMPLOYEE?.includes('READ'));
  assert.ok(!me.permissions.EMR, 'HR has no medical-record permission');
  assert.ok(me.scopes.some((s: any) => s.unit_type === 'COMPANY'));
  const doc = await login('kas.dr.bcpj-ra-kln');
  const dme = (await doc.get('/auth/me')).body;
  assert.ok(dme.permissions.EMR.includes('CREATE'));
  assert.equal(dme.user.staff.staff_type, 'DOCTOR');
});

test('password policy is enforced on change', async () => {
  const c = await login('kas.nurse2.bcpj-ra-kln').catch(() => login('kas.nurse1.bcpj-rb-kln'));
  const r = await c.post('/auth/password', { currentPassword: 'Demo@12345', newPassword: 'short' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /kebijakan/);
});
