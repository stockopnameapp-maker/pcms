// Laboratory worklist, occupational health, ambulance dispatch
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ambulance as AmbulanceIcon, CalendarPlus, Siren } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, label, shiftDate, todayISO } from '../lib/format';
import { useSession } from '../lib/session';
import { RefSelect } from '../components/RefSelect';
import { Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Panel, Spinner, Status, Tag, cx, useToast } from '../components/ui';
import { useClinicChoice } from './Queue';
import { ResourcePage } from '../components/ResourcePage';

// ================================================================== LAB
export function LabWorklist() {
  const [clinicId, setClinicId] = useClinicChoice();
  const [sp] = useSearchParams();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const toast = useToast();
  const { me } = useSession();
  const q = useQuery({ queryKey: ['lab', clinicId, status], queryFn: () => api.get('/lab/worklist', { clinicId, status: status || undefined }), refetchInterval: 30_000 });
  useEffect(() => { const id = sp.get('order'); if (id && q.data) { const o = q.data.data.find((x: any) => x.id === id); if (o) start(o); } }, [q.data]);
  function start(o: any) { setOpen(o); setVals(Object.fromEntries(o.results.map((r: any) => [r.lab_test_id, r.value_numeric ?? r.value_text ?? '']))); }
  async function save(verify: boolean) {
    try {
      const results = open.results.filter((r: any) => vals[r.lab_test_id] !== '' && vals[r.lab_test_id] !== undefined).map((r: any) => (
        r.result_type === 'NUMERIC' ? { labTestId: r.lab_test_id, valueNumeric: Number(vals[r.lab_test_id]) } : { labTestId: r.lab_test_id, valueText: String(vals[r.lab_test_id]) }));
      if (results.length) await api.post(`/lab/orders/${open.id}/results`, { results });
      if (verify) await api.post(`/lab/orders/${open.id}/verify`);
      toast('ok', verify ? 'Hasil diverifikasi dokter' : 'Hasil disimpan'); setOpen(null); q.refetch();
    } catch (e: any) { toast('error', e.message); }
  }
  return (
    <div>
      <PageHeader title="Laboratorium" description="Daftar kerja order lab. Nilai di luar rujukan ditandai otomatis; dokter memverifikasi sebelum hasil final."
        actions={<><select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Belum selesai</option>{['ORDERED', 'RESULTED', 'VERIFIED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
          <div className="w-64"><RefSelect kind="clinic" value={clinicId} onChange={setClinicId} placeholder="Semua klinik" /></div></>} />
      <div className="panel">
        {q.isLoading ? <Loading /> : q.data?.data.length ? (
          <table className="tbl"><thead><tr><th>Waktu</th><th>No.</th><th>Pasien</th><th>Pemeriksaan</th><th>Prioritas</th><th>Status</th></tr></thead>
            <tbody>{q.data.data.map((o: any) => (
              <tr key={o.id} className="cursor-pointer" onClick={() => start(o)}><td className="num">{fmtDateTime(o.ordered_at)}</td><td>{o.order_no}</td><td>{o.patient_name}<span className="block text-[12px] text-bark">{o.mrn} · {o.clinic_name}</span></td>
                <td>{o.results.map((r: any) => r.code).join(', ')}</td><td><Status value={o.priority} /></td><td><Status value={o.status} /></td></tr>))}</tbody></table>
        ) : <Empty title="Tidak ada order lab" />}
        <ErrorBox error={q.error} />
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${open.order_no} · ${open.patient_name}` : ''} size="lg"
        footer={<><button className="btn-secondary" onClick={() => setOpen(null)}>Tutup</button>
          {open?.status !== 'VERIFIED' && <button className="btn-secondary" onClick={() => save(false)}>Simpan hasil</button>}
          {open?.status !== 'VERIFIED' && me?.user.staff?.staff_type === 'DOCTOR' && <button className="btn-primary" onClick={() => save(true)}>Simpan & verifikasi</button>}</>}>
        {open && <>
          {open.clinical_info && <p className="text-[13px] text-bark mb-3">Info klinis: {open.clinical_info} · peminta {open.ordered_by_name}</p>}
          <table className="tbl"><thead><tr><th>Pemeriksaan</th><th className="w-48">Hasil</th><th>Satuan</th><th>Rujukan</th><th>Flag</th></tr></thead>
            <tbody>{open.results.map((r: any) => (
              <tr key={r.lab_test_id}><td>{r.name}</td>
                <td>{open.status === 'VERIFIED' ? <span className="num font-medium">{r.value_numeric ?? r.value_text}</span> : r.result_type === 'POS_NEG'
                  ? <select className="input h-8" value={vals[r.lab_test_id] ?? ''} onChange={(e) => setVals((s) => ({ ...s, [r.lab_test_id]: e.target.value }))}><option value="">—</option><option>POSITIF</option><option>NEGATIF</option></select>
                  : <input className="input h-8 num" value={vals[r.lab_test_id] ?? ''} onChange={(e) => setVals((s) => ({ ...s, [r.lab_test_id]: r.result_type === 'NUMERIC' ? e.target.value.replace(/[^\d.]/g, '') : e.target.value }))} />}</td>
                <td className="text-bark">{r.unit}</td><td className="text-bark num">{r.ref_range}</td><td>{r.flag && <Status value={['HIGH', 'LOW'].includes(r.flag) ? 'ABNORMAL' : r.flag} text={label(r.flag)} />}</td></tr>))}</tbody></table>
        </>}
      </Modal>
    </div>
  );
}

// ================================================================== OCCUPATIONAL HEALTH
export function OccCompliance() {
  const { scope, can } = useSession();
  const nav = useNavigate();
  const [filter, setFilter] = useState({ compliance: '', risk: '', fit: '', q: '' });
  const [schedule, setSchedule] = useState(false);
  const q = useQuery({ queryKey: ['occ', scope?.id, filter], queryFn: () => api.get('/occ-health/compliance', { unitId: scope?.id, ...filter }), enabled: !!scope });
  const occ = useQuery({ queryKey: ['occ-agg', scope?.id], queryFn: () => api.get('/dashboard/occupational', { unitId: scope?.id }), enabled: !!scope && can('DASHBOARD') });
  const rows = q.data?.data ?? [];
  const count = (k: string) => rows.filter((r: any) => r.mcu_compliance === k).length;
  return (
    <div className="space-y-4">
      <PageHeader title="Kesehatan kerja" description={`Karyawan → jabatan → risiko → pemeriksaan → status kelaikan, untuk ${scope?.name}.`}
        actions={can('OCC_HEALTH', 'CREATE') && <button className="btn-primary" onClick={() => setSchedule(true)}><CalendarPlus className="w-4 h-4" />Jadwalkan MCU massal</button>} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[['OVERDUE', 'Terlambat MCU', 'text-sev-critical'], ['NEVER_EXAMINED', 'Belum pernah MCU', 'text-sev-high'], ['DUE_SOON', 'Jatuh tempo ≤ 30 hari', 'text-amber-700'], ['UP_TO_DATE', 'Tepat waktu', 'text-canopy-700']].map(([k, l, c]) => (
          <button key={k} onClick={() => setFilter((f) => ({ ...f, compliance: f.compliance === k ? '' : k }))} className={cx('panel p-4 text-left hover:border-canopy-500', filter.compliance === k && 'ring-2 ring-kernel-100 border-kernel')}>
            <p className="text-[12.5px] text-bark">{l}</p><p className={cx('font-cond text-[26px] font-semibold num', c)}>{q.isLoading ? '…' : count(k)}</p></button>))}
      </div>
      {occ.data?.data?.occupational_cases_90d?.length > 0 && (
        <Panel title="Penyakit akibat kerja (90 hari)" bodyClass="p-0">
          <table className="tbl"><thead><tr><th>Kelompok risiko</th><th>ICD-10</th><th>Diagnosis</th><th className="text-right">Kasus</th></tr></thead>
            <tbody>{occ.data.data.occupational_cases_90d.map((r: any, i: number) => <tr key={i}><td>{r.risk}</td><td className="num">{r.icd10}</td><td>{r.title}</td><td className="text-right num">{r.cases ?? '<5'}</td></tr>)}</tbody></table>
        </Panel>
      )}
      <div className="panel">
        <div className="flex flex-wrap gap-2 p-3 border-b border-line">
          <input className="input max-w-xs" placeholder="Cari nama / no. karyawan" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />
          <select className="input w-48" value={filter.fit} onChange={(e) => setFilter((f) => ({ ...f, fit: e.target.value }))}><option value="">Status fit: semua</option>{['FIT', 'FIT_WITH_RESTRICTION', 'TEMPORARILY_UNFIT', 'UNFIT', 'NOT_ASSESSED'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
          <select className="input w-48" value={filter.risk} onChange={(e) => setFilter((f) => ({ ...f, risk: e.target.value }))}><option value="">Risiko: semua</option>{['HARVESTER', 'SPRAYER', 'MANURING', 'DRIVER', 'HEAVY_EQUIPMENT', 'MILL_WORKER', 'WORKSHOP', 'SECURITY', 'OFFICE', 'HIGH_RISK'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
          <span className="text-[13px] text-bark self-center ml-auto num">{rows.length} karyawan</span>
        </div>
        {q.isLoading ? <Loading /> : rows.length ? (
          <div className="overflow-x-auto max-h-[640px]"><table className="tbl"><thead className="sticky top-0"><tr><th>Karyawan</th><th>Unit</th><th>Jabatan</th><th>Risiko</th><th>MCU terakhir</th><th>Status fit</th><th>MCU berikut</th><th>Kepatuhan</th></tr></thead>
            <tbody>{rows.slice(0, 500).map((r: any) => (
              <tr key={r.employee_id} className="cursor-pointer" onClick={() => nav(`/occ-health/employees/${r.employee_id}`)}>
                <td>{r.full_name}<span className="block text-[12px] text-bark">{r.employee_no}</span></td><td>{r.unit_name}</td><td>{r.position_name}</td><td>{r.risk_name} <Status value={r.risk_level} /></td>
                <td className="num">{fmtDate(r.last_mcu_date)}</td><td><Status value={r.fit_status ?? 'NOT_ASSESSED'} />{r.restrictions && <span className="block text-[12px] text-bark max-w-[220px] truncate" title={r.restrictions}>{r.restrictions}</span>}</td>
                <td className="num">{fmtDate(r.next_mcu_due)}</td><td><Status value={r.mcu_compliance} /></td></tr>))}</tbody></table></div>
        ) : <Empty title="Tidak ada karyawan yang cocok" />}
        <ErrorBox error={q.error} />
      </div>
      <ScheduleModal open={schedule} onClose={() => setSchedule(false)} onDone={() => q.refetch()} />
    </div>
  );
}

function ScheduleModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { scope, me } = useSession();
  const [v, setV] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  useEffect(() => { if (open) setV({ unitId: scope?.id, clinicId: me?.user.staff?.home_clinic_id ?? null, mcuType: 'ANNUAL', scheduledDate: shiftDate(todayISO(), 7), selection: 'ALL_DUE', riskCode: '' }); }, [open]);
  async function submit() {
    setBusy(true); setErr(null);
    try { const r = await api.post('/occ-health/mcu/schedule', { ...v, riskCode: v.riskCode || undefined }); toast('ok', `${r.created} MCU dijadwalkan`); onDone(); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Jadwalkan MCU massal"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className="btn-primary" disabled={busy || !v.unitId || !v.clinicId} onClick={submit}>{busy && <Spinner className="w-4 h-4 text-white" />}Jadwalkan</button></>}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Unit karyawan"><RefSelect kind="org_unit" value={v.unitId} onChange={(x) => setV((s: any) => ({ ...s, unitId: x }))} /></Field>
        <Field label="Klinik pemeriksa"><RefSelect kind="clinic" value={v.clinicId} onChange={(x) => setV((s: any) => ({ ...s, clinicId: x }))} /></Field>
        <Field label="Karyawan"><select className="input" value={v.selection} onChange={(e) => setV((s: any) => ({ ...s, selection: e.target.value }))}>
          <option value="ALL_DUE">Semua yang terlambat / jatuh tempo / belum pernah</option><option value="OVERDUE">Hanya terlambat</option><option value="NEVER_EXAMINED">Belum pernah MCU</option><option value="DUE_SOON">Jatuh tempo ≤ 30 hari</option></select></Field>
        <Field label="Kategori risiko (opsional)"><select className="input" value={v.riskCode} onChange={(e) => setV((s: any) => ({ ...s, riskCode: e.target.value }))}><option value="">Semua</option>{['HARVESTER', 'SPRAYER', 'MANURING', 'DRIVER', 'HEAVY_EQUIPMENT', 'MILL_WORKER', 'WORKSHOP', 'SECURITY', 'OFFICE', 'HIGH_RISK'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
        <Field label="Jenis MCU"><select className="input" value={v.mcuType} onChange={(e) => setV((s: any) => ({ ...s, mcuType: e.target.value }))}>{['ANNUAL', 'PERIODIC', 'SPECIAL'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
        <Field label="Tanggal pemeriksaan"><input type="date" className="input" value={v.scheduledDate} onChange={(e) => setV((s: any) => ({ ...s, scheduledDate: e.target.value }))} /></Field>
      </div>
      <p className="text-[12.5px] text-bark mt-3">Karyawan yang sudah memiliki MCU aktif (direncanakan/terjadwal) dilewati. HR officer menerima pengingat 14 hari sebelum jadwal.</p>
      <div className="mt-2"><ErrorBox error={err} /></div>
    </Modal>
  );
}

export function OccEmployee() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['occ-emp', id], queryFn: () => api.get(`/occ-health/employees/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { employee: e, risk, status, mcu, assessments, accidents } = q.data;
  const chain = [
    ['Karyawan', e.full_name, `${e.employee_no} · ${e.unit_name}`],
    ['Jabatan', e.position_name, ''],
    ['Risiko', risk?.name, `${label(risk?.risk_level)} · MCU tiap ${risk?.mcu_interval_months} bln`],
    ['Pemeriksaan', status?.last_mcu_date ? fmtDate(status.last_mcu_date) : 'Belum pernah', status?.last_mcu_type ? label(status.last_mcu_type) : ''],
    ['Status kesehatan', label(status?.fit_status ?? 'NOT_ASSESSED'), status?.restrictions ?? ''],
  ];
  return (
    <div className="space-y-5">
      <PageHeader title={e.full_name} description={`${e.employee_no} · ${e.position_name} · ${e.unit_name}`} actions={status && <Status value={status.mcu_compliance} />} />
      <ol className="grid md:grid-cols-5 gap-0 panel overflow-hidden">
        {chain.map(([k, v, s], i) => (
          <li key={k} className={cx('p-4 relative', i < 4 && 'md:border-r border-b md:border-b-0 border-line', i === 4 && 'bg-canopy-50')}>
            <p className="text-[12px] text-bark">{k}</p><p className="font-semibold mt-0.5">{v ?? '–'}</p>{s && <p className="text-[12.5px] text-bark mt-0.5">{s}</p>}
          </li>))}
      </ol>
      {risk && <Panel title="Profil bahaya & pemeriksaan wajib"><KV items={[['Bahaya kerja', risk.hazards?.map(label).join(', ')], ['Pemeriksaan wajib', risk.required_exams?.map(label).join(', ')]]} /></Panel>}
      <Panel title="Riwayat MCU" bodyClass="p-0">
        {mcu.length ? <table className="tbl"><thead><tr><th>No.</th><th>Jenis</th><th>Tanggal</th><th>Klinik</th><th>Status</th><th>Kelaikan</th><th>Temuan</th></tr></thead>
          <tbody>{mcu.map((m: any) => (
            <tr key={m.id}><td><Link className="text-canopy-700 hover:underline" to={`/occ-health/mcu/${m.id}`}>{m.mcu_no}</Link></td><td>{label(m.mcu_type)}</td><td className="num">{fmtDate(m.exam_date ?? m.due_date)}</td><td>{m.clinic_name}</td>
              <td><Status value={m.status} /></td><td><Status value={m.fit_status} />{m.restrictions && <span className="block text-[12px] text-bark">{m.restrictions}</span>}</td>
              <td className="text-[12.5px]">{m.findings.length ? m.findings.filter((f: any) => f.flag !== 'NORMAL').map((f: any) => `${label(f.exam)}: ${f.result}`).join('; ') || 'Normal' : <span className="text-bark-400">tidak dapat diakses</span>}</td></tr>))}</tbody></table>
          : <Empty title="Belum ada MCU" />}
      </Panel>
      <div className="grid md:grid-cols-2 gap-5">
        <Panel title="Penilaian kelaikan" bodyClass="p-0">{assessments.length ? <table className="tbl"><tbody>{assessments.map((a: any) => <tr key={a.assessment_no}><td>{label(a.assessment_type)}</td><td><Status value={a.fit_status} /></td><td className="num">{fmtDate(a.valid_from)} – {fmtDate(a.valid_until)}</td><td><Status value={a.status} /></td></tr>)}</tbody></table> : <Empty title="Belum ada penilaian" />}</Panel>
        <Panel title="Kecelakaan kerja" bodyClass="p-0">{accidents.length ? <table className="tbl"><tbody>{accidents.map((a: any) => <tr key={a.incident_no}><td>{a.incident_no}</td><td className="num">{fmtDate(a.occurred_at)}</td><td><Status value={a.severity} /></td><td className="num">{a.lost_time_days} hari</td><td><Status value={a.status} /></td></tr>)}</tbody></table> : <Empty title="Tidak ada kecelakaan" />}</Panel>
      </div>
    </div>
  );
}

const EXAMS = ['PHYSICAL', 'VISUS', 'COLOR_BLIND', 'AUDIOMETRY', 'SPIROMETRY', 'XRAY_THORAX', 'ECG', 'CHOLINESTERASE', 'HEMATOLOGY', 'LIVER_FUNCTION', 'KIDNEY_FUNCTION', 'BLOOD_GLUCOSE', 'LIPID_PROFILE', 'URINALYSIS', 'DRUG_SCREEN', 'MUSCULOSKELETAL', 'DERMATOLOGY', 'PSYCHOLOGY'];
export function McuDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { me } = useSession();
  const q = useQuery({ queryKey: ['mcu', id], queryFn: () => api.get(`/occ-health/mcu/${id}`) });
  const [f, setF] = useState<Record<string, any>>({});
  const [out, setOut] = useState<any>({ examDate: todayISO(), fitStatus: 'FIT', restrictions: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (!q.data) return;
    const m = q.data.mcu; const req: string[] = m.required_exams ?? ['PHYSICAL'];
    const existing = Object.fromEntries(q.data.findings.map((x: any) => [x.exam_code, { result: x.result, flag: x.flag, icd10Code: x.icd10_code }]));
    setF(Object.fromEntries([...new Set([...req, ...Object.keys(existing)])].map((k) => [k, existing[k] ?? { result: '', flag: 'NORMAL', icd10Code: null }])));
  }, [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const m = q.data.mcu;
  const done = m.status === 'COMPLETED';
  const doctor = me?.user.staff?.staff_type === 'DOCTOR';
  async function complete() {
    setBusy(true); setErr(null);
    try {
      const findings = Object.entries(f).filter(([, x]: any) => x.result).map(([examCode, x]: any) => ({ examCode, result: x.result, flag: x.flag, icd10Code: x.icd10Code || null }));
      const r = await api.post(`/occ-health/mcu/${id}/complete`, { ...out, restrictions: out.restrictions || undefined, findings });
      toast('ok', `MCU selesai. MCU berikutnya ${fmtDate(r.nextDue)}`); q.refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <PageHeader title={`MCU ${m.mcu_no}`} description={`${m.employee_name} (${m.employee_no}) · ${m.position_name} · ${m.unit_name} · risiko ${m.risk_name}`} actions={<><Status value={m.mcu_type} text={label(m.mcu_type)} /><Status value={m.status} /></>} />
      <Panel title="Hasil administratif"><KV cols={3} items={[['Jatuh tempo', fmtDate(m.due_date)], ['Tanggal periksa', fmtDate(m.exam_date)], ['Klinik', m.clinic_name], ['Status kelaikan', <Status value={m.fit_status} />], ['Pembatasan', m.restrictions], ['MCU berikutnya', fmtDate(m.next_due_date)]]} /></Panel>
      {q.data.canSeeFindings ? (
        <Panel title="Pemeriksaan & temuan klinis" actions={<span className="text-[12px] text-bark">rahasia medis — tidak terlihat oleh HR/HSE</span>} bodyClass="p-0">
          <table className="tbl"><thead><tr><th>Pemeriksaan</th><th>Hasil</th><th className="w-36">Flag</th><th className="w-64">ICD-10 (bila abnormal)</th></tr></thead>
            <tbody>{Object.entries(f).map(([k, x]: any) => (
              <tr key={k}><td>{label(k)}</td>
                <td>{done ? x.result : <input className="input h-8" value={x.result} onChange={(e) => setF((s) => ({ ...s, [k]: { ...x, result: e.target.value } }))} placeholder="mis. Dalam batas normal" />}</td>
                <td>{done ? <Status value={x.flag === 'NORMAL' ? 'NORMAL' : 'ABNORMAL'} text={label(x.flag)} /> : <select className="input h-8" value={x.flag} onChange={(e) => setF((s) => ({ ...s, [k]: { ...x, flag: e.target.value } }))}>{['NORMAL', 'BORDERLINE', 'ABNORMAL', 'CRITICAL'].map((o) => <option key={o} value={o}>{label(o)}</option>)}</select>}</td>
                <td>{done ? x.icd10Code ?? '–' : x.flag !== 'NORMAL' && <RefSelect kind="icd10" value={x.icd10Code} onChange={(v) => setF((s) => ({ ...s, [k]: { ...x, icd10Code: v } }))} />}</td></tr>))}</tbody></table>
          {!done && <div className="p-3 border-t border-line flex gap-2 items-center"><select className="input w-60" defaultValue="" onChange={(e) => { if (e.target.value) setF((s) => ({ ...s, [e.target.value]: { result: '', flag: 'NORMAL', icd10Code: null } })); e.target.value = ''; }}>
            <option value="">+ Tambah pemeriksaan</option>{EXAMS.filter((x) => !(x in f)).map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></div>}
        </Panel>
      ) : <p className="text-[13px] text-bark bg-mist border border-line rounded-md px-3 py-2">Temuan klinis MCU hanya dapat dilihat tenaga medis klinik pemeriksa. Anda melihat hasil administratif (status kelaikan & pembatasan).</p>}
      {!done && q.data.canSeeFindings && doctor && (
        <Panel title="Kesimpulan dokter">
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Tanggal pemeriksaan"><input type="date" className="input" value={out.examDate} onChange={(e) => setOut((s: any) => ({ ...s, examDate: e.target.value }))} /></Field>
            <Field label="Status kelaikan kerja"><select className="input" value={out.fitStatus} onChange={(e) => setOut((s: any) => ({ ...s, fitStatus: e.target.value }))}>{['FIT', 'FIT_WITH_RESTRICTION', 'TEMPORARILY_UNFIT', 'UNFIT'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Berlaku sampai (opsional)" hint="Default mengikuti interval risiko"><input type="date" className="input" value={out.validUntil ?? ''} onChange={(e) => setOut((s: any) => ({ ...s, validUntil: e.target.value || undefined }))} /></Field>
            <Field label="Pembatasan kerja" className="sm:col-span-3" required={out.fitStatus === 'FIT_WITH_RESTRICTION'}><input className="input" value={out.restrictions} onChange={(e) => setOut((s: any) => ({ ...s, restrictions: e.target.value }))} placeholder="mis. Tidak menyemprot pestisida selama 3 bulan" /></Field>
          </div>
          <ErrorBox error={err} />
          <div className="flex justify-end mt-3"><button className="btn-primary" disabled={busy} onClick={complete}>{busy && <Spinner className="w-4 h-4 text-white" />}Selesaikan MCU</button></div>
        </Panel>
      )}
    </div>
  );
}

// ================================================================== AMBULANCE
export function AmbulanceBoard() {
  const { scope, can } = useSession();
  const [dispatch, setDispatch] = useState<any>(null);
  const toast = useToast();
  const nav = useNavigate();
  const fleet = useQuery({ queryKey: ['fleet', scope?.id], queryFn: () => api.get('/r/ambulances', { unitId: scope?.id, pageSize: 100 }), refetchInterval: 30_000 });
  const trips = useQuery({ queryKey: ['trips-active', scope?.id], queryFn: () => api.get('/r/ambulance-trips', { unitId: scope?.id, pageSize: 20, sort: 'dispatched_at' }), refetchInterval: 30_000 });
  async function submit() {
    try { await api.post('/ambulance/dispatch', dispatch); toast('ok', 'Ambulans diberangkatkan'); setDispatch(null); fleet.refetch(); trips.refetch(); } catch (e: any) { toast('error', e.message); }
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Armada ambulans" description="Status armada real-time dan dispatch darurat." />
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {fleet.isLoading && <Loading />}
        {fleet.data?.data.map((a: any) => (
          <div key={a.id} className={cx('panel p-4', a.status === 'AVAILABLE' && 'border-canopy-300')}>
            <div className="flex justify-between items-start"><div><p className="font-cond font-semibold text-[18px]">{a.vehicle_no}</p><p className="text-[12.5px] text-bark">{a.code} · {label(a.vehicle_type)}</p></div><Status value={a.status} /></div>
            <p className="text-[13px] mt-2">{a.clinic_name}</p>
            <p className="text-[12px] text-bark num">Odometer {a.odometer_km?.toLocaleString('id-ID')} km · servis {fmtDate(a.next_service_date)}</p>
            {a.status === 'AVAILABLE' && can('AMBULANCE', 'CREATE') && <button className="btn-primary btn-sm mt-3 w-full" onClick={() => setDispatch({ ambulanceId: a.id, tripType: 'EMERGENCY', priority: 'EMERGENCY', origin: a.clinic_name, destination: '' })}><Siren className="w-4 h-4" />Dispatch</button>}
          </div>))}
      </div>
      <Panel title="Perjalanan terakhir" actions={<Link to="/r/ambulance-trips" className="text-[13px] text-canopy-700 hover:underline">Semua perjalanan</Link>} bodyClass="p-0">
        {trips.data?.data.length ? <table className="tbl"><thead><tr><th>Waktu</th><th>Ambulans</th><th>Jenis</th><th>Rute</th><th>Pasien</th><th>Status</th></tr></thead>
          <tbody>{trips.data.data.map((t: any) => (
            <tr key={t.id} className="cursor-pointer" onClick={() => nav(`/r/ambulance-trips?id=${t.id}`)}><td className="num">{fmtDateTime(t.dispatched_at)}</td><td>{t.vehicle_no}</td><td><Status value={t.priority} text={label(t.trip_type)} /></td>
              <td>{t.origin} → {t.destination}</td><td>{t.patient_name ?? '–'}</td><td><Status value={t.status} /></td></tr>))}</tbody></table> : <Empty title="Belum ada perjalanan" />}
      </Panel>
      <Modal open={!!dispatch} onClose={() => setDispatch(null)} title="Dispatch ambulans"
        footer={<><button className="btn-secondary" onClick={() => setDispatch(null)}>Batal</button><button className="btn bg-sev-critical text-white hover:bg-red-800" disabled={!dispatch?.destination} onClick={submit}><AmbulanceIcon className="w-4 h-4" />Berangkatkan</button></>}>
        {dispatch && <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Jenis perjalanan"><select className="input" value={dispatch.tripType} onChange={(e) => setDispatch({ ...dispatch, tripType: e.target.value })}>{['EMERGENCY', 'REFERRAL', 'INTER_CLINIC', 'RETURN', 'OTHER'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Prioritas"><select className="input" value={dispatch.priority} onChange={(e) => setDispatch({ ...dispatch, priority: e.target.value })}>{['EMERGENCY', 'URGENT', 'NORMAL'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Asal / lokasi jemput"><input className="input" value={dispatch.origin} onChange={(e) => setDispatch({ ...dispatch, origin: e.target.value })} /></Field>
          <Field label="Tujuan" required><input className="input" value={dispatch.destination} onChange={(e) => setDispatch({ ...dispatch, destination: e.target.value })} placeholder="mis. Blok C12 Divisi I / RSUD" /></Field>
          <Field label="Pasien (opsional)" className="sm:col-span-2"><RefSelect kind="patient" value={dispatch.patientId} onChange={(v) => setDispatch({ ...dispatch, patientId: v ?? undefined })} /></Field>
          <Field label="Catatan" className="sm:col-span-2"><textarea className="input" rows={2} value={dispatch.notes ?? ''} onChange={(e) => setDispatch({ ...dispatch, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

export function AlertsPage() {
  const { can } = useSession();
  const toast = useToast(); const qc = useQueryClient();
  return <ResourcePage resourceKey="alerts" title="Early warning" description="Alert dihasilkan otomatis dari data: lonjakan penyakit (uji statistik Poisson), penyakit akibat kerja, kecelakaan, stok minimum, kedaluwarsa, dan keterlambatan MCU."
    actions={can('ALERT', 'CREATE') && <button className="btn-secondary" onClick={async () => { try { const r = await api.post('/admin/jobs/alert-engine'); toast('ok', `Pemeriksaan selesai: ${r.result.raised} alert baru, ${r.result.resolved} selesai otomatis`); qc.invalidateQueries({ queryKey: ['list', 'alerts'] }); } catch (e: any) { toast('error', e.message); } }}>Jalankan pemeriksaan sekarang</button>} />;
}
