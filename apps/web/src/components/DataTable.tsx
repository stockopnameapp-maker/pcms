import { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { ColumnDef } from '../lib/meta';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, label } from '../lib/format';
import { Status, Tag, cx } from './ui';

export function Cell({ col, value }: { col: ColumnDef; value: any }) {
  if (value === null || value === undefined || value === '') return <span className="text-bark-400">–</span>;
  switch (col.kind) {
    case 'date': return <span className="num whitespace-nowrap">{fmtDate(value)}</span>;
    case 'datetime': return <span className="num whitespace-nowrap">{fmtDateTime(value)}</span>;
    case 'money': return <span className="num whitespace-nowrap">{fmtMoney(value)}</span>;
    case 'number': return <span className="num">{fmtNum(value, 1)}</span>;
    case 'bool': return value ? <Tag tone="green">Ya</Tag> : <span className="text-bark-400">Tidak</span>;
    case 'status': return <Status value={value} />;
    case 'badge': return <Tag>{label(value)}</Tag>;
    default: return <span className={cx(String(value).length > 80 && 'line-clamp-2')}>{String(value)}</span>;
  }
}

export function DataTable({ columns, rows, onRowClick, sort, dir, onSort, empty, rowKey = 'id', extra }: {
  columns: ColumnDef[]; rows: any[]; onRowClick?: (r: any) => void; sort?: string; dir?: string; onSort?: (c: string) => void; empty?: ReactNode; rowKey?: string;
  extra?: { header: string; render: (r: any) => ReactNode };
}) {
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} className={cx(['number', 'money'].includes(c.kind ?? '') && 'text-right')}>
                {onSort ? (
                  <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => onSort(c.name)}>
                    {c.label}{sort === c.name && (dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                  </button>
                ) : c.label}
              </th>
            ))}
            {extra && <th>{extra.header}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[rowKey] ?? i} className={cx(onRowClick && 'cursor-pointer')} onClick={() => onRowClick?.(r)} tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={(e) => e.key === 'Enter' && onRowClick?.(r)}>
              {columns.map((c) => <td key={c.name} className={cx(['number', 'money'].includes(c.kind ?? '') && 'text-right')}><Cell col={c} value={r[c.name]} /></td>)}
              {extra && <td onClick={(e) => e.stopPropagation()}>{extra.render(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-line text-[13px] text-bark">
      <span className="num">{total ? `${fmtNum((page - 1) * pageSize + 1)}–${fmtNum(Math.min(page * pageSize, total))} dari ${fmtNum(total)}` : '0 data'}</span>
      <div className="flex items-center gap-1">
        <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Sebelumnya"><ChevronLeft className="w-4 h-4" /></button>
        <span className="num px-2">{page} / {pages}</span>
        <button className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Berikutnya"><ChevronRight className="w-4 h-4" /></button>
      </div>
    </div>
  );
}
