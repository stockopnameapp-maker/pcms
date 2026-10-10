import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, RefreshCw, ScanLine, Search, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtTime, label, todayISO } from '../lib/format';
import { useSession } from '../lib/session';
import { go } from '../lib/router';
import { Scanner } from '../components/Scanner';
import { Badge, Empty, ErrorBox, Field, IconButton, Loading, Segments, Sheet, Spinner, TopBar, cx, useToast } from '../components/ui';

const FILTERS = [
  { id: 'ACTIVE', label: 'Aktif' }, { id: 'WAITING', label: 'Menunggu' }, { id: 'TRIAGE', label: 'Triase' }, { id: 'WAITING_DOCTOR', label: 'Menunggu dokter' },
  { id: 'IN_CONSULTATION', label: 'Konsultasi' }, { id: 'PHARMACY', label: 'Farmasi' }, { id: 'COMPLETED', label: 'Selesai' },
];
const ACTIVE = ['WAITING', 'TRIAGE', 'WAITING_DOCTOR', 'IN_CONSULTATION', 'PHARMACY'];
const TRIAGE_DOT: Record<string, string> = { RED: 'bg-sev-critical', YELLOW: 'bg-amber-400', GREEN: 'bg-canopy-500', BLACK: 'bg-ink' };

export function ClinicSwitcher() {
  const { clinics, clinic, setClinic } = useSession();
  const [open, setOpen] = useState(false);
  if (clinics.length <= 1) return null;
  return (
    <>
      <IconButton label="Ganti klinik" onClick={() => setOpen(true)}><ChevronDown className="w-6 h-6" /></IconButton>
      <Sheet open={open} onClose={() => setOpen(false)} title="Pilih klinik">
        <ul className="divide-y divide-line">
          {clinics.map((c) => (
            <li key={c.id}><button className={cx('w-full text-left py-3.5 px-1 flex justify-between items-center', c.id === clinic?.id && 'text-canopy-700 font-medium')}
              onClick={() => { setClinic(c.id); setOpen(false); }}>{c.name}<span className="text-[13px] text-bark">{c.code}</span></button></li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}

/** Patient search used by registration and the Patients tab; QR scans land in the same search. */
export function PatientSearch({ onPick, autoFocus }: { onPick: (p: any) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [d, setD] = useState('');
  const [scan, setScan] = useState(false);
  useEffect(() => { const t = setTimeout(() => setD(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const r = useQuery({ queryKey: ['patient-lookup', d], queryFn: () => api.get('/patients/lookup', { q: d }), enabled: d.length >= 3 });
  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-5 h-5 absolute left-3.5 top-3.5 text-bark-400" aria-hidden />
          <input className="input pl-11" placeholder="Nama, No. karyawan, NIK, No. RM" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} aria-label="Cari pasien" />
        </div>
        <button className="btn-secondary w-12 px-0" aria-label="Pindai kartu QR" onClick={() => setScan(true)}><ScanLine className="w-6 h-6 text-canopy-700" /></button>
      </div>
      <div className="mt-3">
        {d.length > 0 && d.length < 3 && <p className="text-[14px] text-bark">Ketik minimal 3 karakter.</p>}
        {r.isFetching && <p className="flex items-center gap-2 text-[14px] text-bark"><Spinner className="w-4 h-4" />Mencari…</p>}
        <ErrorBox error={r.error} />
        {r.data?.data?.length === 0 && <p className="text-[14px] text-bark">Tidak ditemukan.</p>}
        <ul className="space-y-2">
          {r.data?.data?.map((p: any, i: number) => (
            <li key={i}><button className="card w-full text-left px-4 py-3 active:bg-canopy-50" onClick={() => onPick(p)}>
              <span className="flex items-center gap-2 flex-wrap"><span className="font-medium text-[15.5px]">{p.full_name}</span><Badge value={p.patient_type} /></span>
              <span className="block text-[13.5px] text-bark mt-0.5">{[p.mrn, p.employee_no, p.birth_date && fmtDate(p.birth_date), p.unit_name].filter(Boolean).join(' · ')}</span>
              {p.kind !== 'PATIENT' && <span className="block text-[13px] text-kernel mt-0.5">Belum punya rekam medis — dibuat saat registrasi</span>}
            </button></li>
          ))}
        </ul>
      </div>
      {scan && <Scanner onClose={() => setScan(false)} onResult={(t) => { setScan(false); setQ(t); setD(t); }} />}
    </div>
  );
}

function RegisterSheet({ clinicId, open, onClose, onDone }: { clinicId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const [sel, setSel] = useState<any>(null);
  const [priority, setPriority] = useState('NORMAL');
  const [source, setSource] = useState('WALK_IN');
  const [complaint, setComplaint] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  useEffect(() => { if (!open) { setSel(null); setErr(null); setPriority('NORMAL'); setSource('WALK_IN'); setComplaint(''); } }, [open]);
  async function register() {
    setBusy(true); setErr(null);
    try {
      const body: any = { clinicId, priority, source, complaint: complaint.trim() || undefined };
      if (sel.patient_id) body.patientId = sel.patient_id; else { body.kind = sel.kind; body.refId = sel.kind === 'FAMILY' ? sel.family_member_id : sel.employee_id; }
      const res = await api.post('/queue/register', body);
      toast('ok', `${sel.full_name} terdaftar · nomor ${res.queueCode}`);
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={sel ? 'Daftarkan ke antrian' : 'Registrasi pasien'}
      footer={sel && <>
        <button className="btn-secondary flex-1" onClick={() => setSel(null)}>Kembali</button>
        <button className={cx('flex-[2]', priority === 'EMERGENCY' ? 'btn-danger' : 'btn-primary')} disabled={busy} onClick={register}>
          {busy && <Spinner />}{priority === 'EMERGENCY' && <AlertTriangle className="w-5 h-5" />}Daftarkan</button>
      </>}>
      {!sel ? <PatientSearch onPick={setSel} autoFocus /> : (
        <div className="space-y-4">
          <div className="rounded-xl bg-canopy-50 border border-canopy-100 px-4 py-3">
            <p className="font-medium">{sel.full_name}</p>
            <p className="text-[13.5px] text-bark">{label(sel.patient_type)}{sel.mrn ? ` · ${sel.mrn}` : ''}{sel.unit_name ? ` · ${sel.unit_name}` : ''}</p>
          </div>
          <div>
            <span className="label">Prioritas</span>
            <div className="grid grid-cols-3 gap-2">
              {[['NORMAL', 'Normal'], ['PRIORITY', 'Prioritas'], ['EMERGENCY', 'Gawat darurat']].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setPriority(k)} aria-pressed={priority === k}
                  className={cx('btn-secondary btn-sm', priority === k && (k === 'EMERGENCY' ? 'border-sev-critical text-sev-critical bg-red-50' : 'border-canopy-600 text-canopy-700 bg-canopy-50'))}>{l}</button>))}
            </div>
          </div>
          <Field label="Sumber kunjungan"><select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            {['WALK_IN', 'APPOINTMENT', 'ACCIDENT', 'FOLLOW_UP', 'REFERRAL_RETURN', 'MCU'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          <Field label="Keluhan singkat (opsional)"><input className="input" value={complaint} onChange={(e) => setComplaint(e.target.value)} placeholder="mis. demam 2 hari" /></Field>
          <ErrorBox error={err} />
        </div>
      )}
    </Sheet>
  );
}

export function TriageSheet({ ticket, onClose, onDone }: { ticket: any; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [complaint, setComplaint] = useState(ticket.chief_complaint ?? '');
  const [level, setLevel] = useState(ticket.priority === 'EMERGENCY' ? 'RED' : 'GREEN');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    setBusy(true); setErr(null);
    try {
      const vitals: any = {};
      for (const k of ['systolic', 'diastolic', 'heart_rate', 'respiratory_rate', 'spo2', 'pain_score', 'gcs', 'blood_glucose']) if (v[k]) vitals[k] = Math.round(Number(v[k]));
      for (const k of ['temperature_c', 'weight_kg', 'height_cm']) if (v[k]) vitals[k] = Number(v[k]);
      await api.post(`/queue/${ticket.id}/triage`, { chiefComplaint: complaint, triageLevel: level, vitals });
      toast('ok', `Triase ${ticket.queue_code} selesai, menunggu dokter`); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const box = (k: string, l: string, unit: string) => (
    <Field label={`${l} (${unit})`}><input className="input num" inputMode="decimal" value={v[k] ?? ''} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value.replace(',', '.').replace(/[^\d.]/g, '') }))} /></Field>
  );
  return (
    <Sheet open onClose={onClose} title={`Triase · ${ticket.queue_code} · ${ticket.patient_name}`}
      footer={<><button className="btn-secondary flex-1" onClick={onClose}>Batal</button><button className="btn-primary flex-[2]" disabled={busy || complaint.trim().length < 2} onClick={save}>{busy && <Spinner />}Simpan & ke dokter</button></>}>
      <div className="space-y-4">
        {ticket.allergies > 0 && <p className="text-[14px] text-red-800 bg-red-50 border border-red-200 rounded-xl px-3.5 py-2.5 flex gap-2"><AlertTriangle className="w-5 h-5 shrink-0" />Pasien memiliki {ticket.allergies} catatan alergi aktif.</p>}
        <Field label="Keluhan utama"><textarea className="input" rows={2} value={complaint} onChange={(e) => setComplaint(e.target.value)} /></Field>
        <div>
          <span className="label">Tingkat triase</span>
          <div className="grid grid-cols-3 gap-2">{[['RED', 'Merah', 'Gawat'], ['YELLOW', 'Kuning', 'Mendesak'], ['GREEN', 'Hijau', 'Tidak mendesak']].map(([k, l, s]) => (
            <button key={k} type="button" onClick={() => setLevel(k)} aria-pressed={level === k}
              className={cx('rounded-xl border px-2 py-2.5 text-center', level === k ? (k === 'RED' ? 'border-sev-critical bg-red-50 text-sev-critical' : k === 'YELLOW' ? 'border-amber-500 bg-amber-50 text-amber-800' : 'border-canopy-600 bg-canopy-50 text-canopy-700') : 'border-line bg-white')}>
              <span className="block font-medium">{l}</span><span className="block text-[12.5px]">{s}</span></button>))}</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {box('systolic', 'Sistolik', 'mmHg')}{box('diastolic', 'Diastolik', 'mmHg')}{box('heart_rate', 'Nadi', 'x/mnt')}{box('respiratory_rate', 'Napas', 'x/mnt')}
          {box('temperature_c', 'Suhu', '°C')}{box('spo2', 'SpO₂', '%')}{box('weight_kg', 'Berat', 'kg')}{box('height_cm', 'Tinggi', 'cm')}
          {box('blood_glucose', 'Gula darah', 'mg/dL')}{box('pain_score', 'Nyeri', '0–10')}
        </div>
        <ErrorBox error={err} />
      </div>
    </Sheet>
  );
}

export default function Queue() {
  const { clinic, can, isDoctor } = useSession();
  const [filter, setFilter] = useState('ACTIVE');
  const [register, setRegister] = useState(false);
  const [triage, setTriage] = useState<any>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const date = todayISO();
  const board = useQuery({ queryKey: ['queue', clinic?.id, date], queryFn: () => api.get('/queue/board', { clinicId: clinic!.id, date }), enabled: !!clinic, refetchInterval: 15_000 });
  const tickets: any[] = board.data?.tickets ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { ACTIVE: 0 };
    for (const t of tickets) { c[t.status] = (c[t.status] ?? 0) + 1; if (ACTIVE.includes(t.status)) c.ACTIVE++; }
    return c;
  }, [tickets]);
  const shown = tickets.filter((t) => (filter === 'ACTIVE' ? ACTIVE.includes(t.status) : t.status === filter))
    .sort((a, b) => (a.priority === 'EMERGENCY' ? -1 : 0) - (b.priority === 'EMERGENCY' ? -1 : 0));
  const refresh = () => qc.invalidateQueries({ queryKey: ['queue'] });

  async function move(t: any, to: string, reason?: string) {
    setBusyId(t.id);
    try {
      const r = await api.post(`/queue/${t.id}/transition`, { to, reason });
      if (to === 'IN_CONSULTATION' && r.encounterId) go({ name: 'encounter', id: r.encounterId });
      else { toast('ok', `${t.queue_code}: ${label(to)}`); refresh(); }
    } catch (e: any) { toast('error', e.message); } finally { setBusyId(null); }
  }

  return (
    <div className="pb-28">
      <TopBar title={clinic?.name ?? 'Antrian'} subtitle={`Antrian hari ini · ${fmtDate(date)}`} left={<img src="./mark.png" alt="" className="w-8 h-8 rounded-lg bg-white p-1" />}
        right={<><IconButton label="Muat ulang" onClick={() => board.refetch()}><RefreshCw className={cx('w-5 h-5', board.isFetching && 'animate-spin')} /></IconButton><ClinicSwitcher /></>} />
      {!clinic ? <Empty title="Akun ini tidak terhubung ke klinik" hint="Versi mobile untuk dokter dan perawat klinik. Hubungi admin untuk penugasan klinik." /> : <>
        <Segments value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ ...f, count: counts[f.id] ?? 0 }))} />
        <div className="px-4 space-y-3">
          <ErrorBox error={board.error} />
          {board.isLoading ? <Loading /> : shown.length === 0 ? <Empty title={filter === 'ACTIVE' ? 'Tidak ada pasien dalam antrian' : `Tidak ada pasien berstatus ${label(filter).toLowerCase()}`} hint="Papan diperbarui otomatis setiap 15 detik." /> : shown.map((t) => (
            <article key={t.id} className={cx('card p-4', t.priority === 'EMERGENCY' && 'border-red-300 bg-red-50/40')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-cond text-[22px] font-semibold num leading-none">{t.queue_code}</span>
                    {t.triage_level && <span className={cx('w-3 h-3 rounded-full', TRIAGE_DOT[t.triage_level])} aria-label={`Triase ${label(t.triage_level)}`} />}
                    {t.priority !== 'NORMAL' && <Badge value={t.priority} />}
                  </div>
                  <p className="font-medium text-[16px] mt-1.5 leading-snug">{t.patient_name}</p>
                  <p className="text-[13.5px] text-bark">{label(t.gender)}, {t.age} th · {label(t.patient_type)}{t.allergies > 0 && <span className="text-red-700 font-medium"> · alergi</span>}</p>
                </div>
                <div className="text-right shrink-0">
                  <Badge value={t.status} />
                  <p className="text-[12.5px] text-bark num mt-1">{fmtTime(t.registered_at)}</p>
                  {!['COMPLETED', 'CANCELLED'].includes(t.status) && <p className={cx('text-[12.5px] num', t.wait_min > 45 ? 'text-sev-high font-medium' : 'text-bark')}>{Math.max(0, Number(t.wait_min) || 0)} mnt</p>}
                </div>
              </div>
              {t.chief_complaint && <p className="text-[14px] text-bark-700 mt-2 line-clamp-2">{t.chief_complaint}</p>}
              <div className="flex flex-wrap gap-2 mt-3 empty:hidden">
                {['WAITING', 'TRIAGE'].includes(t.status) && can('EMR', 'CREATE') && <button className="btn-secondary btn-sm flex-1" onClick={() => setTriage(t)}>{t.status === 'TRIAGE' ? 'Lanjutkan triase' : 'Triase'}</button>}
                {['WAITING', 'WAITING_DOCTOR'].includes(t.status) && isDoctor && <button className="btn-primary btn-sm flex-1" disabled={busyId === t.id} onClick={() => move(t, 'IN_CONSULTATION')}>{busyId === t.id && <Spinner className="w-4 h-4" />}Panggil & periksa</button>}
                {t.status === 'IN_CONSULTATION' && t.encounter_id && can('EMR') && <button className="btn-primary btn-sm flex-1" onClick={() => go({ name: 'encounter', id: t.encounter_id })}>Buka pemeriksaan</button>}
                {['COMPLETED', 'PHARMACY'].includes(t.status) && t.encounter_id && can('EMR') && <button className="btn-secondary btn-sm flex-1" onClick={() => go({ name: 'encounter', id: t.encounter_id })}>Lihat rekam medis</button>}
              </div>
            </article>
          ))}
        </div>
        {can('QUEUE', 'CREATE') && (
          <button className="fixed right-4 bottom-[84px] z-20 btn-primary rounded-full h-14 px-5 shadow-lg" onClick={() => setRegister(true)}><UserPlus className="w-5 h-5" />Daftarkan pasien</button>
        )}
        <RegisterSheet clinicId={clinic.id} open={register} onClose={() => setRegister(false)} onDone={() => { setRegister(false); refresh(); }} />
        {triage && <TriageSheet ticket={triage} onClose={() => setTriage(null)} onDone={() => { setTriage(null); refresh(); }} />}
      </>}
    </div>
  );
}
