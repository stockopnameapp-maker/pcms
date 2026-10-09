import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ScanLine, Search, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtTime, label, todayISO } from '../lib/format';
import { useSession } from '../lib/session';
import { RefSelect } from '../components/RefSelect';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Panel, Spinner, Status, Tag, cx, useToast } from '../components/ui';

const COLUMNS = [
  { id: 'WAITING', title: 'Menunggu' }, { id: 'TRIAGE', title: 'Triase' }, { id: 'WAITING_DOCTOR', title: 'Menunggu dokter' },
  { id: 'IN_CONSULTATION', title: 'Konsultasi' }, { id: 'PHARMACY', title: 'Farmasi' }, { id: 'COMPLETED', title: 'Selesai' },
];

export function useClinicChoice() {
  const { scope, me } = useSession();
  const [clinicId, setClinicId] = useState<string | null>(null);
  useEffect(() => {
    if (scope?.unit_type === 'CLINIC') setClinicId(scope.id);
    else if (me?.user.staff?.home_clinic_id) setClinicId((c) => c ?? me.user.staff!.home_clinic_id);
  }, [scope?.id, me?.user.staff?.home_clinic_id]);
  return [clinicId, setClinicId] as const;
}

function Register({ clinicId, onDone }: { clinicId: string; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [d, setD] = useState('');
  const [sel, setSel] = useState<any>(null);
  const [priority, setPriority] = useState('NORMAL');
  const [source, setSource] = useState('WALK_IN');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  useEffect(() => { const t = setTimeout(() => setD(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const r = useQuery({ queryKey: ['lookup-patient', d], queryFn: () => api.get('/patients/lookup', { q: d }), enabled: d.length >= 3 });
  async function register() {
    setBusy(true); setErr(null);
    try {
      const body: any = { clinicId, priority, source };
      if (sel.patient_id) body.patientId = sel.patient_id; else { body.kind = sel.kind; body.refId = sel.kind === 'FAMILY' ? sel.family_member_id : sel.employee_id; }
      const res = await api.post('/queue/register', body);
      toast('ok', `${sel.full_name} terdaftar dengan nomor antrian ${res.queueCode}`);
      setSel(null); setQ(''); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Panel title={<span className="flex items-center gap-2"><UserPlus className="w-4 h-4 text-canopy-600" />Registrasi pasien</span>}>
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-2.5 text-bark-400" />
        <input className="input pl-9" placeholder="No. karyawan, NIK, No. RM, nama, telepon, atau pindai QR" value={q} onChange={(e) => { setQ(e.target.value); setSel(null); }} autoFocus />
        <ScanLine className="w-4 h-4 absolute right-3 top-2.5 text-bark-400" aria-hidden />
      </div>
      <p className="text-[12px] text-bark mt-1">Pemindai QR kartu karyawan/pasien bekerja sebagai keyboard — arahkan kursor ke kolom ini lalu pindai.</p>
      {!sel && d.length >= 3 && (
        <ul className="mt-3 border border-line rounded-md divide-y divide-line max-h-72 overflow-y-auto">
          {r.isLoading && <li className="p-3 text-bark text-[13px]">Mencari…</li>}
          {r.error && <li className="p-3"><ErrorBox error={r.error} /></li>}
          {r.data?.data.length === 0 && <li className="p-3 text-bark text-[13px]">Tidak ditemukan. Untuk kontraktor/tamu baru, tambahkan di menu Pasien.</li>}
          {r.data?.data.map((p: any, i: number) => (
            <li key={i}><button className="w-full text-left px-3 py-2 hover:bg-canopy-50" onClick={() => setSel(p)}>
              <span className="font-medium">{p.full_name}</span> <Tag>{label(p.patient_type)}</Tag>{p.kind !== 'PATIENT' && <Tag tone="gold">belum punya RM</Tag>}
              <span className="block text-[12.5px] text-bark">{[p.mrn, p.employee_no, p.birth_date && fmtDate(p.birth_date), p.unit_name, p.nik_masked && 'NIK ' + p.nik_masked].filter(Boolean).join(' · ')}</span>
            </button></li>
          ))}
        </ul>
      )}
      {sel && (
        <div className="mt-3 rounded-md border border-canopy-300 bg-canopy-50 p-3">
          <p className="font-medium">{sel.full_name} <span className="text-bark font-normal">· {label(sel.patient_type)}{sel.mrn ? ` · ${sel.mrn}` : ''}</span></p>
          {sel.kind !== 'PATIENT' && <p className="text-[12.5px] text-bark-700">Rekam medis baru akan dibuat otomatis saat registrasi.</p>}
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <Field label="Prioritas"><select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="NORMAL">Normal</option><option value="PRIORITY">Prioritas (lansia, hamil, disabilitas)</option><option value="EMERGENCY">Gawat darurat</option></select></Field>
            <Field label="Sumber kunjungan"><select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              {['WALK_IN', 'APPOINTMENT', 'ACCIDENT', 'FOLLOW_UP', 'REFERRAL_RETURN', 'MCU'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          </div>
          <ErrorBox error={err} />
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn-ghost" onClick={() => setSel(null)}>Batal</button>
            <button className={priority === 'EMERGENCY' ? 'btn bg-sev-critical text-white hover:bg-red-800' : 'btn-primary'} disabled={busy} onClick={register}>
              {busy && <Spinner className="w-4 h-4 text-white" />}{priority === 'EMERGENCY' && <AlertTriangle className="w-4 h-4" />}Daftarkan ke antrian</button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function TriageModal({ ticket, onClose, onDone }: { ticket: any; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [complaint, setComplaint] = useState(ticket.chief_complaint ?? '');
  const [level, setLevel] = useState(ticket.priority === 'EMERGENCY' ? 'RED' : 'GREEN');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const num = (k: string) => (v[k] ? Number(v[k]) : undefined);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const vitals: any = {};
      for (const k of ['systolic', 'diastolic', 'heart_rate', 'respiratory_rate', 'spo2', 'pain_score', 'gcs', 'blood_glucose']) if (v[k]) vitals[k] = Math.round(num(k)!);
      for (const k of ['temperature_c', 'weight_kg', 'height_cm']) if (v[k]) vitals[k] = num(k);
      await api.post(`/queue/${ticket.id}/triage`, { chiefComplaint: complaint, triageLevel: level, vitals });
      toast('ok', `Triase ${ticket.queue_code} selesai — menunggu dokter`); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const box = (k: string, l: string, unit: string) => (
    <Field label={`${l} (${unit})`}><input className="input num" inputMode="decimal" value={v[k] ?? ''} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value.replace(/[^\d.]/g, '') }))} /></Field>
  );
  return (
    <Modal open onClose={onClose} title={`Triase · ${ticket.queue_code} · ${ticket.patient_name}`} size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className="btn-primary" disabled={busy || complaint.length < 2} onClick={save}>{busy && <Spinner className="w-4 h-4 text-white" />}Simpan & teruskan ke dokter</button></>}>
      {ticket.allergies > 0 && <p className="mb-3 text-[13px] text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2">Pasien memiliki {ticket.allergies} catatan alergi aktif.</p>}
      <div className="space-y-4">
        <Field label="Keluhan utama" required><textarea className="input" rows={2} value={complaint} onChange={(e) => setComplaint(e.target.value)} /></Field>
        <div>
          <span className="field-label">Tingkat triase</span>
          <div className="flex gap-2">{[['RED', 'Merah — gawat'], ['YELLOW', 'Kuning — mendesak'], ['GREEN', 'Hijau — tidak mendesak']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setLevel(k)} className={cx('btn-secondary btn-sm', level === k && (k === 'RED' ? 'border-sev-critical text-sev-critical bg-red-50' : k === 'YELLOW' ? 'border-amber-500 text-amber-800 bg-amber-50' : 'border-canopy-600 text-canopy-700 bg-canopy-50'))}>{l}</button>))}</div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {box('systolic', 'Sistolik', 'mmHg')}{box('diastolic', 'Diastolik', 'mmHg')}{box('heart_rate', 'Nadi', 'x/mnt')}{box('respiratory_rate', 'Napas', 'x/mnt')}
          {box('temperature_c', 'Suhu', '°C')}{box('spo2', 'SpO₂', '%')}{box('weight_kg', 'Berat', 'kg')}{box('height_cm', 'Tinggi', 'cm')}
          {box('blood_glucose', 'Gula darah', 'mg/dL')}{box('pain_score', 'Nyeri', '0–10')}{box('gcs', 'GCS', '3–15')}
        </div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

export default function Queue() {
  const { can, me } = useSession();
  const [clinicId, setClinicId] = useClinicChoice();
  const [date, setDate] = useState(todayISO());
  const [triage, setTriage] = useState<any>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ['queue', clinicId, date], queryFn: () => api.get('/queue/board', { clinicId, date }), enabled: !!clinicId, refetchInterval: 15_000 });
  const isDoctor = me?.user.staff?.staff_type === 'DOCTOR';
  const isToday = date === todayISO();

  async function move(t: any, to: string, reason?: string) {
    setBusyId(t.id);
    try {
      const r = await api.post(`/queue/${t.id}/transition`, { to, reason });
      if (to === 'IN_CONSULTATION' && r.encounterId) nav(`/emr/${r.encounterId}`);
      else { toast('ok', `${t.queue_code}: ${label(to)}`); qc.invalidateQueries({ queryKey: ['queue'] }); }
    } catch (e: any) { toast('error', e.message); } finally { setBusyId(null); }
  }

  const tickets = board.data?.tickets ?? [];
  return (
    <div className="space-y-5">
      <PageHeader title="Antrian & registrasi" description="Alur kunjungan: registrasi → triase → dokter → farmasi → selesai. Papan diperbarui otomatis setiap 15 detik."
        actions={<>
          <div className="w-64"><RefSelect kind="clinic" value={clinicId} onChange={(v) => v && setClinicId(v)} allowClear={false} placeholder="Pilih klinik" /></div>
          <input type="date" className="input w-40" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Tanggal" />
        </>} />
      {!clinicId ? <Empty title="Pilih klinik" hint="Pilih klinik pada bar cakupan atau di kanan atas untuk menampilkan antrian." /> : (
        <>
          {isToday && can('QUEUE', 'CREATE') && <Register clinicId={clinicId} onDone={() => qc.invalidateQueries({ queryKey: ['queue'] })} />}
          <ErrorBox error={board.error} />
          {board.isLoading ? <Loading /> : (
            <div className="grid md:grid-cols-3 xl:grid-cols-6 gap-3">
              {COLUMNS.map((col) => {
                const items = tickets.filter((t: any) => t.status === col.id);
                return (
                  <section key={col.id} className="bg-white border border-line rounded-panel flex flex-col min-h-[180px]">
                    <header className="flex items-center justify-between px-3 py-2 border-b border-line">
                      <h2 className="text-[13.5px] font-semibold">{col.title}</h2><span className="num text-[13px] text-bark">{items.length}</span>
                    </header>
                    <ul className="p-2 space-y-2 flex-1 overflow-y-auto max-h-[560px] scrollbar-thin">
                      {items.length === 0 && <li className="text-[12.5px] text-bark-400 text-center py-4">Kosong</li>}
                      {items.map((t: any) => (
                        <li key={t.id} className={cx('rounded-md border p-2.5 text-[13px]', t.priority === 'EMERGENCY' ? 'border-red-300 bg-red-50/50' : t.priority === 'PRIORITY' ? 'border-amber-200' : 'border-line')}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-cond text-[17px] font-semibold num">{t.queue_code}</span>
                            <span className="flex gap-1 items-center">{t.triage_level && <span className={cx('w-2.5 h-2.5 rounded-full', { RED: 'bg-sev-critical', YELLOW: 'bg-amber-400', GREEN: 'bg-canopy-500', BLACK: 'bg-ink' }[t.triage_level as string])} title={`Triase ${t.triage_level}`} />}
                              <span className="text-[11.5px] text-bark num">{fmtTime(t.registered_at)}</span></span>
                          </div>
                          <p className="font-medium leading-tight mt-0.5">{t.patient_name}</p>
                          <p className="text-[12px] text-bark">{label(t.gender)}, {t.age} th · {label(t.patient_type)}{t.allergies > 0 && <span className="text-red-700"> · alergi</span>}</p>
                          {t.chief_complaint && <p className="text-[12px] text-bark-700 mt-1 line-clamp-2">{t.chief_complaint}</p>}
                          {!['COMPLETED', 'CANCELLED'].includes(t.status) && <p className={cx('text-[11.5px] mt-1 num', t.wait_min > 45 ? 'text-sev-high' : 'text-bark')}>menunggu {Math.max(0, Number(t.wait_min) || 0)} mnt</p>}
                          {isToday && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {t.status === 'WAITING' && can('EMR', 'CREATE') && <button className="btn-secondary btn-sm" disabled={busyId === t.id} onClick={() => setTriage(t)}>Triase</button>}
                              {t.status === 'TRIAGE' && can('EMR', 'CREATE') && <button className="btn-secondary btn-sm" onClick={() => setTriage(t)}>Lanjutkan triase</button>}
                              {['WAITING', 'WAITING_DOCTOR'].includes(t.status) && isDoctor && <button className="btn-primary btn-sm" disabled={busyId === t.id} onClick={() => move(t, 'IN_CONSULTATION')}>Panggil</button>}
                              {t.status === 'IN_CONSULTATION' && t.encounter_id && can('EMR') && <button className="btn-primary btn-sm" onClick={() => nav(`/emr/${t.encounter_id}`)}>Buka RM</button>}
                              {t.status === 'PHARMACY' && t.prescription_id && can('PHARMACY', 'UPDATE') && <button className="btn-primary btn-sm" onClick={() => nav(`/pharmacy/dispense/${t.prescription_id}`)}>Serahkan obat</button>}
                              {['WAITING', 'TRIAGE', 'WAITING_DOCTOR'].includes(t.status) && can('QUEUE', 'UPDATE') && <button className="btn-ghost btn-sm text-bark" disabled={busyId === t.id} onClick={() => move(t, 'CANCELLED', 'Pasien meninggalkan klinik')}>Batal</button>}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          {tickets.some((t: any) => t.status === 'CANCELLED') && <p className="text-[12.5px] text-bark">{tickets.filter((t: any) => t.status === 'CANCELLED').length} kunjungan dibatalkan pada {fmtDate(date)}.</p>}
        </>
      )}
      {triage && <TriageModal ticket={triage} onClose={() => setTriage(null)} onDone={() => { setTriage(null); qc.invalidateQueries({ queryKey: ['queue'] }); }} />}
    </div>
  );
}
