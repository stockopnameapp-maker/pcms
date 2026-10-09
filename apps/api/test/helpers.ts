// Shared harness for API integration tests: one Fastify instance (in-process,
// via inject), real PostgreSQL with RLS, and an owner pool used ONLY to look up
// fixtures and to assert side effects the API user is not allowed to read.
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool } from '../src/core/db.js';

export const PASSWORD = 'Demo@12345';
let app: FastifyInstance | null = null;
let ownerPool: pg.Pool | null = null;
let ipSeq = 0;

export async function server() {
  if (!app) { app = await buildServer({ logger: false }); await app.ready(); }
  return app;
}
export function owner() {
  if (!ownerPool) ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL, max: 3 });
  return ownerPool;
}
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> { return (await owner().query(sql, params)).rows; }
export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T> { return (await q<T>(sql, params))[0]; }

export async function close() {
  await app?.close(); app = null;
  await ownerPool?.end(); ownerPool = null;
  await pool.end().catch(() => {});
}

/** a fresh client IP per login so per-route login rate limits never interfere between tests */
const ip = () => `10.${(++ipSeq >> 8) & 255}.${ipSeq & 255}.7`;

export async function rawLogin(username: string, password = PASSWORD) {
  const s = await server();
  return s.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password }, headers: { 'x-forwarded-for': ip() } });
}

export interface Client {
  username: string; token: string; refreshToken: string;
  get: (url: string, query?: Record<string, any>) => Promise<Res>;
  post: (url: string, body?: any) => Promise<Res>;
  patch: (url: string, body?: any, headers?: Record<string, string>) => Promise<Res>;
  put: (url: string, body?: any) => Promise<Res>;
  del: (url: string) => Promise<Res>;
  raw: (method: string, url: string, payload: any, headers: Record<string, string>) => Promise<Res>;
}
export interface Res { status: number; body: any; headers: Record<string, any>; raw: Buffer }

export async function login(username: string): Promise<Client> {
  const r = await rawLogin(username);
  if (r.statusCode !== 200) throw new Error(`login ${username} failed: ${r.statusCode} ${r.body}`);
  const { accessToken, refreshToken } = r.json();
  const s = await server();
  const call = async (method: any, url: string, body?: any, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await s.inject({ method, url: '/api/v1' + url, payload: body, headers: { authorization: `Bearer ${accessToken}`, ...headers } });
    let parsed: any = null;
    try { parsed = res.json(); } catch { parsed = null; }
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.rawPayload };
  };
  const qs = (query?: Record<string, any>) => {
    if (!query) return '';
    const e = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
    return e.length ? '?' + new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString() : '';
  };
  return {
    username, token: accessToken, refreshToken,
    get: (url, query) => call('GET', url + qs(query)),
    post: (url, body) => call('POST', url, body ?? {}),
    patch: (url, body, headers) => call('PATCH', url, body, headers),
    put: (url, body) => call('PUT', url, body),
    del: (url) => call('DELETE', url),
    raw: (method, url, payload, headers) => call(method, url, payload, headers),
  };
}

export const unitId = async (code: string) => (await one<{ id: string }>('SELECT id FROM org_unit WHERE code = $1', [code])).id;
