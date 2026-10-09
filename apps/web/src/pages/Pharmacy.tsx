import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRightLeft, PackagePlus, Plus, Trash2, Truck } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, fmtMoney, fmtMoneyShort, fmtNum, label, todayISO } from '../lib/format';
import { useSession } from '../lib/session';
import { RefSelect } from '../components/RefSelect';
import { Drawer, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Panel, Spinner, Status, Tag, cx, useToast } from '../components/ui';
import { useClinicChoice } from './Queue';

// ------------------------------------------------------------------ dispensing
export function DispenseList() {
  const [clinicId, setClinicId] = useClinicChoice();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['rx-queue', clinicId], queryFn: () => api.get('/pharmacy/prescriptions', { clinicId }), refetchInterval: 20_000 });
  return (
    <div>
      <PageHeader title="Resep masuk" description="Resep yang dikirim dokter dan menunggu penyerahan obat. Stok dipotong otomatis per batch (kedaluwarsa terdekat lebih dulu)."
        actions={<div className="w-64"><RefSelect kind="clinic" value={clinicId} onChange={(v) => setClinicId(v)} placeholder="Semua klinik" /></div>} />
      <div className="panel">
        {q.isLoading ? <Loading /> : q.data?.data.length ? (
          <table className="tbl"><thead><tr><th>Waktu</th><th>Antrian</th><th>No. resep</th><th>Pasien</th><th>Dokter</th><th>Klinik</th><th className="text-right">Item</th><th>Status</th></tr></thead>
            <tbody>{q.data.data.map((r: any) => (
              <tr key={r.id} className="cursor-pointer" onClick={() => nav(`/pharmacy/dispense/${r.id}`)}>
                <td className="num">{fmtDateTime(r.prescribed_at)}</td><td className="font-cond font-semibold">{r.queue_code ?? '–'}</td><td>{r.prescription_no}</td>
                <td>{r.patient_name}<span className="block text-[12px] text-bark">{r.mrn}</span></td><td>{r.prescriber_name}</td><td>{r.clinic_name}</td><td className="text-right num">{r.items}</td><td><Status value={r.status} /></td>
              </tr>))}</tbody></table>
        ) : <Empty title="Tidak ada resep menunggu" hint="Resep baru muncul otomatis setelah dokter mengirimkannya dari rekam medis." />}
        <ErrorBox error={q.error} />
      </div>
    </div>
  );
}

