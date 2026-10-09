import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Paperclip, Pencil, Plus, Printer, QrCode, Search, Trash2, Upload, History, Stethoscope, HeartPulse } from 'lucide-react';
import { api, download, imageUrl } from '../lib/api';
import { FieldDef, ResourceMeta, useResourceMeta } from '../lib/meta';
import { fmtDateTime, fmtRelative, label } from '../lib/format';
import { useSession } from '../lib/session';
import { DataTable, Pager, Cell } from './DataTable';
import { FieldInput, ResourceForm, validateField } from './ResourceForm';
import { RefSelect } from './RefSelect';
import { Confirm, Drawer, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Spinner, Status, cx, useToast } from './ui';

// Fields asked for when moving a record to a status (beyond a free-text note)
const TRANSITION_FIELDS: Record<string, Record<string, FieldDef[]>> = {
  accidents: {
    PENDING_APPROVAL: [
      { name: 'investigation_findings', label: 'Temuan investigasi', type: 'textarea', required: true },
      { name: 'root_cause', label: 'Akar masalah', type: 'textarea', required: true },
      { name: 'corrective_action', label: 'Tindakan perbaikan', type: 'textarea', required: true }],
    RETURN_TO_WORK: [{ name: 'return_to_work_date', label: 'Tanggal kembali bekerja', type: 'date', required: true }, { name: 'lost_time_days', label: 'Hari kerja hilang', type: 'number', min: 0 }],
    CLOSED: [{ name: 'lost_time_days', label: 'Hari kerja hilang (final)', type: 'number', min: 0 }],
  },
  referrals: {
    INPATIENT: [{ name: 'admission_date', label: 'Tanggal masuk rawat inap', type: 'date', required: true }],
    FOLLOW_UP: [{ name: 'follow_up_date', label: 'Tanggal kontrol', type: 'date' }, { name: 'discharge_date', label: 'Tanggal pulang', type: 'date' }],
    RETURNED: [
      { name: 'hospital_diagnosis', label: 'Diagnosis rumah sakit', type: 'textarea' }, { name: 'treatment_summary', label: 'Ringkasan perawatan', type: 'textarea' },
      { name: 'actual_cost', label: 'Biaya aktual (Rp)', type: 'number', min: 0 }, { name: 'follow_up_date', label: 'Kontrol di klinik', type: 'date' }],
  },
  'stock-transfers': { REJECTED: [{ name: 'reject_reason', label: 'Alasan penolakan', type: 'textarea', required: true }] },
  appointments: { CANCELLED: [{ name: 'cancel_reason', label: 'Alasan pembatalan', type: 'text', required: true }] },
  'ambulance-trips': { COMPLETED: [{ name: 'odometer_end', label: 'Odometer akhir (km)', type: 'number', min: 0 }], EN_ROUTE: [{ name: 'odometer_start', label: 'Odometer awal (km)', type: 'number', min: 0 }] },
};

