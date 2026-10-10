import { LogOut, Server } from 'lucide-react';
import { server } from '../lib/api';
import { label } from '../lib/format';
import { useSession } from '../lib/session';
import { ClinicSwitcher } from './Queue';
import { TopBar } from '../components/ui';

export default function Account({ onChangeServer }: { onChangeServer: () => void }) {
  const { me, clinic, clinics, logout } = useSession();
  const u = me?.user;
  return (
    <div className="pb-24">
      <TopBar title="Akun" left={<img src="./mark.png" alt="" className="w-8 h-8 rounded-lg bg-white p-1" />} />
      <div className="p-4 space-y-4">
        <div className="card p-5">
          <p className="text-[18px] font-semibold">{u?.full_name}</p>
          <p className="text-[14px] text-bark">{u?.username} · {u?.tenant_name}</p>
          {u?.staff && <p className="text-[14px] mt-1">{label(u.staff.staff_type === 'DOCTOR' ? 'Dokter' : u.staff.staff_type === 'NURSE' ? 'Perawat' : u.staff.staff_type)}</p>}
        </div>
        <div className="card p-5">
          <div className="flex items-center justify-between gap-2">
            <div><p className="text-[13px] text-bark">Klinik aktif</p><p className="font-medium">{clinic?.name ?? '—'}</p></div>
            {clinics.length > 1 && <div className="text-ink"><ClinicSwitcher /></div>}
          </div>
          <p className="text-[13px] text-bark mt-3">Peran</p>
          <ul className="text-[14px]">{me?.roles.map((r, i) => <li key={i}>{r.name} · {r.scope_name}</li>)}</ul>
        </div>
        <div className="card p-5">
          <p className="text-[13px] text-bark">Server</p>
          <p className="font-medium break-all">{server.url}</p>
          <button className="btn-secondary btn-sm mt-3" onClick={onChangeServer}><Server className="w-4 h-4" />Ganti server</button>
        </div>
        <p className="text-[13px] text-bark px-1">Fitur lain (farmasi, MCU, K3, laporan, administrasi) tersedia di aplikasi web Palmora Health.</p>
        <button className="btn-secondary w-full text-sev-critical" onClick={logout}><LogOut className="w-5 h-5" />Keluar</button>
        <p className="text-center text-[12.5px] text-bark-400">Palmora Health mobile · versi {__APP_VERSION__}</p>
      </div>
    </div>
  );
}
