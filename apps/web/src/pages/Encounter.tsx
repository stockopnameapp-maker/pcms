import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History, Lock, Plus, Printer, Trash2 } from 'lucide-react';
import { api, download } from '../lib/api';
import { fmtDate, fmtDateTime, fmtNum, label, todayISO, shiftDate } from '../lib/format';
import { RefSelect } from '../components/RefSelect';
import { Confirm, Empty, ErrorBox, Field, KV, Loading, Modal, Panel, Spinner, Status, Tabs, Tag, cx, useToast } from '../components/ui';

function Soap({ e, editable, onSaved }: { e: any; editable: boolean; onSaved: () => void }) {
  const fields = [
    ['chief_complaint', 'Keluhan utama (S)'], ['history_of_present_illness', 'Riwayat penyakit sekarang (S)'], ['physical_exam', 'Pemeriksaan fisik (O)'],
    ['assessment', 'Assessment (A)'], ['plan', 'Rencana (P)'], ['doctor_notes', 'Catatan dokter — rahasia, dienkripsi'],
  ];
  const [v, setV] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  useEffect(() => {
    setV(Object.fromEntries([...fields.map(([k]) => [k, e[k] ?? '']), ['disposition', e.disposition ?? ''], ['follow_up_date', e.follow_up_date ?? ''], ['is_work_related', !!e.is_work_related]]));
  }, [e.id, e.version]);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const body: any = { version: e.version };
      for (const k of Object.keys(v)) if ((v[k] ?? '') !== (e[k] ?? (k === 'is_work_related' ? false : ''))) body[k] = v[k] === '' ? null : v[k];
      if (Object.keys(body).length === 1) { toast('info', 'Tidak ada perubahan'); return; }
      await api.patch(`/emr/encounters/${e.id}`, body);
      toast('ok', 'Rekam medis disimpan'); onSaved();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3">
      {fields.map(([k, l]) => (
        <Field key={k} label={l}>
          <textarea className={cx('input', k === 'doctor_notes' && 'bg-kernel-50/40')} rows={k === 'chief_complaint' ? 2 : 3} value={v[k] ?? ''} disabled={!editable} onChange={(x) => setV((s) => ({ ...s, [k]: x.target.value }))} />
        </Field>
      ))}
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Disposisi"><select className="input" disabled={!editable} value={v.disposition ?? ''} onChange={(x) => setV((s) => ({ ...s, disposition: x.target.value }))}>
          <option value="">—</option>{['HOME', 'REST', 'REFERRED', 'ADMITTED', 'RETURN_TO_WORK', 'LEFT_AGAINST_ADVICE', 'DECEASED'].map((d) => <option key={d} value={d}>{label(d)}</option>)}</select></Field>
        <Field label="Tanggal kontrol"><input type="date" className="input" disabled={!editable} value={v.follow_up_date ?? ''} onChange={(x) => setV((s) => ({ ...s, follow_up_date: x.target.value }))} /></Field>
        <label className="flex items-center gap-2 mt-6"><input type="checkbox" className="accent-canopy-600 w-4 h-4" disabled={!editable} checked={!!v.is_work_related} onChange={(x) => setV((s) => ({ ...s, is_work_related: x.target.checked }))} />Terkait pekerjaan</label>
      </div>
      <ErrorBox error={err} />
      {editable && <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={save}>{busy && <Spinner className="w-4 h-4 text-white" />}Simpan catatan</button></div>}
    </div>
  );
}

