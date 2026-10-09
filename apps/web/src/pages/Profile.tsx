import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, MonitorSmartphone, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, label } from '../lib/format';
import { useSession } from '../lib/session';
import { ErrorBox, Field, KV, Loading, Modal, PageHeader, Panel, Tag, useToast } from '../components/ui';
import { PW_HINT, pwOk } from './Admin';

function PasswordForm({ onDone, forced }: { onDone: () => void; forced?: boolean }) {
  const [cur, setCur] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const toast = useToast();
  const valid = cur && pwOk(pw) && pw === pw2 && pw !== cur;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!valid) return;
    setBusy(true); setErr(null);
    try { await api.post('/auth/password', { currentPassword: cur, newPassword: pw }); toast('ok', 'Password diganti'); setCur(''); setPw(''); setPw2(''); onDone(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      {forced && <p className="text-[13.5px] text-bark-700">Akun Anda menggunakan password sementara. Ganti password sebelum melanjutkan.</p>}
      <Field label="Password saat ini" required><input type="password" className="input" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
      <Field label="Password baru" required hint={PW_HINT} error={pw && !pwOk(pw) ? PW_HINT : pw && pw === cur ? 'Harus berbeda dari password saat ini' : undefined}>
        <input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
      <Field label="Ulangi password baru" required error={pw2 && pw !== pw2 ? 'Tidak sama' : undefined}><input type="password" className="input" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
      <ErrorBox error={err} />
      <button className="btn-primary" disabled={!valid || busy}><KeyRound className="w-4 h-4" />Ganti password</button>
    </form>
  );
}

export function ForcePasswordChange() {
  const { me, refreshMe, logout } = useSession();
  const [flag, setFlag] = useState(() => sessionStorage.getItem('pcms.mustChange') === '1');
  const open = flag || !!me?.user.must_change_password;
  if (!open || !me) return null;
  return (
    <Modal open onClose={() => {}} title="Ganti password" size="sm" footer={<button className="btn-ghost" onClick={logout}><LogOut className="w-4 h-4" />Keluar</button>}>
      <PasswordForm forced onDone={() => { sessionStorage.removeItem('pcms.mustChange'); setFlag(false); refreshMe(); }} />
    </Modal>
  );
}

function Mfa() {
  const { me, refreshMe } = useSession();
  const toast = useToast();
  const [setup, setSetup] = useState<any>(null);
  const [code, setCode] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [err, setErr] = useState<any>(null);
  const enabled = me?.user.mfa_enabled;
  async function go(fn: () => Promise<any>, msg: string) {
    setErr(null);
    try { await fn(); toast('ok', msg); setSetup(null); setDisabling(false); setCode(''); refreshMe(); } catch (e) { setErr(e); }
  }
  return (
    <Panel title="Autentikasi dua langkah (TOTP)">
      <p className="text-[13.5px] text-bark-700 mb-3">Lindungi akses rekam medis dengan kode 6 digit dari aplikasi authenticator (Google Authenticator, Microsoft Authenticator, Authy).</p>
      <p className="mb-3">Status: {enabled ? <Tag tone="green">Aktif</Tag> : <Tag tone="amber">Belum aktif</Tag>}</p>
      {!enabled && !setup && <button className="btn-primary" onClick={async () => { setErr(null); try { setSetup(await api.post('/auth/mfa/setup')); } catch (e) { setErr(e); } }}><ShieldCheck className="w-4 h-4" />Aktifkan</button>}
      {setup && (
        <div className="flex flex-wrap gap-5 items-start">
          <img src={setup.qrDataUrl} alt="QR code untuk aplikasi authenticator" className="w-44 h-44 border border-line rounded" />
          <div className="space-y-3 flex-1 min-w-[220px]">
            <p className="text-[13px]">Pindai QR dengan aplikasi authenticator, atau masukkan kunci berikut secara manual:</p>
            <code className="block p-2 bg-mist rounded text-[12.5px] break-all">{setup.secret}</code>
            <Field label="Kode 6 digit dari aplikasi"><input className="input num w-40 tracking-widest" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
            <button className="btn-primary" disabled={code.length !== 6} onClick={() => go(() => api.post('/auth/mfa/enable', { code }), 'MFA aktif')}>Verifikasi & aktifkan</button>
          </div>
        </div>
      )}
      {enabled && !disabling && <button className="btn-secondary" onClick={() => setDisabling(true)}><ShieldOff className="w-4 h-4" />Nonaktifkan</button>}
      {enabled && disabling && (
        <div className="flex gap-2 items-end">
          <Field label="Kode saat ini"><input className="input num w-40" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
          <button className="btn-danger" disabled={code.length !== 6} onClick={() => go(() => api.post('/auth/mfa/disable', { code }), 'MFA dinonaktifkan')}>Nonaktifkan MFA</button>
        </div>
      )}
      <ErrorBox error={err} />
    </Panel>
  );
}

