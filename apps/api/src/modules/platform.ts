// Administration, audit viewer (Phase 11), attachments, printable documents, self-service portal, public verification.
import { BRAND_MARK_PNG, BRAND_MARK_RATIO } from '../core/brand.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { anonymous } from '../core/db.js';
import { config } from '../core/config.js';
import { authenticate, db, page, parse, requirePerm, sendFile, zUuid } from '../core/http.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { assertPasswordPolicy, hashPassword } from '../core/security.js';
import { runAlertEngine } from '../jobs/scheduler.js';

const ALLOWED_MIME = /^(image\/(png|jpeg|webp)|application\/pdf|text\/plain|application\/vnd\.openxmlformats-officedocument\.[a-z.]+)$/;
const ENTITY_MODULE: Record<string, { table: string; module: string; unit: string }> = {
  encounter: { table: 'encounter', module: 'EMR', unit: 'clinic_id' }, lab_order: { table: 'lab_order', module: 'LAB', unit: 'clinic_id' },
  accident: { table: 'accident', module: 'ACCIDENT', unit: 'org_unit_id' }, referral: { table: 'referral', module: 'REFERRAL', unit: 'clinic_id' },
  mcu: { table: 'mcu', module: 'OCC_HEALTH', unit: 'clinic_id' }, employee: { table: 'employee', module: 'EMPLOYEE', unit: 'org_unit_id' },
  clinic_asset: { table: 'clinic_asset', module: 'CLINIC', unit: 'clinic_id' }, ambulance: { table: 'ambulance', module: 'AMBULANCE', unit: 'clinic_id' },
};

function pdfDoc(): { doc: PDFKit.PDFDocument; done: Promise<Buffer> } {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  return { doc, done };
}

function letterhead(doc: PDFKit.PDFDocument, clinic: any, title: string, number: string) {
  doc.rect(0, 0, doc.page.width, 92).fill('#0F3D2E');
  { // Palmora Health mark on a white tile, top right
    const tx = doc.page.width - 50 - 66, ty = 13;
    doc.roundedRect(tx, ty, 66, 66, 9).fill('#FFFFFF');
    const w = 52; doc.image(BRAND_MARK_PNG, tx + 7, ty + (66 - w * BRAND_MARK_RATIO) / 2, { width: w });
  }
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(16).text(clinic.clinic_name ?? 'Klinik', 50, 24);
  doc.font('Helvetica').fontSize(9).text([clinic.address, clinic.city].filter(Boolean).join(', ') || clinic.tenant_name || '', 50, 46)
    .text(clinic.tenant_name ? `${clinic.tenant_name}${clinic.phone ? ' · Telp ' + clinic.phone : ''}` : '', 50, 60);
  doc.fillColor('#1F2A24').font('Helvetica-Bold').fontSize(14).text(title, 50, 120, { align: 'center' });
  doc.font('Helvetica').fontSize(10).text(`Nomor: ${number}`, { align: 'center' });
  doc.moveDown(1.5);
}