function Diagnoses({ data, id, editable, onChange }: { data: any; id: string; editable: boolean; onChange: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [type, setType] = useState('PRIMARY');
  const [occ, setOcc] = useState(false);
  const toast = useToast();
  const active = data.diagnoses.filter((d: any) => d.certainty !== 'RULED_OUT');
  const hasPrimary = active.some((d: any) => d.diagnosis_type === 'PRIMARY');
  async function add() {
    try { await api.post(`/emr/encounters/${id}/diagnoses`, { icd10Code: code, diagnosisType: hasPrimary && type === 'PRIMARY' ? 'SECONDARY' : type, isOccupational: occ }); setCode(null); setOcc(false); onChange(); }
    catch (e: any) { toast('error', e.message); }
  }
  return (
    <div className="space-y-4">
      {active.length ? (
        <table className="tbl"><thead><tr><th>ICD-10</th><th>Diagnosis</th><th>Jenis</th><th></th></tr></thead>
          <tbody>{active.map((d: any) => (
            <tr key={d.id}><td className="num">{d.icd10_code}</td><td>{d.title} {d.is_occupational && <Tag tone="gold">penyakit akibat kerja</Tag>}</td><td><Tag tone={d.diagnosis_type === 'PRIMARY' ? 'green' : 'gray'}>{label(d.diagnosis_type)}</Tag></td>
              <td className="text-right">{editable && <button className="btn-ghost btn-sm" title="Tandai salah input (ruled out)" onClick={async () => { await api.del(`/emr/encounters/${id}/diagnoses/${d.id}`); onChange(); }}><Trash2 className="w-4 h-4" /></button>}</td></tr>))}</tbody></table>
      ) : <p className="text-bark text-[13.5px]">Belum ada diagnosis. Diagnosis utama wajib sebelum rekam medis ditandatangani.</p>}
      {editable && (
        <div className="grid sm:grid-cols-[1fr_160px_auto_auto] gap-2 items-end">
          <Field label="Cari ICD-10"><RefSelect kind="icd10" value={code} onChange={setCode} placeholder="Kode atau nama penyakit" /></Field>
          <Field label="Jenis"><select className="input" value={hasPrimary && type === 'PRIMARY' ? 'SECONDARY' : type} onChange={(e) => setType(e.target.value)}>
            {!hasPrimary && <option value="PRIMARY">Utama</option>}<option value="SECONDARY">Sekunder</option><option value="DIFFERENTIAL">Diferensial</option></select></Field>
          <label className="flex items-center gap-2 h-9 text-[13px]"><input type="checkbox" className="accent-canopy-600" checked={occ} onChange={(e) => setOcc(e.target.checked)} />Akibat kerja</label>
          <button className="btn-primary" disabled={!code} onClick={add}><Plus className="w-4 h-4" />Tambah</button>
        </div>
      )}
    </div>
  );
}

function Prescriptions({ data, id, editable, onChange }: { data: any; id: string; editable: boolean; onChange: () => void }) {
  const blank = { medicineId: null as string | null, qty: '10', dose: '', frequency: '3x1', route: 'ORAL', durationDays: '3', instructions: 'Sesudah makan' };
  const [rows, setRows] = useState([{ ...blank }]);
  const [warn, setWarn] = useState<any>(null);
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function submit(withOverride?: string) {
    setBusy(true);
    try {
      const items = rows.filter((r) => r.medicineId).map((r) => ({ medicineId: r.medicineId, qty: Number(r.qty), dose: r.dose || '1 dosis', frequency: r.frequency, route: r.route,
        durationDays: r.durationDays ? Number(r.durationDays) : undefined, instructions: r.instructions || undefined }));
      const res = await api.post(`/emr/encounters/${id}/prescriptions`, { items, allergyOverrideReason: withOverride });
      if (res.warning === 'ALLERGY') { setWarn(res); return; }
      toast('ok', 'Resep dikirim ke farmasi'); setRows([{ ...blank }]); setWarn(null); setOverride(''); onChange();
    } catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      {data.prescriptions.map((rx: any) => (
        <div key={rx.id} className="border border-line rounded-md">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line bg-[#FAFBFA]"><span className="text-[13px] font-medium">{rx.prescription_no}</span><Status value={rx.status} /></div>
          <table className="tbl"><tbody>{rx.items.map((i: any) => (
            <tr key={i.id}><td>{i.medicine}</td><td className="num">{fmtNum(i.qty)} {i.unit}</td><td>{i.dose} · {i.frequency} · {label(i.route)}{i.duration_days ? ` · ${i.duration_days} hari` : ''}</td><td className="text-bark">{i.instructions}</td>
              <td className="num text-right text-bark">{i.dispensed_qty > 0 ? `diserahkan ${fmtNum(i.dispensed_qty)}` : ''}</td></tr>))}</tbody></table>
        </div>
      ))}
      {editable && (
        <div className="border border-dashed border-canopy-300 rounded-md p-3 space-y-2">
          <p className="text-[13px] font-medium">Resep baru</p>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 md:grid-cols-[2fr_70px_1fr_90px_110px_70px_1fr_auto] gap-2 items-end">
              <Field label="Obat"><RefSelect kind="medicine" value={r.medicineId} onChange={(v) => setRows((s) => s.map((x, j) => (j === i ? { ...x, medicineId: v } : x)))} /></Field>
              <Field label="Jumlah"><input className="input num" value={r.qty} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></Field>
              <Field label="Dosis"><input className="input" placeholder="500 mg" value={r.dose} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, dose: e.target.value } : x)))} /></Field>
              <Field label="Frekuensi"><input className="input" value={r.frequency} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, frequency: e.target.value } : x)))} /></Field>
              <Field label="Rute"><select className="input" value={r.route} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, route: e.target.value } : x)))}>
                {['ORAL', 'TOPICAL', 'IM', 'IV', 'SC', 'INHALATION', 'OPHTHALMIC', 'OTIC', 'RECTAL', 'OTHER'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
              <Field label="Hari"><input className="input num" value={r.durationDays} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, durationDays: e.target.value } : x)))} /></Field>
              <Field label="Aturan pakai"><input className="input" value={r.instructions} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)))} /></Field>
              <button className="btn-ghost btn-sm mb-0.5" aria-label="Hapus baris" onClick={() => setRows((s) => (s.length > 1 ? s.filter((_, j) => j !== i) : s))}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <div className="flex justify-between">
            <button className="btn-ghost btn-sm" onClick={() => setRows((s) => [...s, { ...blank }])}><Plus className="w-4 h-4" />Tambah obat</button>
            <button className="btn-primary" disabled={busy || !rows.some((r) => r.medicineId)} onClick={() => submit()}>{busy && <Spinner className="w-4 h-4 text-white" />}Kirim resep ke farmasi</button>
          </div>
        </div>
      )}
      <Modal open={!!warn} onClose={() => setWarn(null)} title="Peringatan alergi" size="sm"
        footer={<><button className="btn-secondary" onClick={() => setWarn(null)}>Ubah resep</button><button className="btn-danger" disabled={override.length < 10} onClick={() => submit(override)}>Tetap kirim</button></>}>
        <p className="flex gap-2 text-red-800"><AlertTriangle className="w-5 h-5 shrink-0" />{warn?.message}</p>
        <Field label="Alasan klinis melanjutkan (min. 10 karakter, tercatat di audit)" className="mt-3"><textarea className="input" rows={2} value={override} onChange={(e) => setOverride(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

function Labs({ data, id, editable, onChange }: { data: any; id: string; editable: boolean; onChange: () => void }) {
  const tests = useQuery({ queryKey: ['lab-tests-all'], queryFn: () => api.get('/lookup/lab_test', { limit: 50 }) });
  const [sel, setSel] = useState<string[]>([]);
  const [priority, setPriority] = useState('ROUTINE');
  const toast = useToast();
  return (
    <div className="space-y-4">
      {data.labs.map((l: any) => (
        <div key={l.id} className="border border-line rounded-md">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line bg-[#FAFBFA]"><span className="text-[13px] font-medium">{l.order_no} · {fmtDateTime(l.ordered_at)}</span><Status value={l.status} /></div>
          <table className="tbl"><tbody>{l.results.map((r: any) => (
            <tr key={r.id}><td>{r.test}</td><td className="num font-medium">{r.value_numeric ?? r.value_text ?? <span className="text-bark-400">menunggu</span>} {r.unit}</td><td className="text-bark num">{r.ref_range}</td><td>{r.flag && <Status value={r.flag === 'HIGH' || r.flag === 'LOW' ? 'ABNORMAL' : r.flag} text={label(r.flag)} />}</td></tr>))}</tbody></table>
        </div>
      ))}
      {editable && (
        <div className="border border-dashed border-canopy-300 rounded-md p-3">
          <p className="text-[13px] font-medium mb-2">Order pemeriksaan</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
            {tests.data?.data.map((t: any) => (
              <label key={t.id} className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="accent-canopy-600" checked={sel.includes(t.id)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} />{t.label}</label>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <select className="input w-36" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="ROUTINE">Rutin</option><option value="URGENT">Mendesak</option><option value="STAT">Segera (STAT)</option></select>
            <button className="btn-primary" disabled={!sel.length} onClick={async () => { try { await api.post(`/emr/encounters/${id}/lab-orders`, { testIds: sel, priority }); setSel([]); toast('ok', 'Order lab dikirim'); onChange(); } catch (e: any) { toast('error', e.message); } }}>Kirim order</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Documents({ data, id, editable, onChange }: { data: any; id: string; editable: boolean; onChange: () => void }) {
  const [mode, setMode] = useState<string | null>(null);
  const [v, setV] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  const t = todayISO();
  const open = (m: string) => {
    setErr(null); setMode(m);
    setV(m === 'sick' ? { leaveType: 'SICK_LEAVE', startDate: t, endDate: shiftDate(t, 1) } : m === 'cert' ? { certificateType: 'FIT_TO_WORK', fitStatus: 'FIT', validFrom: t, validUntil: shiftDate(t, 30) }
      : { urgency: 'ROUTINE', payerType: 'BPJS', transportMode: 'COMPANY_VEHICLE' });
  };
  async function save() {
    setBusy(true); setErr(null);
    try {
      const path = mode === 'sick' ? 'sick-leave' : mode === 'cert' ? 'certificates' : 'referrals';
      const body = { ...v }; if (body.estimatedCost) body.estimatedCost = Number(body.estimatedCost);
      await api.post(`/emr/encounters/${id}/${path}`, body);
      toast('ok', 'Dokumen diterbitkan'); setMode(null); onChange();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const set = (k: string) => (e: any) => setV((s: any) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-3 gap-3">
        <div className="border border-line rounded-md p-3"><p className="font-medium text-[13.5px] mb-2">Surat sakit</p>
          {data.sickLeaves.map((s: any) => <p key={s.id} className="text-[13px] flex justify-between items-center py-1">{s.certificate_no} · {s.days} hari <button className="btn-ghost btn-sm" onClick={() => download(`/documents/sick-leave/${s.id}.pdf`)}><Printer className="w-4 h-4" /></button></p>)}
          {editable && <button className="btn-secondary btn-sm mt-1" onClick={() => open('sick')}>Terbitkan surat sakit</button>}</div>
        <div className="border border-line rounded-md p-3"><p className="font-medium text-[13.5px] mb-2">Surat keterangan</p>
          {data.certificates.map((c: any) => <p key={c.id} className="text-[13px] flex justify-between items-center py-1">{label(c.certificate_type)} <button className="btn-ghost btn-sm" onClick={() => download(`/documents/certificate/${c.id}.pdf`)}><Printer className="w-4 h-4" /></button></p>)}
          {editable && <button className="btn-secondary btn-sm mt-1" onClick={() => open('cert')}>Terbitkan surat keterangan</button>}</div>
        <div className="border border-line rounded-md p-3"><p className="font-medium text-[13.5px] mb-2">Rujukan</p>
          {data.referrals.map((r: any) => <p key={r.id} className="text-[13px] flex justify-between items-center py-1">{r.hospital_name} <span className="flex gap-1 items-center"><Status value={r.status} /><button className="btn-ghost btn-sm" onClick={() => download(`/documents/referral/${r.id}.pdf`)}><Printer className="w-4 h-4" /></button></span></p>)}
          {editable && <button className="btn-secondary btn-sm mt-1" onClick={() => open('ref')}>Buat rujukan</button>}</div>
      </div>
      <p className="text-[12.5px] text-bark">Surat sakit dan surat keterangan tidak mencantumkan diagnosis — HR hanya melihat status administratif.</p>
      <Modal open={!!mode} onClose={() => setMode(null)} title={mode === 'sick' ? 'Surat sakit / istirahat' : mode === 'cert' ? 'Surat keterangan dokter' : 'Rujukan ke rumah sakit'}
        footer={<><button className="btn-secondary" onClick={() => setMode(null)}>Batal</button><button className="btn-primary" disabled={busy} onClick={save}>{busy && <Spinner className="w-4 h-4 text-white" />}Terbitkan</button></>}>
        <div className="grid sm:grid-cols-2 gap-3">
          {mode === 'sick' && <>
            <Field label="Jenis"><select className="input" value={v.leaveType} onChange={set('leaveType')}>{['SICK_LEAVE', 'REST_RECOMMENDATION', 'WORK_ACCIDENT_LEAVE', 'MATERNITY'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field><div />
            <Field label="Mulai"><input type="date" className="input" value={v.startDate} onChange={set('startDate')} /></Field>
            <Field label="Sampai"><input type="date" className="input" value={v.endDate} onChange={set('endDate')} /></Field>
            <Field label="Catatan administratif" className="sm:col-span-2"><input className="input" value={v.adminRemarks ?? ''} onChange={set('adminRemarks')} /></Field>
          </>}
          {mode === 'cert' && <>
            <Field label="Jenis surat"><select className="input" value={v.certificateType} onChange={set('certificateType')}>{['FIT_TO_WORK', 'RETURN_TO_WORK', 'MEDICAL_CERTIFICATE', 'REST_RECOMMENDATION', 'HEALTH_STATEMENT'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Status kelaikan"><select className="input" value={v.fitStatus ?? ''} onChange={set('fitStatus')}><option value="">—</option>{['FIT', 'FIT_WITH_RESTRICTION', 'TEMPORARILY_UNFIT', 'UNFIT'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Pembatasan" className="sm:col-span-2"><input className="input" value={v.restrictions ?? ''} onChange={set('restrictions')} /></Field>
            <Field label="Keperluan" className="sm:col-span-2"><input className="input" value={v.purpose ?? ''} onChange={set('purpose')} /></Field>
            <Field label="Berlaku dari"><input type="date" className="input" value={v.validFrom} onChange={set('validFrom')} /></Field>
            <Field label="Berlaku sampai"><input type="date" className="input" value={v.validUntil} onChange={set('validUntil')} /></Field>
          </>}
          {mode === 'ref' && <>
            <Field label="Rumah sakit" className="sm:col-span-2"><RefSelect kind="hospital" value={v.hospitalId} onChange={set('hospitalId')} /></Field>
            <Field label="Urgensi"><select className="input" value={v.urgency} onChange={set('urgency')}>{['ROUTINE', 'URGENT', 'EMERGENCY'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Spesialis tujuan"><input className="input" value={v.specialtyNeeded ?? ''} onChange={set('specialtyNeeded')} /></Field>
            <Field label="Alasan rujukan" className="sm:col-span-2"><textarea className="input" rows={3} value={v.reason ?? ''} onChange={set('reason')} /></Field>
            <Field label="Transportasi"><select className="input" value={v.transportMode} onChange={set('transportMode')}>{['AMBULANCE', 'COMPANY_VEHICLE', 'PRIVATE', 'OTHER'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Penjamin"><select className="input" value={v.payerType} onChange={set('payerType')}>{['BPJS', 'COMPANY', 'INSURANCE', 'SELF'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Estimasi biaya (Rp)"><input className="input num" value={v.estimatedCost ?? ''} onChange={set('estimatedCost')} /></Field>
          </>}
        </div>
        <div className="mt-3"><ErrorBox error={err} /></div>
      </Modal>
    </div>
  );
}

export default function Encounter() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('soap');
  const [signing, setSigning] = useState(false);
  const [addendum, setAddendum] = useState(false);
  const [add, setAdd] = useState({ reason: '', content: '' });
  const [proc, setProc] = useState('');
  const q = useQuery({ queryKey: ['encounter', id], queryFn: () => api.get(`/emr/encounters/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['encounter', id] });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data; const e = d.encounter; const p = d.patient;
  const editable = d.canEdit && e.status === 'OPEN';
  const v = d.vitals[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] text-bark">{e.encounter_no} · {e.clinic_name} · {fmtDateTime(e.started_at)}</p>
          <h1 className="text-[22px] font-semibold">{p.full_name} <span className="text-bark font-normal text-[16px]">{label(p.gender)}, {p.age} th</span></h1>
          <p className="text-[13px] text-bark">{p.mrn} · {label(p.patient_type)}{p.employee_no ? ` · ${p.employee_no}` : ''}{p.position_name ? ` · ${p.position_name}` : ''}{p.unit_name ? ` — ${p.unit_name}` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Status value={e.status} />
          <Link to={`/patients/${p.id}`} className="btn-secondary"><History className="w-4 h-4" />Riwayat medis</Link>
          {e.status === 'SIGNED' && d.canEdit && <button className="btn-secondary" onClick={() => setAddendum(true)}>Tambah addendum</button>}
          {editable && <button className="btn-primary" onClick={() => setSigning(true)}><Lock className="w-4 h-4" />Tanda tangani & selesai</button>}
        </div>
      </div>
      {e.status === 'SIGNED' && <p className="text-[13px] text-canopy-700 bg-canopy-50 border border-canopy-100 rounded-md px-3 py-2">Ditandatangani {e.signed_by_name} pada {fmtDateTime(e.signed_at)}. Rekam medis bersifat final; koreksi dicatat sebagai addendum.</p>}
      {!d.canEdit && <p className="text-[13px] text-bark bg-mist border border-line rounded-md px-3 py-2">Mode baca — rekam medis dari klinik lain terlihat karena pasien sedang dalam perawatan Anda. Setiap pembukaan tercatat di audit trail.</p>}

      <div className="grid xl:grid-cols-[300px_1fr] gap-4">
        <aside className="space-y-4">
          <Panel title="Alergi">
            {d.allergies.length ? d.allergies.map((a: any) => <p key={a.id} className="text-[13.5px] text-red-800 py-0.5"><AlertTriangle className="inline w-3.5 h-3.5 mr-1" />{a.allergen} <span className="text-bark">({label(a.severity)}{a.reaction ? `, ${a.reaction}` : ''})</span></p>)
              : <p className="text-[13px] text-bark">Tidak ada alergi tercatat</p>}
          </Panel>
          <Panel title="Tanda vital terakhir">
            {v ? <KV cols={2} items={[['TD', v.systolic ? `${v.systolic}/${v.diastolic} mmHg` : null], ['Nadi', v.heart_rate && `${v.heart_rate}x/mnt`], ['Suhu', v.temperature_c && `${v.temperature_c} °C`],
              ['SpO₂', v.spo2 && `${v.spo2}%`], ['Napas', v.respiratory_rate && `${v.respiratory_rate}x/mnt`], ['BMI', v.bmi], ['Gula darah', v.blood_glucose], ['Nyeri', v.pain_score]]} />
              : <p className="text-[13px] text-bark">Belum diukur</p>}
          </Panel>
          <Panel title="Riwayat & risiko kerja">
            {d.history.map((h: any) => <p key={h.id} className="text-[13px] py-0.5"><Tag>{label(h.history_type)}</Tag> {h.description}</p>)}
            {p.risk_name && <p className="text-[13px] mt-2">Risiko pekerjaan: <span className="font-medium">{p.risk_name}</span></p>}
            {!d.history.length && !p.risk_name && <p className="text-[13px] text-bark">Tidak ada catatan</p>}
          </Panel>
        </aside>
        <section className="panel">
          <div className="px-4 pt-2"><Tabs value={tab} onChange={setTab} tabs={[
            { id: 'soap', label: 'Pemeriksaan (SOAP)' }, { id: 'dx', label: 'Diagnosis', count: d.diagnoses.filter((x: any) => x.certainty !== 'RULED_OUT').length },
            { id: 'proc', label: 'Tindakan', count: d.procedures.length }, { id: 'rx', label: 'Resep', count: d.prescriptions.length }, { id: 'lab', label: 'Laboratorium', count: d.labs.length },
            { id: 'docs', label: 'Surat & rujukan', count: d.sickLeaves.length + d.certificates.length + d.referrals.length }, { id: 'add', label: 'Addendum', count: d.addenda.length }]} /></div>
          <div className="p-4">
            {tab === 'soap' && <Soap e={e} editable={editable} onSaved={refresh} />}
            {tab === 'dx' && <Diagnoses data={d} id={e.id} editable={editable} onChange={refresh} />}
            {tab === 'proc' && (
              <div className="space-y-3">
                {d.procedures.length ? <table className="tbl"><tbody>{d.procedures.map((x: any) => <tr key={x.id}><td>{x.description}</td><td className="text-bark">{x.performed_by_name}</td><td className="num text-bark">{fmtDateTime(x.performed_at)}</td></tr>)}</tbody></table>
                  : <p className="text-bark text-[13.5px]">Belum ada tindakan.</p>}
                {editable && <div className="flex gap-2"><input className="input" placeholder="mis. Hecting 3 jahitan, perawatan luka, nebulisasi" value={proc} onChange={(x) => setProc(x.target.value)} />
                  <button className="btn-primary" disabled={proc.length < 2} onClick={async () => { try { await api.post(`/emr/encounters/${e.id}/procedures`, { description: proc }); setProc(''); refresh(); } catch (x: any) { toast('error', x.message); } }}>Tambah</button></div>}
              </div>
            )}
            {tab === 'rx' && <Prescriptions data={d} id={e.id} editable={editable} onChange={refresh} />}
            {tab === 'lab' && <Labs data={d} id={e.id} editable={editable || (d.canEdit && e.status === 'SIGNED')} onChange={refresh} />}
            {tab === 'docs' && <Documents data={d} id={e.id} editable={d.canEdit} onChange={refresh} />}
            {tab === 'add' && (d.addenda.length ? d.addenda.map((a: any) => (
              <div key={a.id} className="border-l-2 border-kernel pl-3 py-1 mb-3"><p className="text-[12.5px] text-bark">{a.author_name} · {fmtDateTime(a.created_at)} · {a.reason}</p><p className="whitespace-pre-wrap">{a.content}</p></div>))
              : <Empty title="Belum ada addendum" hint="Addendum dipakai untuk koreksi atau tambahan setelah rekam medis ditandatangani." />)}
          </div>
        </section>
      </div>

      <Confirm open={signing} title="Tanda tangani rekam medis?" confirmText="Tanda tangani"
        message="Setelah ditandatangani, catatan klinis tidak dapat diubah. Pasien akan diteruskan ke farmasi bila ada resep, atau kunjungan ditutup."
        onClose={() => setSigning(false)}
        onConfirm={async () => { try { await api.post(`/emr/encounters/${e.id}/sign`); toast('ok', 'Rekam medis ditandatangani'); setSigning(false); refresh(); } catch (x: any) { toast('error', x.message); setSigning(false); } }} />
      <Modal open={addendum} onClose={() => setAddendum(false)} title="Addendum rekam medis"
        footer={<><button className="btn-secondary" onClick={() => setAddendum(false)}>Batal</button><button className="btn-primary" disabled={add.reason.length < 5 || add.content.length < 5}
          onClick={async () => { try { await api.post(`/emr/encounters/${e.id}/addenda`, add); setAddendum(false); setAdd({ reason: '', content: '' }); refresh(); toast('ok', 'Addendum disimpan'); } catch (x: any) { toast('error', x.message); } }}>Simpan addendum</button></>}>
        <Field label="Alasan"><input className="input" value={add.reason} onChange={(x) => setAdd((s) => ({ ...s, reason: x.target.value }))} /></Field>
        <Field label="Isi addendum" className="mt-3"><textarea className="input" rows={5} value={add.content} onChange={(x) => setAdd((s) => ({ ...s, content: x.target.value }))} /></Field>
      </Modal>
    </div>
  );
}
