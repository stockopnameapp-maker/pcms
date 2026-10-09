import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api, download } from '../lib/api';
import { fmtDate, fmtMoney, fmtMoneyShort, fmtNum, label, shiftDate, todayISO } from '../lib/format';
import { useSession } from '../lib/session';
import { BarChart, DonutChart, LineChart, SERIES } from '../components/Chart';
import { Empty, ErrorBox, Loading, PageHeader, Panel, Tabs, cx, useToast } from '../components/ui';

const DIMS = [
  { id: 'category', label: 'Kategori biaya' }, { id: 'company', label: 'Per PT' }, { id: 'estate', label: 'Per kebun' }, { id: 'clinic', label: 'Per klinik' },
  { id: 'disease', label: 'Per penyakit' }, { id: 'employee', label: 'Per karyawan' }, { id: 'payer', label: 'Penjamin' }, { id: 'month', label: 'Per bulan' },
];
const PERIODS = [{ d: 30, l: '30 hari' }, { d: 90, l: '90 hari' }, { d: 180, l: '6 bulan' }, { d: 365, l: '12 bulan' }];

export default function Finance() {
  const { scope, can } = useSession();
  const toast = useToast();
  const [dim, setDim] = useState('category');
  const [days, setDays] = useState(180);
  const to = todayISO(); const from = shiftDate(to, -(days - 1));
  const enabled = !!scope;
  const base = { unitId: scope?.id, from, to };
  const costs = useQuery({ queryKey: ['fin', dim, base], queryFn: () => api.get('/finance/costs', { ...base, dimension: dim, limit: 30 }), enabled });
  const cats = useQuery({ queryKey: ['fin', 'category', base], queryFn: () => api.get('/finance/costs', { ...base, dimension: 'category', limit: 20 }), enabled });
  const trendM = useQuery({ queryKey: ['fin', 'trend', base], queryFn: () => api.get('/dashboard/trend', { ...base, from: shiftDate(to, -364), metric: 'medical_cost', bucket: 'month' }), enabled });
  const trendD = useQuery({ queryKey: ['fin', 'trendMed', base], queryFn: () => api.get('/dashboard/trend', { ...base, from: shiftDate(to, -364), metric: 'medicine_cost', bucket: 'month' }), enabled });
  const kpi = useQuery({ queryKey: ['fin', 'kpi', base], queryFn: () => api.get('/dashboard/summary', base), enabled });

  const trend = useMemo(() => {
    const a = trendM.data?.data ?? []; const b = new Map((trendD.data?.data ?? []).map((x: any) => [x.bucket, x.value]));
    return a.map((x: any) => ({ label: fmtDate(x.bucket).slice(3), medical: x.value, medicine: b.get(x.bucket) ?? 0 }));
  }, [trendM.data, trendD.data]);

  if (!scope) return <Loading />;
  if ((costs.error as any)?.status === 403) return <Empty title={`Analitik biaya tidak tersedia untuk ${scope.name}`} hint="Peran Anda tidak memiliki izin analitik (DASHBOARD) pada unit ini. Pilih unit lain pada bar cakupan." />;
  const coded = dim === 'category' || dim === 'payer';
  const rows: any[] = (costs.data?.data ?? []).map((r: any) => (coded ? { ...r, label: label(r.label) } : r));
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  const k = kpi.data?.data;

  return (
    <div className="space-y-5">
      <PageHeader title={`Analitik biaya medis · ${scope.name}`} description={`${fmtDate(from)} – ${fmtDate(to)}. Biaya tercatat otomatis dari pengeluaran obat, laboratorium, rujukan, MCU dan operasional ambulans.`}
        actions={<div className="flex gap-2 flex-wrap">
          <div className="flex rounded-md border border-line bg-white p-0.5">{PERIODS.map((p) => (
            <button key={p.d} className={cx('px-3 h-8 rounded text-[13px]', days === p.d ? 'bg-canopy-600 text-white' : 'text-bark-700 hover:bg-canopy-50')} onClick={() => setDays(p.d)}>{p.l}</button>))}</div>
          {(can('FINANCE', 'EXPORT') || can('REPORT', 'EXPORT')) && <button className="btn-secondary" onClick={() => download(`/reports/MEDICAL_COST`, { ...base, dimension: dim, format: 'xlsx' }).catch((e) => toast('error', e.message))}><Download className="w-4 h-4" />Excel</button>}
        </div>} />

      {k && (
        <section className="panel grid grid-cols-2 md:grid-cols-4 divide-x divide-line">
          {[['Total biaya medis', fmtMoneyShort(k.medical_cost), `periode sebelumnya ${fmtMoneyShort(k.medical_cost_prev)}`],
            ['Biaya obat', fmtMoneyShort(k.medicine_cost), k.medical_cost ? `${fmtNum((k.medicine_cost / k.medical_cost) * 100, 1)}% dari total` : ''],
            ['Biaya per karyawan', k.total_employees ? fmtMoneyShort(k.cost_per_employee) : '–', `${fmtNum(k.total_employees)} karyawan aktif`],
            ['Biaya per kunjungan', k.patient_visits ? fmtMoneyShort(k.medical_cost / k.patient_visits) : '–', `${fmtNum(k.patient_visits)} kunjungan`]].map(([t, v, s]) => (
            <div key={t} className="px-5 py-4"><p className="text-[12.5px] text-bark">{t}</p><p className="font-cond text-[26px] font-semibold num leading-tight mt-1">{v}</p><p className="text-[12px] text-bark mt-0.5">{s}</p></div>))}
        </section>
      )}

      <div className="grid xl:grid-cols-[1.6fr_1fr] gap-5">
        <Panel title="Tren 12 bulan">
          {trendM.isLoading ? <Loading /> : <LineChart data={trend} x="label" series={[{ key: 'medical', name: 'Total biaya medis' }, { key: 'medicine', name: 'Biaya obat' }]} money height={260} />}
          <ErrorBox error={trendM.error} />
        </Panel>
        <Panel title="Komposisi biaya">
          {cats.isLoading ? <Loading /> : <DonutChart data={(cats.data?.data ?? []).map((r: any, i: number) => ({ name: label(r.label), value: Number(r.amount), color: SERIES[i % SERIES.length] }))} height={260} />}
        </Panel>
      </div>

      <Panel title="Rincian biaya" bodyClass="p-0">
        <div className="px-4 pt-3"><Tabs tabs={DIMS} value={dim} onChange={setDim} /></div>
        {costs.isLoading ? <Loading /> : !rows.length ? <Empty title="Belum ada biaya tercatat pada periode ini" /> : (
          <div className="grid lg:grid-cols-[1fr_1.1fr] gap-0">
            <div className="p-4"><BarChart data={[...rows].slice(0, 15).reverse()} x="label" y="amount" horizontal money height={Math.max(220, Math.min(rows.length, 15) * 28)} name="Biaya" /></div>
            <div className="overflow-x-auto border-l border-line">
              <table className="tbl">
                <thead><tr><th>{DIMS.find((d) => d.id === dim)?.label}</th><th className="text-right">Biaya</th><th className="text-right">Porsi</th><th className="text-right">Transaksi</th><th className="text-right">Per karyawan</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.key ?? r.label}><td>{r.label}</td><td className="text-right num">{fmtMoney(r.amount)}</td>
                    <td className="text-right num">{total ? fmtNum((Number(r.amount) / total) * 100, 1) : 0}%</td><td className="text-right num">{fmtNum(r.transactions)}</td>
                    <td className="text-right num">{r.per_employee != null ? fmtMoney(r.per_employee) : '–'}</td></tr>))}
                  <tr className="font-semibold bg-mist"><td>Total</td><td className="text-right num">{fmtMoney(total)}</td><td className="text-right num">100%</td><td className="text-right num">{fmtNum(rows.reduce((s, r) => s + Number(r.transactions), 0))}</td><td /></tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
        <ErrorBox error={costs.error} />
      </Panel>
    </div>
  );
}
