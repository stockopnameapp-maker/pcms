import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, Ambulance, BarChart3, Bell, Boxes, Building2, ChevronDown, ChevronRight, ClipboardList, FileBarChart, FlaskConical, HardHat,
  HeartPulse, LogOut, Menu, Pill, Search, Settings2, ShieldCheck, Stethoscope, User, Users, Wallet, X, FileText, Database, Home,
} from 'lucide-react';
import { api } from '../lib/api';
import { fmtRelative, label } from '../lib/format';
import { Scope, useSession } from '../lib/session';
import { Status, cx } from './ui';

type Item = { to: string; label: string; perm?: [string, string?] | ((can: (m: string, a?: string) => boolean, me: any) => boolean) };
type Section = { title: string; icon: any; items: Item[] };

export const NAV: Section[] = [
  { title: 'Ringkasan', icon: BarChart3, items: [
    { to: '/dashboard', label: 'Dashboard', perm: ['DASHBOARD'] },
    { to: '/alerts', label: 'Early warning', perm: (c) => c('ALERT') || c('DASHBOARD') },
    { to: '/portal', label: 'Portal kesehatan saya', perm: (_c, me) => !!me?.user.employee_id },
  ] },
  { title: 'Pelayanan', icon: Stethoscope, items: [
    { to: '/queue', label: 'Antrian & registrasi', perm: ['QUEUE'] },
    { to: '/r/patients', label: 'Pasien', perm: ['PATIENT'] },
    { to: '/r/encounters', label: 'Rekam medis', perm: ['EMR'] },
    { to: '/r/appointments', label: 'Janji temu', perm: ['APPOINTMENT'] },
    { to: '/lab', label: 'Laboratorium', perm: ['LAB'] },
    { to: '/r/referrals', label: 'Rujukan', perm: ['REFERRAL'] },
    { to: '/r/inpatients', label: 'Rawat inap', perm: ['EMR'] },
  ] },
  { title: 'Farmasi & stok', icon: Pill, items: [
    { to: '/pharmacy/dispense', label: 'Resep masuk', perm: ['PHARMACY'] },
    { to: '/pharmacy/stock', label: 'Stok obat', perm: ['INVENTORY'] },
    { to: '/r/stock-transfers', label: 'Transfer antar klinik', perm: ['INVENTORY'] },
    { to: '/r/purchase-orders', label: 'Purchase order', perm: ['INVENTORY'] },
    { to: '/r/stock-opnames', label: 'Stock opname', perm: ['INVENTORY'] },
    { to: '/r/medicine-batches', label: 'Batch & kedaluwarsa', perm: ['INVENTORY'] },
    { to: '/r/inventory-transactions', label: 'Mutasi stok', perm: ['INVENTORY'] },
    { to: '/r/inventory-levels', label: 'Stok minimum', perm: ['INVENTORY'] },
  ] },
  { title: 'Kesehatan kerja', icon: HeartPulse, items: [
    { to: '/occ-health', label: 'Kepatuhan MCU & kelaikan', perm: ['OCC_HEALTH'] },
    { to: '/r/mcu', label: 'Medical check up', perm: ['OCC_HEALTH'] },
    { to: '/r/health-assessments', label: 'Penilaian kelaikan', perm: ['OCC_HEALTH'] },
  ] },
  { title: 'K3', icon: HardHat, items: [{ to: '/r/accidents', label: 'Kecelakaan & insiden', perm: ['ACCIDENT'] }] },
  { title: 'Administrasi medis', icon: FileText, items: [
    { to: '/r/sick-leaves', label: 'Surat sakit', perm: ['SICK_LEAVE'] },
    { to: '/r/medical-certificates', label: 'Surat keterangan', perm: ['SICK_LEAVE'] },
  ] },
  { title: 'Ambulans', icon: Ambulance, items: [
    { to: '/ambulance', label: 'Armada & dispatch', perm: ['AMBULANCE'] },
    { to: '/r/ambulance-trips', label: 'Perjalanan', perm: ['AMBULANCE'] },
    { to: '/r/ambulance-maintenance', label: 'Perawatan kendaraan', perm: ['AMBULANCE'] },
    { to: '/r/ambulance-fuel', label: 'BBM', perm: ['AMBULANCE'] },
  ] },
  { title: 'SDM', icon: Users, items: [
    { to: '/r/employees', label: 'Karyawan', perm: ['EMPLOYEE'] },
    { to: '/r/family-members', label: 'Keluarga karyawan', perm: ['EMPLOYEE'] },
  ] },
  { title: 'Keuangan', icon: Wallet, items: [
    { to: '/finance', label: 'Analitik biaya medis', perm: (c) => c('FINANCE') || c('DASHBOARD') },
    { to: '/r/costs', label: 'Transaksi biaya', perm: ['FINANCE'] },
  ] },
  { title: 'Laporan', icon: FileBarChart, items: [{ to: '/reports', label: 'Pusat laporan', perm: (c) => ['REPORT', 'DASHBOARD', 'QUEUE', 'INVENTORY', 'OCC_HEALTH', 'ACCIDENT', 'SICK_LEAVE', 'EMPLOYEE', 'FINANCE'].some((m) => c(m)) }] },
  { title: 'Organisasi', icon: Building2, items: [
    { to: '/org', label: 'Struktur organisasi', perm: ['ORGANIZATION'] },
    { to: '/r/clinics', label: 'Klinik', perm: ['CLINIC'] },
    { to: '/r/medical-staff', label: 'Tenaga medis', perm: ['CLINIC'] },
    { to: '/r/staff-schedules', label: 'Jadwal praktik', perm: ['CLINIC'] },
    { to: '/r/clinic-rooms', label: 'Ruangan', perm: ['CLINIC'] },
    { to: '/r/clinic-beds', label: 'Tempat tidur', perm: ['CLINIC'] },
    { to: '/r/clinic-assets', label: 'Alat medis & aset', perm: ['CLINIC'] },
  ] },
  { title: 'Master data', icon: Database, items: [
    { to: '/r/medicines', label: 'Katalog obat', perm: (c) => c('MASTER_DATA') || c('PHARMACY') || c('INVENTORY') },
    { to: '/r/medicine-categories', label: 'Kategori obat', perm: ['MASTER_DATA'] },
    { to: '/r/suppliers', label: 'Supplier', perm: (c) => c('MASTER_DATA') || c('INVENTORY') },
    { to: '/r/hospitals', label: 'Rumah sakit rujukan', perm: (c) => c('MASTER_DATA') || c('REFERRAL') },
    { to: '/r/lab-tests', label: 'Pemeriksaan lab', perm: (c) => c('MASTER_DATA') || c('LAB') },
    { to: '/r/job-positions', label: 'Jabatan', perm: (c) => c('MASTER_DATA') || c('EMPLOYEE') },
    { to: '/r/risk-categories', label: 'Kategori risiko kerja', perm: (c) => c('MASTER_DATA') || c('OCC_HEALTH') },
  ] },
  { title: 'Sistem', icon: ShieldCheck, items: [
    { to: '/admin/users', label: 'Pengguna', perm: ['USER_ADMIN'] },
    { to: '/admin/roles', label: 'Role & izin', perm: ['USER_ADMIN'] },
    { to: '/r/role-assignments', label: 'Penugasan role', perm: ['USER_ADMIN'] },
    { to: '/audit', label: 'Audit trail', perm: ['AUDIT'] },
    { to: '/r/break-glass', label: 'Akses darurat', perm: ['AUDIT'] },
  ] },
];

