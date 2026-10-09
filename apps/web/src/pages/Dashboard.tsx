import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, ChevronRight, Users, Clock, BedDouble, Pill, Ambulance as AmbulanceIcon } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtMoneyShort, fmtNum, fmtRelative, label, shiftDate, todayISO } from '../lib/format';
import { useSession } from '../lib/session';
import { BarChart, DonutChart, LineChart } from '../components/Chart';
import { Empty, ErrorBox, Loading, Modal, PageHeader, Panel, Status, Tag, cx } from '../components/ui';

const PRESETS = [{ d: 7, l: '7 hari' }, { d: 30, l: '30 hari' }, { d: 90, l: '90 hari' }, { d: 180, l: '6 bulan' }];
const TYPE_LABEL: Record<string, string> = { GROUP: 'grup', COMPANY: 'PT', REGION: 'region', ESTATE: 'kebun', MILL: 'pabrik', CLINIC: 'klinik', WAREHOUSE: 'gudang' };

function Delta({ cur, prev, inverse }: { cur: number; prev: number; inverse?: boolean }) {
  if (!prev) return null;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return <span className="text-[12px] text-bark">stabil</span>;
  const bad = inverse ? pct < 0 : pct > 0;
  return (
    <span className={cx('inline-flex items-center text-[12px] num', bad ? 'text-sev-high' : 'text-canopy-600')}>
      {pct > 0 ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}{Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function Kpi({ title, value, sub, delta }: { title: string; value: string; sub?: React.ReactNode; delta?: React.ReactNode }) {
  return (
    <div className="px-4 py-3.5 min-w-0">
      <p className="text-[12.5px] text-bark">{title}</p>
      <p className="font-cond text-[26px] leading-8 font-semibold text-ink num mt-0.5 truncate">{value}</p>
      <p className="text-[12px] text-bark flex items-center gap-2 min-h-[18px]">{delta}{sub}</p>
    </div>
  );
}

function ClinicToday({ clinicId }: { clinicId: string }) {
  const q = useQuery({ queryKey: ['clinic-today', clinicId], queryFn: () => api.get('/dashboard/clinic-today', { clinicId }), refetchInterval: 30_000 });
  const d = q.data?.data;
  if (q.isLoading) return <Loading />;
  if (!d) return <ErrorBox error={q.error} />;
  const queue = d.queue ?? {};
  const waiting = (queue.WAITING ?? 0) + (queue.TRIAGE ?? 0) + (queue.WAITING_DOCTOR ?? 0);
  return (
    <Panel title={<span className="flex items-center gap-2">Hari ini di {d.clinic.name} <Status value={d.clinic.status} /></span>}
      actions={<Link to="/queue" className="btn-secondary btn-sm">Buka papan antrian</Link>}>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
        <div><p className="text-[12.5px] text-bark flex items-center gap-1"><Users className="w-3.5 h-3.5" />Pasien hari ini</p><p className="font-cond text-[24px] font-semibold num">{d.today_patients}</p>
          <p className="text-[12px] text-bark">{d.emergency_today} darurat</p></div>
        <div><p className="text-[12.5px] text-bark flex items-center gap-1"><Clock className="w-3.5 h-3.5" />Menunggu</p><p className="font-cond text-[24px] font-semibold num">{waiting}</p>
          <p className="text-[12px] text-bark">rata-rata {d.avg_wait_min ?? 0} mnt</p></div>
        <div><p className="text-[12.5px] text-bark">Konsultasi</p><p className="font-cond text-[24px] font-semibold num">{queue.IN_CONSULTATION ?? 0}</p><p className="text-[12px] text-bark">{queue.COMPLETED ?? 0} selesai</p></div>
        <div><p className="text-[12.5px] text-bark flex items-center gap-1"><Pill className="w-3.5 h-3.5" />Resep menunggu</p><p className="font-cond text-[24px] font-semibold num">{d.pending_prescriptions}</p>
          <p className={cx('text-[12px]', d.low_stock ? 'text-sev-high' : 'text-bark')}>{d.low_stock} obat di bawah minimum</p></div>
        <div><p className="text-[12.5px] text-bark flex items-center gap-1"><BedDouble className="w-3.5 h-3.5" />Rawat inap</p><p className="font-cond text-[24px] font-semibold num">{d.inpatients}</p><p className="text-[12px] text-bark">{d.beds_available} bed tersedia</p></div>
        <div><p className="text-[12.5px] text-bark">Rujukan aktif</p><p className="font-cond text-[24px] font-semibold num">{d.active_referrals}</p><p className="text-[12px] text-bark">{d.referrals_today} hari ini · {d.accidents_today} kecelakaan</p></div>
        <div><p className="text-[12.5px] text-bark flex items-center gap-1"><AmbulanceIcon className="w-3.5 h-3.5" />Ambulans</p>
          {d.ambulance.length ? d.ambulance.map((a: any) => <p key={a.code} className="text-[13px] mt-1">{a.vehicle_no} <Status value={a.status} /></p>) : <p className="text-[13px] text-bark mt-1">Tidak ada</p>}</div>
      </div>
      <div className="grid md:grid-cols-[1fr_280px] gap-6 mt-5">
        <div><p className="text-[12.5px] text-bark mb-1">Kunjungan 14 hari</p><BarChart data={d.daily_visits.map((x: any) => ({ ...x, d: fmtDate(x.date).slice(0, 6) }))} x="d" y="visits" height={160} name="Kunjungan" /></div>
        <div>
          <p className="text-[12.5px] text-bark mb-2">Dokter bertugas</p>
          {d.doctors_on_duty.length ? d.doctors_on_duty.map((x: any) => <p key={x.id} className="text-[13.5px] py-1 border-b border-line last:border-0">{x.name}<span className="block text-[12px] text-bark num">{String(x.from).slice(0, 5)}–{String(x.to).slice(0, 5)}</span></p>)
            : <p className="text-[13px] text-bark">Tidak ada jadwal dokter hari ini</p>}
          <p className="text-[12.5px] text-bark mt-3">{d.nurses} perawat · {d.expiring_batches} batch obat mendekati kedaluwarsa</p>
        </div>
      </div>
    </Panel>
  );
}

export default function Dashboard() {
  const { scope, setScope, can, me } = useSession();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  useEffect(() => { const u = sp.get('unitId'); if (u && me?.scopes.some((s) => s.id === u)) { setScope(u); setSp({}, { replace: true }); } }, [sp, me]);
  const [days, setDays] = useState(30);
  const [icd, setIcd] = useState<any>(null);
  const to = todayISO(); const from = shiftDate(to, -(days - 1));
  const params = { unitId: scope?.id, from, to };
  const enabled = !!scope;
  const summary = useQuery({ queryKey: ['dash', 'summary', params], queryFn: () => api.get('/dashboard/summary', params), enabled });
  const visits = useQuery({ queryKey: ['dash', 'visits', params, days], queryFn: () => api.get('/dashboard/trend', { ...params, from: shiftDate(to, -Math.max(days, 90) + 1), metric: 'visits', bucket: days > 90 ? 'month' : 'week' }), enabled });
  const cost = useQuery({ queryKey: ['dash', 'cost', params], queryFn: () => api.get('/dashboard/trend', { ...params, from: shiftDate(to, -179), metric: 'medical_cost', bucket: 'month' }), enabled });
  const diseases = useQuery({ queryKey: ['dash', 'dx', params], queryFn: () => api.get('/dashboard/top-diseases', { ...params, limit: 10 }), enabled });
  const drill = useQuery({ queryKey: ['dash', 'drill', params], queryFn: () => api.get('/dashboard/drilldown', params), enabled });
  const perf = useQuery({ queryKey: ['dash', 'perf', params], queryFn: () => api.get('/dashboard/clinic-performance', params), enabled: enabled && scope?.unit_type !== 'CLINIC' });
  const occ = useQuery({ queryKey: ['dash', 'occ', scope?.id], queryFn: () => api.get('/dashboard/occupational', { unitId: scope?.id }), enabled });
  const alerts = useQuery({ queryKey: ['dash', 'alerts', scope?.id], queryFn: () => api.get('/r/alerts', { unitId: scope?.id, status: 'OPEN', pageSize: 6, sort: 'detected_at' }), enabled: enabled && (can('ALERT') || can('DASHBOARD')) });
  const icdTrend = useQuery({ queryKey: ['dash', 'icd', icd?.icd10_code, params], queryFn: () => api.get('/dashboard/trend', { ...params, from: shiftDate(to, -89), metric: `disease:${icd.icd10_code}`, bucket: 'week' }), enabled: !!icd });

  const k = summary.data?.data;
  const fitDonut = useMemo(() => k ? [
    { name: 'Fit', value: k.fit, color: '#1F6B4F' }, { name: 'Fit dgn pembatasan', value: k.fit_with_restriction, color: '#B38B2E' },
    { name: 'Unfit sementara', value: k.temporarily_unfit, color: '#C2410C' }, { name: 'Unfit', value: k.unfit, color: '#B42318' },
    { name: 'Belum dinilai', value: Math.max(0, k.mcu_total - k.fit - k.fit_with_restriction - k.temporarily_unfit - k.unfit), color: '#C9D1CD' },
  ] : [], [k]);

  if (!scope) return <Loading />;
  if (summary.error && (summary.error as any).status === 403) {
    return <Empty title={`Dashboard tidak tersedia untuk ${scope.name}`} hint="Peran Anda tidak memiliki izin DASHBOARD pada unit ini. Pilih unit lain pada bar cakupan di atas, atau buka modul kerja Anda dari menu." />;
  }
  const isClinic = scope.unit_type === 'CLINIC';
  return (
    <div className="space-y-5">
      <PageHeader title={`Dashboard ${TYPE_LABEL[scope.unit_type] ?? ''} · ${scope.name}`}
        description={`${fmtDate(from)} – ${fmtDate(to)}. Angka mencakup seluruh unit di bawah ${scope.name}.`}
        actions={<div className="flex rounded-md border border-line bg-white p-0.5">{PRESETS.map((p) => (
          <button key={p.d} className={cx('px-3 h-8 rounded text-[13px]', days === p.d ? 'bg-canopy-600 text-white' : 'text-bark-700 hover:bg-canopy-50')} onClick={() => setDays(p.d)}>{p.l}</button>))}</div>} />

      {isClinic && <ClinicToday clinicId={scope.id} />}

      <section className="panel">
        {summary.isLoading ? <Loading /> : k && (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 divide-x divide-y xl:divide-y-0 divide-line">
            <Kpi title="Kunjungan pasien" value={fmtNum(k.patient_visits)} delta={<Delta cur={k.patient_visits} prev={k.patient_visits_prev} />} sub={<span>{fmtNum(k.unique_patients)} pasien</span>} />
            <Kpi title="Kecelakaan kerja" value={fmtNum(k.accident_cases)} delta={<Delta cur={k.accident_cases} prev={k.accident_cases_prev} />} sub={<span>{k.lti_cases} LTI · {k.lost_days} hari hilang</span>} />
            <Kpi title="Hari sakit" value={fmtNum(k.sick_leave_days)} delta={<Delta cur={k.sick_leave_days} prev={k.sick_leave_days_prev} />} sub={<span>{k.sick_leave_cases} surat</span>} />
            <Kpi title="Rujukan" value={fmtNum(k.referrals)} delta={<Delta cur={k.referrals} prev={k.referrals_prev} />} sub={<span>{fmtNum(k.disease_cases)} kasus penyakit</span>} />
            <Kpi title="Biaya medis" value={fmtMoneyShort(k.medical_cost)} delta={<Delta cur={k.medical_cost} prev={k.medical_cost_prev} />} sub={k.total_employees ? <span>{fmtMoneyShort(k.cost_per_employee)}/karyawan</span> : <span>obat {fmtMoneyShort(k.medicine_cost)}</span>} />
            <Kpi title="Kepatuhan MCU" value={k.mcu_total ? `${fmtNum(k.mcu_completion_pct, 1)}%` : '–'} sub={k.mcu_total ? <span>{k.mcu_overdue} terlambat dari {fmtNum(k.mcu_total)} karyawan</span> : <span>{k.total_clinics} klinik</span>} />
          </div>
        )}
        <ErrorBox error={summary.error} />
      </section>

      <div className="grid xl:grid-cols-[1.6fr_1fr] gap-5">
        <Panel title="Tren kunjungan" actions={<span className="text-[12px] text-bark">{days > 90 ? 'per bulan' : 'per minggu'}, 90+ hari terakhir</span>}>
          {visits.data ? <LineChart data={visits.data.data.map((d: any) => ({ ...d, label: fmtDate(d.bucket).slice(0, 6) }))} x="label" series={[{ key: 'value', name: 'Kunjungan' }]} area height={250} /> : <Loading />}
        </Panel>
        <Panel title="Early warning" actions={<Link to="/alerts" className="text-[13px] text-canopy-700 hover:underline">Semua alert</Link>} bodyClass="p-0">
          {alerts.data?.data?.length ? (
            <ul className="divide-y divide-line">
              {alerts.data.data.map((a: any) => (
                <li key={a.id} className="px-4 py-3 flex gap-3">
                  <span className={cx('w-1 rounded-full shrink-0', { LOW: 'bg-sev-low', MEDIUM: 'bg-sev-medium', HIGH: 'bg-sev-high', CRITICAL: 'bg-sev-critical' }[a.severity as string])} />
                  <div className="min-w-0"><p className="text-[13.5px] leading-snug">{a.message}</p>
                    <p className="text-[12px] text-bark mt-0.5"><Status value={a.severity} /> {a.unit_name} · {fmtRelative(a.detected_at)}</p></div>
                </li>
              ))}
            </ul>
          ) : <Empty title="Tidak ada alert terbuka" hint="Mesin early warning memeriksa data setiap 15 menit." />}
        </Panel>
      </div>

      <div className="grid xl:grid-cols-[1.2fr_1fr_1fr] gap-5">
        <Panel title="Penyakit terbanyak" actions={<span className="text-[12px] text-bark">klik untuk tren</span>} bodyClass="p-0">
          {diseases.data?.data?.length ? (
            <table className="tbl">
              <thead><tr><th>ICD-10</th><th>Diagnosis</th><th className="text-right">Kasus</th><th className="text-right">%</th></tr></thead>
              <tbody>{diseases.data.data.map((d: any) => (
                <tr key={d.icd10_code} className="cursor-pointer" onClick={() => setIcd(d)}>
                  <td className="num">{d.icd10_code}</td><td>{d.title}{d.occupational && <Tag tone="gold">kerja</Tag>}</td>
                  <td className="text-right num">{d.suppressed ? <span title="Jumlah kecil disamarkan untuk melindungi privasi pasien" className="text-bark">&lt;5</span> : d.cases}</td>
                  <td className="text-right num text-bark">{d.share ?? '–'}</td>
                </tr>))}</tbody>
            </table>
          ) : diseases.isLoading ? <Loading /> : <Empty title="Belum ada diagnosis pada periode ini" />}
        </Panel>
        <Panel title="Status kelaikan kerja">
          {k?.mcu_total ? <DonutChart data={fitDonut} height={210} /> : <Empty title="Tidak ada karyawan pada unit ini" />}
        </Panel>
        <Panel title="Biaya medis 6 bulan">
          {cost.data ? <BarChart data={cost.data.data.map((d: any) => ({ ...d, label: new Date(d.bucket).toLocaleDateString('id-ID', { month: 'short' }) }))} x="label" y="value" money height={210} color="#B38B2E" name="Biaya" /> : <Loading />}
        </Panel>
      </div>

      {drill.data?.data?.length > 0 && (
        <Panel title={`Rincian per unit di bawah ${scope.name}`} bodyClass="p-0">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Unit</th><th className="text-right">Karyawan</th><th className="text-right">Kunjungan</th><th className="text-right">Kecelakaan</th><th className="text-right">LTI</th>
                <th className="text-right">Rujukan</th><th className="text-right">Hari sakit</th><th className="text-right">Biaya medis</th><th className="text-right">Biaya/karyawan</th><th className="text-right">MCU</th><th className="text-right">Unfit</th><th className="text-right">Alert</th><th /></tr></thead>
              <tbody>{drill.data.data.map((r: any) => (
                <tr key={r.unit_id} className="cursor-pointer" onClick={() => setScope(r.unit_id)}>
                  <td><span className="font-medium">{r.name}</span><span className="block text-[12px] text-bark">{label(r.unit_type)}</span></td>
                  <td className="text-right num">{fmtNum(r.employees)}</td><td className="text-right num">{fmtNum(r.visits)}</td><td className="text-right num">{r.accidents}</td>
                  <td className={cx('text-right num', r.lti > 0 && 'text-sev-high font-medium')}>{r.lti}</td><td className="text-right num">{r.referrals}</td><td className="text-right num">{fmtNum(r.sick_leave_days)}</td>
                  <td className="text-right num">{fmtMoneyShort(r.medical_cost)}</td><td className="text-right num">{r.cost_per_employee ? fmtMoneyShort(r.cost_per_employee) : '–'}</td>
                  <td className={cx('text-right num', r.mcu_completion_pct !== null && r.mcu_completion_pct < 85 && 'text-sev-high')}>{r.mcu_completion_pct !== null ? `${r.mcu_completion_pct}%` : '–'}</td>
                  <td className="text-right num">{r.unfit}</td><td className="text-right num">{r.open_alerts}</td>
                  <td><ChevronRight className="w-4 h-4 text-bark-400" /></td>
                </tr>))}</tbody>
            </table>
          </div>
        </Panel>
      )}

      <div className="grid xl:grid-cols-2 gap-5">
        {!isClinic && perf.data?.data?.length > 0 && (
          <Panel title="Kinerja klinik" bodyClass="p-0">
            <div className="overflow-x-auto"><table className="tbl">
              <thead><tr><th>Klinik</th><th className="text-right">Kunjungan</th><th className="text-right">Tunggu (mnt)</th><th className="text-right">Rujukan %</th><th className="text-right">Biaya/kunjungan</th><th className="text-right">Kunj./dokter/hari</th></tr></thead>
              <tbody>{perf.data.data.map((c: any) => (
                <tr key={c.clinic_id} className="cursor-pointer" onClick={() => setScope(c.clinic_id)}>
                  <td>{c.clinic} {c.status !== 'OPEN' && <Status value={c.status} />}</td><td className="text-right num">{c.visits}</td>
                  <td className={cx('text-right num', c.avg_wait_min > 45 && 'text-sev-high')}>{c.avg_wait_min ?? '–'}</td><td className="text-right num">{c.referral_rate ?? '–'}</td>
                  <td className="text-right num">{c.cost_per_visit ? fmtMoneyShort(c.cost_per_visit) : '–'}</td><td className="text-right num">{c.visits_per_doctor_day ?? '–'}</td>
                </tr>))}</tbody>
            </table></div>
          </Panel>
        )}
        {occ.data?.data?.by_risk?.length > 0 && (
          <Panel title="Kesehatan kerja per kategori risiko" actions={can('OCC_HEALTH') && <Link to="/occ-health" className="text-[13px] text-canopy-700 hover:underline">Detail</Link>} bodyClass="p-0">
            <div className="overflow-x-auto"><table className="tbl">
              <thead><tr><th>Risiko</th><th className="text-right">Karyawan</th><th className="text-right">Patuh MCU</th><th className="text-right">Terlambat</th><th className="text-right">Pembatasan</th><th className="text-right">Unfit</th></tr></thead>
              <tbody>{occ.data.data.by_risk.map((r: any) => (
                <tr key={r.risk_code}><td>{r.risk_name} <Status value={r.risk_level} /></td><td className="text-right num">{r.employees}</td>
                  <td className="text-right num">{Math.round((100 * r.compliant) / r.employees)}%</td><td className={cx('text-right num', r.overdue > 0 && 'text-sev-high')}>{r.overdue + r.never}</td>
                  <td className="text-right num">{r.restricted}</td><td className="text-right num">{r.unfit}</td></tr>))}</tbody>
            </table></div>
          </Panel>
        )}
      </div>

      {isClinic && can('EMR') && (
        <p className="text-[13px] text-bark">Lanjut ke tingkat pasien: <button className="text-canopy-700 hover:underline" onClick={() => nav('/r/encounters')}>daftar rekam medis {scope.name}</button></p>
      )}

      <Modal open={!!icd} onClose={() => setIcd(null)} title={icd ? `${icd.icd10_code} · ${icd.title}` : ''}>
        {icdTrend.data ? <LineChart data={icdTrend.data.data.map((d: any) => ({ ...d, label: fmtDate(d.bucket).slice(0, 6) }))} x="label" series={[{ key: 'value', name: 'Kasus' }]} area height={260} />
          : <Loading />}
        <p className="text-[12.5px] text-bark mt-2">Kasus per minggu, 90 hari terakhir, {scope.name}.</p>
      </Modal>
      <p className="sr-only">{me?.user.full_name}</p>
    </div>
  );
}
