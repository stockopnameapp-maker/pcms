import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CalendarPlus, CircleX, Leaf, ShieldX } from 'lucide-react';
import { api, imageUrl } from '../lib/api';
import { fmtDate, fmtDateTime, label, todayISO, shiftDate } from '../lib/format';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Panel, Spinner, Status, Tabs, useToast } from '../components/ui';

function QrCard({ patient }: { patient: any }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    imageUrl(`/portal/card.png?patientId=${patient.id}`).then((u) => { url = u; setSrc(u); }).catch(() => setSrc(null));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [patient.id]);
  return (
    <div className="rounded-lg border border-canopy-200 bg-gradient-to-br from-white to-canopy-50 p-4 flex gap-4 items-center">
      <div className="w-28 h-28 bg-white rounded grid place-items-center border border-line shrink-0">{src ? <img src={src} alt={`QR kartu pasien ${patient.full_name}`} className="w-full h-full" /> : <Spinner />}</div>
      <div className="min-w-0">
        <p className="font-cond font-semibold text-[17px] leading-tight">{patient.full_name}</p>
        <p className="text-[12.5px] text-bark num">{patient.mrn}</p>
        <p className="text-[12.5px] text-bark">{label(patient.patient_type)} · lahir {fmtDate(patient.birth_date)}</p>
        <p className="text-[12.5px] text-bark">Klinik utama: {patient.clinic}</p>
        <p className="text-[11.5px] text-bark mt-1">Tunjukkan QR ini di pendaftaran klinik.</p>
      </div>
    </div>
  );
}