function allowed(item: Item, can: any, me: any) {
  if (!item.perm) return true;
  if (typeof item.perm === 'function') return item.perm(can, me);
  return can(item.perm[0], item.perm[1] ?? 'READ');
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can, me } = useSession();
  const loc = useLocation();
  const sections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => allowed(i, can, me)) })).filter((s) => s.items.length);
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(sections.map((s) => [s.title, true])));
  return (
    <nav className="flex flex-col h-full" aria-label="Navigasi utama">
      <Link to="/" className="flex items-center gap-2.5 px-4 h-14 shrink-0 border-b border-white/10" onClick={onNavigate}>
        <img src="/favicon.svg" className="w-8 h-8" alt="" />
        <span className="leading-tight"><span className="block font-semibold text-white text-[15px] tracking-tight">PCMS</span>
          <span className="block text-[11.5px] text-canopy-300/80">{me?.user.tenant_name}</span></span>
      </Link>
      <div className="flex-1 overflow-y-auto scrollbar-thin py-3 px-2 space-y-1">
        {sections.map((s) => (
          <div key={s.title}>
            <button className="w-full flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-canopy-300/90 hover:text-white" onClick={() => setOpen((o) => ({ ...o, [s.title]: !o[s.title] }))} aria-expanded={open[s.title]}>
              <s.icon className="w-4 h-4" /><span className="flex-1 text-left">{s.title}</span>
              <ChevronDown className={cx('w-3.5 h-3.5 transition-transform', !open[s.title] && '-rotate-90')} />
            </button>
            {open[s.title] && (
              <ul className="mb-2">
                {s.items.map((i) => {
                  const active = loc.pathname === i.to || (i.to !== '/' && loc.pathname.startsWith(i.to + '/'));
                  return (
                    <li key={i.to}>
                      <NavLink to={i.to} onClick={onNavigate}
                        className={cx('block ml-6 pl-3 pr-2 py-1.5 rounded-md text-[13.5px] border-l-2', active ? 'bg-white/10 text-white border-kernel' : 'text-white/75 border-transparent hover:text-white hover:bg-white/5')}>
                        {i.label}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </nav>
  );
}

const TYPE_NAME: Record<string, string> = { GROUP: 'Grup', COMPANY: 'PT', REGION: 'Region', ESTATE: 'Kebun', MILL: 'Pabrik', CLINIC: 'Klinik', WAREHOUSE: 'Gudang' };

/** The organisational lineage — Grup › PT › Region › Kebun › Klinik — every screen follows it. */
function ScopeBar() {
  const { me, scope, scopeChain, setScope } = useSession();
  const [menu, setMenu] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  if (!me || !scope) return null;
  const scopes = me.scopes;
  const children = (id: string | null) => scopes.filter((s) => s.parent_id === id);
  const roots = scopes.filter((s) => !scopes.some((p) => p.id === s.parent_id));
  const levels: { current?: Scope; options: Scope[]; key: string }[] = scopeChain.map((s, i) => ({ current: s, options: i === 0 ? roots : children(scopeChain[i - 1].id), key: s.id }));
  const kids = children(scope.id);
  if (kids.length) levels.push({ options: kids, key: 'next' });
  return (
    <div ref={ref} className="flex items-center gap-0.5 min-w-0 overflow-x-auto scrollbar-thin" aria-label="Cakupan organisasi">
      {levels.map((l, i) => (
        <div key={l.key} className="relative flex items-center shrink-0">
          {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-bark-400 mx-0.5" />}
          <button onClick={() => setMenu(menu === l.key ? null : l.key)} disabled={l.options.length <= 1 && !!l.current}
            className={cx('flex flex-col items-start px-2 py-1 rounded-md text-left hover:bg-canopy-50 disabled:hover:bg-transparent disabled:cursor-default',
              l.current?.id === scope.id && 'bg-kernel-50 ring-1 ring-kernel-100')}>
            <span className="text-[10.5px] leading-3 text-bark">{l.current ? TYPE_NAME[l.current.unit_type] ?? label(l.current.unit_type) : 'Telusuri'}</span>
            <span className={cx('text-[13px] leading-4 whitespace-nowrap max-w-[200px] truncate', l.current ? 'font-medium text-ink' : 'text-canopy-700')}>
              {l.current ? l.current.name : `${l.options.length} unit`}{(l.options.length > 1 || !l.current) && <ChevronDown className="inline w-3 h-3 ml-0.5 text-bark-400" />}
            </span>
          </button>
          {menu === l.key && (
            <ul className="absolute left-0 top-full mt-1 z-40 min-w-[240px] max-h-80 overflow-y-auto bg-white border border-line rounded-md shadow-pop py-1">
              {l.options.map((o) => (
                <li key={o.id}><button className={cx('w-full text-left px-3 py-1.5 hover:bg-canopy-50 text-[13.5px]', o.id === l.current?.id && 'font-medium text-canopy-700')}
                  onClick={() => { setScope(o.id); setMenu(null); }}>
                  {o.name}<span className="block text-[11.5px] text-bark">{TYPE_NAME[o.unit_type] ?? o.unit_type} · {o.code}</span>
                </button></li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [d, setD] = useState('');
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setD(q), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); ref.current?.querySelector('input')?.focus(); } };
    document.addEventListener('mousedown', h); window.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, []);
  const r = useQuery({ queryKey: ['search', d], queryFn: () => api.get('/search', { q: d }), enabled: d.length >= 2 });
  return (
    <div ref={ref} className="relative w-full max-w-[340px]">
      <Search className="w-4 h-4 absolute left-3 top-2.5 text-bark-400" />
      <input className="input pl-9 pr-12 bg-mist border-transparent focus:bg-white" placeholder="Cari pasien, karyawan, obat…" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} aria-label="Pencarian global" />
      <kbd className="absolute right-2.5 top-2 text-[11px] text-bark-400 border border-line rounded px-1 hidden sm:block">Ctrl K</kbd>
      {open && d.length >= 2 && (
        <div className="absolute z-40 mt-1 w-[min(480px,90vw)] right-0 sm:left-0 bg-white border border-line rounded-md shadow-pop max-h-[70vh] overflow-y-auto">
          {r.isLoading && <p className="px-4 py-3 text-bark text-[13px]">Mencari…</p>}
          {r.data?.data.length === 0 && <p className="px-4 py-3 text-bark text-[13px]">Tidak ada hasil dalam cakupan akses Anda.</p>}
          {r.data?.data.map((s: any) => (
            <div key={s.type} className="py-1 border-b border-line last:border-0">
              <p className="px-4 pt-1.5 pb-1 text-[12px] font-medium text-canopy-700">{s.label}</p>
              {s.items.map((i: any) => (
                <button key={i.id} className="w-full text-left px-4 py-1.5 hover:bg-canopy-50" onClick={() => { setOpen(false); setQ(''); nav(i.url); }}>
                  <span className="block text-[13.5px]">{i.title}</span><span className="block text-[12px] text-bark">{i.subtitle}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const n = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/notifications', { limit: 30 }), refetchInterval: 30_000 });
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const unread = n.data?.unread ?? 0;
  return (
    <div ref={ref} className="relative">
      <button className="btn-ghost relative" onClick={() => setOpen((o) => !o)} aria-label={`Notifikasi, ${unread} belum dibaca`}>
        <Bell className="w-5 h-5" />
        {unread > 0 && <span className="absolute top-1 right-1.5 min-w-[17px] h-[17px] px-1 rounded-full bg-sev-critical text-white text-[10.5px] leading-[17px] text-center num">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-40 w-[min(420px,92vw)] bg-white border border-line rounded-md shadow-pop">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
            <span className="font-semibold">Notifikasi</span>
            <button className="btn-ghost btn-sm" disabled={!unread} onClick={async () => { await api.post('/notifications/read-all'); qc.invalidateQueries({ queryKey: ['notifications'] }); }}>Tandai semua dibaca</button>
          </div>
          <ul className="max-h-[60vh] overflow-y-auto divide-y divide-line">
            {n.data?.data.length === 0 && <li className="px-4 py-6 text-center text-bark text-[13px]">Tidak ada notifikasi</li>}
            {n.data?.data.map((x: any) => (
              <li key={x.id}>
                <button className={cx('w-full text-left px-4 py-2.5 hover:bg-canopy-50 flex gap-3', !x.read_at && 'bg-kernel-50/50')}
                  onClick={async () => { setOpen(false); if (!x.read_at) { await api.post(`/notifications/${x.id}/read`); qc.invalidateQueries({ queryKey: ['notifications'] }); } if (x.action_url) nav(x.action_url.startsWith('/accidents/') ? `/r/accidents?id=${x.entity_id}` : x.action_url.startsWith('/referrals/') ? `/r/referrals?id=${x.entity_id}` : x.action_url.startsWith('/alerts') ? '/alerts' : x.action_url.startsWith('/pharmacy/transfers') ? `/pharmacy/transfers/${x.entity_id}` : x.action_url.startsWith('/emr/') ? x.action_url : x.action_url.startsWith('/sick-leave') ? '/r/sick-leaves' : x.action_url.startsWith('/occ-health') ? '/occ-health' : x.action_url.startsWith('/audit') ? '/r/break-glass' : x.action_url); }}>
                  <span className={cx('mt-1.5 w-2 h-2 rounded-full shrink-0', { LOW: 'bg-sev-low', MEDIUM: 'bg-sev-medium', HIGH: 'bg-sev-high', CRITICAL: 'bg-sev-critical' }[x.severity as string])} />
                  <span className="min-w-0">
                    <span className={cx('block text-[13.5px]', !x.read_at && 'font-medium')}>{x.title}</span>
                    {x.body && <span className="block text-[12.5px] text-bark line-clamp-2">{x.body}</span>}
                    <span className="block text-[11.5px] text-bark-400 mt-0.5">{fmtRelative(x.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  if (!me) return null;
  const initials = me.user.full_name.replace(/^(dr|apt|Ns)\.?\s+/i, '').split(' ').slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-canopy-50" onClick={() => setOpen((o) => !o)} aria-label="Menu pengguna">
        <span className="w-8 h-8 rounded-full bg-canopy-700 text-white grid place-items-center text-[12.5px] font-semibold">{initials}</span>
        <span className="hidden md:block text-left leading-tight"><span className="block text-[13px] font-medium max-w-[160px] truncate">{me.user.full_name}</span>
          <span className="block text-[11.5px] text-bark max-w-[160px] truncate">{me.roles.map((r) => r.name).join(', ')}</span></span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-40 w-72 bg-white border border-line rounded-md shadow-pop py-1">
          <div className="px-4 py-2 border-b border-line">
            <p className="font-medium">{me.user.full_name}</p><p className="text-[12.5px] text-bark">{me.user.username}</p>
            <ul className="mt-2 space-y-1">{me.roles.map((r) => <li key={r.code + r.scope_id} className="text-[12px] text-bark-700"><span className="font-medium">{r.name}</span> · {r.scope_name}</li>)}</ul>
          </div>
          <Link to="/profile" className="flex items-center gap-2 px-4 py-2 hover:bg-canopy-50 text-[13.5px]" onClick={() => setOpen(false)}><User className="w-4 h-4" />Profil & keamanan akun</Link>
          <button className="w-full flex items-center gap-2 px-4 py-2 hover:bg-canopy-50 text-[13.5px] text-red-700" onClick={logout}><LogOut className="w-4 h-4" />Keluar</button>
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const [mobile, setMobile] = useState(false);
  const { me } = useSession();
  // portal-only accounts (employee self-service) have no organisational scope to switch or records to search
  const staffUser = Object.keys(me?.permissions ?? {}).some((m) => m !== 'NOTIFICATION');
  const loc = useLocation();
  useEffect(() => setMobile(false), [loc.pathname]);
  return (
    <div className="min-h-screen lg:pl-[248px]">
      <aside className="hidden lg:block fixed inset-y-0 left-0 w-[248px] bg-canopy text-white z-30"><Sidebar /></aside>
      {mobile && (
        <div className="lg:hidden fixed inset-0 z-50 bg-canopy-900/40" onClick={() => setMobile(false)}>
          <aside className="w-[270px] h-full bg-canopy text-white" onClick={(e) => e.stopPropagation()}><Sidebar onNavigate={() => setMobile(false)} /></aside>
        </div>
      )}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-line">
        <div className="flex items-center gap-3 px-3 sm:px-5 h-14">
          <button className="lg:hidden btn-ghost" onClick={() => setMobile(true)} aria-label="Buka menu"><Menu className="w-5 h-5" /></button>
          <div className="flex-1 min-w-0 hidden md:block">{staffUser && <ScopeBar />}</div>
          <div className="flex-1 md:flex-none flex justify-end">{staffUser && <GlobalSearch />}</div>
          <Notifications />
          <UserMenu />
        </div>
        {staffUser && <div className="md:hidden px-3 pb-2"><ScopeBar /></div>}
      </header>
      <main className="px-3 sm:px-6 py-5 max-w-[1500px] mx-auto"><Outlet /></main>
    </div>
  );
}