function Sessions() {
  const qc = useQueryClient(); const toast = useToast();
  const { logout } = useSession();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.get('/auth/sessions') });
  return (
    <Panel title="Sesi aktif" actions={<button className="btn-secondary btn-sm" onClick={async () => { try { await api.post('/auth/logout-all'); toast('ok', 'Semua sesi diakhiri'); await logout(); } catch (e: any) { toast('error', e.message); } }}><LogOut className="w-3.5 h-3.5" />Keluar dari semua perangkat</button>} bodyClass="p-0">
      {q.isLoading ? <Loading /> : (
        <table className="tbl">
          <thead><tr><th>Perangkat</th><th>IP</th><th>Mulai</th><th>Aktivitas terakhir</th><th /></tr></thead>
          <tbody>{(q.data?.data ?? []).map((s: any) => (
            <tr key={s.id}>
              <td className="max-w-[320px]"><MonitorSmartphone className="inline w-4 h-4 mr-1 text-bark" /><span className="text-[12.5px]">{(s.user_agent ?? 'Tidak diketahui').slice(0, 90)}</span>{s.is_current && <Tag tone="green">Sesi ini</Tag>}</td>
              <td className="num">{s.ip_address ?? '–'}</td><td className="num">{fmtDateTime(s.created_at)}</td><td className="num">{fmtDateTime(s.last_used_at)}</td>
              <td className="text-right">{!s.is_current && <button className="btn-ghost btn-sm" onClick={async () => { try { await api.del(`/auth/sessions/${s.id}`); qc.invalidateQueries({ queryKey: ['sessions'] }); toast('ok', 'Sesi diakhiri'); } catch (e: any) { toast('error', e.message); } }}>Akhiri</button>}</td>
            </tr>))}</tbody>
        </table>
      )}
      <ErrorBox error={q.error} />
    </Panel>
  );
}

export default function Profile() {
  const { me } = useSession();
  if (!me) return <Loading />;
  const u = me.user;
  return (
    <div className="space-y-5">
      <PageHeader title="Profil & keamanan akun" description={`${u.tenant_name} · ${u.home_unit_name}`} />
      <div className="grid xl:grid-cols-2 gap-5 items-start">
        <Panel title="Akun">
          <KV items={[['Nama', u.full_name], ['Username', u.username], ['Email', u.email ?? '–'], ['Unit asal', u.home_unit_name],
            ['Tenaga medis', u.staff ? label(u.staff.staff_type) : '–'], ['Terhubung ke karyawan', u.employee_id ? 'Ya' : 'Tidak']]} />
          <h3 className="font-cond font-semibold text-[15px] mt-5 mb-2">Role aktif</h3>
          <ul className="space-y-1">{me.roles.map((r, i) => <li key={i} className="text-[13.5px]"><b className="font-medium">{r.name}</b> <span className="text-bark">di {r.scope_name} ({label(r.scope_type)})</span></li>)}</ul>
        </Panel>
        <Panel title="Ganti password"><PasswordForm onDone={() => {}} /></Panel>
      </div>
      <Mfa />
      <Sessions />
    </div>
  );
}
