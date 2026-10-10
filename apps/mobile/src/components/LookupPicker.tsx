import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../lib/api';
import { ErrorBox, Sheet, Spinner } from './ui';

/** Search-as-you-type picker over /lookup/:kind (ICD-10, medicines, hospitals), shown as a bottom sheet. */
export function LookupPicker({ kind, title, placeholder, open, onClose, onPick, params }: {
  kind: string; title: string; placeholder: string; open: boolean; onClose: () => void;
  onPick: (item: { id: string; label: string; sub?: string }) => void; params?: Record<string, any>;
}) {
  const [q, setQ] = useState('');
  const [d, setD] = useState('');
  useEffect(() => { const t = setTimeout(() => setD(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (!open) { setQ(''); setD(''); } }, [open]);
  const r = useQuery({ queryKey: ['lookup', kind, d, params], queryFn: () => api.get(`/lookup/${kind}`, { q: d, limit: 30, ...params }), enabled: open && d.length >= 2 });
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="relative">
        <Search className="w-5 h-5 absolute left-3.5 top-3.5 text-bark-400" aria-hidden />
        <input className="input pl-11" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label={placeholder} />
      </div>
      <div className="mt-3">
        {d.length < 2 && <p className="text-[14px] text-bark px-1">Ketik minimal 2 huruf.</p>}
        {r.isFetching && <p className="flex items-center gap-2 text-bark text-[14px] px-1"><Spinner className="w-4 h-4" />Mencari…</p>}
        <ErrorBox error={r.error} />
        {r.data?.data?.length === 0 && <p className="text-[14px] text-bark px-1">Tidak ditemukan.</p>}
        <ul className="divide-y divide-line">
          {r.data?.data?.map((it: any) => (
            <li key={it.id}><button className="w-full text-left py-3 px-1 active:bg-canopy-50" onClick={() => { onPick(it); onClose(); }}>
              <span className="block text-[15px]">{it.label}</span>{it.sub && <span className="block text-[13px] text-bark">{it.sub}</span>}
            </button></li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
