import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { api } from '../lib/api';
import { cx } from './ui';

export interface RefOption { id: string; label: string; sub?: string }

/** Searchable select backed by /lookup/:kind (results already filtered by the user's permissions). */
export function RefSelect({ kind, value, onChange, params, placeholder = 'Cari…', disabled, invalid, allowClear = true, id }: {
  kind: string; value: string | null | undefined; onChange: (v: string | null, opt?: RefOption) => void; params?: Record<string, any>;
  placeholder?: string; disabled?: boolean; invalid?: boolean; allowClear?: boolean; id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 220); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const list = useQuery({ queryKey: ['lookup', kind, debounced, params], queryFn: () => api.get<{ data: RefOption[] }>(`/lookup/${kind}`, { q: debounced, limit: 25, ...params }), enabled: open });
  const current = useQuery({ queryKey: ['lookup-id', kind, value], queryFn: () => api.get<{ data: RefOption[] }>(`/lookup/${kind}`, { id: value, ...params }), enabled: !!value, staleTime: 300_000 });
  const currentLabel = current.data?.data?.[0]?.label;

  return (
    <div ref={box} className="relative">
      <button type="button" id={id} disabled={disabled} onClick={() => setOpen((o) => !o)}
        className={cx('input flex items-center justify-between text-left', invalid && 'border-sev-critical', !value && 'text-bark-400')} aria-haspopup="listbox" aria-expanded={open}>
        <span className="truncate">{value ? currentLabel ?? '…' : placeholder}</span>
        <span className="flex items-center gap-1 shrink-0">
          {value && allowClear && !disabled && <X className="w-3.5 h-3.5 text-bark-400 hover:text-ink" onClick={(e) => { e.stopPropagation(); onChange(null); }} />}
          <ChevronDown className="w-4 h-4 text-bark-400" />
        </span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[260px] bg-white border border-line rounded-md shadow-pop">
          <input autoFocus className="input border-0 border-b rounded-b-none focus:ring-0" placeholder="Ketik untuk mencari…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
            {list.isLoading && <li className="px-3 py-2 text-bark text-[13px]">Mencari…</li>}
            {list.data?.data.length === 0 && <li className="px-3 py-2 text-bark text-[13px]">Tidak ada hasil</li>}
            {list.error && <li className="px-3 py-2 text-red-700 text-[13px]">{(list.error as any).message}</li>}
            {list.data?.data.map((o) => (
              <li key={o.id} role="option" aria-selected={o.id === value}>
                <button type="button" className={cx('w-full text-left px-3 py-1.5 hover:bg-canopy-50', o.id === value && 'bg-canopy-50')} onClick={() => { onChange(o.id, o); setOpen(false); setQ(''); }}>
                  <span className="block text-[13.5px] text-ink">{o.label}</span>{o.sub && <span className="block text-[12px] text-bark">{o.sub}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
