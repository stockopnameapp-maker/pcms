import { BRAND_MARK_PNG, BRAND_MARK_RATIO } from '../core/brand.js';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { ColumnDef } from './resources.def.js';

export interface ExportResult { buffer: Buffer; mime: string }

const fmtCell = (v: unknown, kind?: string) => {
  if (v === null || v === undefined) return '';
  if (kind === 'bool') return v ? 'Ya' : 'Tidak';
  if (kind === 'datetime' && v instanceof Date) return v.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v as any;
};

export async function exportRows(format: string, title: string, columns: ColumnDef[], rows: any[], meta: Record<string, string> = {}): Promise<ExportResult> {
  if (format === 'csv') {
    const esc = (s: unknown) => { const t = String(fmtCell(s)); return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(fmtCell(r[c.name], c.kind))).join(','))];
    return { buffer: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), mime: 'text/csv; charset=utf-8' };
  }
  if (format === 'pdf') return { buffer: await pdfTable(title, columns, rows, meta), mime: 'application/pdf' };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palmora Health'; wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 14, color: { argb: 'FF0F3D2E' } };
  for (const [k, v] of Object.entries(meta)) ws.addRow([k, v]).font = { color: { argb: 'FF5B6B63' } };
  ws.addRow([`Dicetak: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} · ${rows.length} baris · RAHASIA — hanya untuk penggunaan internal`]).font = { italic: true, size: 9 };
  ws.addRow([]);
  const header = ws.addRow(columns.map((c) => c.label));
  header.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B6B4A' } };
    c.alignment = { vertical: 'middle' };
  });
  const headerRow = header.number;
  for (const r of rows) ws.addRow(columns.map((c) => {
    const v = r[c.name];
    if (c.kind === 'money' || c.kind === 'number') return v === null || v === undefined ? null : Number(v);
    if ((c.kind === 'date' || c.kind === 'datetime') && v) return c.kind === 'date' ? v : new Date(v);
    return fmtCell(v, c.kind);
  }));
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(48, Math.max(10, c.label.length + 4, ...rows.slice(0, 200).map((r) => String(r[c.name] ?? '').length + 2)));
    if (c.kind === 'money') col.numFmt = '#,##0';
    if (c.kind === 'datetime') col.numFmt = 'dd/mm/yyyy hh:mm';
  });
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: columns.length } };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

function pdfTable(title: string, columns: ColumnDef[], rows: any[], meta: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', layout: columns.length > 6 ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const width = doc.page.width - 72;
    doc.rect(0, 0, doc.page.width, 64).fill('#0F3D2E');
    { const tx = doc.page.width - 36 - 48, ty = 8; doc.roundedRect(tx, ty, 48, 48, 7).fill('#FFFFFF');
      const w = 38; doc.image(BRAND_MARK_PNG, tx + 5, ty + (48 - w * BRAND_MARK_RATIO) / 2, { width: w }); }
    doc.fillColor('#FFFFFF').fontSize(15).font('Helvetica-Bold').text('Palmora Health', 36, 18).fontSize(11).font('Helvetica').text(title, 36, 38);
    doc.fillColor('#5B6B63').fontSize(8).text(`Dicetak ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} · ${rows.length} baris`, 36, 70);
    let y = 84;
    for (const [k, v] of Object.entries(meta)) { doc.text(`${k}: ${v}`, 36, y); y += 11; }
    y += 6;
    const colW = width / columns.length;
    const drawHeader = () => {
      doc.rect(36, y, width, 18).fill('#1B6B4A');
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5);
      columns.forEach((c, i) => doc.text(c.label, 38 + i * colW, y + 5, { width: colW - 4, ellipsis: true, lineBreak: false }));
      y += 18; doc.font('Helvetica').fillColor('#1F2A24');
    };
    drawHeader();
    rows.slice(0, 5000).forEach((r, idx) => {
      if (y > doc.page.height - 50) { doc.addPage(); y = 36; drawHeader(); }
      if (idx % 2 === 0) doc.rect(36, y, width, 15).fill('#F2F6F4');
      doc.fillColor('#1F2A24').fontSize(7.5);
      columns.forEach((c, i) => {
        let v: any = r[c.name];
        if (c.kind === 'money' && v !== null && v !== undefined) v = 'Rp ' + Number(v).toLocaleString('id-ID');
        else if (c.kind === 'datetime' && v) v = new Date(v).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });
        doc.text(String(fmtCell(v, c.kind)), 38 + i * colW, y + 4, { width: colW - 4, ellipsis: true, lineBreak: false });
      });
      y += 15;
    });
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor('#8A968F').fontSize(7).text(`RAHASIA — dokumen internal · Halaman ${i + 1} dari ${range.count}`, 36, doc.page.height - 28, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}
