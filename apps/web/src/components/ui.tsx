import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { X, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { label, toneOf, TONE_CLASS } from '../lib/format';

export const cx = clsx;

export function Status({ value, text }: { value: any; text?: string }) {
  if (value === null || value === undefined || value === '') return <span className="text-bark-400">–</span>;
  return <span className={cx('chip', TONE_CLASS[toneOf(value)])}>{text ?? label(value)}</span>;
}
export function Tag({ children, tone = 'gray' }: { children: ReactNode; tone?: keyof typeof TONE_CLASS }) {
  return <span className={cx('chip', TONE_CLASS[tone])}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('animate-spin text-canopy-600', className ?? 'w-5 h-5')} aria-label="Memuat" />;
}
export function Loading({ text = 'Memuat data…' }: { text?: string }) {
  return <div className="flex items-center gap-2 text-bark py-10 justify-center"><Spinner /> {text}</div>;
}
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="py-12 text-center">
      <p className="font-medium text-ink">{title}</p>
      {hint && <p className="text-bark mt-1 text-[13px] max-w-md mx-auto">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorBox({ error }: { error: any }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex gap-2 items-start rounded-md border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-[13px]">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span>{error.message ?? String(error)}</span>
    </div>
  );
}

export function PageHeader({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight">{title}</h1>
          {description && <p className="text-bark mt-1 max-w-3xl">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Panel({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('panel', className)}>
      {(title || actions) && <div className="panel-head"><h2 className="panel-title">{title}</h2>{actions && <div className="flex gap-2 items-center">{actions}</div>}</div>}
      <div className={bodyClass ?? 'p-4'}>{children}</div>
    </section>
  );
}

export function Field({ label: l, children, hint, error, required, className }: { label: string; children: ReactNode; hint?: string; error?: string; required?: boolean; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="field-label">{l}{required && <span className="text-sev-critical"> *</span>}</span>
      {children}
      {hint && !error && <span className="block text-[12px] text-bark-400 mt-1">{hint}</span>}
      {error && <span className="block text-[12px] text-sev-critical mt-1">{error}</span>}
    </label>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-canopy-900/40 p-3 sm:p-8 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className={cx('w-full bg-white rounded-panel shadow-pop', w)}>
        <div className="panel-head"><h2 className="font-semibold text-[16px]">{title}</h2><button className="btn-ghost btn-sm" onClick={onClose} aria-label="Tutup"><X className="w-4 h-4" /></button></div>
        <div className="p-5 max-h-[72vh] overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-line bg-[#FAFBFA] rounded-b-panel">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, subtitle, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 bg-canopy-900/25" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" className="absolute right-0 top-0 h-full w-full max-w-[680px] bg-white shadow-pop flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="min-w-0"><h2 className="font-semibold text-[17px] truncate">{title}</h2>{subtitle && <div className="text-bark text-[13px] mt-0.5">{subtitle}</div>}</div>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Tutup"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 px-5 py-3 border-t border-line bg-[#FAFBFA]">{footer}</div>}
      </aside>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: ReactNode; count?: number }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line overflow-x-auto scrollbar-thin">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('px-3 py-2 -mb-px border-b-2 text-[13.5px] whitespace-nowrap', value === t.id ? 'border-canopy-600 text-canopy-700 font-medium' : 'border-transparent text-bark hover:text-ink')}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 text-[11.5px] text-bark-400 num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function KV({ items, cols = 2 }: { items: [string, ReactNode][]; cols?: number }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-3', cols === 3 ? 'sm:grid-cols-3' : cols === 1 ? '' : 'sm:grid-cols-2')}>
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0"><dt className="text-[12px] text-bark">{k}</dt><dd className="text-ink break-words">{v === null || v === undefined || v === '' ? <span className="text-bark-400">–</span> : v}</dd></div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------ toasts
type ToastT = { id: number; kind: 'ok' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: ToastT['kind'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((kind: ToastT['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[min(420px,calc(100vw-2rem))]" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('flex gap-2 items-start rounded-md px-3.5 py-2.5 shadow-pop text-[13.5px] border',
            t.kind === 'ok' && 'bg-white border-canopy-300 text-canopy-800', t.kind === 'error' && 'bg-white border-red-200 text-red-800', t.kind === 'info' && 'bg-white border-line text-ink')}>
            {t.kind === 'ok' ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-canopy-600" /> : t.kind === 'error' ? <AlertTriangle className="w-4 h-4 mt-0.5" /> : <Info className="w-4 h-4 mt-0.5" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Confirm({ open, title, message, confirmText = 'Lanjutkan', danger, onConfirm, onClose, children, busy }: {
  open: boolean; title: string; message?: ReactNode; confirmText?: string; danger?: boolean; onConfirm: () => void; onClose: () => void; children?: ReactNode; busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Batal</button><button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={onConfirm}>{busy && <Spinner className="w-4 h-4" />}{confirmText}</button></>}>
      {message && <p className="text-bark-700">{message}</p>}
      {children}
    </Modal>
  );
}