export default async function platformRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- public (no login)
  app.get('/public/verify/:code', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req: FastifyRequest<{ Params: { code: string } }>) => {
    const code = parse(z.string().regex(/^[0-9A-Fa-f]{12}$/), req.params.code);
    const r = await anonymous((tx) => tx.val('SELECT app.verify_certificate($1)', [code]));
    if (!r) throw notFound('Surat dengan kode verifikasi ini');
    return r;
  });

  app.register(async (a) => {
    a.addHook('preHandler', authenticate);

    // ============================================================ USER ADMINISTRATION
    a.post('/admin/users', async (req) => {
      const b = parse(z.object({ username: z.string().regex(/^[a-zA-Z0-9._-]{3,50}$/), fullName: z.string().min(2).max(120), email: z.string().email().optional(),
        phone: z.string().max(20).optional(), homeUnitId: zUuid, password: z.string().min(1).max(200), employeeId: zUuid.optional(),
        roles: z.array(z.object({ roleId: zUuid, scopeUnitId: zUuid })).max(10).default([]) }), req.body);
      assertPasswordPolicy(b.password, b.username);
      const hash = await hashPassword(b.password);
      return db(req, async (tx) => {
        await requirePerm(tx, 'USER_ADMIN', 'CREATE', b.homeUnitId);
        const id = await tx.val(`INSERT INTO app_user (home_unit_id, username, email, full_name, phone, password_hash, must_change_password, employee_id)
                                 VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`, [b.homeUnitId, b.username.toLowerCase(), b.email ?? null, b.fullName, b.phone ?? null, hash, b.employeeId ?? null]);
        for (const r of b.roles) await tx.q(`INSERT INTO user_role_assignment (user_id, role_id, scope_unit_id, reason) VALUES ($1, $2, $3, 'Dibuat bersama akun')`, [id, r.roleId, r.scopeUnitId]);
        return { id };
      });
    });

    a.post('/admin/users/:id/reset-password', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
      const b = parse(z.object({ newPassword: z.string().min(1).max(200) }), req.body);
      assertPasswordPolicy(b.newPassword);
      const hash = await hashPassword(b.newPassword);
      return db(req, async (tx) => { await tx.q('SELECT app.admin_reset_password($1, $2)', [req.params.id, hash]); return { ok: true }; });
    });

    a.post('/admin/users/:id/unlock', async (req: FastifyRequest<{ Params: { id: string } }>) =>
      db(req, async (tx) => {
        const r = await tx.q(`UPDATE app_user SET failed_attempts = 0, locked_until = NULL, status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END WHERE id = $1 RETURNING id`, [req.params.id]);
        if (!r.length) throw notFound('Pengguna');
        return { ok: true };
      }));

    a.get('/admin/roles', async (req) => db(req, async (tx) => {
      await requirePerm(tx, 'USER_ADMIN', 'READ');
      return {
        roles: await tx.q(`SELECT r.id, r.code, r.name, r.description, r.is_system, r.typical_scope, r.is_clinical,
                                  (SELECT coalesce(jsonb_agg(p.code ORDER BY p.code), '[]') FROM role_permission rp JOIN permission p ON p.id = rp.permission_id WHERE rp.role_id = r.id) AS permissions,
                                  (SELECT count(*) FROM user_role_assignment a WHERE a.role_id = r.id AND a.revoked_at IS NULL) AS assignments
                             FROM role r WHERE r.deleted_at IS NULL ORDER BY r.is_system DESC, r.name`),
        modules: await tx.q('SELECT code, name, description, is_clinical FROM permission_module ORDER BY sort_order'),
        actions: ['CREATE', 'READ', 'UPDATE', 'DELETE', 'APPROVE', 'EXPORT', 'PRINT'],
      };
    }));

    a.post('/admin/roles', async (req) => {
      const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9_]{2,40}$/), name: z.string().min(2).max(100), description: z.string().max(500).optional(),
        typicalScope: z.string().optional(), permissions: z.array(z.string().regex(/^[A-Z_]+:[A-Z]+$/)).default([]) }), req.body);
      return db(req, async (tx) => {
        const id = await tx.val(`INSERT INTO role (tenant_id, code, name, description, typical_scope, is_system) VALUES (app.current_tenant_id(), $1, $2, $3, $4, false) RETURNING id`,
          [b.code, b.name, b.description ?? null, b.typicalScope ?? null]);
        if (b.permissions.length) await tx.q(`INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = ANY($2::text[])`, [id, b.permissions]);
        return { id };
      });
    });

    a.put('/admin/roles/:id/permissions', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
      const b = parse(z.object({ permissions: z.array(z.string().regex(/^[A-Z_]+:[A-Z]+$/)) }), req.body);
      return db(req, async (tx) => {
        const r = await tx.one('SELECT is_system FROM role WHERE id = $1', [req.params.id]);
        if (!r) throw notFound('Role');
        if (r.is_system) throw forbidden('Role sistem tidak dapat diubah. Buat role kustom.');
        await tx.q('DELETE FROM role_permission WHERE role_id = $1', [req.params.id]);
        await tx.q(`INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = ANY($2::text[])`, [req.params.id, b.permissions]);
        return { ok: true };
      });
    });

    a.post('/admin/jobs/alert-engine', async (req) => {
      await db(req, (tx) => requirePerm(tx, 'ALERT', 'CREATE'));
      return { result: await runAlertEngine() };
    });

    // ============================================================ AUDIT TRAIL
    a.get('/audit', async (req: FastifyRequest<{ Querystring: any }>) => {
      const pg = page(req.query);
      return db(req, async (tx) => {
        const q: any = req.query; const params: unknown[] = []; const w: string[] = [];
        const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
        if (q.table) w.push(`l.table_name = ${p(q.table)}`);
        if (q.recordId) w.push(`l.record_id = ${p(q.recordId)}::uuid`);
        if (q.userId) w.push(`l.user_id = ${p(q.userId)}::uuid`);
        if (q.action) w.push(`l.action = ${p(q.action)}`);
        if (q.module) w.push(`l.module = ${p(q.module)}`);
        if (q.from) w.push(`l.occurred_at >= ${p(q.from)}::date`);
        if (q.to) w.push(`l.occurred_at < ${p(q.to)}::date + 1`);
        if (q.q) w.push(`(u.username ILIKE ${p('%' + q.q + '%')} OR l.note ILIKE $${params.length} OR l.table_name ILIKE $${params.length})`);
        const rows = await tx.q(`SELECT l.id, l.occurred_at, l.user_id, u.username, u.full_name, host(l.ip_address) AS ip_address, l.user_agent, l.module, l.table_name, l.record_id,
                                        l.action, l.changed_fields, l.old_values, l.new_values, l.note, count(*) OVER() AS _total
                                   FROM audit.audit_log l LEFT JOIN app_user u ON u.id = l.user_id
                                  ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY l.occurred_at DESC, l.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
        const total = rows[0]?._total ?? 0; rows.forEach((r) => delete r._total);
        return { data: rows, total, page: pg.page, pageSize: pg.pageSize };
      });
    });

    // ============================================================ ATTACHMENTS
    a.post('/files', async (req, reply) => {
      const file = await (req as any).file({ limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });
      if (!file) throw badRequest('File wajib diunggah');
      const fields = Object.fromEntries(Object.entries(file.fields).map(([k, v]: any) => [k, v?.value]));
      const meta = parse(z.object({ entityType: z.string(), entityId: zUuid, description: z.string().max(300).optional() }), fields);
      const ent = ENTITY_MODULE[meta.entityType];
      if (!ent) throw badRequest('Jenis entitas lampiran tidak didukung');
      if (!ALLOWED_MIME.test(file.mimetype)) throw badRequest('Tipe file tidak diizinkan (PNG, JPEG, WEBP, PDF, TXT, Office)');
      const buf: Buffer = await file.toBuffer();
      if (file.file.truncated) throw badRequest(`Ukuran file maksimal ${config.maxUploadMb} MB`);
      // magic-number check (do not trust the client's content type)
      const sig = buf.subarray(0, 4).toString('hex');
      const okSig = { 'application/pdf': '25504446', 'image/png': '89504e47', 'image/jpeg': 'ffd8ff' } as Record<string, string>;
      if (okSig[file.mimetype] && !sig.startsWith(okSig[file.mimetype])) throw badRequest('Isi file tidak sesuai dengan tipenya');
      const sha = createHash('sha256').update(buf).digest('hex');
      const row = await db(req, async (tx) => {
        const unit = await tx.val(`SELECT ${ent.unit} FROM ${ent.table} WHERE id = $1`, [meta.entityId]);
        if (!unit) throw notFound('Data induk lampiran');
        const tenant = await tx.val('SELECT app.current_tenant_id()');
        const key = `${tenant}/${meta.entityType}/${meta.entityId}/${randomUUID()}${path.extname(file.filename).toLowerCase().slice(0, 8)}`;
        const id = await tx.val(`INSERT INTO attachment (owner_unit_id, module, entity_type, entity_id, file_name, mime_type, size_bytes, storage_key, sha256, description)
                                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [unit, ent.module, meta.entityType, meta.entityId, file.filename.slice(0, 200), file.mimetype, buf.length, key, sha, meta.description ?? null]);
        const full = path.join(config.storageDir, key);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, buf, { mode: 0o600 });
        return { id, file_name: file.filename, size_bytes: buf.length, sha256: sha };
      });
      reply.code(201);
      return { data: row };
    });

    a.get('/files/:id/download', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const f = await db(req, async (tx) => {
        const row = await tx.one('SELECT * FROM attachment WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
        if (!row) throw notFound('Lampiran');
        await tx.q(`SELECT app.log_access('VIEW', 'attachment', $1, $2, $3)`, [row.id, row.module, row.file_name]);
        return row;
      });
      const buf = await readFile(path.join(config.storageDir, f.storage_key)).catch(() => { throw notFound('Berkas fisik lampiran'); });
      if (createHash('sha256').update(buf).digest('hex') !== f.sha256) throw badRequest('Integritas berkas gagal diverifikasi');
      return sendFile(reply, buf, f.mime_type, f.file_name);
    });

    // ============================================================ PRINTABLE DOCUMENTS (PDF + QR verification)
    a.get('/documents/:kind/:id.pdf', async (req: FastifyRequest<{ Params: { kind: string; id: string } }>, reply) => {
      const kind = req.params.kind;
      const data = await db(req, async (tx) => {
        let row: any;
        const clinicSql = `(SELECT jsonb_build_object('clinic_name', c.name, 'address', c.address, 'city', c.city, 'phone', c.phone, 'tenant_name', t.name)
                              FROM org_unit c JOIN tenant t ON t.id = c.tenant_id WHERE c.id = x.clinic_id) AS clinic`;
        if (kind === 'sick-leave') {
          row = await tx.one(`SELECT x.*, coalesce(p.full_name, e.full_name) AS full_name, p.mrn, coalesce(p.birth_date, e.birth_date) AS birth_date, coalesce(p.gender, e.gender) AS gender, e.employee_no, u.name AS unit_name, jp.name AS position_name,
                                     coalesce(d.title_prefix || ' ', '') || d.full_name || coalesce(', ' || d.title_suffix, '') AS doctor_name, d.sip_no, ${clinicSql}
                                FROM sick_leave x LEFT JOIN patient p ON p.id = x.patient_id JOIN medical_staff d ON d.id = x.issued_by
                                LEFT JOIN employee e ON e.id = x.employee_id LEFT JOIN org_unit u ON u.id = x.employee_unit_id LEFT JOIN job_position jp ON jp.id = e.position_id
                               WHERE x.id = $1`, [req.params.id]);
        } else if (kind === 'certificate') {
          row = await tx.one(`SELECT x.*, coalesce(p.full_name, e.full_name) AS full_name, p.mrn, coalesce(p.birth_date, e.birth_date) AS birth_date, coalesce(p.gender, e.gender) AS gender, e.employee_no, u.name AS unit_name, jp.name AS position_name,
                                     coalesce(d.title_prefix || ' ', '') || d.full_name || coalesce(', ' || d.title_suffix, '') AS doctor_name, d.sip_no, ${clinicSql}
                                FROM medical_certificate x LEFT JOIN patient p ON p.id = x.patient_id JOIN medical_staff d ON d.id = x.issued_by
                                LEFT JOIN employee e ON e.id = x.employee_id LEFT JOIN org_unit u ON u.id = x.employee_unit_id LEFT JOIN job_position jp ON jp.id = e.position_id
                               WHERE x.id = $1`, [req.params.id]);
        } else if (kind === 'referral') {
          row = await tx.one(`SELECT x.*, p.full_name, p.mrn, p.birth_date, p.gender, p.bpjs_kesehatan_no, h.name AS hospital_name, h.address AS hospital_address,
                                     coalesce(i.title_id, i.title_en) AS diagnosis, coalesce(d.title_prefix || ' ', '') || d.full_name AS doctor_name, d.sip_no, ${clinicSql},
                                     (SELECT jsonb_build_object('systolic', v.systolic, 'diastolic', v.diastolic, 'heart_rate', v.heart_rate, 'temperature_c', v.temperature_c, 'spo2', v.spo2)
                                        FROM vital_sign v WHERE v.encounter_id = x.encounter_id ORDER BY v.recorded_at DESC LIMIT 1) AS vitals,
                                     (SELECT e.physical_exam FROM encounter e WHERE e.id = x.encounter_id) AS physical_exam
                                FROM referral x JOIN patient p ON p.id = x.patient_id JOIN hospital h ON h.id = x.hospital_id JOIN medical_staff d ON d.id = x.referring_doctor_id
                                LEFT JOIN icd10_code i ON i.code = x.icd10_code WHERE x.id = $1`, [req.params.id]);
        } else throw notFound('Jenis dokumen');
        if (!row) throw notFound('Dokumen');
        await tx.q(`SELECT app.log_access('PRINT', $1, $2, $3)`, [kind.replace('-', '_'), row.id, kind === 'referral' ? 'REFERRAL' : 'SICK_LEAVE']);
        return row;
      });
      const { doc, done } = pdfDoc();
      const fmt = (d: any) => (d ? new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }) : '-');
      const line = (label: string, value: any) => { doc.font('Helvetica').fontSize(11).fillColor('#5B6B63').text(label, 70, doc.y, { continued: true, width: 140 }).fillColor('#1F2A24').text(`:  ${value ?? '-'}`); };
      if (kind === 'sick-leave') {
        letterhead(doc, data.clinic, data.leave_type === 'REST_RECOMMENDATION' ? 'SURAT REKOMENDASI ISTIRAHAT' : 'SURAT KETERANGAN SAKIT', data.certificate_no);
        doc.font('Helvetica').fontSize(11).text('Yang bertanda tangan di bawah ini menerangkan bahwa:', 50); doc.moveDown(0.7);
        line('Nama', data.full_name); line('No. Rekam Medis', data.mrn); line('No. Karyawan', data.employee_no); line('Jabatan / Unit', [data.position_name, data.unit_name].filter(Boolean).join(' — '));
        doc.moveDown(0.8);
        doc.text(`Perlu beristirahat selama ${data.days} (${data.days === 1 ? 'satu' : data.days}) hari, terhitung mulai tanggal ${fmt(data.start_date)} sampai dengan ${fmt(data.end_date)}.`, 50, doc.y, { align: 'justify' });
        doc.moveDown(0.5).text('Surat keterangan ini dibuat untuk dipergunakan sebagaimana mestinya. Diagnosis bersifat rahasia dan tidak dicantumkan.', { align: 'justify' });
      } else if (kind === 'certificate') {
        const titles: Record<string, string> = { FIT_TO_WORK: 'SURAT KETERANGAN LAIK KERJA', RETURN_TO_WORK: 'SURAT KETERANGAN KEMBALI BEKERJA', MEDICAL_CERTIFICATE: 'SURAT KETERANGAN DOKTER',
          REST_RECOMMENDATION: 'SURAT REKOMENDASI ISTIRAHAT', HEALTH_STATEMENT: 'SURAT KETERANGAN SEHAT' };
        letterhead(doc, data.clinic, titles[data.certificate_type] ?? 'SURAT KETERANGAN', data.certificate_no);
        doc.font('Helvetica').fontSize(11).text('Berdasarkan hasil pemeriksaan, dengan ini menerangkan bahwa:', 50); doc.moveDown(0.7);
        line('Nama', data.full_name); line('Tanggal lahir', fmt(data.birth_date)); line('No. Karyawan', data.employee_no); line('Jabatan / Unit', [data.position_name, data.unit_name].filter(Boolean).join(' — '));
        doc.moveDown(0.8);
        if (data.fit_status) { line('Status kelaikan', String(data.fit_status).replace(/_/g, ' ')); }
        if (data.restrictions) line('Pembatasan', data.restrictions);
        line('Keperluan', data.purpose); line('Berlaku', `${fmt(data.valid_from)}${data.valid_until ? ' s/d ' + fmt(data.valid_until) : ''}`);
        if (data.status === 'REVOKED') doc.moveDown().fillColor('#B42318').font('Helvetica-Bold').text('SURAT INI TELAH DICABUT', { align: 'center' });
      } else {
        letterhead(doc, data.clinic, 'SURAT RUJUKAN', data.referral_no);
        doc.font('Helvetica').fontSize(11).text(`Kepada Yth. Dokter ${data.specialty_needed ?? 'Jaga'}`, 50).text(data.hospital_name).text(data.hospital_address ?? '');
        doc.moveDown().text('Mohon pemeriksaan dan penanganan lebih lanjut terhadap pasien:'); doc.moveDown(0.5);
        line('Nama', data.full_name); line('No. RM', data.mrn); line('Tanggal lahir', fmt(data.birth_date)); line('No. BPJS', data.bpjs_kesehatan_no);
        doc.moveDown(0.5);
        line('Diagnosis kerja', `${data.icd10_code ?? ''} ${data.diagnosis ?? ''}`.trim());
        if (data.vitals) line('Tanda vital', `TD ${data.vitals.systolic ?? '-'}/${data.vitals.diastolic ?? '-'} mmHg, N ${data.vitals.heart_rate ?? '-'}x/m, S ${data.vitals.temperature_c ?? '-'}°C, SpO2 ${data.vitals.spo2 ?? '-'}%`);
        line('Pemeriksaan fisik', data.physical_exam); line('Alasan rujukan', data.reason); line('Urgensi', data.urgency);
        doc.moveDown().fillColor('#B42318').fontSize(9).text('RAHASIA MEDIS — hanya untuk tenaga kesehatan yang merawat.', 50);
      }
      // signature + QR verification
      const y = Math.max(doc.y + 30, 560);
      doc.fillColor('#1F2A24').font('Helvetica').fontSize(11).text(`${data.clinic?.city ?? ''}, ${fmt(data.issued_at ?? data.referral_date ?? new Date())}`, 330, y);
      doc.text('Dokter pemeriksa,', 330, y + 16);
      doc.font('Helvetica-Bold').text(data.doctor_name, 330, y + 76).font('Helvetica').fontSize(9).text(data.sip_no ? `SIP: ${data.sip_no}` : '', 330, y + 92);
      const verify = data.verification_code ? `Verifikasi: /verify/${data.verification_code}` : `Dokumen: ${data.certificate_no ?? data.referral_no}`;
      const qr = await QRCode.toBuffer(data.verification_code ? `PCMS-VERIFY:${data.verification_code}` : `PCMS:${kind}:${data.id}`, { margin: 0, width: 110 });
      doc.image(qr, 60, y, { width: 90 });
      doc.fontSize(8).fillColor('#5B6B63').text(verify, 50, y + 96, { width: 160 });
      doc.fontSize(7).text(`Dicetak melalui Palmora Health · ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`, 50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100 });
      doc.end();
      return sendFile(reply, await done, 'application/pdf', `${kind}-${data.certificate_no ?? data.referral_no}.pdf`);
    });

    // ============================================================ SELF-SERVICE PORTAL (Employee / Patient)
    a.get('/portal/summary', async (req) => db(req, async (tx) => ({ data: await tx.val('SELECT app.portal_summary()') })));
    a.post('/portal/appointments', async (req) => {
      const b = parse(z.object({ patientId: zUuid, clinicId: zUuid, scheduledAt: z.string().min(16), reason: z.string().min(3).max(300) }), req.body);
      const { toTimestamp } = await import('../core/time.js');
      return db(req, async (tx) => ({ id: await tx.val('SELECT app.portal_book_appointment($1, $2, $3, $4)', [b.patientId, b.clinicId, toTimestamp(b.scheduledAt), b.reason]) }));
    });
    a.delete('/portal/appointments/:id', async (req: FastifyRequest<{ Params: { id: string } }>) =>
      db(req, async (tx) => { await tx.q('SELECT app.portal_cancel_appointment($1)', [req.params.id]); return { ok: true }; }));
    a.get('/portal/card.png', async (req: FastifyRequest<{ Querystring: { patientId?: string } }>, reply) => {
      const s = await db(req, (tx) => tx.val('SELECT app.portal_summary()'));
      const p = (s.patients as any[]).find((x) => !req.query.patientId || x.id === req.query.patientId);
      if (!p) throw notFound('Kartu pasien');
      reply.header('Content-Type', 'image/png');
      return reply.send(await QRCode.toBuffer(`PCMS:PATIENT:${p.qr_token}`, { margin: 1, width: 320, color: { dark: '#0F3D2E' } }));
    });
  });
}
