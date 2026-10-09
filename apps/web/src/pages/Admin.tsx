import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, KeyRound, Pencil, Plus, Save, Trash2, Unlock, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, fmtNum, label } from '../lib/format';
import { useResourceMeta } from '../lib/meta';
import { useSession } from '../lib/session';
import { RefSelect } from '../components/RefSelect';
import { ResourceForm } from '../components/ResourceForm';
import { ResourcePage } from '../components/ResourcePage';
import { Pager } from '../components/DataTable';
import { Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Panel, Status, Tag, cx, useToast } from '../components/ui';

// ====================================================================== AUDIT TRAIL
const ACTIONS = ['INSERT', 'UPDATE', 'SOFT_DELETE', 'RESTORE', 'DELETE', 'VIEW', 'EXPORT', 'PRINT', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'BREAK_GLASS', 'APPROVE', 'STATUS_CHANGE'];
const ACTION_TONE: Record<string, any> = { INSERT: 'green', UPDATE: 'blue', SOFT_DELETE: 'red', DELETE: 'red', BREAK_GLASS: 'red', LOGIN_FAILED: 'amber', EXPORT: 'amber', PRINT: 'amber', APPROVE: 'green' };

function short(v: any) {
  if (v === null || v === undefined) return '∅';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

export function Audit() {
  const [f, setF] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const set = (k: string, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const q = useQuery({ queryKey: ['audit', f, page], queryFn: () => api.get('/audit', { ...f, page, pageSize: 50 }), placeholderData: (p) => p });
  return (
    <div className="space-y-5">
      <PageHeader title="Audit trail" description="Catatan tidak dapat diubah atau dihapus. Mencakup perubahan data, akses rekam medis, ekspor, cetak, login dan akses darurat." />
      <div className="panel p-4 grid sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
        <Field label="Cari pengguna / tabel / catatan" className="lg:col-span-2"><input className="input" value={f.q ?? ''} onChange={(e) => set('q', e.target.value)} placeholder="mis. dr.budi atau encounter" /></Field>
        <Field label="Aksi"><select className="input" value={f.action ?? ''} onChange={(e) => set('action', e.target.value)}><option value="">Semua</option>{ACTIONS.map((a) => <option key={a} value={a}>{label(a)}</option>)}</select></Field>
        <Field label="Pengguna"><RefSelect kind="app_user" value={f.userId || null} onChange={(v) => set('userId', v ?? '')} /></Field>
        <Field label="Dari"><input type="date" className="input" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} /></Field>
        <Field label="Sampai"><input type="date" className="input" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} /></Field>
      </div>
      <Panel bodyClass="p-0">
        {q.isLoading ? <Loading /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !q.data.data.length ? <Empty title="Tidak ada catatan audit untuk filter ini" /> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th className="w-6" /><th>Waktu</th><th>Pengguna</th><th>Aksi</th><th>Modul</th><th>Objek</th><th>Keterangan</th><th>IP</th></tr></thead>
              <tbody>{q.data.data.map((r: any) => (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td>{open === r.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4 text-bark" />}</td>
                    <td className="num whitespace-nowrap">{fmtDateTime(r.occurred_at)}</td>
                    <td>{r.full_name ?? <span className="text-bark">sistem</span>}<span className="block text-[12px] text-bark">{r.username}</span></td>
                    <td><Tag tone={ACTION_TONE[r.action] ?? 'gray'}>{label(r.action)}</Tag></td>
                    <td>{r.module ?? '–'}</td>
                    <td className="text-[12.5px]">{r.table_name ?? '–'}{r.record_id && <span className="block text-bark num">{String(r.record_id).slice(0, 8)}</span>}</td>
                    <td className="max-w-[320px] truncate">{r.note ?? (r.changed_fields?.length ? `${r.changed_fields.length} kolom: ${r.changed_fields.slice(0, 4).join(', ')}` : '')}</td>
                    <td className="num text-[12.5px]">{r.ip_address ?? '–'}</td>
                  </tr>
                  {open === r.id && (
                    <tr><td /><td colSpan={7} className="bg-mist">
                      <KV items={[['Record ID', <span className="num">{r.record_id ?? '–'}</span>], ['User agent', <span className="text-[12px]">{r.user_agent ?? '–'}</span>]]} />
                      {r.changed_fields?.length ? (
                        <table className="mt-3 text-[12.5px] w-full"><thead><tr className="text-bark"><th className="text-left py-1 pr-3 font-medium">Kolom</th><th className="text-left pr-3 font-medium">Sebelum</th><th className="text-left font-medium">Sesudah</th></tr></thead>
                          <tbody>{r.changed_fields.map((c: string) => (
                            <tr key={c} className="border-t border-line"><td className="py-1 pr-3 font-medium">{c}</td><td className="pr-3 text-red-800 break-all">{short(r.old_values?.[c])}</td><td className="text-canopy-800 break-all">{short(r.new_values?.[c])}</td></tr>))}</tbody></table>
                      ) : r.new_values && r.action === 'INSERT' ? <p className="mt-2 text-[12px] text-bark break-all">{short(r.new_values)}</p> : null}
                    </td></tr>
                  )}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        )}
        {q.data && <Pager page={page} pageSize={50} total={Number(q.data.total)} onPage={setPage} />}
      </Panel>
    </div>
  );
}

// ====================================================================== ORGANISATION TREE
const TYPE_TONE: Record<string, any> = { GROUP: 'green', COMPANY: 'blue', REGION: 'gray', ESTATE: 'amber', MILL: 'amber', DIVISION: 'gray', CLINIC: 'green', WAREHOUSE: 'blue', DEPARTMENT: 'gray' };

export function OrgTree() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { resource } = useResourceMeta('org-units');
  const q = useQuery({ queryKey: ['org-tree'], queryFn: () => api.get('/org/tree') });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState<null | { mode: 'create' | 'update'; initial?: any; presets?: any }>(null);
  const [sp] = useSearchParams();
  useEffect(() => {
    const f = sp.get('focus'); const rows: any[] = q.data?.data ?? [];
    if (!f || !rows.length) return;
    const byId = new Map(rows.map((r) => [r.id, r])); const open = new Set<string>();
    for (let x: any = byId.get(f); x?.parent_id; x = byId.get(x.parent_id)) open.add(x.parent_id);
    setExpanded(open); setSel(f);
  }, [sp, q.data]);

  const { roots, children, byId } = useMemo(() => {
    const rows: any[] = q.data?.data ?? [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const children = new Map<string, any[]>();
    const roots: any[] = [];
    for (const r of rows) { if (r.parent_id && byId.has(r.parent_id)) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]); else roots.push(r); }
    return { roots, children, byId };
  }, [q.data]);

  const matches = useMemo(() => {
    if (!filter.trim()) return null;
    const t = filter.toLowerCase(); const keep = new Set<string>();
    for (const r of byId.values()) if (r.name.toLowerCase().includes(t) || r.code.toLowerCase().includes(t)) { for (let x: any = r; x; x = x.parent_id ? byId.get(x.parent_id) : null) keep.add(x.id); }
    return keep;
  }, [filter, byId]);

  const total = (id: string): number => (children.get(id) ?? []).reduce((s, c) => s + Number(c.employees) + total(c.id), 0);
  const selected = sel ? byId.get(sel) : null;
  const allowedChildren = selected ? (q.data?.rules ?? []).filter((r: any) => r.parent_type === selected.unit_type).map((r: any) => r.child_type) : [];

  async function edit(id: string) {
    try { const r = await api.get(`/r/org-units/${id}`); setForm({ mode: 'update', initial: r.data }); } catch (e: any) { toast('error', e.message); }
  }

  function Node({ n, level }: { n: any; level: number }) {
    if (matches && !matches.has(n.id)) return null;
    const kids = children.get(n.id) ?? [];
    const isOpen = expanded.has(n.id) || !!matches || level < 1;
    return (
      <li>
        <div className={cx('flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer', sel === n.id ? 'bg-canopy-600 text-white' : 'hover:bg-canopy-50')} style={{ paddingLeft: level * 18 + 4 }}
          onClick={() => setSel(n.id)}>
          <button className="w-5 h-5 grid place-items-center" aria-label={isOpen ? 'Tutup' : 'Buka'} onClick={(e) => { e.stopPropagation(); setExpanded((s) => { const x = new Set(s); x.has(n.id) ? x.delete(n.id) : x.add(n.id); return x; }); }}>
            {kids.length ? (isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />) : null}
          </button>
          <span className="flex-1 truncate text-[13.5px]">{n.name}</span>
          <span className={cx('text-[11px] num', sel === n.id ? 'text-white/80' : 'text-bark')}>{label(n.unit_type)}</span>
          {n.status !== 'ACTIVE' && <Status value={n.status} />}
        </div>
        {isOpen && kids.length > 0 && <ul>{kids.map((k) => <Node key={k.id} n={k} level={level + 1} />)}</ul>}
      </li>
    );
  }

  if (q.isLoading) return <Loading />;
  return (
    <div className="space-y-5">
      <PageHeader title="Struktur organisasi" description="Hierarki dinamis Group → PT → Region → Kebun/Pabrik → Divisi → Klinik. Aturan induk-anak dikelola sebagai data dan divalidasi di basis data." />
      <ErrorBox error={q.error} />
      <div className="grid lg:grid-cols-[minmax(320px,440px)_1fr] gap-5 items-start">
        <Panel title={`${fmtNum(byId.size)} unit`} bodyClass="p-2">
          <input className="input mb-2" placeholder="Cari unit atau kode…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="max-h-[68vh] overflow-y-auto scrollbar-thin">{roots.map((r) => <Node key={r.id} n={r} level={0} />)}</ul>
        </Panel>
        {!selected ? <Empty title="Pilih unit di pohon organisasi" hint="Detail unit, sub-unit dan aksi pengelolaan akan tampil di sini." /> : (
          <Panel title={selected.name} actions={<div className="flex gap-2">
            {can('ORGANIZATION', 'UPDATE') && <button className="btn-secondary btn-sm" onClick={() => edit(selected.id)}><Pencil className="w-3.5 h-3.5" />Ubah</button>}
            {can('ORGANIZATION', 'CREATE') && allowedChildren.length > 0 && <button className="btn-primary btn-sm" onClick={() => setForm({ mode: 'create', presets: { parent_id: selected.id, unit_type: allowedChildren[0] } })}><Plus className="w-3.5 h-3.5" />Sub-unit</button>}
          </div>}>
            <KV items={[
              ['Kode', <span className="num">{selected.code}</span>], ['Tipe', <Tag tone={TYPE_TONE[selected.unit_type]}>{label(selected.unit_type)}</Tag>],
              ['Induk', selected.parent_id ? byId.get(selected.parent_id)?.name ?? '–' : '— (puncak hierarki)'], ['Kota', selected.city ?? '–'],
              ['Karyawan langsung', fmtNum(selected.employees)], ['Karyawan termasuk sub-unit', fmtNum(Number(selected.employees) + total(selected.id))],
              ['Status', <Status value={selected.status} />], ...(selected.operational_status ? [['Status klinik', <Status value={selected.operational_status} />] as [string, any]] : []),
              ['Sub-unit yang diizinkan', allowedChildren.length ? allowedChildren.map((t: string) => label(t)).join(', ') : 'Tidak ada'],
            ]} />
            <h3 className="font-cond font-semibold text-[15px] mt-5 mb-2">Sub-unit ({(children.get(selected.id) ?? []).length})</h3>
            {(children.get(selected.id) ?? []).length ? (
              <table className="tbl"><thead><tr><th>Kode</th><th>Nama</th><th>Tipe</th><th className="text-right">Karyawan</th><th>Status</th></tr></thead>
                <tbody>{(children.get(selected.id) ?? []).map((c) => (
                  <tr key={c.id} className="cursor-pointer" onClick={() => { setSel(c.id); setExpanded((s) => new Set(s).add(selected.id)); }}>
                    <td className="num">{c.code}</td><td>{c.name}</td><td><Tag tone={TYPE_TONE[c.unit_type]}>{label(c.unit_type)}</Tag></td>
                    <td className="text-right num">{fmtNum(Number(c.employees) + total(c.id))}</td><td><Status value={c.operational_status ?? c.status} /></td></tr>))}</tbody></table>
            ) : <p className="text-bark text-[13px]">Belum ada sub-unit.</p>}
          </Panel>
        )}
      </div>
      {form && resource && (
        <Modal open onClose={() => setForm(null)} title={form.mode === 'create' ? 'Tambah unit organisasi' : `Ubah ${form.initial?.name}`} size="lg">
          <ResourceForm resource={resource} mode={form.mode} initial={form.initial} presets={form.presets} onCancel={() => setForm(null)}
            onSaved={(row) => { setForm(null); toast('ok', 'Unit organisasi tersimpan'); qc.invalidateQueries({ queryKey: ['org-tree'] }); qc.invalidateQueries({ queryKey: ['me'] }); if (row?.id) setSel(row.id); }} />
        </Modal>
      )}
    </div>
  );
}

// ====================================================================== USERS
export const PW_HINT = 'Minimal 10 karakter dengan minimal 3 jenis: huruf kecil, huruf besar, angka, simbol.';
export function pwOk(p: string) { return p.length >= 10 && [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3; }

function CreateUser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const [v, setV] = useState<any>({ username: '', fullName: '', email: '', phone: '', homeUnitId: null, password: '', employeeId: null });
  const [roles, setRoles] = useState<{ roleId: string | null; scopeUnitId: string | null }[]>([{ roleId: null, scopeUnitId: null }]);
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const errs: Record<string, string> = {};
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(v.username)) errs.username = '3–50 karakter: huruf, angka, titik, minus, garis bawah';
  if (v.fullName.trim().length < 2) errs.fullName = 'Wajib diisi';
  if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errs.email = 'Format email tidak valid';
  if (!v.homeUnitId) errs.homeUnitId = 'Wajib dipilih';
  if (!pwOk(v.password)) errs.password = PW_HINT;
  const [touched, setTouched] = useState(false);
  const set = (k: string) => (e: any) => setV((s: any) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  async function save() {
    setTouched(true); if (Object.keys(errs).length) return;
    setBusy(true); setErr(null);
    try {
      await api.post('/admin/users', { ...v, email: v.email || undefined, phone: v.phone || undefined, employeeId: v.employeeId || undefined,
        roles: roles.filter((r) => r.roleId && r.scopeUnitId) });
      toast('ok', `Akun ${v.username} dibuat. Pengguna wajib mengganti password saat login pertama.`);
      qc.invalidateQueries({ queryKey: ['resource', 'users'] }); qc.invalidateQueries(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const e = (k: string) => (touched ? errs[k] : undefined);
  return (
    <Modal open={open} onClose={onClose} title="Buat akun pengguna" size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className="btn-primary" disabled={busy} onClick={save}><UserPlus className="w-4 h-4" />Buat akun</button></>}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Username" required error={e('username')}><input className="input" value={v.username} onChange={set('username')} autoComplete="off" /></Field>
        <Field label="Nama lengkap" required error={e('fullName')}><input className="input" value={v.fullName} onChange={set('fullName')} /></Field>
        <Field label="Email" error={e('email')}><input className="input" type="email" value={v.email} onChange={set('email')} /></Field>
        <Field label="Telepon"><input className="input" value={v.phone} onChange={set('phone')} /></Field>
        <Field label="Unit asal" required error={e('homeUnitId')}><RefSelect kind="org_unit" value={v.homeUnitId} onChange={set('homeUnitId')} invalid={!!e('homeUnitId')} /></Field>
        <Field label="Karyawan terkait (untuk portal)"><RefSelect kind="employee" value={v.employeeId} onChange={set('employeeId')} /></Field>
        <Field label="Password awal" required error={e('password')} hint={!e('password') ? PW_HINT : undefined} className="sm:col-span-2"><input className="input" type="text" value={v.password} onChange={set('password')} autoComplete="new-password" /></Field>
      </div>
      <h3 className="font-cond font-semibold text-[15px] mt-5 mb-2">Role & cakupan</h3>
      <p className="text-[12.5px] text-bark mb-2">Setiap role berlaku untuk unit yang dipilih beserta seluruh sub-unitnya.</p>
      {roles.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-2">
          <RefSelect kind="role" value={r.roleId} onChange={(x) => setRoles((s) => s.map((y, j) => (j === i ? { ...y, roleId: x } : y)))} placeholder="Role" />
          <RefSelect kind="org_unit" value={r.scopeUnitId} onChange={(x) => setRoles((s) => s.map((y, j) => (j === i ? { ...y, scopeUnitId: x } : y)))} placeholder="Cakupan unit" />
          <button className="btn-ghost btn-sm" aria-label="Hapus role" onClick={() => setRoles((s) => s.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>
        </div>))}
      <button className="btn-ghost btn-sm" onClick={() => setRoles((s) => [...s, { roleId: null, scopeUnitId: null }])}><Plus className="w-3.5 h-3.5" />Tambah role</button>
      <ErrorBox error={err} />
    </Modal>
  );
}

function AccountTools({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const [user, setUser] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<any>(null);
  const run = async (fn: () => Promise<any>, msg: string) => { setErr(null); try { await fn(); toast('ok', msg); qc.invalidateQueries(); onClose(); } catch (e) { setErr(e); } };
  return (
    <Modal open={open} onClose={onClose} title="Reset password / buka kunci akun" size="sm">
      <Field label="Pengguna"><RefSelect kind="app_user" value={user} onChange={setUser} /></Field>
      <div className="mt-4 p-3 rounded border border-line">
        <p className="text-[13px] font-medium mb-1">Buka kunci</p>
        <p className="text-[12.5px] text-bark mb-2">Mengosongkan hitungan login gagal dan status terkunci.</p>
        <button className="btn-secondary btn-sm" disabled={!user} onClick={() => run(() => api.post(`/admin/users/${user}/unlock`), 'Akun dibuka')}><Unlock className="w-3.5 h-3.5" />Buka kunci</button>
      </div>
      <div className="mt-3 p-3 rounded border border-line">
        <p className="text-[13px] font-medium mb-1">Reset password</p>
        <p className="text-[12.5px] text-bark mb-2">Semua sesi aktif pengguna dicabut dan pengguna wajib mengganti password saat login.</p>
        <input className="input" placeholder="Password sementara" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        {pw && !pwOk(pw) && <p className="text-[12px] text-sev-critical mt-1">{PW_HINT}</p>}
        <button className="btn-danger btn-sm mt-2" disabled={!user || !pwOk(pw)} onClick={() => run(() => api.post(`/admin/users/${user}/reset-password`, { newPassword: pw }), 'Password direset')}><KeyRound className="w-3.5 h-3.5" />Reset password</button>
      </div>
      <ErrorBox error={err} />
    </Modal>
  );
}

export function AdminUsers() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const [tools, setTools] = useState(false);
  return (<>
    <ResourcePage resourceKey="users" title="Pengguna" description="Akun pengguna dalam cakupan Anda. Role ditugaskan per unit organisasi; kelola penugasan di menu Penugasan role."
      actions={<>
        {can('USER_ADMIN', 'UPDATE') && <button className="btn-secondary" onClick={() => setTools(true)}><KeyRound className="w-4 h-4" />Reset / buka kunci</button>}
        {can('USER_ADMIN', 'CREATE') && <button className="btn-primary" onClick={() => setCreating(true)}><UserPlus className="w-4 h-4" />Buat akun</button>}
      </>} />
    {creating && <CreateUser open onClose={() => setCreating(false)} />}
    {tools && <AccountTools open onClose={() => setTools(false)} />}
  </>);
}

// ====================================================================== ROLES & PERMISSION MATRIX
const ACT_SHORT: Record<string, string> = { CREATE: 'C', READ: 'R', UPDATE: 'U', DELETE: 'D', APPROVE: 'A', EXPORT: 'E', PRINT: 'P' };

export function AdminRoles() {
  const { can } = useSession();
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-roles'], queryFn: () => api.get('/admin/roles') });
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [newRole, setNewRole] = useState(false);
  const [nr, setNr] = useState({ code: '', name: '', description: '', copyFrom: '' });
  const [err, setErr] = useState<any>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { roles, modules, actions } = q.data;
  const role = roles.find((r: any) => r.id === sel) ?? roles[0];
  const perms: Set<string> = draft ?? new Set(role.permissions);
  const editable = !role.is_system && can('USER_ADMIN', 'UPDATE');
  const toggle = (p: string) => { if (!editable) return; const s = new Set(perms); s.has(p) ? s.delete(p) : s.add(p); setDraft(s); };

  async function save() {
    try { await api.put(`/admin/roles/${role.id}/permissions`, { permissions: [...perms] }); toast('ok', 'Izin role disimpan'); setDraft(null); qc.invalidateQueries({ queryKey: ['admin-roles'] }); }
    catch (e: any) { toast('error', e.message); }
  }
  async function create() {
    setErr(null);
    try {
      const src = roles.find((r: any) => r.id === nr.copyFrom);
      const r = await api.post('/admin/roles', { code: nr.code, name: nr.name, description: nr.description || undefined, permissions: src?.permissions ?? [] });
      toast('ok', 'Role dibuat'); setNewRole(false); setNr({ code: '', name: '', description: '', copyFrom: '' });
      await qc.invalidateQueries({ queryKey: ['admin-roles'] }); setSel(r.id); setDraft(null);
    } catch (e) { setErr(e); }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Role & izin" description="Matriks izin per modul: C buat · R lihat · U ubah · D hapus · A setujui · E ekspor · P cetak. Role sistem terkunci; buat role kustom untuk kebutuhan khusus."
        actions={can('USER_ADMIN', 'CREATE') && <button className="btn-primary" onClick={() => setNewRole(true)}><Plus className="w-4 h-4" />Role kustom</button>} />
      <div className="grid lg:grid-cols-[280px_1fr] gap-5 items-start">
        <nav className="panel p-2 max-h-[75vh] overflow-y-auto">
          {roles.map((r: any) => (
            <button key={r.id} onClick={() => { setSel(r.id); setDraft(null); }} className={cx('w-full text-left px-2.5 py-2 rounded', r.id === role.id ? 'bg-canopy-600 text-white' : 'hover:bg-canopy-50')}>
              <span className="block text-[13.5px]">{r.name}</span>
              <span className={cx('block text-[11.5px]', r.id === role.id ? 'text-white/80' : 'text-bark')}>{r.code} · {r.assignments} penugasan{r.is_system ? '' : ' · kustom'}</span>
            </button>))}
        </nav>
        <Panel title={<span>{role.name} {role.is_system ? <Tag>Sistem</Tag> : <Tag tone="blue">Kustom</Tag>}{role.is_clinical && <Tag tone="green">Klinis</Tag>}</span>}
          actions={editable && draft && <div className="flex gap-2"><button className="btn-ghost btn-sm" onClick={() => setDraft(null)}>Batalkan</button><button className="btn-primary btn-sm" onClick={save}><Save className="w-3.5 h-3.5" />Simpan</button></div>} bodyClass="p-0">
          {role.description && <p className="px-4 pt-3 text-[13px] text-bark-700">{role.description}</p>}
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Modul</th>{actions.map((a: string) => <th key={a} className="text-center w-12" title={label(a)}>{ACT_SHORT[a]}</th>)}</tr></thead>
              <tbody>{modules.map((m: any) => (
                <tr key={m.code}>
                  <td>{m.name}{m.is_clinical && <span className="ml-1 text-[11px] text-sev-high">medis</span>}<span className="block text-[11.5px] text-bark">{m.code}</span></td>
                  {actions.map((a: string) => { const p = `${m.code}:${a}`; const on = perms.has(p); return (
                    <td key={a} className="text-center">
                      <button disabled={!editable} onClick={() => toggle(p)} aria-label={`${m.code} ${a}`} aria-pressed={on}
                        className={cx('w-6 h-6 rounded border text-[11px] font-semibold', on ? 'bg-canopy-600 border-canopy-600 text-white' : 'border-line text-transparent', editable && 'hover:border-canopy-600')}>{ACT_SHORT[a]}</button>
                    </td>); })}
                </tr>))}</tbody>
            </table>
          </div>
        </Panel>
      </div>
      <Modal open={newRole} onClose={() => setNewRole(false)} title="Buat role kustom" size="sm"
        footer={<><button className="btn-secondary" onClick={() => setNewRole(false)}>Batal</button><button className="btn-primary" disabled={!/^[A-Z0-9_]{2,40}$/.test(nr.code) || nr.name.trim().length < 2} onClick={create}>Buat role</button></>}>
        <Field label="Kode" hint="Huruf besar, angka, garis bawah" error={nr.code && !/^[A-Z0-9_]{2,40}$/.test(nr.code) ? 'Format kode tidak valid' : undefined}><input className="input" value={nr.code} onChange={(e) => setNr({ ...nr, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Nama" className="mt-3"><input className="input" value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} /></Field>
        <Field label="Deskripsi" className="mt-3"><textarea className="input" rows={2} value={nr.description} onChange={(e) => setNr({ ...nr, description: e.target.value })} /></Field>
        <Field label="Salin izin dari role" className="mt-3"><select className="input" value={nr.copyFrom} onChange={(e) => setNr({ ...nr, copyFrom: e.target.value })}><option value="">— kosong —</option>{roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <ErrorBox error={err} />
      </Modal>
    </div>
  );
}

