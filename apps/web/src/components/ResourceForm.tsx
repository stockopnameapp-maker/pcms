import { FormEvent, useMemo, useState } from 'react';
import { FieldDef, ResourceMeta } from '../lib/meta';
import { api, ApiError } from '../lib/api';
import { RefSelect } from './RefSelect';
import { ErrorBox, Field, Spinner, cx, useToast } from './ui';

const toLocalInput = (v: any) => {
  if (!v) return '';
  const d = new Date(v);
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  return p.replace(' ', 'T');
};

export function validateField(f: FieldDef, v: any): string | undefined {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  if (f.required && empty) return 'Wajib diisi';
  if (empty) return;
  if (f.type === 'number') {
    const n = Number(v);
    if (Number.isNaN(n)) return 'Harus angka';
    if (f.min !== undefined && n < f.min) return `Minimal ${f.min}`;
    if (f.max !== undefined && n > f.max) return `Maksimal ${f.max}`;
  }
  if ((f.type === 'text' || f.type === 'textarea') && f.maxLength && String(v).length > f.maxLength) return `Maksimal ${f.maxLength} karakter`;
  if (f.pattern && typeof v === 'string' && !new RegExp(f.pattern).test(v)) return f.patternMessage ?? 'Format tidak valid';
}

export function FieldInput({ f, value, onChange, values, invalid, disabled }: { f: FieldDef; value: any; onChange: (v: any) => void; values: Record<string, any>; invalid?: boolean; disabled?: boolean }) {
  const cls = cx('input', invalid && 'border-sev-critical');
  switch (f.type) {
    case 'textarea': return <textarea className={cls} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} maxLength={f.maxLength} />;
    case 'number': return <input type="number" step="any" className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} min={f.min} max={f.max} />;
    case 'date': return <input type="date" className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    case 'datetime': return <input type="datetime-local" className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    case 'time': return <input type="time" className={cls} value={value ? String(value).slice(0, 5) : ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    case 'boolean': return (
      <label className="flex items-center gap-2 h-9"><input type="checkbox" className="w-4 h-4 accent-canopy-600" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} /><span className="text-[13.5px]">Ya</span></label>
    );
    case 'select': return (
      <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">— pilih —</option>
        {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
    case 'tags': return <input className={cls} value={Array.isArray(value) ? value.join(', ') : value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="pisahkan dengan koma" />;
    case 'ref': {
      const params: Record<string, any> = {};
      for (const [k, v] of Object.entries(f.refParams ?? {})) params[k] = v in values ? values[v] : v;
      return <RefSelect kind={f.ref!} value={value} onChange={(v) => onChange(v)} params={params} invalid={invalid} disabled={disabled} />;
    }
    default: return <input className={cls} value={value ?? ''} onChange={(e) => onChange(f.pattern?.startsWith('^[A-Z') ? e.target.value.toUpperCase() : e.target.value)} disabled={disabled} maxLength={f.maxLength} />;
  }
}

export function ResourceForm({ resource, mode, initial, onSaved, onCancel, presets }: {
  resource: ResourceMeta; mode: 'create' | 'update'; initial?: any; onSaved: (row: any) => void; onCancel: () => void; presets?: Record<string, any>;
}) {
  const fields = resource.fields.filter((f) => (mode === 'create' ? f.create !== false : f.update !== false));
  const [values, setValues] = useState<Record<string, any>>(() => {
    const v: Record<string, any> = {};
    for (const f of fields) {
      const raw = mode === 'update' ? initial?.[f.name] : presets?.[f.name] ?? f.default;
      v[f.name] = f.type === 'datetime' ? toLocalInput(raw) : f.type === 'select' && raw !== undefined && raw !== null ? String(raw) : raw ?? (f.type === 'boolean' ? false : '');
    }
    return v;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const groups = useMemo(() => {
    const g: [string, FieldDef[]][] = [];
    for (const f of fields) { const k = f.group ?? ''; const last = g.find((x) => x[0] === k); if (last) last[1].push(f); else g.push([k, [f]]); }
    return g;
  }, [fields]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const f of fields) { const m = validateField(f, values[f.name]); if (m) errs[f.name] = m; }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body: Record<string, any> = {};
    for (const f of fields) {
      let v = values[f.name];
      if (mode === 'update' && JSON.stringify(v ?? '') === JSON.stringify((f.type === 'datetime' ? toLocalInput(initial?.[f.name]) : initial?.[f.name]) ?? '')) continue;
      if (v === '') v = null;
      if (f.type === 'number' && v !== null) v = Number(v);
      body[f.name] = v;
    }
    if (mode === 'create') for (const k of Object.keys(body)) if (body[k] === null) delete body[k];
    setBusy(true); setErr(null);
    try {
      const r = mode === 'create'
        ? await api.post(`/r/${resource.key}`, body)
        : Object.keys(body).length ? await api.patch(`/r/${resource.key}/${initial.id}`, body, { 'If-Match': String(initial.version ?? '') }) : { data: initial };
      toast('ok', mode === 'create' ? `${resource.singular} berhasil dibuat` : 'Perubahan disimpan');
      onSaved(r.data);
    } catch (e: any) {
      setErr(e);
      if (e instanceof ApiError && Array.isArray(e.details)) {
        const fe: Record<string, string> = {};
        for (const d of e.details) if (d.field) fe[d.field] = d.message;
        setErrors(fe);
      }
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="space-y-5">
        {groups.map(([g, fs]) => (
          <fieldset key={g || 'main'}>
            {g && <legend className="text-[13px] font-semibold text-canopy-700 mb-2">{g}</legend>}
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-3">
              {fs.map((f) => (
                <Field key={f.name} label={f.label} required={f.required} hint={f.help} error={errors[f.name]} className={f.wide || f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                  <FieldInput f={f} value={values[f.name]} values={values} invalid={!!errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
                </Field>
              ))}
            </div>
          </fieldset>
        ))}
        <ErrorBox error={err} />
      </div>
      <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-line">
        <button type="button" className="btn-secondary" onClick={onCancel}>Batal</button>
        <button type="submit" className="btn-primary" disabled={busy}>{busy && <Spinner className="w-4 h-4 text-white" />}{mode === 'create' ? `Simpan ${resource.singular.toLowerCase()}` : 'Simpan perubahan'}</button>
      </div>
    </form>
  );
}