function BookModal({ data, onClose }: { data: any; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [v, setV] = useState({ patientId: data.patients[0]?.id ?? '', clinicId: data.patients[0] ? data.clinics.find((c: any) => c.name === data.patients[0].clinic)?.id ?? '' : '', date: shiftDate(todayISO(), 1), time: '08:00', reason: '' });
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const errs: string[] = [];
  if (!v.patientId) errs.push('Pilih pasien');
  if (!v.clinicId) errs.push('Pilih klinik');
  if (v.time < '07:00' || v.time > '15:00') errs.push('Jam layanan 07:00–15:00');
  if (v.date <= todayISO() && v.date !== todayISO()) errs.push('Tanggal sudah lewat');
  if (v.reason.trim().length < 3) errs.push('Isi keperluan kunjungan');
  async function save() {
    setBusy(true); setErr(null);
    try { await api.post('/portal/appointments', { patientId: v.patientId, clinicId: v.clinicId, scheduledAt: `${v.date}T${v.time}`, reason: v.reason }); toast('ok', 'Janji temu dibuat'); qc.invalidateQueries({ queryKey: ['portal'] }); onClose(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const set = (k: string) => (e: any) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title="Buat janji temu" size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className="btn-primary" disabled={busy || errs.length > 0} onClick={save}>Buat janji</button></>}>
      <div className="space-y-3">
        <Field label="Untuk"><select className="input" value={v.patientId} onChange={set('patientId')}>{data.patients.map((p: any) => <option key={p.id} value={p.id}>{p.full_name} ({label(p.patient_type)})</option>)}</select></Field>
        <Field label="Klinik"><select className="input" value={v.clinicId} onChange={set('clinicId')}><option value="">Pilih klinik…</option>{data.clinics.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tanggal"><input type="date" className="input" min={todayISO()} max={shiftDate(todayISO(), 60)} value={v.date} onChange={set('date')} /></Field>
          <Field label="Jam" hint="07:00–15:00"><input type="time" className="input" min="07:00" max="15:00" step={900} value={v.time} onChange={set('time')} /></Field>
        </div>
        <Field label="Keperluan"><textarea className="input" rows={2} maxLength={300} value={v.reason} onChange={set('reason')} placeholder="mis. kontrol tekanan darah" /></Field>
        {errs.length > 0 && v.reason && <p className="text-[12.5px] text-sev-high">{errs.join(' · ')}</p>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

export default function Portal() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['portal'], queryFn: () => api.get('/portal/summary') });
  const [tab, setTab] = useState('visits');
  const [book, setBook] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data.data;
  if (!d.employee && !d.patients.length) return <Empty title="Akun Anda belum terhubung ke data karyawan" hint="Hubungi HR atau admin sistem untuk menautkan akun ke nomor karyawan Anda." />;
  async function cancel(id: string) {
    try { await api.del(`/portal/appointments/${id}`); toast('ok', 'Janji temu dibatalkan'); qc.invalidateQueries({ queryKey: ['portal'] }); } catch (e: any) { toast('error', e.message); }
  }
  const upcoming = d.appointments.filter((a: any) => new Date(a.scheduled_at) > new Date() && ['SCHEDULED', 'CONFIRMED'].includes(a.status));
  const nextMcu = d.mcu.find((m: any) => ['SCHEDULED', 'OVERDUE'].includes(m.status));
  return (
    <div className="space-y-5">
      <PageHeader title={`Halo, ${d.employee?.full_name ?? d.patients[0]?.full_name}`}
        description={d.employee ? `${d.employee.employee_no} · ${d.employee.position ?? ''} · ${d.employee.unit}${d.employee.bpjs ? ` · BPJS ${d.employee.bpjs}` : ''}` : undefined}
        actions={d.clinics.length > 0 && <button className="btn-primary" onClick={() => setBook(true)}><CalendarPlus className="w-4 h-4" />Buat janji temu</button>} />

      <div className="grid xl:grid-cols-[1fr_380px] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          {(upcoming.length > 0 || nextMcu) && (
            <Panel title="Yang akan datang">
              {upcoming.map((a: any) => (
                <div key={a.id} className="flex items-center gap-3 py-2 border-b border-line last:border-0">
                  <div className="flex-1"><p className="font-medium num">{fmtDateTime(a.scheduled_at)}</p><p className="text-[12.5px] text-bark">{a.clinic} · {a.patient} · {a.reason}</p></div>
                  <Status value={a.status} />
                  <button className="btn-ghost btn-sm" onClick={() => cancel(a.id)}><CircleX className="w-3.5 h-3.5" />Batalkan</button>
                </div>))}
              {nextMcu && <p className="py-2 text-[13.5px]">Medical check up <b className="font-medium">{label(nextMcu.mcu_type)}</b> jatuh tempo {fmtDate(nextMcu.due_date)} <Status value={nextMcu.status} /></p>}
            </Panel>
          )}
          <Panel bodyClass="p-0">
            <div className="px-4 pt-3"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'visits', label: 'Kunjungan', count: d.visits.length }, { id: 'mcu', label: 'Medical check up', count: d.mcu.length },
              { id: 'sick', label: 'Surat sakit', count: d.sick_leaves.length }, { id: 'appt', label: 'Riwayat janji', count: d.appointments.length }]} /></div>
            {tab === 'visits' && (d.visits.length ? (
              <ul className="divide-y divide-line">{d.visits.map((v: any) => (
                <li key={v.id} className="px-4 py-3">
                  <p className="font-medium num">{fmtDate(v.started_at)} <span className="text-bark font-normal">· {v.clinic} · {v.patient}</span></p>
                  {v.diagnosis && <p className="text-[13.5px]">Diagnosis: {v.diagnosis}</p>}
                  {v.medicines && <p className="text-[13px] text-bark-700">Obat: {v.medicines}</p>}
                  {v.follow_up_date && <p className="text-[12.5px] text-canopy-700">Kontrol kembali {fmtDate(v.follow_up_date)}</p>}
                </li>))}</ul>) : <Empty title="Belum ada kunjungan" />)}
            {tab === 'mcu' && (d.mcu.length ? (
              <table className="tbl"><thead><tr><th>No.</th><th>Jenis</th><th>Jatuh tempo</th><th>Diperiksa</th><th>Hasil</th><th>Berikutnya</th></tr></thead>
                <tbody>{d.mcu.map((m: any) => <tr key={m.mcu_no}><td className="num">{m.mcu_no}</td><td>{label(m.mcu_type)}</td><td className="num">{fmtDate(m.due_date)}</td><td className="num">{fmtDate(m.exam_date)}</td>
                  <td><Status value={m.fit_status ?? m.status} />{m.restrictions && <span className="block text-[12px] text-bark">{m.restrictions}</span>}</td><td className="num">{fmtDate(m.next_due_date)}</td></tr>)}</tbody></table>) : <Empty title="Belum ada data MCU" />)}
            {tab === 'sick' && (d.sick_leaves.length ? (
              <table className="tbl"><thead><tr><th>No.</th><th>Periode</th><th className="text-right">Hari</th><th>Jenis</th><th>Status</th></tr></thead>
                <tbody>{d.sick_leaves.map((s: any) => <tr key={s.certificate_no}><td className="num">{s.certificate_no}</td><td className="num">{fmtDate(s.start_date)} – {fmtDate(s.end_date)}</td><td className="text-right num">{s.days}</td><td>{label(s.leave_type)}</td><td><Status value={s.status} /></td></tr>)}</tbody></table>) : <Empty title="Belum ada surat sakit" />)}
            {tab === 'appt' && (d.appointments.length ? (
              <table className="tbl"><thead><tr><th>Waktu</th><th>Klinik</th><th>Pasien</th><th>Keperluan</th><th>Status</th></tr></thead>
                <tbody>{d.appointments.map((a: any) => <tr key={a.id}><td className="num">{fmtDateTime(a.scheduled_at)}</td><td>{a.clinic}</td><td>{a.patient}</td><td>{a.reason}</td><td><Status value={a.status} /></td></tr>)}</tbody></table>) : <Empty title="Belum ada janji temu" />)}
          </Panel>
        </div>
        <aside className="space-y-3">
          <h2 className="font-cond font-semibold text-[16px]">Kartu pasien</h2>
          {d.patients.map((p: any) => <QrCard key={p.id} patient={p} />)}
          <p className="text-[12px] text-bark">Portal hanya menampilkan data Anda dan keluarga yang terdaftar sebagai tanggungan. Catatan dokter yang bersifat rahasia tidak ditampilkan.</p>
        </aside>
      </div>
      {book && <BookModal data={d} onClose={() => setBook(false)} />}
    </div>
  );
}

