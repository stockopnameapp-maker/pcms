// API client: bearer access token, transparent refresh-token rotation, typed errors.
// Tokens live in sessionStorage (cleared when the browser tab closes); the strict
// CSP served by the API blocks third-party scripts.
const BASE = '/api/v1';
const KEY = 'pcms.session';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

type Session = { accessToken: string; refreshToken: string };
let session: Session | null = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } })();
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export const auth = {
  get token() { return session?.accessToken; },
  get isLoggedIn() { return !!session; },
  set(s: Session | null) {
    session = s;
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY);
    listeners.forEach((l) => l());
  },
  onChange(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
};

async function refresh(): Promise<boolean> {
  if (!session?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session!.refreshToken }) });
      if (!r.ok) { auth.set(null); return false; }
      const j = await r.json();
      auth.set({ accessToken: j.accessToken, refreshToken: j.refreshToken });
      return true;
    } catch { return false; } finally { setTimeout(() => (refreshing = null), 0); }
  })();
  return refreshing;
}

export async function request<T = any>(method: string, path: string, body?: any, opts: { raw?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const doFetch = () => fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}), ...opts.headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  let res = await doFetch();
  if (res.status === 401 && session && !path.startsWith('/auth/login')) {
    if (await refresh()) res = await doFetch();
  }
  if (opts.raw) {
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? res.statusText); }
    return res as any;
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) auth.set(null);
    throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `Permintaan gagal (${res.status})`, json?.error?.details);
  }
  return json as T;
}

export const api = {
  get: <T = any>(p: string, params?: Record<string, any>) => request<T>('GET', p + qs(params)),
  post: <T = any>(p: string, b?: any) => request<T>('POST', p, b ?? {}),
  patch: <T = any>(p: string, b?: any, headers?: Record<string, string>) => request<T>('PATCH', p, b, { headers }),
  put: <T = any>(p: string, b?: any) => request<T>('PUT', p, b),
  del: <T = any>(p: string) => request<T>('DELETE', p),
};

export function qs(params?: Record<string, any>) {
  if (!params) return '';
  const e = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? '?' + new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString() : '';
}

/** Download a protected file (export, PDF) and save it. */
export async function download(path: string, params?: Record<string, any>, fallbackName = 'download') {
  const res: Response = await request('GET', path + qs(params), undefined, { raw: true });
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Fetch a protected image as an object URL. */
export async function imageUrl(path: string) {
  const res: Response = await request('GET', path, undefined, { raw: true });
  return URL.createObjectURL(await res.blob());
}
