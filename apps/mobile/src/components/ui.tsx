import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { label, TONE_CLASS, toneOf } from '../lib/format';

export const cx = clsx;

export function Spinner({ className = 'w-5 h-5' }: { className?: string }) {
  return <Loader2 className={cx('animate-spin', className)} aria-hidden />;
}

export function Loading({ text = 'Memuat…' }: { text?: string }) {
  return <div className="flex items-center justify-center gap-2 py-16 text-bark" role="status"><Spinner className="w-5 h-5 text-canopy-600" />{text}</div>;
}

export function ErrorBox({ error }: { error: any }) {
  if (!error) return null;
  const msg = error?.message ?? String(error);
  const details = error?.details?.fieldErrors ? Object.entries(error.details.fieldErrors).map(([k, v]: any) => `${k}: ${v.join(', ')}`).join('; ') : null;
  return (
    <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-[14px] text-red-800" role="alert">
      <AlertCircle className="w-5 h-5 shrink-0 mt-px" aria-hidden />
      <div><p>{msg}</p>{details && <p className="text-[13px] mt-0.5">{details}</p>}</div>
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return <div className="text-center py-12 px-6"><p className="font-medium text-ink">{title}</p>{hint && <p className="text-[14px] text-bark mt-1">{hint}</p>}</div>;
}

export function Badge({ value, text, className }: { value: string; text?: string; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-[12.5px] font-medium', TONE_CLASS[toneOf(value)], className)}>{text ?? label(value)}</span>;
}

export function Field({ label: l, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return <label className={cx('block', className)}><span className="label">{l}</span>{children}{hint && <span className="block text-[12.5px] text-bark mt-1">{hint}</span>}</label>;
}

/** Bottom sheet: the mobile stand-in for a modal dialog. */
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <button className="absolute inset-0 bg-ink/40" aria-label="Tutup" onClick={onClose} />
      <div className="sheet-in relative bg-white rounded-t-3xl max-h-[92vh] flex flex-col safe-bottom">
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
          <h2 className="font-semibold text-[17px] leading-snug">{title}</h2>
          <button className="w-10 h-10 -mr-2 grid place-items-center rounded-full active:bg-mist" aria-label="Tutup" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4 flex-1">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex gap-2">{footer}</div>}
      </div>
    </div>
  );
}

type Toast = { id: number; kind: 'ok' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, kind, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed left-0 right-0 top-0 z-50 flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+64px)] pointer-events-none" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto max-w-md w-full rounded-xl px-4 py-3 text-[14.5px] shadow-lg flex gap-2',
            t.kind === 'error' ? 'bg-red-700 text-white' : 'bg-ink text-white')}>
            {t.kind === 'ok' && <CheckCircle2 className="w-5 h-5 shrink-0 text-canopy-300" aria-hidden />}
            {t.kind === 'error' && <AlertCircle className="w-5 h-5 shrink-0" aria-hidden />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function TopBar({ title, subtitle, left, right }: { title: ReactNode; subtitle?: ReactNode; left?: ReactNode; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 bg-canopy text-white safe-top">
      <div className="h-14 flex items-center gap-2 px-2">
        <div className="w-11 shrink-0 flex justify-center">{left}</div>
        <div className="flex-1 min-w-0">
          <h1 className="text-[17px] font-semibold leading-tight truncate text-white">{title}</h1>
          {subtitle && <p className="text-[12.5px] text-canopy-300 truncate">{subtitle}</p>}
        </div>
        <div className="shrink-0 flex items-center">{right}</div>
      </div>
    </header>
  );
}

export function IconButton({ label: l, onClick, children, className }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return <button className={cx('w-11 h-11 grid place-items-center rounded-full active:bg-white/15', className)} aria-label={l} onClick={onClick}>{children}</button>;
}

/** Segmented tabs that scroll sideways on narrow phones. */
export function Segments({ value, onChange, items, fill }: { value: string; onChange: (v: string) => void; items: { id: string; label: string; count?: number }[]; fill?: boolean }) {
  return (
    <div className={cx('px-4 py-3', fill ? 'grid gap-1.5' : 'flex gap-2 overflow-x-auto')} style={fill ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined} role="tablist">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)}
          className={cx('chip', fill && 'justify-center px-1 text-[13.5px] flex-col h-auto py-1.5 gap-0 rounded-xl leading-tight', value === i.id ? 'bg-canopy-600 border-canopy-600 text-white' : 'bg-white border-line text-bark-700')}>
          {i.label}{i.count !== undefined && <span className={cx('num text-[13px]', value === i.id ? 'text-canopy-100' : 'text-bark-400')}>{i.count}</span>}
        </button>
      ))}
    </div>
  );
}
