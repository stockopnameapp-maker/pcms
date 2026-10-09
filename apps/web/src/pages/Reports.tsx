import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Download, FileSpreadsheet, FileText, Lock, Play, Printer } from 'lucide-react';
import { api, download } from '../lib/api';
import { fmtDate, fmtNum, shiftDate, todayISO } from '../lib/format';
import { useSession } from '../lib/session';
import { DataTable } from '../components/DataTable';
import { RefSelect } from '../components/RefSelect';
import { Empty, ErrorBox, Field, Loading, PageHeader, Panel, Spinner, cx, useToast } from '../components/ui';

const DIM_LABEL: Record<string, string> = { category: 'Kategori', company: 'PT', estate: 'Kebun', clinic: 'Klinik', disease: 'Penyakit', employee: 'Karyawan', payer: 'Penjamin', month: 'Bulan' };

export default function Reports() {
  const { scope } = useSession();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const list = useQuery({ queryKey: ['reports'], queryFn: () => api.get('/reports') });
  const reports: any[] = list.data?.data ?? [];
  const code = sp.get('code') ?? reports.find((r) => r.allowed)?.code;
  const rep = reports.find((r) => r.code === code);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayISO());
  const [dimension, setDimension] = useState('');
  const [run, setRun] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { if (!unitId && scope) setUnitId(scope.id); }, [scope, unitId]);
  useEffect(() => {
    if (!rep) return;
    setFrom(shiftDate(todayISO(), -(rep.defaultDays - 1))); setTo(todayISO());
    setDimension(rep.dimensions?.[0] ?? ''); setRun(null);
  }, [rep?.code]);

  const params = { unitId, from, to, dimension: dimension || undefined };
  const result = useQuery({ queryKey: ['report', run], queryFn: () => api.get(`/reports/${run.code}`, run.params), enabled: !!run, retry: false });

  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of reports) m.set(r.category, [...(m.get(r.category) ?? []), r]);
    return [...m.entries()];
  }, [reports]);

  async function exp(format: string) {
    setBusy(format);
    try { await download(`/reports/${rep.code}`, { ...params, format }, `${rep.code}.${format}`); toast('ok', 'Laporan diunduh dan tercatat di audit trail'); }
    catch (e: any) { toast('error', e.message); } finally { setBusy(null); }
  }

  if (list.isLoading) return <Loading />;
  return (
    <div className="space-y-5">
      <PageHeader title="Pusat laporan" description="Semua laporan dihitung langsung dari basis data sesuai cakupan unit dan izin Anda. Setiap unduhan tercatat di audit trail." />
      <ErrorBox error={list.error} />
      <div className="grid lg:grid-cols-[280px_1fr] gap-5 items-start">
        <nav className="panel p-2" aria-label="Daftar laporan">
          {groups.map(([cat, items]) => (
            <div key={cat} className="mb-2 last:mb-0">
              <p className="px-2 pt-2 pb-1 text-[12px] text-bark font-medium">{cat}</p>
              {items.map((r) => (
                <button key={r.code} disabled={!r.allowed} onClick={() => setSp({ code: r.code })}
                  className={cx('w-full text-left px-2.5 py-1.5 rounded text-[13.5px] flex items-center gap-2',
                    r.code === code ? 'bg-canopy-600 text-white' : r.allowed ? 'hover:bg-canopy-50 text-ink' : 'text-bark/60 cursor-not-allowed')}>
                  <span className="flex-1">{r.title.replace(/^Laporan /, '')}</span>{!r.allowed && <Lock className="w-3.5 h-3.5" />}
                </button>))}
            </div>))}
        </nav>

        {!rep ? <Empty title="Tidak ada laporan yang dapat Anda akses" /> : (
          <div className="space-y-4 min-w-0">
            <Panel title={rep.title}>
              <p className="text-[13.5px] text-bark-700 mb-4">{rep.description}</p>
              <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3 items-end">
                <Field label="Unit organisasi" className="xl:col-span-2"><RefSelect kind="org_unit" value={unitId} onChange={setUnitId} allowClear={false} /></Field>
                {rep.defaultDays > 1 && <>
                  <Field label="Dari tanggal"><input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
                  <Field label="Sampai tanggal"><input type="date" className="input" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} /></Field>
                </>}
                {rep.dimensions && <Field label="Dimensi"><select className="input" value={dimension} onChange={(e) => setDimension(e.target.value)}>{rep.dimensions.map((d: string) => <option key={d} value={d}>{DIM_LABEL[d] ?? d}</option>)}</select></Field>}
              </div>
              <div className="flex flex-wrap gap-2 mt-4">
                <button className="btn-primary" disabled={!unitId || (rep.defaultDays > 1 && (!from || !to || from > to))} onClick={() => setRun({ code: rep.code, params: { ...params } })}><Play className="w-4 h-4" />Tampilkan</button>
                {rep.canExport ? <>
                  <button className="btn-secondary" disabled={!unitId || !!busy} onClick={() => exp('xlsx')}>{busy === 'xlsx' ? <Spinner className="w-4 h-4" /> : <FileSpreadsheet className="w-4 h-4" />}Excel</button>
                  <button className="btn-secondary" disabled={!unitId || !!busy} onClick={() => exp('csv')}>{busy === 'csv' ? <Spinner className="w-4 h-4" /> : <Download className="w-4 h-4" />}CSV</button>
                  <button className="btn-secondary" disabled={!unitId || !!busy} onClick={() => exp('pdf')}>{busy === 'pdf' ? <Spinner className="w-4 h-4" /> : <Printer className="w-4 h-4" />}PDF</button>
                </> : <span className="text-[12.5px] text-bark self-center">Anda dapat melihat laporan ini, tetapi tidak memiliki izin EXPORT.</span>}
              </div>
            </Panel>

            {run && (
              <Panel title={result.data ? `${result.data.report.unitName} · ${rep.defaultDays > 1 ? `${fmtDate(result.data.report.from)} – ${fmtDate(result.data.report.to)}` : `per ${fmtDate(todayISO())}`}` : 'Hasil'}
                actions={result.data && <span className="text-[12.5px] text-bark num">{fmtNum(result.data.total)} baris{result.data.total > result.data.rows.length ? `, ${fmtNum(result.data.rows.length)} ditampilkan — unduh untuk data lengkap` : ''}</span>} bodyClass="p-0">
                {result.isLoading ? <Loading text="Menghitung laporan…" /> : result.error ? <div className="p-4"><ErrorBox error={result.error} /></div> : (
                  <div className="max-h-[65vh] overflow-auto">
                    <DataTable columns={result.data.columns} rows={result.data.rows.map((r: any, i: number) => ({ ...r, __k: i }))} rowKey="__k"
                      empty={<Empty title="Tidak ada data pada periode dan unit ini" />} />
                  </div>
                )}
              </Panel>
            )}
            {!run && <div className="panel p-6 text-center text-bark text-[13.5px]"><FileText className="w-6 h-6 mx-auto mb-2 text-canopy-600" />Atur unit dan periode, lalu tekan <b>Tampilkan</b> untuk pratinjau.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
