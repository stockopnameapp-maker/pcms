import { FormEvent, useState } from 'react';
import { Eye, EyeOff, Server } from 'lucide-react';
import { api, auth, normalizeServer, probeServer, server } from '../lib/api';
import { ErrorBox, Field, Spinner } from '../components/ui';

function Brand() {
  return (
    <div className="flex flex-col items-center text-center gap-3 pt-10 pb-8">
      <div className="w-20 h-20 rounded-3xl bg-white grid place-items-center p-2.5 shadow-sm"><img src="./mark.png" alt="" className="w-full h-auto" /></div>
      <div>
        <p className="text-[24px] font-semibold text-white leading-tight">Palmora Health</p>
        <p className="text-[14px] text-canopy-300">Klinik · dokter & perawat</p>
      </div>
    </div>
  );
}

/** First launch: which Palmora Health server this phone talks to. */
export function ServerSetup({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState(server.url ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const origin = normalizeServer(v);
      await probeServer(origin);
      server.set(origin);
      onDone();
    } catch (x: any) { setErr(x instanceof TypeError ? new Error('Alamat server tidak valid') : x); } finally { setBusy(false); }
  }
  return (
    <div className="min-h-screen bg-canopy flex flex-col safe-top">
      <Brand />
      <form onSubmit={submit} className="flex-1 bg-white rounded-t-3xl px-6 pt-7 pb-10 space-y-5 safe-bottom">
        <div>
          <h1 className="text-[20px] font-semibold flex items-center gap-2"><Server className="w-5 h-5 text-canopy-600" aria-hidden />Hubungkan ke server</h1>
          <p className="text-[14.5px] text-bark mt-1">Masukkan alamat server Palmora Health perusahaan Anda. Tanyakan ke admin sistem bila belum tahu.</p>
        </div>
        <Field label="Alamat server" hint="Contoh: palmora.perusahaan.co.id atau https://…-8080.app.github.dev">
          <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="palmora.perusahaan.co.id" value={v} onChange={(e) => setV(e.target.value)} required />
        </Field>
        <ErrorBox error={err} />
        <button className="btn-primary w-full" disabled={busy || !v.trim()}>{busy && <Spinner />}Hubungkan</button>
      </form>
    </div>
  );
}

export function Login({ onChangeServer }: { onChangeServer: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [otp, setOtp] = useState('');
  const [mfa, setMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/auth/login', { username: username.trim(), password, otp: mfa ? otp : undefined });
      if (r.mfaRequired) { setMfa(true); return; }
      auth.set({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  const host = server.url ? new URL(server.url).host : '';
  return (
    <div className="min-h-screen bg-canopy flex flex-col safe-top">
      <Brand />
      <form onSubmit={submit} className="flex-1 bg-white rounded-t-3xl px-6 pt-7 pb-10 space-y-4 safe-bottom">
        <h1 className="text-[20px] font-semibold">Masuk</h1>
        {!mfa ? <>
          <Field label="Username"><input className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
          <Field label="Password">
            <div className="relative">
              <input className="input pr-12" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="absolute right-1 top-1 w-10 h-10 grid place-items-center text-bark" aria-label={show ? 'Sembunyikan password' : 'Tampilkan password'} onClick={() => setShow((s) => !s)}>
                {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}</button>
            </div>
          </Field>
        </> : (
          <Field label="Kode 6 digit dari aplikasi autentikator">
            <input className="input text-center tracking-[0.4em] num" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} autoFocus required />
          </Field>
        )}
        <ErrorBox error={err} />
        <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner />}{mfa ? 'Verifikasi' : 'Masuk'}</button>
        <p className="text-[13.5px] text-bark text-center pt-2">Server: <span className="text-ink">{host}</span> · <button type="button" className="text-canopy-700 font-medium underline underline-offset-2" onClick={onChangeServer}>Ubah</button></p>
      </form>
    </div>
  );
}
