import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtNum, label } from '../lib/format';
import { useSession } from '../lib/session';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Panel, Status, Tag, useToast } from '../components/ui';

export default function PatientTimeline() {
  const { id } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [bg, setBg] = useState(false);
  const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['timeline', id], queryFn: () => api.get(`/emr/patients/${id}/timeline`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { patient: p, visits, allergies, history, mcu } = q.data;
  const years = new Map<string, any[]>();
  for (const v of visits) { const y = String(v.started_at).slice(0, 4); years.set(y, [...(years.get(y) ?? []), v]); }
  return (
    <div className="space-y-5">
      <PageHeader title={p.full_name} description={`${p.mrn} · ${label(p.patient_type)} · ${label(p.gender)}, ${p.age} th · klinik utama ${p.clinic_name}${p.employee_no ? ` · ${p.employee_no} ${p.position_name ?? ''}` : ''}`}
        actions={can('EMR', 'CREATE') && <button className="btn-danger" onClick={() => setBg(true)}><ShieldAlert className="w-4 h-4" />Akses darurat</button>} />
      <div className="grid xl:grid-cols-[1fr_320px] gap-5">
        <Panel title="Riwayat kunjungan" bodyClass="p-5">
          {!visits.length ? (
            <Empty title="Tidak ada kunjungan yang dapat Anda lihat"
              hint="Rekam medis dari klinik lain hanya terlihat saat pasien sedang berkunjung ke klinik Anda (7 hari), atau melalui akses darurat yang tercatat dan dilaporkan ke Medical Director." />
          ) : [...years.entries()].map(([y, list]) => (
            <div key={y} className="mb-6 last:mb-0">
              <h3 className="font-cond text-[15px] font-semibold text-canopy-700 mb-2">{y}</h3>
              <ol className="relative border-l-2 border-canopy-100 ml-2 space-y-5">
                {list.map((v: any) => (
                  <li key={v.id} className="ml-5">
                    <span className="absolute -left-[7px] mt-1.5 w-3 h-3 rounded-full bg-white border-2 border-canopy-600" />
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <Link to={`/emr/${v.id}`} className="font-cond font-semibold text-[15px] num hover:text-canopy-700">{fmtDate(v.started_at)}</Link>
                      <span className="text-[12.5px] text-bark">{v.clinic_name} · {v.doctor_name ?? '—'} · {label(v.encounter_type)}</span>
                      {v.status !== 'SIGNED' && <Status value={v.status} />}
                    </div>
                    <p className="mt-1"><span className="text-bark">Diagnosis: </span>{v.diagnoses.length ? v.diagnoses.map((d: any) => `${d.title} (${d.code})`).join(', ') : '—'}</p>
                    {v.chief_complaint && <p className="text-[13.5px]"><span className="text-bark">Keluhan: </span>{v.chief_complaint}</p>}
                    {v.plan && <p className="text-[13.5px]"><span className="text-bark">Tatalaksana: </span>{v.plan}</p>}
                    {v.medications.length > 0 && <p className="text-[13.5px]"><span className="text-bark">Obat: </span>{v.medications.map((m: any) => `${m.medicine} ${fmtNum(m.qty)} (${m.frequency})`).join('; ')}</p>}
                    {v.labs.length > 0 && <p className="text-[13.5px]"><span className="text-bark">Lab: </span>{v.labs.map((l: any) => `${l.test} ${l.value ?? '…'}${l.unit ? ' ' + l.unit : ''}${l.flag && !['NORMAL', 'NEGATIVE'].includes(l.flag) ? ' ▲' : ''}`).join(', ')}</p>}
                    {v.vitals?.systolic && <p className="text-[12.5px] text-bark">TD {v.vitals.systolic}/{v.vitals.diastolic} · suhu {v.vitals.temperature_c ?? '–'} °C · SpO₂ {v.vitals.spo2 ?? '–'}%</p>}
                    {v.referred_to && <p className="text-[13px]"><Tag tone="blue">Dirujuk</Tag> {v.referred_to}</p>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </Panel>
        <aside className="space-y-4">
          <Panel title="Alergi">{allergies.length ? allergies.map((a: any, i: number) => <p key={i} className="text-red-800 text-[13.5px]"><AlertTriangle className="inline w-3.5 h-3.5 mr-1" />{a.allergen} ({label(a.severity)})</p>) : <p className="text-bark text-[13px]">Tidak ada</p>}</Panel>
          <Panel title="Riwayat penyakit">{history.length ? history.map((h: any, i: number) => <p key={i} className="text-[13.5px] py-0.5"><Tag>{label(h.history_type)}</Tag> {h.description}</p>) : <p className="text-bark text-[13px]">Tidak ada</p>}</Panel>
          <Panel title="Medical check up">{mcu.length ? mcu.map((m: any) => <p key={m.mcu_no} className="text-[13.5px] py-1 border-b border-line last:border-0">{label(m.mcu_type)} · {fmtDate(m.exam_date)} <Status value={m.fit_status ?? m.status} />{m.restrictions && <span className="block text-[12px] text-bark">{m.restrictions}</span>}</p>) : <p className="text-bark text-[13px]">Tidak ada</p>}</Panel>
        </aside>
      </div>
      <Modal open={bg} onClose={() => setBg(false)} title="Akses darurat rekam medis (break-glass)" size="sm"
        footer={<><button className="btn-secondary" onClick={() => setBg(false)}>Batal</button><button className="btn-danger" disabled={reason.trim().length < 15}
          onClick={async () => { try { await api.post('/emr/break-glass', { patientId: id, reason, minutes: 60 }); toast('ok', 'Akses darurat aktif 60 menit'); setBg(false); qc.invalidateQueries({ queryKey: ['timeline', id] }); } catch (e: any) { toast('error', e.message); } }}>Buka akses 60 menit</button></>}>
        <p className="text-[13.5px] text-bark-700">Gunakan hanya untuk keadaan darurat medis ketika riwayat pasien dibutuhkan untuk keselamatan. Akses dicatat atas nama Anda dan Medical Director menerima notifikasi untuk review.</p>
        <Field label="Alasan klinis (min. 15 karakter)" className="mt-3"><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}