// Links from a record to its specialised workspace
function recordLinks(key: string, row: any, nav: (p: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const btn = (k: string, text: string, icon: ReactNode, onClick: () => void) => <button key={k} className="btn-secondary btn-sm" onClick={onClick}>{icon}{text}</button>;
  if (key === 'encounters') out.push(btn('emr', 'Buka rekam medis', <Stethoscope className="w-4 h-4" />, () => nav(`/emr/${row.id}`)));
  if (key === 'patients') out.push(btn('tl', 'Riwayat medis', <History className="w-4 h-4" />, () => nav(`/patients/${row.id}`)));
  if (key === 'employees') out.push(btn('oh', 'Status kesehatan kerja', <HeartPulse className="w-4 h-4" />, () => nav(`/occ-health/employees/${row.id}`)));
  if (key === 'mcu') out.push(btn('mcu', 'Buka pemeriksaan MCU', <HeartPulse className="w-4 h-4" />, () => nav(`/occ-health/mcu/${row.id}`)));
  if (key === 'stock-transfers') out.push(btn('trf', 'Proses transfer', <FileText className="w-4 h-4" />, () => nav(`/pharmacy/transfers/${row.id}`)));
  if (key === 'purchase-orders') out.push(btn('po', 'Buka PO', <FileText className="w-4 h-4" />, () => nav(`/pharmacy/purchase-orders/${row.id}`)));
  if (key === 'stock-opnames') out.push(btn('opn', 'Buka opname', <FileText className="w-4 h-4" />, () => nav(`/pharmacy/opnames/${row.id}`)));
  if (key === 'prescriptions') out.push(btn('rx', 'Serahkan obat', <FileText className="w-4 h-4" />, () => nav(`/pharmacy/dispense/${row.id}`)));
  if (key === 'lab-orders') out.push(btn('lab', 'Input hasil lab', <FileText className="w-4 h-4" />, () => nav(`/lab?order=${row.id}`)));
  if (key === 'sick-leaves') out.push(btn('pdf', 'Cetak surat', <Printer className="w-4 h-4" />, () => download(`/documents/sick-leave/${row.id}.pdf`)));
  if (key === 'medical-certificates') out.push(btn('pdf', 'Cetak surat', <Printer className="w-4 h-4" />, () => download(`/documents/certificate/${row.id}.pdf`)));
  if (key === 'referrals') out.push(btn('pdf', 'Cetak surat rujukan', <Printer className="w-4 h-4" />, () => download(`/documents/referral/${row.id}.pdf`)));
  return out;
}
const QR_KIND: Record<string, string> = { employees: 'employee', patients: 'patient', medicines: 'medicine', 'clinic-assets': 'asset', ambulances: 'ambulance' };
const ATTACH_ENTITY: Record<string, string> = { accidents: 'accident', referrals: 'referral', mcu: 'mcu', employees: 'employee', 'clinic-assets': 'clinic_asset', ambulances: 'ambulance', encounters: 'encounter', 'lab-orders': 'lab_order' };

export function RecordDrawer({ resource, id, onClose, onChanged }: { resource: ResourceMeta; id: string; onClose: () => void; onChanged: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ['record', resource.key, id], queryFn: () => api.get(`/r/${resource.key}/${id}`) });
  const [editing, setEditing] = useState(false);
  const [trans, setTrans] = useState<any>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const row = q.data?.data;
  const title = row ? row[resource.titleField] ?? resource.singular : resource.singular;
  const columnNames = new Set(resource.columns.map((c) => c.name));
  const kv: [string, ReactNode][] = row ? [
    ...resource.columns.map((c) => [c.label, <Cell col={c} value={row[c.name]} />] as [string, ReactNode]),
    ...resource.fields.filter((f) => !columnNames.has(f.name) && f.type !== 'ref' && row[f.name] !== undefined).map((f) => [f.label, <Cell col={{ name: f.name, label: f.label,
      kind: f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime' : f.type === 'boolean' ? 'bool' : f.type === 'select' ? 'badge' : 'text' }} value={Array.isArray(row[f.name]) ? row[f.name].join(', ') : row[f.name]} />] as [string, ReactNode]),
  ] : [];

  async function upload(file: File) {
    const fd = new FormData();
    fd.append('entityType', ATTACH_ENTITY[resource.key]); fd.append('entityId', id); fd.append('file', file);
    try { await api.post('/files', fd); toast('ok', 'Lampiran diunggah'); q.refetch(); } catch (e: any) { toast('error', e.message); }
  }

  return (
    <Drawer open onClose={onClose} title={editing ? `Ubah ${resource.singular.toLowerCase()}` : title} subtitle={!editing && row?.status ? <Status value={row.status} /> : resource.title}
      footer={!editing && row && (
        <>
          {recordLinks(resource.key, row, nav)}
          {QR_KIND[resource.key] && <button className="btn-secondary btn-sm" onClick={async () => setQr(await imageUrl(`/qr/${QR_KIND[resource.key]}/${id}.png`))}><QrCode className="w-4 h-4" />QR</button>}
          {resource.permissions.update && <button className="btn-secondary btn-sm" onClick={() => setEditing(true)}><Pencil className="w-4 h-4" />Ubah</button>}
          {resource.permissions.delete && <button className="btn-danger btn-sm" onClick={() => setConfirmDel(true)}><Trash2 className="w-4 h-4" />Hapus</button>}
        </>
      )}>
      {q.isLoading && <Loading />}
      <ErrorBox error={q.error} />
      {row && editing && (
        <ResourceForm resource={resource} mode="update" initial={row} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); q.refetch(); onChanged(); }} />
      )}
      {row && !editing && (
        <div className="space-y-6">
          {q.data.transitions?.length > 0 && (
            <section className="rounded-md bg-canopy-50 border border-canopy-100 p-3">
              <p className="text-[12.5px] text-canopy-700 mb-2">Langkah berikutnya</p>
              <div className="flex flex-wrap gap-2">
                {q.data.transitions.map((t: any) => (
                  <button key={t.to_status} className={cx(t.required_action === 'APPROVE' ? 'btn-primary' : 'btn-secondary', 'btn-sm')}
                    onClick={() => (resource.key === 'mcu' && t.to_status === 'COMPLETED' ? nav(`/occ-health/mcu/${id}`) : setTrans(t))}>
                    {t.label ?? label(t.to_status)}{t.required_action === 'APPROVE' && <span className="text-[11px] opacity-80">· persetujuan</span>}
                  </button>
                ))}
              </div>
            </section>
          )}
          <KV items={kv} />
          {q.data.events?.length > 0 && (
            <section>
              <h3 className="font-semibold text-[14px] mb-2">Riwayat status</h3>
              <ol className="relative border-l-2 border-canopy-100 ml-1.5 space-y-3">
                {q.data.events.map((e: any, i: number) => (
                  <li key={i} className="ml-4">
                    <span className="absolute -left-[7px] mt-1.5 w-3 h-3 rounded-full bg-white border-2 border-canopy-500" />
                    <div className="text-[13.5px]"><Status value={e.to_status} /> <span className="text-bark">oleh {e.actor ?? 'sistem'} · {fmtDateTime(e.occurred_at)}</span></div>
                    {e.note && <p className="text-[13px] text-bark-700 mt-0.5">{e.note}</p>}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {ATTACH_ENTITY[resource.key] && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-[14px]">Lampiran</h3>
                <button className="btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><Upload className="w-4 h-4" />Unggah</button>
                <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </div>
              {q.data.attachments?.length ? (
                <ul className="divide-y divide-line border border-line rounded-md">
                  {q.data.attachments.map((a: any) => (
                    <li key={a.id} className="flex items-center justify-between px-3 py-2 text-[13.5px]">
                      <span className="flex items-center gap-2"><Paperclip className="w-4 h-4 text-bark" />{a.file_name}<span className="text-bark-400 text-[12px]">{Math.ceil(a.size_bytes / 1024)} KB · {fmtRelative(a.created_at)}</span></span>
                      <button className="btn-ghost btn-sm" onClick={() => download(`/files/${a.id}/download`)}>Unduh</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-bark text-[13px]">Belum ada lampiran (foto lokasi, hasil pemeriksaan, surat RS).</p>}
            </section>
          )}
        </div>
      )}
      {trans && <TransitionModal resource={resource} id={id} transition={trans} onClose={() => setTrans(null)} onDone={() => { setTrans(null); q.refetch(); onChanged(); }} />}
      <Confirm open={confirmDel} title={`Hapus ${resource.singular.toLowerCase()}?`} danger confirmText="Hapus"
        message="Data akan diarsipkan (soft delete) dan tetap tercatat di audit trail. Pemulihan dapat dilakukan administrator."
        onClose={() => setConfirmDel(false)}
        onConfirm={async () => { try { await api.del(`/r/${resource.key}/${id}`); toast('ok', `${resource.singular} dihapus`); onChanged(); onClose(); } catch (e: any) { toast('error', e.message); setConfirmDel(false); } }} />
      <Modal open={!!qr} onClose={() => setQr(null)} title="Kode QR" size="sm">
        {qr && <div className="text-center"><img src={qr} alt="QR" className="mx-auto w-56 h-56" /><p className="text-bark text-[13px] mt-2">{title}</p>
          <a href={qr} download={`qr-${title}.png`} className="btn-secondary btn-sm mt-3">Unduh PNG</a></div>}
      </Modal>
    </Drawer>
  );
}

function TransitionModal({ resource, id, transition, onClose, onDone }: { resource: ResourceMeta; id: string; transition: any; onClose: () => void; onDone: () => void }) {
  const extra = TRANSITION_FIELDS[resource.key]?.[transition.to_status] ?? [];
  const [values, setValues] = useState<Record<string, any>>({});
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function go() {
    const errs: Record<string, string> = {};
    for (const f of extra) { const m = validateField(f, values[f.name]); if (m) errs[f.name] = m; }
    setErrors(errs); if (Object.keys(errs).length) return;
    const patch: Record<string, any> = {};
    for (const f of extra) if (values[f.name] !== undefined && values[f.name] !== '') patch[f.name] = f.type === 'number' ? Number(values[f.name]) : values[f.name];
    setBusy(true); setErr(null);
    try {
      await api.post(`/r/${resource.key}/${id}/transition`, { to: transition.to_status, note: note || undefined, patch: Object.keys(patch).length ? patch : undefined });
      toast('ok', `Status diubah: ${label(transition.to_status)}`); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={transition.label ?? label(transition.to_status)} size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className="btn-primary" disabled={busy} onClick={go}>{busy && <Spinner className="w-4 h-4 text-white" />}{transition.label ?? 'Simpan'}</button></>}>
      <div className="space-y-3">
        {transition.required_action === 'APPROVE' && <p className="text-[13px] text-bark-700 bg-kernel-50 border border-kernel-100 rounded-md p-2">Langkah ini memerlukan izin persetujuan dan tercatat atas nama Anda. Persetujuan tidak dapat dilakukan oleh pembuat data (prinsip empat mata).</p>}
        {extra.map((f) => (
          <Field key={f.name} label={f.label} required={f.required} error={errors[f.name]}>
            <FieldInput f={f} value={values[f.name]} values={values} invalid={!!errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
          </Field>
        ))}
        <Field label="Catatan (opsional)"><textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

export function ResourcePage({ resourceKey, title, description, presetFilters, actions, hideCreate }: {
  resourceKey?: string; title?: string; description?: ReactNode; presetFilters?: Record<string, string>; actions?: ReactNode; hideCreate?: boolean;
}) {
  const params = useParams();
  const key = resourceKey ?? params.key!;
  const { resource, isLoading, error } = useResourceMeta(key);
  const { scope } = useSession();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ col?: string; dir?: string }>({});
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [useScope, setUseScope] = useState(true);
  const [creating, setCreating] = useState(false);
  const openId = sp.get('id');
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => { const t = setTimeout(() => { setDebounced(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); setFilters({}); setQ(''); }, [key]);

  const query = { page, pageSize: 25, q: debounced, sort: sort.col, dir: sort.dir, unitId: resource?.scoped && useScope ? scope?.id : undefined, ...presetFilters, ...filters };
  const list = useQuery({ queryKey: ['list', key, query], queryFn: () => api.get(`/r/${key}`, query), enabled: !!resource?.permissions.read, placeholderData: keepPreviousData });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!resource) return <Empty title="Halaman tidak ditemukan" />;
  if (!resource.permissions.read) return <Empty title="Akses dibatasi" hint={`Anda tidak memiliki izin ${resource.module}:READ. Hubungi administrator bila Anda membutuhkan akses ini.`} />;

  return (
    <div>
      <PageHeader title={title ?? resource.title} description={description}
        actions={<>
          {actions}
          {resource.permissions.export && (
            <div className="flex">
              <button className="btn-secondary rounded-r-none" onClick={() => download(`/r/${key}/export`, { ...query, page: undefined, pageSize: undefined, format: 'xlsx' }).catch((e) => toast('error', e.message))}><Download className="w-4 h-4" />Excel</button>
              <button className="btn-secondary rounded-none border-l-0" onClick={() => download(`/r/${key}/export`, { ...query, format: 'csv' }).catch((e) => toast('error', e.message))}>CSV</button>
              <button className="btn-secondary rounded-l-none border-l-0" onClick={() => download(`/r/${key}/export`, { ...query, format: 'pdf' }).catch((e) => toast('error', e.message))}>PDF</button>
            </div>
          )}
          {!hideCreate && resource.permissions.create && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="w-4 h-4" />Tambah {resource.singular.toLowerCase()}</button>}
        </>} />
      <div className="panel">
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-line">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-bark-400" />
            <input className="input pl-9" placeholder="Cari…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari" />
          </div>
          {resource.filters.map((f) => (
            <div key={f.name} className="min-w-[160px]">
              {f.type === 'select' && (
                <select className="input" value={filters[f.name] ?? ''} onChange={(e) => { setFilters((s) => ({ ...s, [f.name]: e.target.value })); setPage(1); }} aria-label={f.label}>
                  <option value="">{f.label}: semua</option>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
              {f.type === 'date' && <input type="date" className="input" value={filters[f.name] ?? ''} title={f.label} aria-label={f.label} onChange={(e) => { setFilters((s) => ({ ...s, [f.name]: e.target.value })); setPage(1); }} />}
              {f.type === 'ref' && <div className="w-56"><RefSelect kind={f.ref!} value={filters[f.name]} placeholder={f.label} onChange={(v) => { setFilters((s) => ({ ...s, [f.name]: v ?? '' })); setPage(1); }} /></div>}
            </div>
          ))}
          {resource.scoped && scope && (
            <label className="flex items-center gap-1.5 text-[13px] text-bark ml-auto">
              <input type="checkbox" className="accent-canopy-600" checked={useScope} onChange={(e) => setUseScope(e.target.checked)} />
              Hanya {scope.name}
            </label>
          )}
          {list.isFetching && <Spinner className="w-4 h-4" />}
        </div>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : (
          <DataTable columns={resource.columns} rows={list.data?.data ?? []} sort={sort.col ?? resource.sort} dir={sort.dir}
            onSort={(c) => setSort((s) => ({ col: c, dir: s.col === c && s.dir === 'asc' ? 'desc' : 'asc' }))}
            onRowClick={(r) => setSp((p) => { p.set('id', r.id); return p; })}
            empty={<Empty title={debounced || Object.values(filters).some(Boolean) ? 'Tidak ada data yang cocok dengan pencarian' : `Belum ada ${resource.title.toLowerCase()}`}
              hint={resource.scoped && useScope ? `Data dibatasi ke ${scope?.name}. Hapus centang "Hanya ${scope?.name}" untuk melihat seluruh cakupan akses Anda.` : undefined} />} />
        )}
        {list.data && <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} />}
      </div>
      {openId && <RecordDrawer resource={resource} id={openId} onClose={() => setSp((p) => { p.delete('id'); return p; })} onChanged={() => qc.invalidateQueries({ queryKey: ['list', key] })} />}
      <Modal open={creating} onClose={() => setCreating(false)} title={`Tambah ${resource.singular.toLowerCase()}`} size="lg">
        {creating && <ResourceForm resource={resource} mode="create" presets={presetFilters} onCancel={() => setCreating(false)}
          onSaved={(r) => { setCreating(false); qc.invalidateQueries({ queryKey: ['list', key] }); setSp((p) => { p.set('id', r.id); return p; }); }} />}
      </Modal>
    </div>
  );
}
