import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, History, Lock, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, fmtNum, label, shiftDate, todayISO } from '../lib/format';
import { go } from '../lib/router';
import { LookupPicker } from '../components/LookupPicker';
import { Badge, Empty, ErrorBox, Field, IconButton, Loading, Segments, Sheet, Spinner, TopBar, cx, useToast } from '../components/ui';

const SOAP: [string, string, number][] = [
  ['chief_complaint', 'Keluhan utama (S)', 2], ['history_of_present_illness', 'Riwayat penyakit sekarang (S)', 3], ['physical_exam', 'Pemeriksaan fisik (O)', 3],
  ['assessment', 'Assessment (A)', 2], ['plan', 'Rencana (P)', 3], ['doctor_notes', 'Catatan dokter (rahasia, terenkripsi)', 2],
];

function Soap({ e, editable, onSaved }: { e: any; editable: boolean; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  useEffect(() => {
    setV(Object.fromEntries([...SOAP.map(([k]) => [k, e[k] ?? '']), ['disposition', e.disposition ?? ''], ['follow_up_date', e.follow_up_date ?? ''], ['is_work_related', !!e.is_work_related]]));
  }, [e.id, e.version]);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const body: any = { version: e.version };
      for (const k of Object.keys(v)) if ((v[k] ?? '') !== (e[k] ?? (k === 'is_work_related' ? false : ''))) body[k] = v[k] === '' ? null : v[k];
      if (Object.keys(body).length === 1) { toast('info', 'Tidak ada perubahan'); return; }
      await api.patch(`/emr/encounters/${e.id}`, body);
      toast('ok', 'Catatan pemeriksaan disimpan'); onSaved();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      {SOAP.map(([k, l, rows]) => (
        <Field key={k} label={l}><textarea className={cx('input', k === 'doctor_notes' && 'bg-kernel-50')} rows={rows} value={v[k] ?? ''} disabled={!editable} onChange={(x) => setV((s) => ({ ...s, [k]: x.target.value }))} /></Field>
      ))}
      <Field label="Disposisi"><select className="input" disabled={!editable} value={v.disposition ?? ''} onChange={(x) => setV((s) => ({ ...s, disposition: x.target.value }))}>
        <option value="">—</option>{['HOME', 'REST', 'REFERRED', 'ADMITTED', 'RETURN_TO_WORK', 'LEFT_AGAINST_ADVICE'].map((d) => <option key={d} value={d}>{label(d)}</option>)}</select></Field>
      <Field label="Tanggal kontrol"><input type="date" className="input" disabled={!editable} value={v.follow_up_date ?? ''} onChange={(x) => setV((s) => ({ ...s, follow_up_date: x.target.value }))} /></Field>
      <label className="flex items-center gap-3 py-1"><input type="checkbox" className="w-6 h-6 accent-canopy-600" disabled={!editable} checked={!!v.is_work_related} onChange={(x) => setV((s) => ({ ...s, is_work_related: x.target.checked }))} />Terkait pekerjaan</label>
      <ErrorBox error={err} />
      {editable && <button className="btn-primary w-full" disabled={busy} onClick={save}>{busy && <Spinner />}Simpan catatan</button>}
    </div>
  );
}

function Diagnoses({ d, editable, onChange }: { d: any; editable: boolean; onChange: () => void }) {
  const [pick, setPick] = useState(false);
  const [occ, setOcc] = useState(false);
  const toast = useToast();
  const active = d.diagnoses.filter((x: any) => x.certainty !== 'RULED_OUT');
  const hasPrimary = active.some((x: any) => x.diagnosis_type === 'PRIMARY');
  async function add(code: string) {
    try { await api.post(`/emr/encounters/${d.encounter.id}/diagnoses`, { icd10Code: code, diagnosisType: hasPrimary ? 'SECONDARY' : 'PRIMARY', isOccupational: occ }); setOcc(false); onChange(); }
    catch (e: any) { toast('error', e.message); }
  }
  return (
    <div className="space-y-3">
      {active.length === 0 && <p className="text-[14.5px] text-bark">Belum ada diagnosis. Diagnosis utama wajib sebelum rekam medis ditandatangani.</p>}
      {active.map((x: any) => (
        <div key={x.id} className="card px-4 py-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-medium"><span className="num text-canopy-700">{x.icd10_code}</span> · {x.title}</p>
            <p className="mt-1 flex gap-1.5 flex-wrap"><Badge value={x.diagnosis_type === 'PRIMARY' ? 'COMPLETED' : 'NORMAL'} text={label(x.diagnosis_type)} />{x.is_occupational && <Badge value="PHARMACY" text="Akibat kerja" />}</p>
          </div>
          {editable && <button className="w-11 h-11 grid place-items-center rounded-full text-bark active:bg-mist" aria-label={`Hapus diagnosis ${x.icd10_code}`}
            onClick={async () => { await api.del(`/emr/encounters/${d.encounter.id}/diagnoses/${x.id}`); onChange(); }}><Trash2 className="w-5 h-5" /></button>}
        </div>
      ))}
      {editable && <>
        <label className="flex items-center gap-3 py-1"><input type="checkbox" className="w-6 h-6 accent-canopy-600" checked={occ} onChange={(e) => setOcc(e.target.checked)} />Diagnosis berikutnya penyakit akibat kerja</label>
        <button className="btn-secondary w-full" onClick={() => setPick(true)}><Plus className="w-5 h-5" />{hasPrimary ? 'Tambah diagnosis sekunder' : 'Tambah diagnosis utama'}</button>
      </>}
      <LookupPicker kind="icd10" title="Cari ICD-10" placeholder="Kode atau nama penyakit" open={pick} onClose={() => setPick(false)} onPick={(it) => add(it.id)} />
    </div>
  );
}