export function Dispense() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ['rx', id], queryFn: () => api.get(`/pharmacy/prescriptions/${id}`) });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (q.data) setQty(Object.fromEntries(q.data.items.map((i: any) => [i.id, String(Math.max(0, Math.min(Number(i.qty) - Number(i.dispensed_qty), Number(i.available))))])));
  }, [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { prescription: rx, items, allergies } = q.data;
  const open = ['SUBMITTED', 'IN_PREPARATION', 'PARTIALLY_DISPENSED'].includes(rx.status);
  async function dispense() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/pharmacy/prescriptions/${id}/dispense`, { items: Object.entries(qty).map(([itemId, v]) => ({ itemId, qty: Number(v) || 0 })) });
      toast('ok', r.status === 'DISPENSED' ? 'Obat diserahkan, kunjungan selesai' : 'Sebagian obat diserahkan'); nav('/pharmacy/dispense');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <PageHeader title={`Resep ${rx.prescription_no}`} description={`${rx.patient_name} (${rx.mrn}) · ${label(rx.gender)}, ${rx.age} th · ${rx.prescriber_name} · ${rx.clinic_name} · ${fmtDateTime(rx.prescribed_at)}`}
        actions={<Status value={rx.status} />} />
      {allergies.length > 0 && <p className="flex gap-2 text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-[13.5px]"><AlertTriangle className="w-4 h-4 mt-0.5" />Alergi obat: {allergies.map((a: any) => `${a.allergen} (${label(a.severity)})`).join(', ')}</p>}
      {rx.notes && <p className="text-[13.5px] bg-kernel-50 border border-kernel-100 rounded-md px-3 py-2">{rx.notes}</p>}
      <div className="panel">
        <table className="tbl"><thead><tr><th>Obat</th><th>Aturan pakai</th><th className="text-right">Diresepkan</th><th className="text-right">Sudah diserahkan</th><th className="text-right">Stok layak</th><th className="text-right w-32">Serahkan</th></tr></thead>
          <tbody>{items.map((i: any) => {
            const remain = Number(i.qty) - Number(i.dispensed_qty);
            return (
              <tr key={i.id}>
                <td>{i.medicine} {['PSYCHOTROPIC', 'NARCOTIC'].includes(i.drug_class) && <Tag tone="red">{label(i.drug_class)}</Tag>}</td>
                <td>{i.dose} · {i.frequency} · {label(i.route)}{i.duration_days ? ` · ${i.duration_days} hari` : ''}<span className="block text-[12px] text-bark">{i.instructions}</span></td>
                <td className="text-right num">{fmtNum(i.qty)} {i.unit}</td><td className="text-right num">{fmtNum(i.dispensed_qty)}</td>
                <td className={cx('text-right num', Number(i.available) < remain && 'text-sev-high font-medium')}>{fmtNum(i.available)}</td>
                <td className="text-right">{open && remain > 0 ? <input className="input num text-right h-8" value={qty[i.id] ?? ''} onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value.replace(/[^\d.]/g, '') }))} /> : <Tag tone="green">lengkap</Tag>}</td>
              </tr>);
          })}</tbody></table>
      </div>
      <ErrorBox error={err} />
      {open && <div className="flex justify-end gap-2"><Link to="/pharmacy/stock" className="btn-secondary">Cek stok / minta transfer</Link><button className="btn-primary" disabled={busy} onClick={dispense}>{busy && <Spinner className="w-4 h-4 text-white" />}Serahkan obat</button></div>}
    </div>
  );
}

// ------------------------------------------------------------------ stock
function StockDetail({ siteId, medicine, onClose }: { siteId: string; medicine: any; onClose: () => void }) {
  const q = useQuery({ queryKey: ['stock-detail', siteId, medicine.medicine_id], queryFn: () => api.get(`/pharmacy/stock/${siteId}/${medicine.medicine_id}`) });
  const [adj, setAdj] = useState<any>(null);
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <Drawer open onClose={onClose} title={medicine.name} subtitle={`${medicine.site_name} · ${fmtNum(medicine.qty_on_hand)} ${medicine.unit}`}>
      {q.isLoading ? <Loading /> : (
        <div className="space-y-5">
          <section>
            <h3 className="font-semibold mb-2">Batch</h3>
            <table className="tbl"><thead><tr><th>Batch</th><th>Kedaluwarsa</th><th className="text-right">Qty</th><th></th></tr></thead>
              <tbody>{q.data.batches.map((b: any) => (
                <tr key={b.batch_id}><td>{b.batch_no}</td><td className={cx('num', b.days_to_expiry < 0 ? 'text-sev-critical' : b.days_to_expiry < 60 && 'text-sev-high')}>{fmtDate(b.expiry_date)} <span className="text-[12px]">({b.days_to_expiry} hr)</span></td>
                  <td className="text-right num">{fmtNum(b.qty_on_hand)}</td><td className="text-right"><button className="btn-ghost btn-sm" onClick={() => setAdj({ batchId: b.batch_id, batchNo: b.batch_no, type: b.days_to_expiry < 0 ? 'EXPIRED_WRITE_OFF' : 'ADJUSTMENT_OUT', qty: '', reason: '' })}>Penyesuaian</button></td></tr>))}</tbody></table>
          </section>
          <section>
            <h3 className="font-semibold mb-2">Mutasi terakhir</h3>
            <table className="tbl"><tbody>{q.data.movements.map((m: any, i: number) => (
              <tr key={i}><td className="num whitespace-nowrap">{fmtDateTime(m.txn_at)}</td><td><Tag>{label(m.txn_type)}</Tag></td><td className={cx('text-right num', m.qty < 0 ? 'text-bark-700' : 'text-canopy-700')}>{m.qty > 0 ? '+' : ''}{fmtNum(m.qty)}</td>
                <td className="text-[12px] text-bark">{m.batch_no} · {m.by_name ?? 'sistem'}{m.reason ? ` · ${m.reason}` : ''}</td></tr>))}</tbody></table>
          </section>
        </div>
      )}
      <Modal open={!!adj} onClose={() => setAdj(null)} title={`Penyesuaian stok · batch ${adj?.batchNo}`} size="sm"
        footer={<><button className="btn-secondary" onClick={() => setAdj(null)}>Batal</button><button className="btn-primary" disabled={!Number(adj?.qty) || (adj?.reason ?? '').length < 5}
          onClick={async () => { try { await api.post('/pharmacy/adjustments', { siteId, medicineId: medicine.medicine_id, batchId: adj.batchId, qty: Number(adj.qty), type: adj.type, reason: adj.reason }); toast('ok', 'Penyesuaian dicatat'); setAdj(null); q.refetch(); qc.invalidateQueries({ queryKey: ['stock'] }); } catch (e: any) { toast('error', e.message); } }}>Simpan</button></>}>
        {adj && <div className="space-y-3">
          <Field label="Jenis"><select className="input" value={adj.type} onChange={(e) => setAdj({ ...adj, type: e.target.value })}>
            {['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGED_WRITE_OFF', 'EXPIRED_WRITE_OFF', 'RETURN_FROM_PATIENT', 'RETURN_TO_SUPPLIER'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Jumlah"><input className="input num" value={adj.qty} onChange={(e) => setAdj({ ...adj, qty: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
          <Field label="Alasan (wajib, tercatat di audit)"><textarea className="input" rows={2} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Drawer>
  );
}

export function TransferRequestModal({ open, onClose, toUnitId, preset }: { open: boolean; onClose: () => void; toUnitId?: string | null; preset?: { medicineId: string; qty: number }[] }) {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(toUnitId ?? null);
  const [priority, setPriority] = useState('NORMAL');
  const [items, setItems] = useState<{ medicineId: string | null; qty: string }[]>([{ medicineId: null, qty: '' }]);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  const nav = useNavigate();
  useEffect(() => { if (open) { setTo(toUnitId ?? null); setItems(preset?.length ? preset.map((p) => ({ medicineId: p.medicineId, qty: String(p.qty) })) : [{ medicineId: null, qty: '' }]); setErr(null); } }, [open]);
  async function submit() {
    try {
      const r = await api.post('/pharmacy/transfers', { fromUnitId: from, toUnitId: to, priority, items: items.filter((i) => i.medicineId && Number(i.qty) > 0).map((i) => ({ medicineId: i.medicineId, qty: Number(i.qty) })) });
      toast('ok', 'Permintaan transfer dikirim untuk persetujuan'); onClose(); nav(`/pharmacy/transfers/${r.id}`);
    } catch (e) { setErr(e); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Permintaan obat ke klinik lain / gudang pusat" size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className="btn-primary" disabled={!from || !to || !items.some((i) => i.medicineId && Number(i.qty) > 0)} onClick={submit}>Kirim permintaan</button></>}>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Minta dari"><RefSelect kind="stock_site" value={from} onChange={setFrom} /></Field>
        <Field label="Untuk (penerima)"><RefSelect kind="stock_site" value={to} onChange={setTo} /></Field>
        <Field label="Prioritas"><select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="NORMAL">Normal</option><option value="URGENT">Mendesak</option></select></Field>
      </div>
      <div className="mt-4 space-y-2">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1fr_120px_auto] gap-2 items-end">
            <Field label={i === 0 ? 'Obat' : ''}><RefSelect kind="medicine" value={it.medicineId} onChange={(v) => setItems((s) => s.map((x, j) => (j === i ? { ...x, medicineId: v } : x)))} /></Field>
            <Field label={i === 0 ? 'Jumlah' : ''}><input className="input num" value={it.qty} onChange={(e) => setItems((s) => s.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '') } : x)))} /></Field>
            <button className="btn-ghost btn-sm" onClick={() => setItems((s) => (s.length > 1 ? s.filter((_, j) => j !== i) : s))} aria-label="Hapus"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <button className="btn-ghost btn-sm" onClick={() => setItems((s) => [...s, { medicineId: null, qty: '' }])}><Plus className="w-4 h-4" />Tambah obat</button>
      </div>
      <div className="mt-3"><ErrorBox error={err} /></div>
    </Modal>
  );
}

function ReceiptModal({ open, onClose, siteId }: { open: boolean; onClose: () => void; siteId: string }) {
  const [supplier, setSupplier] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [rows, setRows] = useState<any[]>([{ medicineId: null, batchNo: '', expiryDate: '', qty: '', unitCost: '' }]);
  const [err, setErr] = useState<any>(null);
  const toast = useToast(); const qc = useQueryClient();
  async function submit() {
    try {
      await api.post('/pharmacy/receipts', { siteId, supplierId: supplier ?? undefined, reference: ref || undefined,
        items: rows.filter((r) => r.medicineId).map((r) => ({ medicineId: r.medicineId, batchNo: r.batchNo, expiryDate: r.expiryDate, qty: Number(r.qty), unitCost: Number(r.unitCost || 0) })) });
      toast('ok', 'Penerimaan barang dicatat'); qc.invalidateQueries({ queryKey: ['stock'] }); onClose();
    } catch (e) { setErr(e); }
  }
  const set = (i: number, k: string, v: any) => setRows((s) => s.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <Modal open={open} onClose={onClose} title="Penerimaan barang (tanpa PO)" size="xl"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className="btn-primary" onClick={submit}>Simpan penerimaan</button></>}>
      <div className="grid sm:grid-cols-2 gap-3 mb-4"><Field label="Supplier"><RefSelect kind="supplier" value={supplier} onChange={setSupplier} /></Field><Field label="No. faktur / referensi"><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></Field></div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-2 md:grid-cols-[2fr_1fr_1fr_100px_120px] gap-2 mb-2">
          <Field label="Obat"><RefSelect kind="medicine" value={r.medicineId} onChange={(v) => set(i, 'medicineId', v)} /></Field>
          <Field label="No. batch"><input className="input" value={r.batchNo} onChange={(e) => set(i, 'batchNo', e.target.value.toUpperCase())} /></Field>
          <Field label="Kedaluwarsa"><input type="date" className="input" value={r.expiryDate} min={todayISO()} onChange={(e) => set(i, 'expiryDate', e.target.value)} /></Field>
          <Field label="Qty"><input className="input num" value={r.qty} onChange={(e) => set(i, 'qty', e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          <Field label="Harga satuan"><input className="input num" value={r.unitCost} onChange={(e) => set(i, 'unitCost', e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        </div>
      ))}
      <button className="btn-ghost btn-sm" onClick={() => setRows((s) => [...s, { medicineId: null, batchNo: '', expiryDate: '', qty: '', unitCost: '' }])}><Plus className="w-4 h-4" />Tambah baris</button>
      <div className="mt-3"><ErrorBox error={err} /></div>
    </Modal>
  );
}

export function Stock() {
  const { scope, can } = useSession();
  const [sp] = useSearchParams();
  const [siteId, setSiteId] = useState<string | null>(null);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [low, setLow] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [transfer, setTransfer] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const toast = useToast(); const qc = useQueryClient();
  useEffect(() => { if (scope && ['CLINIC', 'WAREHOUSE'].includes(scope.unit_type)) setSiteId(scope.id); }, [scope?.id]);
  const summary = useQuery({ queryKey: ['stock', 'summary'], queryFn: () => api.get('/pharmacy/stock/summary'), enabled: !siteId });
  const list = useQuery({ queryKey: ['stock', siteId, q, low], queryFn: () => api.get('/pharmacy/stock', { siteId, q, low: low ? 1 : undefined }), enabled: !!siteId });
  const lowItems = (list.data?.data ?? []).filter((r: any) => r.is_low_stock);
  return (
    <div className="space-y-4">
      <PageHeader title="Stok obat" description="Posisi stok per klinik dan gudang. Hanya lokasi dalam cakupan akses Anda yang ditampilkan."
        actions={<>
          <div className="w-64"><RefSelect kind="stock_site" value={siteId} onChange={setSiteId} placeholder="Ringkasan semua lokasi" /></div>
          {siteId && can('INVENTORY', 'CREATE') && <>
            <button className="btn-secondary" onClick={() => setReceipt(true)}><PackagePlus className="w-4 h-4" />Terima barang</button>
            <button className="btn-secondary" onClick={() => setTransfer(true)}><ArrowRightLeft className="w-4 h-4" />Minta transfer</button>
            <button className="btn-secondary" onClick={async () => { try { const r = await api.post('/pharmacy/write-off-expired', { siteId }); toast('ok', `${r.batches} batch kedaluwarsa dimusnahkan dari stok`); qc.invalidateQueries({ queryKey: ['stock'] }); } catch (e: any) { toast('error', e.message); } }}>Musnahkan kedaluwarsa</button>
          </>}
        </>} />
      {!siteId ? (
        <div className="panel">
          {summary.isLoading ? <Loading /> : (
            <table className="tbl"><thead><tr><th>Lokasi</th><th>PT / Kebun</th><th className="text-right">Jenis obat</th><th className="text-right">Nilai stok</th><th className="text-right">Di bawah minimum</th><th className="text-right">Akan kedaluwarsa</th><th className="text-right">Kedaluwarsa</th></tr></thead>
              <tbody>{summary.data?.data.map((s: any) => (
                <tr key={s.site_id} className="cursor-pointer" onClick={() => setSiteId(s.site_id)}>
                  <td className="font-medium">{s.site_name} {s.unit_type === 'WAREHOUSE' && <Tag tone="gold">Gudang pusat</Tag>}</td><td className="text-bark">{[s.company_name, s.estate_name].filter(Boolean).join(' / ') || '–'}</td>
                  <td className="text-right num">{s.medicines}</td><td className="text-right num">{fmtMoneyShort(s.stock_value)}</td>
                  <td className={cx('text-right num', s.low_stock > 0 && 'text-sev-high font-medium')}>{s.low_stock}</td><td className={cx('text-right num', s.near_expiry_batches > 0 && 'text-amber-700')}>{s.near_expiry_batches}</td>
                  <td className={cx('text-right num', s.expired_batches > 0 && 'text-sev-critical font-medium')}>{s.expired_batches}</td>
                </tr>))}</tbody></table>
          )}
          <ErrorBox error={summary.error} />
        </div>
      ) : (
        <div className="panel">
          <div className="flex flex-wrap gap-2 items-center p-3 border-b border-line">
            <input className="input max-w-xs" placeholder="Cari obat…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" className="accent-canopy-600" checked={low} onChange={(e) => setLow(e.target.checked)} />Hanya di bawah minimum</label>
            {lowItems.length > 0 && can('INVENTORY', 'CREATE') && <button className="btn-ghost btn-sm ml-auto" onClick={() => setTransfer(true)}>Minta {lowItems.length} obat yang kurang</button>}
          </div>
          {list.isLoading ? <Loading /> : (
            <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Kode</th><th>Obat</th><th>Kategori</th><th className="text-right">Stok</th><th className="text-right">Layak pakai</th><th className="text-right">Minimum</th><th>ED terdekat</th><th className="text-right">Nilai</th></tr></thead>
              <tbody>{list.data?.data.map((r: any) => (
                <tr key={r.medicine_id} className="cursor-pointer" onClick={() => setDetail(r)}>
                  <td className="num text-bark">{r.code}</td><td>{r.name} {r.is_low_stock && <Tag tone="orange">di bawah minimum</Tag>}</td><td className="text-bark">{r.category}</td>
                  <td className="text-right num">{fmtNum(r.qty_on_hand)} <span className="text-bark text-[12px]">{r.unit}</span></td><td className={cx('text-right num', r.is_low_stock && 'text-sev-high font-medium')}>{fmtNum(r.qty_usable)}</td>
                  <td className="text-right num text-bark">{fmtNum(r.min_qty)}</td><td className={cx('num', r.days_to_expiry < 0 ? 'text-sev-critical' : r.days_to_expiry < 60 && 'text-amber-700')}>{fmtDate(r.nearest_expiry)}</td>
                  <td className="text-right num">{fmtMoneyShort(r.stock_value)}</td>
                </tr>))}</tbody></table></div>
          )}
          {list.data?.data.length === 0 && <Empty title="Tidak ada stok" />}
        </div>
      )}
      {detail && <StockDetail siteId={siteId!} medicine={detail} onClose={() => setDetail(null)} />}
      <TransferRequestModal open={transfer} onClose={() => setTransfer(false)} toUnitId={siteId} preset={lowItems.map((r: any) => ({ medicineId: r.medicine_id, qty: Math.max(1, Math.ceil(r.min_qty * 2 - r.qty_usable)) }))} />
      {siteId && <ReceiptModal open={receipt} onClose={() => setReceipt(false)} siteId={siteId} />}
    </div>
  );
}

// ------------------------------------------------------------------ transfer workflow
export function TransferDetail() {
  const { id } = useParams();
  const toast = useToast();
  const q = useQuery({ queryKey: ['transfer', id], queryFn: () => api.get(`/pharmacy/transfers/${id}`) });
  const [approve, setApprove] = useState<Record<string, string>>({});
  const [reject, setReject] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { transfer: t, items, events, transitions } = q.data;
  const can = (s: string) => transitions.some((x: any) => x.to_status === s);
  const act = async (path: string, body?: any, msg?: string) => {
    setBusy(true);
    try { await api.post(`/pharmacy/transfers/${id}/${path}`, body ?? {}); toast('ok', msg ?? 'Tersimpan'); q.refetch(); } catch (e: any) { toast('error', e.message); } finally { setBusy(false); }
  };
  const steps = ['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED'];
  const idx = steps.indexOf(t.status);
  return (
    <div className="space-y-4">
      <PageHeader title={`Transfer ${t.transfer_no}`} description={`${t.from_name} → ${t.to_name} · diminta ${fmtDateTime(t.requested_at)}`} actions={<><Status value={t.priority} /><Status value={t.status} /></>} />
      <ol className="flex flex-wrap gap-2">
        {['Permintaan', 'Persetujuan', 'Pengiriman', 'Penerimaan & stok'].map((s, i) => (
          <li key={s} className={cx('flex items-center gap-2 px-3 py-1.5 rounded-md border text-[13px]', i <= idx && !['REJECTED', 'CANCELLED'].includes(t.status) ? 'border-canopy-300 bg-canopy-50 text-canopy-700' : 'border-line text-bark')}>
            <span className="w-5 h-5 rounded-full grid place-items-center text-[11px] border border-current num">{i + 1}</span>{s}</li>))}
        {['REJECTED', 'CANCELLED'].includes(t.status) && <li className="px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-red-700 text-[13px]">{label(t.status)}{t.reject_reason ? `: ${t.reject_reason}` : ''}</li>}
      </ol>
      <div className="panel">
        <table className="tbl"><thead><tr><th>Obat</th><th className="text-right">Diminta</th><th className="text-right">Stok di asal</th><th className="text-right">Disetujui</th><th>Batch</th><th className="text-right">Dikirim</th><th className="text-right">Diterima</th></tr></thead>
          <tbody>{items.map((i: any) => (
            <tr key={i.id}><td>{i.medicine}</td><td className="text-right num">{fmtNum(i.qty_requested)} {i.unit}</td><td className={cx('text-right num', Number(i.available_at_source) < Number(i.qty_requested) && 'text-sev-high')}>{fmtNum(i.available_at_source)}</td>
              <td className="text-right">{t.status === 'REQUESTED' && can('APPROVED') ? <input className="input num text-right h-8 w-24 ml-auto" placeholder={String(i.qty_requested)} value={approve[i.id] ?? ''} onChange={(e) => setApprove((s) => ({ ...s, [i.id]: e.target.value.replace(/[^\d.]/g, '') }))} /> : <span className="num">{fmtNum(i.qty_approved)}</span>}</td>
              <td className="text-bark">{i.batch_no ? `${i.batch_no} (ED ${fmtDate(i.expiry_date)})` : '–'}</td><td className="text-right num">{fmtNum(i.qty_shipped)}</td><td className="text-right num">{fmtNum(i.qty_received)}</td></tr>))}</tbody></table>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {can('REJECTED') && <button className="btn-danger" disabled={busy} onClick={() => setReject('')}>Tolak</button>}
        {can('APPROVED') && <button className="btn-primary" disabled={busy} onClick={() => act('approve', { items: Object.entries(approve).filter(([, v]) => v !== '').map(([itemId, v]) => ({ itemId, qtyApproved: Number(v) })) }, 'Transfer disetujui')}>Setujui</button>}
        {t.status === 'APPROVED' && can('IN_TRANSIT') && <button className="btn-primary" disabled={busy} onClick={() => act('ship', {}, 'Barang dikirim — stok asal dipotong')}><Truck className="w-4 h-4" />Kirim (FEFO)</button>}
        {t.status === 'IN_TRANSIT' && can('RECEIVED') && <button className="btn-primary" disabled={busy} onClick={() => act('receive', {}, 'Barang diterima — stok tujuan bertambah')}>Terima barang</button>}
        {busy && <Spinner />}
      </div>
      {transitions.length === 0 && !['RECEIVED', 'REJECTED', 'CANCELLED'].includes(t.status) && <p className="text-[13px] text-bark text-right">Menunggu tindakan dari pihak lain (persetujuan oleh lokasi asal, penerimaan oleh lokasi tujuan).</p>}
      <Panel title="Riwayat">
        <ol className="space-y-2">{events.map((e: any, i: number) => <li key={i} className="text-[13.5px]"><Status value={e.to_status} /> <span className="text-bark">{e.actor ?? 'sistem'} · {fmtDateTime(e.occurred_at)}</span>{e.note && <span className="block text-bark-700">{e.note}</span>}</li>)}</ol>
      </Panel>
      <Modal open={reject !== null} onClose={() => setReject(null)} title="Tolak permintaan transfer" size="sm"
        footer={<><button className="btn-secondary" onClick={() => setReject(null)}>Batal</button><button className="btn-danger" disabled={(reject ?? '').length < 5} onClick={() => { act('reject', { reason: reject }, 'Permintaan ditolak'); setReject(null); }}>Tolak</button></>}>
        <Field label="Alasan penolakan"><textarea className="input" rows={3} value={reject ?? ''} onChange={(e) => setReject(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ purchase orders
export function PurchaseOrderNew({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [site, setSite] = useState<string | null>(null);
  const [supplier, setSupplier] = useState<string | null>(null);
  const [rows, setRows] = useState<any[]>([{ medicineId: null, qty: '', unitPrice: '' }]);
  const [err, setErr] = useState<any>(null);
  const nav = useNavigate();
  const total = rows.reduce((s, r) => s + Number(r.qty || 0) * Number(r.unitPrice || 0), 0);
  return (
    <Modal open={open} onClose={onClose} title="Purchase order baru" size="lg"
      footer={<><span className="mr-auto text-[13.5px]">Total <span className="num font-semibold">{fmtMoney(total)}</span></span><button className="btn-secondary" onClick={onClose}>Batal</button>
        <button className="btn-primary" disabled={!site || !supplier} onClick={async () => { try { const r = await api.post('/pharmacy/purchase-orders', { siteId: site, supplierId: supplier, submit: true, items: rows.filter((x) => x.medicineId).map((x) => ({ medicineId: x.medicineId, qty: Number(x.qty), unitPrice: Number(x.unitPrice) })) }); onClose(); nav(`/pharmacy/purchase-orders/${r.id}`); } catch (e) { setErr(e); } }}>Ajukan PO</button></>}>
      <div className="grid sm:grid-cols-2 gap-3 mb-3"><Field label="Lokasi penerima"><RefSelect kind="stock_site" value={site} onChange={setSite} /></Field><Field label="Supplier"><RefSelect kind="supplier" value={supplier} onChange={setSupplier} /></Field></div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[2fr_100px_140px] gap-2 mb-2">
          <RefSelect kind="medicine" value={r.medicineId} onChange={(v) => setRows((s) => s.map((x, j) => (j === i ? { ...x, medicineId: v } : x)))} />
          <input className="input num" placeholder="Qty" value={r.qty} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
          <input className="input num" placeholder="Harga satuan" value={r.unitPrice} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
        </div>))}
      <button className="btn-ghost btn-sm" onClick={() => setRows((s) => [...s, { medicineId: null, qty: '', unitPrice: '' }])}><Plus className="w-4 h-4" />Tambah baris</button>
      <div className="mt-3"><ErrorBox error={err} /></div>
    </Modal>
  );
}

export function PurchaseOrderDetail() {
  const { id } = useParams();
  const toast = useToast();
  const q = useQuery({ queryKey: ['po', id], queryFn: () => api.get(`/pharmacy/purchase-orders/${id}`) });
  const [recv, setRecv] = useState<Record<string, any>>({});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { po, items, transitions, events } = q.data;
  const receiving = ['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status);
  const go = async (to: string) => { try { await api.post(`/r/purchase-orders/${id}/transition`, { to }); toast('ok', label(to)); q.refetch(); } catch (e: any) { toast('error', e.message); } };
  return (
    <div className="space-y-4">
      <PageHeader title={`PO ${po.po_no}`} description={`${po.supplier_name} → ${po.site_name} · ${fmtDate(po.order_date)} · ${fmtMoney(po.total_amount)}`}
        actions={<><Status value={po.status} />{transitions.filter((t: any) => !['RECEIVED', 'PARTIALLY_RECEIVED'].includes(t.to_status)).map((t: any) => <button key={t.to_status} className={t.required_action === 'APPROVE' ? 'btn-primary' : 'btn-secondary'} onClick={() => go(t.to_status)}>{t.label}</button>)}</>} />
      <div className="panel"><table className="tbl"><thead><tr><th>Obat</th><th className="text-right">Dipesan</th><th className="text-right">Diterima</th><th className="text-right">Harga</th>{receiving && <><th>No. batch</th><th>Kedaluwarsa</th><th className="text-right">Terima</th></>}</tr></thead>
        <tbody>{items.map((i: any) => {
          const rest = Number(i.qty_ordered) - Number(i.qty_received); const r = recv[i.id] ?? {};
          return (<tr key={i.id}><td>{i.medicine}</td><td className="text-right num">{fmtNum(i.qty_ordered)} {i.unit}</td><td className="text-right num">{fmtNum(i.qty_received)}</td><td className="text-right num">{fmtMoney(i.unit_price)}</td>
            {receiving && <>{rest > 0 ? <>
              <td><input className="input h-8" value={r.batchNo ?? ''} onChange={(e) => setRecv((s) => ({ ...s, [i.id]: { ...r, batchNo: e.target.value.toUpperCase() } }))} /></td>
              <td><input type="date" className="input h-8" value={r.expiryDate ?? ''} onChange={(e) => setRecv((s) => ({ ...s, [i.id]: { ...r, expiryDate: e.target.value } }))} /></td>
              <td><input className="input h-8 num text-right w-24 ml-auto" placeholder={String(rest)} value={r.qty ?? ''} onChange={(e) => setRecv((s) => ({ ...s, [i.id]: { ...r, qty: e.target.value.replace(/[^\d.]/g, '') } }))} /></td></> : <td colSpan={3}><Tag tone="green">lengkap</Tag></td>}</>}
          </tr>);
        })}</tbody></table></div>
      {receiving && <div className="flex justify-end"><button className="btn-primary" onClick={async () => {
        const list = Object.entries(recv).filter(([, r]: any) => r.batchNo && r.expiryDate).map(([itemId, r]: any) => ({ itemId, batchNo: r.batchNo, expiryDate: r.expiryDate, qtyReceived: Number(r.qty || items.find((x: any) => x.id === itemId).qty_ordered - items.find((x: any) => x.id === itemId).qty_received) }));
        if (!list.length) return toast('error', 'Isi nomor batch dan tanggal kedaluwarsa barang yang diterima');
        try { const r = await api.post(`/pharmacy/purchase-orders/${id}/receive`, { items: list }); toast('ok', `Barang diterima (${label(r.status)})`); setRecv({}); q.refetch(); } catch (e: any) { toast('error', e.message); }
      }}>Simpan penerimaan</button></div>}
      <Panel title="Riwayat"><ol className="space-y-1">{events.map((e: any, i: number) => <li key={i} className="text-[13.5px]"><Status value={e.to_status} /> <span className="text-bark">{e.actor} · {fmtDateTime(e.occurred_at)}</span></li>)}</ol></Panel>
    </div>
  );
}

// ------------------------------------------------------------------ stock opname
export function OpnameDetail() {
  const { id } = useParams();
  const toast = useToast();
  const q = useQuery({ queryKey: ['opname', id], queryFn: () => api.get(`/pharmacy/opnames/${id}`) });
  const [counts, setCounts] = useState<Record<string, string>>({});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { opname: o, items, transitions } = q.data;
  const counting = o.status === 'COUNTING';
  const go = async (to: string) => { try { await api.post(`/r/stock-opnames/${id}/transition`, { to }); toast('ok', label(to)); q.refetch(); } catch (e: any) { toast('error', e.message); } };
  return (
    <div className="space-y-4">
      <PageHeader title={`Stock opname ${o.opname_no}`} description={`${o.site_name} · ${fmtDate(o.count_date)}`}
        actions={<>
          <Status value={o.status} />
          {counting && <button className="btn-secondary" onClick={async () => { try { await api.patch(`/pharmacy/opnames/${id}/counts`, { items: Object.entries(counts).map(([itemId, v]) => ({ itemId, countedQty: Number(v) })) }); toast('ok', 'Hitungan disimpan'); setCounts({}); q.refetch(); } catch (e: any) { toast('error', e.message); } }}>Simpan hitungan</button>}
          {transitions.filter((t: any) => t.to_status !== 'POSTED').map((t: any) => <button key={t.to_status} className={t.required_action === 'APPROVE' ? 'btn-primary' : 'btn-secondary'} onClick={() => go(t.to_status)}>{t.label}</button>)}
          {o.status === 'APPROVED' && <button className="btn-primary" onClick={async () => { try { const r = await api.post(`/pharmacy/opnames/${id}/post`); toast('ok', `${r.adjustments} selisih diposting ke stok`); q.refetch(); } catch (e: any) { toast('error', e.message); } }}>Posting selisih ke stok</button>}
        </>} />
      <div className="panel"><table className="tbl"><thead><tr><th>Obat</th><th>Batch</th><th>ED</th><th className="text-right">Sistem</th><th className="text-right">Fisik</th><th className="text-right">Selisih</th></tr></thead>
        <tbody>{items.map((i: any) => (
          <tr key={i.id}><td>{i.medicine}</td><td className="text-bark">{i.batch_no}</td><td className="num">{fmtDate(i.expiry_date)}</td><td className="text-right num">{fmtNum(i.system_qty)}</td>
            <td className="text-right">{counting ? <input className="input h-8 num text-right w-24 ml-auto" value={counts[i.id] ?? String(i.counted_qty)} onChange={(e) => setCounts((s) => ({ ...s, [i.id]: e.target.value.replace(/[^\d.]/g, '') }))} /> : <span className="num">{fmtNum(i.counted_qty)}</span>}</td>
            <td className={cx('text-right num', Number(i.variance) < 0 ? 'text-sev-high' : Number(i.variance) > 0 && 'text-canopy-700')}>{Number(i.variance) > 0 ? '+' : ''}{fmtNum(i.variance)}</td></tr>))}</tbody></table></div>
    </div>
  );
}

export function OpnameNewButton() {
  const [open, setOpen] = useState(false);
  const [site, setSite] = useState<string | null>(null);
  const nav = useNavigate(); const toast = useToast();
  return (<>
    <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="w-4 h-4" />Mulai stock opname</button>
    <Modal open={open} onClose={() => setOpen(false)} title="Mulai stock opname" size="sm"
      footer={<><button className="btn-secondary" onClick={() => setOpen(false)}>Batal</button><button className="btn-primary" disabled={!site} onClick={async () => { try { const r = await api.post('/pharmacy/opnames', { siteId: site }); nav(`/pharmacy/opnames/${r.id}`); } catch (e: any) { toast('error', e.message); } }}>Mulai</button></>}>
      <Field label="Lokasi stok"><RefSelect kind="stock_site" value={site} onChange={setSite} /></Field>
      <p className="text-[13px] text-bark mt-2">Saldo sistem semua batch dengan stok akan diambil sebagai titik awal penghitungan.</p>
    </Modal>
  </>);
}
