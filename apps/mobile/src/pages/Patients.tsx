import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, label } from '../lib/format';
import { go } from '../lib/router';
import { PatientSearch } from './Queue';
import { Badge, Empty, ErrorBox, IconButton, Loading, TopBar, useToast } from '../components/ui';

export default function Patients() {
  const toast = useToast();
  return (
    <div className="pb-24">
      <TopBar title="Pasien" subtitle="Cari atau pindai kartu QR" left={<img src="./mark.png" alt="" className="w-8 h-8 rounded-lg bg-white p-1" />} />
      <div className="p-4">
        <PatientSearch onPick={(p) => (p.patient_id ? go({ name: 'patient', id: p.patient_id }) : toast('info', 'Belum punya rekam medis. Daftarkan dulu lewat Antrian.'))} />
      </div>
    </div>
  );
}

export function PatientDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['timeline', id], queryFn: () => api.get(`/emr/patients/${id}/timeline`) });
  const back = <IconButton label="Kembali" onClick={() => history.back()}><ArrowLeft className="w-6 h-6" /></IconButton>;
  if (q.isLoading) return <><TopBar title="Riwayat medis" left={back} /><Loading /></>;
  if (q.error) return <><TopBar title="Riwayat medis" left={back} /><div className="p-4"><ErrorBox error={q.error} /></div></>;
  const { patient: p, visits, allergies, history, mcu } = q.data;
  return (
    <div className="pb-24">
      <TopBar title={p.full_name} subtitle={`${p.mrn} · ${label(p.gender)}, ${p.age} th`} left={back} />
      <div className="p-4 space-y-4">
        <div className="card p-4 text-[14px] space-y-1">
          <p><span className="text-bark">Jenis:</span> {label(p.patient_type)}{p.employee_no ? ` · ${p.employee_no}` : ''}</p>
          {p.position_name && <p><span className="text-bark">Jabatan:</span> {p.position_name}</p>}
          <p><span className="text-bark">Klinik utama:</span> {p.clinic_name}</p>
        </div>
        {allergies.length > 0 && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-red-800 text-[14px]">
            <p className="font-medium flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />Alergi</p>
            {allergies.map((a: any) => <p key={a.id}>{a.allergen} ({label(a.severity)})</p>)}
          </div>
        )}
        {history.length > 0 && <div className="card p-4"><p className="font-medium mb-1">Riwayat penyakit</p>{history.map((h: any) => <p key={h.id} className="text-[14px]">{h.description}</p>)}</div>}
        {mcu?.length > 0 && <div className="card p-4"><p className="font-medium mb-1">MCU terakhir</p><p className="text-[14px]">{label(mcu[0].mcu_type)} · {fmtDate(mcu[0].exam_date)} · {label(mcu[0].fit_status ?? mcu[0].status)}</p></div>}
        <h2 className="font-semibold text-[16px] pt-1">Kunjungan</h2>
        {!visits.length ? <Empty title="Tidak ada kunjungan yang dapat Anda lihat" hint="Rekam medis klinik lain hanya terlihat saat pasien sedang dalam perawatan Anda." /> : (
          <ul className="space-y-2">
            {visits.map((v: any) => (
              <li key={v.id}><button className="card w-full text-left px-4 py-3 flex items-center gap-3 active:bg-canopy-50" onClick={() => go({ name: 'encounter', id: v.id })}>
                <div className="flex-1 min-w-0">
                  <p className="font-medium num">{fmtDate(v.started_at)} <span className="font-normal text-bark">· {v.clinic_name}</span></p>
                  <p className="text-[14px] text-bark-700 line-clamp-2">{v.diagnoses?.length ? v.diagnoses.map((d: any) => d.title).join(', ') : v.chief_complaint || label(v.encounter_type)}</p>
                </div>
                <Badge value={v.status} /><ChevronRight className="w-5 h-5 text-bark-400" />
              </button></li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
