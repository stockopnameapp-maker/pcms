// API client for the Android app. The server address is chosen by the user on first launch and kept on the
// device together with the session (access + rotating refresh token), so a doctor stays signed in until the
// server's idle timeout or an explicit logout.
const SERVER_KEY = 'palmora.server';
const SESSION_KEY = 'palmora.session';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

/** Accepts "palmora.example.co.id", "https://host:8080/" or "http://192.168.1.10:8080" and returns the origin. */
export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  return u.origin;
}

export const server = {
  get url(): string | null { return read(SERVER_KEY); },
  set(url: string | null) { write(SERVER_KEY, url); listeners.forEach((l) => l()); },
};

type Session = { accessToken: string; refreshToken: string };
let session: Session | null = (() => { try { return JSON.parse(read(SESSION_KEY) || 'null'); } catch { return null; } })();
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export const auth = {
  get isLoggedIn() { return !!session; },
  get refreshToken() { return session?.refreshToken; },
  set(s: Session | null) {
    session = s;
    write(SESSION_KEY, s ? JSON.stringify(s) : null);
    listeners.forEach((l) => l());
  },
  onChange(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

const base = () => {
  if (!server.url) throw new ApiError(0, 'NO_SERVER', 'Alamat server belum diatur');
  return server.url + '/api/v1';
};

async function net(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Tidak dapat terhubung ke server. Periksa koneksi internet atau alamat server.');
  }
}

async function refresh(): Promise<boolean> {
  if (!session?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const r = await net(`${base()}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session!.refreshToken }) });
      if (!r.ok) { auth.set(null); return false; }
      const j = await r.json();
      auth.set({ accessToken: j.accessToken, refreshToken: j.refreshToken });
      return true;
    } catch { return false; } finally { setTimeout(() => (refreshing = null), 0); }
  })();
  return refreshing;
}

export async function request<T = any>(method: string, path: string, body?: any): Promise<T> {
  const doFetch = () => net(base() + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res = await doFetch();
  if (res.status === 401 && session && !path.startsWith('/auth/login')) {
    if (await refresh()) res = await doFetch();
  }
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { throw new ApiError(res.status, 'BAD_RESPONSE', 'Server membalas dengan format yang tidak dikenali. Periksa alamat server.'); }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) auth.set(null);
    throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `Permintaan gagal (${res.status})`, json?.error?.details);
  }
  return json as T;
}

export function qs(params?: Record<string, any>) {
  if (!params) return '';
  const e = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? '?' + new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString() : '';
}

export const api = {
  get: <T = any>(p: string, params?: Record<string, any>) => request<T>('GET', p + qs(params)),
  post: <T = any>(p: string, b?: any) => request<T>('POST', p, b ?? {}),
  patch: <T = any>(p: string, b?: any) => request<T>('PATCH', p, b),
  del: <T = any>(p: string) => request<T>('DELETE', p),
};

/** Checks that an address really is a Palmora Health server before it is saved. */
export async function probeServer(origin: string): Promise<void> {
  let r: Response;
  try {
    r = await fetch(origin + '/healthz', { method: 'GET' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Server tidak dapat dihubungi. Pastikan alamatnya benar dan HP terhubung ke internet atau jaringan kantor.');
  }
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.status !== 'ok') throw new ApiError(r.status, 'NOT_PALMORA', 'Alamat ini bukan server Palmora Health atau server sedang tidak aktif.');
}