type RxRow = { medicineId: string; name: string; qty: string; dose: string; frequency: string; durationDays: string; instructions: string };

function Prescriptions({ d, editable, onChange }: { d: any; editable: boolean; onChange: () => void }) {
  const [rows, setRows] = useState<RxRow[]>([]);
  const [pick, setPick] = useState(false);
  const [warn, setWarn] = useState<any>(null);
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (i: number, k: keyof RxRow, val: string) => setRows((s) => s.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  async function submit(withOverride?: string) {
    setBusy(true);
    try {
      const items = rows.map((r) => ({ medicineId: r.medicineId, qty: Number(r.qty), dose: r.dose || '1 dosis', frequency: r.frequency, route: 'ORAL',
        durationDays: r.durationDays ? Number(r.durationDays) : undefined, instructions: r.instructions || undefined }));
      const res = await api.post(`/emr/encounters/${d.encounter.id}/prescriptions`, { items, allergyOverrideReason: withOverride });
      if (res.warning === 'ALLERGY') { setWarn(res); return; }
      toast('ok', 'Resep dikirim ke farmasi'); setRows([]); setWarn(null); setOverride(''); onChange();
    } catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3">
      {d.prescriptions.map((rx: any) => (
        <div key={rx.id} className="card">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line"><span className="text-[14px] font-medium">{rx.prescription_no}</span><Badge value={rx.status} /></div>
          <ul className="divide-y divide-line">{rx.items.map((i: any) => (
            <li key={i.id} className="px-4 py-2.5"><p className="font-medium text-[15px]">{i.medicine} <span className="text-bark font-normal num">· {fmtNum(i.qty)} {i.unit}</span></p>
              <p className="text-[13.5px] text-bark">{[i.dose, i.frequency, i.duration_days && `${i.duration_days} hari`, i.instructions].filter(Boolean).join(' · ')}</p></li>))}</ul>
        </div>
      ))}
      {!d.prescriptions.length && !rows.length && <p className="text-[14.5px] text-bark">Belum ada resep.</p>}
      {editable && <>
        {rows.map((r, i) => (
          <div key={i} className="card p-4 space-y-3 border-dashed border-canopy-300">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{r.name}</p>
              <button className="w-10 h-10 -mt-2 -mr-2 grid place-items-center rounded-full text-bark active:bg-mist" aria-label={`Hapus ${r.name}`} onClick={() => setRows((s) => s.filter((_, j) => j !== i))}><Trash2 className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Jumlah"><input className="input num" inputMode="numeric" value={r.qty} onChange={(e) => set(i, 'qty', e.target.value.replace(/\D/g, ''))} /></Field>
              <Field label="Dosis"><input className="input" placeholder="500 mg" value={r.dose} onChange={(e) => set(i, 'dose', e.target.value)} /></Field>
              <Field label="Frekuensi"><input className="input" value={r.frequency} onChange={(e) => set(i, 'frequency', e.target.value)} /></Field>
              <Field label="Lama (hari)"><input className="input num" inputMode="numeric" value={r.durationDays} onChange={(e) => set(i, 'durationDays', e.target.value.replace(/\D/g, ''))} /></Field>
            </div>
            <Field label="Aturan pakai"><input className="input" value={r.instructions} onChange={(e) => set(i, 'instructions', e.target.value)} /></Field>
          </div>
        ))}
        <button className="btn-secondary w-full" onClick={() => setPick(true)}><Plus className="w-5 h-5" />Tambah obat</button>
        {rows.length > 0 && <button className="btn-primary w-full" disabled={busy || rows.some((r) => !Number(r.qty))} onClick={() => submit()}>{busy && <Spinner />}Kirim resep ke farmasi</button>}
      </>}
      <LookupPicker kind="medicine" title="Cari obat" placeholder="Nama obat atau generik" open={pick} onClose={() => setPick(false)}
        onPick={(it) => setRows((s) => [...s, { medicineId: it.id, name: it.label, qty: '10', dose: '', frequency: '3x1', durationDays: '3', instructions: 'Sesudah makan' }])} />
      <Sheet open={!!warn} onClose={() => setWarn(null)} title="Peringatan alergi"
        footer={<><button className="btn-secondary flex-1" onClick={() => setWarn(null)}>Ubah resep</button><button className="btn-danger flex-1" disabled={override.trim().length < 10} onClick={() => submit(override)}>Tetap kirim</button></>}>
        <p className="flex gap-2 text-red-800"><AlertTriangle className="w-5 h-5 shrink-0" />{warn?.message}</p>
        <Field label="Alasan klinis melanjutkan (min. 10 karakter, tercatat di audit)" className="mt-4"><textarea className="input" rows={3} value={override} onChange={(e) => setOverride(e.target.value)} /></Field>
      </Sheet>
    </div>
  );
}

function SickLeave({ d, editable, onChange }: { d: any; editable: boolean; onChange: () => void }) {
  const t = todayISO();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ leaveType: 'SICK_LEAVE', startDate: t, endDate: shiftDate(t, 1), adminRemarks: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  const days = Math.round((new Date(v.endDate).getTime() - new Date(v.startDate).getTime()) / 86400000) + 1;
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/emr/encounters/${d.encounter.id}/sick-leave`, { ...v, adminRemarks: v.adminRemarks || undefined });
      toast('ok', 'Surat sakit diterbitkan dan dikirim ke HR'); setOpen(false); onChange();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3">
      {d.sickLeaves.map((s: any) => (
        <div key={s.id} className="card px-4 py-3 flex items-center justify-between gap-3">
          <div><p className="font-medium num">{s.certificate_no}</p><p className="text-[13.5px] text-bark">{label(s.leave_type)} · {s.days} hari</p></div><Badge value={s.status} />
        </div>
      ))}
      {!d.sickLeaves.length && <p className="text-[14.5px] text-bark">Belum ada surat sakit untuk kunjungan ini.</p>}
      <p className="text-[13.5px] text-bark">Surat sakit tidak mencantumkan diagnosis. HR hanya melihat nomor surat, tanggal, dan jumlah hari; keasliannya dicek lewat QR pada surat cetak.</p>
      {editable && <button className="btn-secondary w-full" onClick={() => { setErr(null); setOpen(true); }}><Plus className="w-5 h-5" />Terbitkan surat sakit</button>}
      <Sheet open={open} onClose={() => setOpen(false)} title="Surat sakit / istirahat"
        footer={<><button className="btn-secondary flex-1" onClick={() => setOpen(false)}>Batal</button><button className="btn-primary flex-[2]" disabled={busy || days < 1} onClick={save}>{busy && <Spinner />}Terbitkan · {Math.max(days, 0)} hari</button></>}>
        <div className="space-y-4">
          <Field label="Jenis"><select className="input" value={v.leaveType} onChange={(e) => setV((s) => ({ ...s, leaveType: e.target.value }))}>
            {['SICK_LEAVE', 'REST_RECOMMENDATION', 'WORK_ACCIDENT_LEAVE', 'MATERNITY'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mulai"><input type="date" className="input" value={v.startDate} onChange={(e) => setV((s) => ({ ...s, startDate: e.target.value }))} /></Field>
            <Field label="Sampai"><input type="date" className="input" value={v.endDate} onChange={(e) => setV((s) => ({ ...s, endDate: e.target.value }))} /></Field>
          </div>
          <Field label="Catatan administratif (opsional)"><input className="input" value={v.adminRemarks} onChange={(e) => setV((s) => ({ ...s, adminRemarks: e.target.value }))} /></Field>
          <ErrorBox error={err} />
        </div>
      </Sheet>
    </div>
  );
}

export default function Encounter({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('soap');
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['encounter', id], queryFn: () => api.get(`/emr/encounters/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['encounter', id] }); qc.invalidateQueries({ queryKey: ['queue'] }); };
  const back = <IconButton label="Kembali" onClick={() => history.back()}><ArrowLeft className="w-6 h-6" /></IconButton>;
  if (q.isLoading) return <><TopBar title="Pemeriksaan" left={back} /><Loading /></>;
  if (q.error) return <><TopBar title="Pemeriksaan" left={back} /><div className="p-4"><ErrorBox error={q.error} /></div></>;
  const d = q.data; const e = d.encounter; const p = d.patient; const v = d.vitals[0];
  const editable = d.canEdit && e.status === 'OPEN';
  const vit: [string, any][] = v ? [['TD', v.systolic && `${v.systolic}/${v.diastolic}`], ['Nadi', v.heart_rate], ['Suhu', v.temperature_c && `${v.temperature_c}°`], ['SpO₂', v.spo2 && `${v.spo2}%`], ['Napas', v.respiratory_rate], ['BB', v.weight_kg && `${v.weight_kg} kg`]] : [];
  return (
    <div className={cx(editable ? 'pb-44' : 'pb-24')}>
      <TopBar title={p.full_name} subtitle={`${label(p.gender)}, ${p.age} th · ${p.mrn}`} left={back}
        right={<IconButton label="Riwayat medis" onClick={() => go({ name: 'patient', id: p.id })}><History className="w-5 h-5" /></IconButton>} />
      <div className="px-4 pt-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] text-bark">{e.encounter_no} · {fmtDateTime(e.started_at)}</p><Badge value={e.status} />
        </div>
        {d.allergies.length > 0 && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-red-800 text-[14px]">
            <p className="font-medium flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />Alergi</p>
            {d.allergies.map((a: any) => <p key={a.id}>{a.allergen} ({label(a.severity)}{a.reaction ? `, ${a.reaction}` : ''})</p>)}
          </div>
        )}
        {vit.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {vit.map(([k, val]) => <div key={k} className="card px-3 py-2"><p className="text-[12px] text-bark">{k}</p><p className="font-medium num">{val ?? '–'}</p></div>)}
          </div>
        )}
        {(p.position_name || p.risk_name) && <p className="text-[13.5px] text-bark">{[p.position_name, p.unit_name, p.risk_name && `risiko: ${p.risk_name}`].filter(Boolean).join(' · ')}</p>}
        {e.status === 'SIGNED' && <p className="text-[14px] text-canopy-700 bg-canopy-50 border border-canopy-100 rounded-xl px-3.5 py-2.5">Ditandatangani {e.signed_by_name} · {fmtDateTime(e.signed_at)}. Koreksi dilakukan lewat addendum di aplikasi web.</p>}
        {!d.canEdit && <p className="text-[14px] text-bark bg-white border border-line rounded-xl px-3.5 py-2.5">Mode baca. Setiap pembukaan rekam medis tercatat di audit trail.</p>}
      </div>
      <Segments fill value={tab} onChange={setTab} items={[
        { id: 'soap', label: 'Pemeriksaan' }, { id: 'dx', label: 'Diagnosis', count: d.diagnoses.filter((x: any) => x.certainty !== 'RULED_OUT').length },
        { id: 'rx', label: 'Resep', count: d.prescriptions.length }, { id: 'sick', label: 'Surat', count: d.sickLeaves.length }]} />
      <div className="px-4">
        {tab === 'soap' && <Soap e={e} editable={editable} onSaved={refresh} />}
        {tab === 'dx' && <Diagnoses d={d} editable={editable} onChange={refresh} />}
        {tab === 'rx' && <Prescriptions d={d} editable={editable} onChange={refresh} />}
        {tab === 'sick' && <SickLeave d={d} editable={d.canEdit} onChange={refresh} />}
      </div>
      {editable && (
        <div className="fixed left-0 right-0 bottom-[68px] z-20 px-4 pb-2">
          <button className="btn-primary w-full shadow-lg" onClick={() => setSigning(true)}><Lock className="w-5 h-5" />Tanda tangani & selesai</button>
        </div>
      )}
      <Sheet open={signing} onClose={() => setSigning(false)} title="Tanda tangani rekam medis?"
        footer={<><button className="btn-secondary flex-1" onClick={() => setSigning(false)}>Batal</button>
          <button className="btn-primary flex-[2]" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/emr/encounters/${e.id}/sign`); toast('ok', 'Rekam medis ditandatangani'); setSigning(false); refresh(); }
            catch (x: any) { toast('error', x.message); setSigning(false); } finally { setBusy(false); }
          }}>{busy && <Spinner />}Tanda tangani</button></>}>
        <p className="text-[15px] text-bark-700">Setelah ditandatangani, catatan klinis tidak dapat diubah. Pasien diteruskan ke farmasi bila ada resep, atau kunjungan ditutup.</p>
        {!d.diagnoses.some((x: any) => x.diagnosis_type === 'PRIMARY' && x.certainty !== 'RULED_OUT') && <p className="mt-3 text-[14px] text-amber-800 bg-amber-50 rounded-xl px-3.5 py-2.5">Diagnosis utama belum diisi.</p>}
      </Sheet>
      {!d.canEdit && !d.diagnoses.length && !d.prescriptions.length && tab !== 'soap' && <Empty title="Tidak ada data" />}
    </div>
  );
}
