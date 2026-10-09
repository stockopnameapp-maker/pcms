import { FormEvent, useState } from 'react';
import { api, auth } from '../lib/api';
import { ErrorBox, Field, Spinner } from '../components/ui';

const DEMO = [
  ['kas.corporate', 'Manajemen korporat'], ['kas.meddirector', 'Medical Director'], ['kas.estate.bcpj-ra', 'Estate Manager'],
  ['kas.dr.bcpj-central', 'Dokter Klinik Central'], ['kas.dr.bcpj-ra-kln', 'Dokter Klinik Rayon A'], ['kas.nurse1.bcpj-ra-kln', 'Perawat'], ['kas.apt.bcpj-ra-kln', 'Apoteker'],
  ['kas.hrmanager.bcpj', 'HR Manager'], ['kas.hseofficer.bcpj-ra', 'HSE Officer'], ['kas.superadmin', 'Super Admin'], ['kas.employee', 'Karyawan (portal)'],
];

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [mfa, setMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/auth/login', { username, password, otp: mfa ? otp : undefined });
      if (r.mfaRequired) { setMfa(true); return; }
      auth.set({ accessToken: r.accessToken, refreshToken: r.refreshToken });
      if (r.mustChangePassword) sessionStorage.setItem('pcms.mustChange', '1');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-white">
      <section className="relative hidden lg:flex flex-col justify-between bg-canopy text-white p-12 overflow-hidden">
        <svg className="absolute -right-24 -bottom-24 w-[620px] opacity-[0.13]" viewBox="0 0 200 200" fill="none" stroke="#9FD3B8" strokeWidth="0.8" aria-hidden>
          {Array.from({ length: 14 }).map((_, i) => {
            const a = (-160 + i * 11) * (Math.PI / 180);
            const x = 100 + Math.cos(a) * 95, y = 160 + Math.sin(a) * 95;
            return <path key={i} d={`M100 160 Q ${100 + Math.cos(a) * 50} ${160 + Math.sin(a) * 70} ${x} ${y}`} />;
          })}
          <path d="M100 160 L100 200" strokeWidth="2" />
        </svg>
        <div className="flex items-center gap-3"><span className="w-11 h-11 rounded-xl bg-white grid place-items-center p-1.5"><img src="/brand/mark.png" alt="" className="w-full h-auto" /></span><span className="leading-tight"><span className="block font-semibold text-[18px] text-white">Palmora Health</span><span className="block text-[12.5px] text-canopy-300">People Health Our Priority</span></span></div>
        <div className="max-w-lg relative">
          <h1 className="text-white text-[34px] leading-[1.15] font-semibold">Satu catatan kesehatan untuk seluruh kebun, pabrik, dan klinik.</h1>
          <p className="text-canopy-300 mt-4 text-[15px] leading-relaxed">Pelayanan klinik, kesehatan kerja, K3, farmasi, dan biaya medis — dari divisi hingga holding, dengan akses yang dibatasi sesuai tugas.</p>
          <dl className="mt-10 grid grid-cols-3 gap-6 text-[13px]">
            {[['Grup → PT → Kebun → Klinik', 'Hierarki dinamis'], ['Need-to-know', 'Rekam medis terlindungi'], ['Early warning', 'Lonjakan penyakit & stok']].map(([a, b]) => (
              <div key={a} className="border-t border-white/20 pt-3"><dt className="text-white font-medium">{b}</dt><dd className="text-canopy-300 mt-0.5">{a}</dd></div>
            ))}
          </dl>
        </div>
        <p className="text-[12px] text-canopy-300/70">Data medis bersifat rahasia. Setiap akses tercatat di audit trail.</p>
      </section>
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <img src="/brand/logo.png" alt="Palmora Health — People Health Our Priority" className="h-32 w-auto mx-auto mb-8" />
          <h2 className="text-[22px] font-semibold">{mfa ? 'Verifikasi dua langkah' : 'Masuk'}</h2>
          <p className="text-bark mt-1">{mfa ? 'Masukkan 6 digit kode dari aplikasi autentikator Anda.' : 'Gunakan akun yang diberikan administrator klinik atau HR.'}</p>
          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            {!mfa ? (
              <>
                <Field label="Username atau email"><input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
                <Field label="Password"><input type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
              </>
            ) : (
              <Field label="Kode autentikator"><input className="input text-center tracking-[0.4em] num text-[18px]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></Field>
            )}
            <ErrorBox error={err} />
            <button className="btn-primary w-full h-10" disabled={busy || !username || !password}>{busy && <Spinner className="w-4 h-4 text-white" />}{mfa ? 'Verifikasi' : 'Masuk'}</button>
            {mfa && <button type="button" className="btn-ghost w-full" onClick={() => { setMfa(false); setOtp(''); }}>Kembali</button>}
          </form>
          {!mfa && (
            <details className="mt-8 text-[13px]">
              <summary className="cursor-pointer text-canopy-700">Akun demo (password: Demo@12345)</summary>
              <ul className="mt-2 grid grid-cols-1 gap-1">
                {DEMO.map(([u, r]) => (
                  <li key={u}><button type="button" className="w-full flex justify-between gap-2 text-left px-2 py-1 rounded hover:bg-canopy-50" onClick={() => { setUsername(u); setPassword('Demo@12345'); }}>
                    <span className="font-medium">{u}</span><span className="text-bark">{r}</span></button></li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </section>
    </div>
  );
}