// ====================================================================== PUBLIC CERTIFICATE VERIFICATION
export function Verify() {
  const { code } = useParams();
  const [state, setState] = useState<{ loading: boolean; data?: any; error?: string }>({ loading: true });
  useEffect(() => {
    fetch(`/api/v1/public/verify/${encodeURIComponent(code ?? '')}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      setState(r.ok ? { loading: false, data: j } : { loading: false, error: j.error?.message ?? 'Dokumen tidak ditemukan' });
    }).catch(() => setState({ loading: false, error: 'Tidak dapat menghubungi server' }));
  }, [code]);
  const d = state.data;
  return (
    <div className="min-h-screen bg-mist grid place-items-center p-4">
      <div className="panel w-full max-w-md p-6">
        <div className="flex items-center gap-2 text-canopy-700 mb-5"><Leaf className="w-5 h-5" /><span className="font-cond font-semibold">PCMS · Verifikasi dokumen</span></div>
        {state.loading ? <Loading /> : state.error ? (
          <div className="text-center py-4"><ShieldX className="w-10 h-10 mx-auto text-sev-critical" /><p className="font-cond text-[20px] font-semibold mt-2">Tidak terverifikasi</p><p className="text-bark text-[13.5px] mt-1">{state.error}</p></div>
        ) : (
          <>
            <div className="text-center py-2">
              {d.valid ? <BadgeCheck className="w-12 h-12 mx-auto text-canopy-600" /> : <ShieldX className="w-12 h-12 mx-auto text-sev-high" />}
              <p className="font-cond text-[22px] font-semibold mt-2">{d.valid ? 'Dokumen sah' : 'Dokumen tidak berlaku'}</p>
              <p className="text-bark text-[13px]">{d.valid ? 'Diterbitkan oleh klinik terdaftar dan masih berlaku.' : `Status: ${label(d.status)}`}</p>
            </div>
            <dl className="mt-4 text-[13.5px] divide-y divide-line border-y border-line">
              {[['Nomor', d.certificate_no], ['Jenis', label(d.certificate_type)], ['Atas nama', d.patient], ['Klinik', d.clinic],
                ['Berlaku', `${fmtDate(d.valid_from)}${d.valid_until ? ' – ' + fmtDate(d.valid_until) : ''}`], ...(d.fit_status ? [['Kelaikan', label(d.fit_status)]] : [])].map(([k, v]) => (
                <div key={k} className="flex justify-between py-2 gap-4"><dt className="text-bark">{k}</dt><dd className="text-right font-medium">{v}</dd></div>))}
            </dl>
            <p className="text-[11.5px] text-bark mt-3">Nama disamarkan untuk melindungi privasi. Diagnosis tidak ditampilkan.</p>
          </>
        )}
        <Link to="/" className="block text-center text-[13px] text-canopy-700 mt-5 hover:underline">Masuk ke PCMS</Link>
      </div>
    </div>
  );
}
