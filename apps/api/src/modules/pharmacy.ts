// Pharmacy & multi-site inventory (Phase 6)
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, db, parse, requirePerm, zDate, zUuid } from '../core/http.js';
import { badRequest, notFound } from '../core/errors.js';
import type { Tx } from '../core/db.js';
import { currentStaff } from './resources.hooks.js';

/** Allocate quantity First-Expired-First-Out across non-expired batches at a site. */
async function fefo(tx: Tx, siteId: string, medicineId: string, qty: number) {
  // Serialise pickers on the same site × medicine for the rest of the transaction. (Row locks via
  // FOR UPDATE would need UPDATE rights on inventory_stock, which the app role deliberately lacks —
  // the ledger trigger maintains it and still rejects any movement that would go negative.)
  await tx.q('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock:${siteId}:${medicineId}`]);
  const batches = await tx.q<{ batch_id: string; qty_on_hand: number; unit_cost: number; batch_no: string; expiry_date: string }>(
    `SELECT s.batch_id, s.qty_on_hand, b.unit_cost, b.batch_no, b.expiry_date FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id
      WHERE s.org_unit_id = $1 AND s.medicine_id = $2 AND s.qty_on_hand > 0 AND b.expiry_date >= current_date
      ORDER BY b.expiry_date, b.batch_no`, [siteId, medicineId]);
  const picks: { batch_id: string; qty: number; unit_cost: number; batch_no: string; expiry_date: string }[] = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, Number(b.qty_on_hand));
    picks.push({ batch_id: b.batch_id, qty: take, unit_cost: Number(b.unit_cost), batch_no: b.batch_no, expiry_date: b.expiry_date });
    left -= take;
  }
  return { picks, shortfall: Math.max(0, left), available: qty - Math.max(0, left) };
}

async function upsertBatch(tx: Tx, medicineId: string, batchNo: string, expiry: string, supplierId: string | null, unitCost: number) {
  const existing = await tx.one('SELECT id, expiry_date FROM medicine_batch WHERE medicine_id = $1 AND batch_no = $2', [medicineId, batchNo]);
  if (existing) {
    if (existing.expiry_date !== expiry) throw badRequest(`Batch ${batchNo} sudah terdaftar dengan tanggal kedaluwarsa ${existing.expiry_date}`);
    return existing.id as string;
  }
  return (await tx.val('INSERT INTO medicine_batch (medicine_id, batch_no, expiry_date, supplier_id, unit_cost) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [medicineId, batchNo, expiry, supplierId, unitCost])) as string;
}

const docScope = (tx: Tx, unitId: string) => tx.val<string>('SELECT code FROM org_unit WHERE id = $1', [unitId]);

export default async function pharmacyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ------------------------------------------------------------ prescriptions to dispense
  app.get('/pharmacy/prescriptions', async (req: FastifyRequest<{ Querystring: { clinicId?: string; status?: string } }>) =>
    db(req, async (tx) => {
      await requirePerm(tx, 'PHARMACY', 'READ');
      const params: unknown[] = [];
      let where = `rx.status IN ('SUBMITTED','IN_PREPARATION','PARTIALLY_DISPENSED')`;
      if (req.query.status) { params.push(req.query.status); where = `rx.status = $${params.length}`; }
      if (req.query.clinicId) { params.push(req.query.clinicId); where += ` AND rx.clinic_id = $${params.length}`; }
      return { data: await tx.q(`
        SELECT rx.id, rx.prescription_no, rx.status, rx.prescribed_at, rx.notes, p.full_name AS patient_name, p.mrn, s.full_name AS prescriber_name, c.name AS clinic_name, rx.clinic_id,
               q.queue_code, (SELECT count(*) FROM prescription_item i WHERE i.prescription_id = rx.id) AS items
          FROM prescription rx JOIN patient p ON p.id = rx.patient_id JOIN medical_staff s ON s.id = rx.prescriber_id JOIN org_unit c ON c.id = rx.clinic_id
          LEFT JOIN encounter e ON e.id = rx.encounter_id LEFT JOIN queue_ticket q ON q.id = e.queue_ticket_id
         WHERE ${where} AND rx.prescribed_at > now() - interval '30 days' ORDER BY rx.prescribed_at LIMIT 200`, params) };
    }));

  app.get('/pharmacy/prescriptions/:id', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const rx = await tx.one(`SELECT rx.*, p.full_name AS patient_name, p.mrn, p.gender, date_part('year', age(p.birth_date))::int AS age, s.full_name AS prescriber_name, c.name AS clinic_name
                                 FROM prescription rx JOIN patient p ON p.id = rx.patient_id JOIN medical_staff s ON s.id = rx.prescriber_id JOIN org_unit c ON c.id = rx.clinic_id WHERE rx.id = $1`, [req.params.id]);
      if (!rx) throw notFound('Resep');
      const items = await tx.q(`SELECT i.id, i.medicine_id, m.name AS medicine, m.unit, m.drug_class, i.qty, i.dose, i.frequency, i.route, i.duration_days, i.instructions, i.dispensed_qty,
                                       (SELECT coalesce(sum(s.qty_on_hand), 0) FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id
                                         WHERE s.org_unit_id = $2 AND s.medicine_id = i.medicine_id AND b.expiry_date >= current_date) AS available
                                  FROM prescription_item i JOIN medicine m ON m.id = i.medicine_id WHERE i.prescription_id = $1 AND i.deleted_at IS NULL ORDER BY m.name`, [rx.id, rx.clinic_id]);
      const allergies = await tx.q(`SELECT allergen, severity, reaction FROM patient_allergy WHERE patient_id = $1 AND status = 'ACTIVE' AND allergen_type = 'DRUG' AND deleted_at IS NULL`, [rx.patient_id]);
      return { prescription: rx, items, allergies };
    }));

  app.post('/pharmacy/prescriptions/:id/dispense', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ items: z.array(z.object({ itemId: zUuid, qty: z.number().min(0) })).min(1) }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['PHARMACIST', 'PHARMACY_TECH', 'DOCTOR', 'NURSE']);
      const rx = await tx.one('SELECT * FROM prescription WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rx) throw notFound('Resep');
      if (!['SUBMITTED', 'IN_PREPARATION', 'PARTIALLY_DISPENSED'].includes(rx.status)) throw badRequest(`Resep berstatus ${rx.status} tidak dapat diserahkan`);
      await requirePerm(tx, 'INVENTORY', 'CREATE', rx.clinic_id);
      const lines: any[] = [];
      for (const it of b.items) {
        if (it.qty <= 0) continue;
        const item = await tx.one('SELECT * FROM prescription_item WHERE id = $1 AND prescription_id = $2', [it.itemId, rx.id]);
        if (!item) throw badRequest('Item resep tidak valid');
        const remaining = Number(item.qty) - Number(item.dispensed_qty);
        if (it.qty > remaining) throw badRequest(`Jumlah melebihi sisa resep (${remaining})`);
        const { picks, shortfall } = await fefo(tx, rx.clinic_id, item.medicine_id, it.qty);
        if (shortfall > 0) throw badRequest(`Stok tidak cukup untuk salah satu obat (kurang ${shortfall}). Ajukan transfer stok atau serahkan sebagian.`);
        for (const p of picks) {
          await tx.q(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, ref_type, ref_id)
                      VALUES (app.next_document_no('INV', $1), $2, $3, $4, 'DISPENSE', $5, $6, 'prescription', $7)`,
            [await docScope(tx, rx.clinic_id), rx.clinic_id, item.medicine_id, p.batch_id, -p.qty, p.unit_cost, rx.id]);
          lines.push({ itemId: item.id, batch: p.batch_no, expiry: p.expiry_date, qty: p.qty });
        }
        await tx.q('UPDATE prescription_item SET dispensed_qty = dispensed_qty + $2 WHERE id = $1', [item.id, it.qty]);
      }
      if (!lines.length) throw badRequest('Tidak ada obat yang diserahkan');
      const done = await tx.val<boolean>(`SELECT bool_and(dispensed_qty >= qty) FROM prescription_item WHERE prescription_id = $1 AND deleted_at IS NULL`, [rx.id]);
      await tx.q(`UPDATE prescription SET status = $2, dispensed_by = $3, dispensed_at = now() WHERE id = $1`, [rx.id, done ? 'DISPENSED' : 'PARTIALLY_DISPENSED', staff.id]);
      if (done) {
        // locate the ticket via the prescription itself: pharmacy staff cannot (and need not) read the encounter
        await tx.q(`UPDATE queue_ticket SET status = 'COMPLETED', completed_at = now()
                     WHERE clinic_id = $1 AND patient_id = $2 AND status = 'PHARMACY' AND visit_date >= $3::date - 1`,
          [rx.clinic_id, rx.patient_id, new Date(rx.created_at).toISOString().slice(0, 10)]);
      }
      return { ok: true, status: done ? 'DISPENSED' : 'PARTIALLY_DISPENSED', lines };
    });
  });

  // ------------------------------------------------------------ stock
  app.get('/pharmacy/stock', async (req: FastifyRequest<{ Querystring: { siteId?: string; q?: string; low?: string } }>) =>
    db(req, async (tx) => {
      await requirePerm(tx, 'INVENTORY', 'READ');
      const params: unknown[] = [];
      const where: string[] = [];
      if (req.query.siteId) { params.push(req.query.siteId); where.push(`sp.org_unit_id = $${params.length}`); }
      if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(m.name ILIKE $${params.length} OR m.code ILIKE $${params.length})`); }
      if (req.query.low === '1') where.push('sp.is_low_stock');
      return { data: await tx.q(`
        SELECT sp.org_unit_id, u.name AS site_name, sp.medicine_id, m.code, m.name, m.unit, mc.name AS category, sp.qty_on_hand, sp.qty_usable, sp.min_qty, sp.nearest_expiry,
               sp.is_low_stock, (sp.nearest_expiry - current_date) AS days_to_expiry, round(sp.qty_on_hand * m.standard_cost) AS stock_value
          FROM v_stock_position sp JOIN medicine m ON m.id = sp.medicine_id JOIN medicine_category mc ON mc.id = m.category_id JOIN org_unit u ON u.id = sp.org_unit_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sp.is_low_stock DESC, m.name LIMIT 1000`, params) };
    }));

  app.get('/pharmacy/stock/summary', async (req) =>
    db(req, async (tx) => { await requirePerm(tx, 'INVENTORY', 'READ'); return { data: await tx.q(`
      SELECT u.id AS site_id, u.name AS site_name, u.unit_type, co.name AS company_name, es.name AS estate_name,
             count(DISTINCT sp.medicine_id) AS medicines, round(sum(sp.qty_on_hand * m.standard_cost)) AS stock_value,
             count(*) FILTER (WHERE sp.is_low_stock) AS low_stock,
             (SELECT count(*) FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id WHERE s.org_unit_id = u.id AND s.qty_on_hand > 0 AND b.expiry_date < current_date) AS expired_batches,
             (SELECT count(*) FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id WHERE s.org_unit_id = u.id AND s.qty_on_hand > 0 AND b.expiry_date BETWEEN current_date AND current_date + 60) AS near_expiry_batches
        FROM v_stock_position sp JOIN medicine m ON m.id = sp.medicine_id JOIN org_unit u ON u.id = sp.org_unit_id
        LEFT JOIN LATERAL (SELECT c.name FROM org_unit c WHERE c.path @> u.path AND c.unit_type = 'COMPANY' LIMIT 1) co ON true
        LEFT JOIN LATERAL (SELECT e.name FROM org_unit e WHERE e.path @> u.path AND e.unit_type = 'ESTATE' LIMIT 1) es ON true
       GROUP BY u.id, u.name, u.unit_type, co.name, es.name ORDER BY u.unit_type DESC, co.name NULLS FIRST, u.name`) }; }));

  app.get('/pharmacy/stock/:siteId/:medicineId', async (req: FastifyRequest<{ Params: { siteId: string; medicineId: string } }>) =>
    db(req, async (tx) => ({
      batches: await tx.q(`SELECT s.batch_id, b.batch_no, b.expiry_date, (b.expiry_date - current_date) AS days_to_expiry, s.qty_on_hand, b.unit_cost
                             FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id WHERE s.org_unit_id = $1 AND s.medicine_id = $2 AND s.qty_on_hand > 0 ORDER BY b.expiry_date`,
        [req.params.siteId, req.params.medicineId]),
      movements: await tx.q(`SELECT t.txn_at, t.txn_type, t.qty, b.batch_no, t.reason, t.ref_type, u.full_name AS by_name FROM inventory_transaction t JOIN medicine_batch b ON b.id = t.batch_id
                               LEFT JOIN app_user u ON u.id = t.created_by WHERE t.org_unit_id = $1 AND t.medicine_id = $2 ORDER BY t.txn_at DESC LIMIT 50`, [req.params.siteId, req.params.medicineId]),
    })));

  // manual adjustments (reason mandatory), damaged/expired write-off, return from patient
  app.post('/pharmacy/adjustments', async (req) => {
    const b = parse(z.object({ siteId: zUuid, medicineId: zUuid, batchId: zUuid, qty: z.number().positive(),
      type: z.enum(['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGED_WRITE_OFF', 'EXPIRED_WRITE_OFF', 'RETURN_FROM_PATIENT', 'RETURN_TO_SUPPLIER']), reason: z.string().min(5).max(300) }), req.body);
    return db(req, async (tx) => {
      const sign = ['ADJUSTMENT_IN', 'RETURN_FROM_PATIENT'].includes(b.type) ? 1 : -1;
      const cost = await tx.val('SELECT unit_cost FROM medicine_batch WHERE id = $1 AND medicine_id = $2', [b.batchId, b.medicineId]);
      if (cost === undefined) throw badRequest('Batch tidak sesuai dengan obat');
      const id = await tx.val(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, reason, ref_type)
                               VALUES (app.next_document_no('INV', $1), $2, $3, $4, $5, $6, $7, $8, 'manual') RETURNING id`,
        [await docScope(tx, b.siteId), b.siteId, b.medicineId, b.batchId, b.type, sign * b.qty, cost, b.reason]);
      return { id };
    });
  });

  app.post('/pharmacy/write-off-expired', async (req) => {
    const b = parse(z.object({ siteId: zUuid }), req.body);
    return db(req, async (tx) => {
      const rows = await tx.q(`SELECT s.medicine_id, s.batch_id, s.qty_on_hand, b.unit_cost FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id
                                WHERE s.org_unit_id = $1 AND s.qty_on_hand > 0 AND b.expiry_date < current_date`, [b.siteId]);
      const scope = await docScope(tx, b.siteId);
      for (const r of rows) {
        await tx.q(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, reason, ref_type)
                    VALUES (app.next_document_no('INV', $1), $2, $3, $4, 'EXPIRED_WRITE_OFF', $5, $6, 'Pemusnahan obat kedaluwarsa', 'manual')`,
          [scope, b.siteId, r.medicine_id, r.batch_id, -Number(r.qty_on_hand), r.unit_cost]);
      }
      return { ok: true, batches: rows.length };
    });
  });

  // direct goods receipt at a site (e.g. local purchase) — creates the batch when new
  app.post('/pharmacy/receipts', async (req) => {
    const b = parse(z.object({ siteId: zUuid, supplierId: zUuid.optional(), items: z.array(z.object({ medicineId: zUuid, batchNo: z.string().min(1).max(40), expiryDate: zDate,
      qty: z.number().positive(), unitCost: z.number().min(0) })).min(1), reference: z.string().max(100).optional() }), req.body);
    return db(req, async (tx) => {
      await requirePerm(tx, 'INVENTORY', 'CREATE', b.siteId);
      const scope = await docScope(tx, b.siteId);
      for (const i of b.items) {
        if (i.expiryDate <= new Date().toISOString().slice(0, 10)) throw badRequest(`Batch ${i.batchNo} sudah kedaluwarsa`);
        const batch = await upsertBatch(tx, i.medicineId, i.batchNo, i.expiryDate, b.supplierId ?? null, i.unitCost);
        await tx.q(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, reason, ref_type)
                    VALUES (app.next_document_no('INV', $1), $2, $3, $4, 'RECEIPT', $5, $6, $7, 'receipt')`, [scope, b.siteId, i.medicineId, batch, i.qty, i.unitCost, b.reference ?? 'Penerimaan barang']);
      }
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ transfers: REQUEST → APPROVAL → TRANSFER → RECEIVING → STOCK UPDATE
  app.get('/pharmacy/transfers/:id', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const t = await tx.one(`SELECT t.*, f.name AS from_name, d.name AS to_name FROM stock_transfer t JOIN org_unit f ON f.id = t.from_unit_id JOIN org_unit d ON d.id = t.to_unit_id WHERE t.id = $1`, [req.params.id]);
      if (!t) throw notFound('Transfer');
      const items = await tx.q(`SELECT i.*, m.name AS medicine, m.unit, b.batch_no, b.expiry_date,
                                       (SELECT coalesce(sum(s.qty_on_hand), 0) FROM inventory_stock s JOIN medicine_batch mb ON mb.id = s.batch_id
                                         WHERE s.org_unit_id = $2 AND s.medicine_id = i.medicine_id AND mb.expiry_date >= current_date) AS available_at_source
                                  FROM stock_transfer_item i JOIN medicine m ON m.id = i.medicine_id LEFT JOIN medicine_batch b ON b.id = i.batch_id
                                 WHERE i.stock_transfer_id = $1 ORDER BY m.name, b.expiry_date`, [t.id, t.from_unit_id]);
      const events = await tx.q(`SELECT w.*, u.full_name AS actor FROM workflow_event w LEFT JOIN app_user u ON u.id = w.actor_id WHERE w.entity_id = $1 ORDER BY w.occurred_at`, [t.id]);
      const transitions = await tx.q(`SELECT to_status, label, required_action FROM workflow_transition WHERE entity = 'stock_transfer' AND from_status = $1`, [t.status]);
      return { transfer: t, items, events, transitions };
    }));

  app.post('/pharmacy/transfers', async (req) => {
    const b = parse(z.object({ fromUnitId: zUuid, toUnitId: zUuid, priority: z.enum(['NORMAL', 'URGENT']).default('NORMAL'), notes: z.string().max(500).optional(),
      items: z.array(z.object({ medicineId: zUuid, qty: z.number().positive() })).min(1).max(50) }).refine((v) => v.fromUnitId !== v.toUnitId, 'unit asal dan tujuan harus berbeda'), req.body);
    return db(req, async (tx) => {
      const id = await tx.val(`INSERT INTO stock_transfer (transfer_no, from_unit_id, to_unit_id, priority, notes, requested_by)
                               VALUES (app.next_document_no('TRF', app.tenant_code()), $1, $2, $3, $4, app.current_user_id()) RETURNING id`, [b.fromUnitId, b.toUnitId, b.priority, b.notes ?? null]);
      for (const i of b.items) await tx.q('INSERT INTO stock_transfer_item (stock_transfer_id, medicine_id, qty_requested) VALUES ($1, $2, $3)', [id, i.medicineId, i.qty]);
      return { id };
    });
  });

  app.post('/pharmacy/transfers/:id/approve', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ items: z.array(z.object({ itemId: zUuid, qtyApproved: z.number().min(0) })).optional(), note: z.string().max(300).optional() }), req.body ?? {});
    return db(req, async (tx) => {
      for (const i of b.items ?? []) await tx.q('UPDATE stock_transfer_item SET qty_approved = $2 WHERE id = $1 AND stock_transfer_id = $3', [i.itemId, i.qtyApproved, req.params.id]);
      await tx.q('UPDATE stock_transfer_item SET qty_approved = qty_requested WHERE stock_transfer_id = $1 AND qty_approved IS NULL', [req.params.id]);
      await tx.q(`SELECT set_config('app.workflow_note', $1, true)`, [b.note ?? '']);
      const r = await tx.q(`UPDATE stock_transfer SET status = 'APPROVED' WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!r.length) throw notFound('Transfer');
      return { ok: true };
    });
  });

  app.post('/pharmacy/transfers/:id/reject', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ reason: z.string().min(5).max(300) }), req.body);
    return db(req, async (tx) => {
      await tx.q(`SELECT set_config('app.workflow_note', $1, true)`, [b.reason]);
      const r = await tx.q(`UPDATE stock_transfer SET status = 'REJECTED', reject_reason = $2 WHERE id = $1 RETURNING id`, [req.params.id, b.reason]);
      if (!r.length) throw notFound('Transfer');
      return { ok: true };
    });
  });

  // ship: FEFO-pick batches at the source, post TRANSFER_OUT, split items per batch
  app.post('/pharmacy/transfers/:id/ship', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const t = await tx.one(`SELECT * FROM stock_transfer WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!t) throw notFound('Transfer');
      if (t.status !== 'APPROVED') throw badRequest('Transfer harus disetujui sebelum dikirim');
      const scope = await docScope(tx, t.from_unit_id);
      const items = await tx.q(`SELECT * FROM stock_transfer_item WHERE stock_transfer_id = $1 AND coalesce(qty_approved, 0) > 0`, [t.id]);
      for (const it of items) {
        const { picks, shortfall } = await fefo(tx, t.from_unit_id, it.medicine_id, Number(it.qty_approved));
        if (shortfall > 0) throw badRequest(`Stok di unit asal tidak cukup (kurang ${shortfall}) — sesuaikan jumlah disetujui`);
        for (const [n, p] of picks.entries()) {
          const itemId = n === 0 ? it.id : await tx.val(`INSERT INTO stock_transfer_item (stock_transfer_id, medicine_id, qty_requested, qty_approved) VALUES ($1, $2, $3, $3) RETURNING id`,
            [t.id, it.medicine_id, p.qty]);
          await tx.q('UPDATE stock_transfer_item SET batch_id = $2, qty_shipped = $3, qty_approved = CASE WHEN $4 THEN $3 ELSE qty_approved END WHERE id = $1', [itemId, p.batch_id, p.qty, picks.length > 1]);
          await tx.q(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, ref_type, ref_id)
                      VALUES (app.next_document_no('INV', $1), $2, $3, $4, 'TRANSFER_OUT', $5, $6, 'stock_transfer', $7)`, [scope, t.from_unit_id, it.medicine_id, p.batch_id, -p.qty, p.unit_cost, t.id]);
        }
      }
      await tx.q(`UPDATE stock_transfer SET status = 'IN_TRANSIT', shipped_by = app.current_user_id(), shipped_at = now() WHERE id = $1`, [t.id]);
      return { ok: true };
    }));

  app.post('/pharmacy/transfers/:id/receive', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ items: z.array(z.object({ itemId: zUuid, qtyReceived: z.number().min(0) })).optional() }), req.body ?? {});
    return db(req, async (tx) => {
      const t = await tx.one(`SELECT * FROM stock_transfer WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!t) throw notFound('Transfer');
      if (t.status !== 'IN_TRANSIT') throw badRequest('Hanya transfer dalam perjalanan yang dapat diterima');
      const scope = await docScope(tx, t.to_unit_id);
      const map = new Map((b.items ?? []).map((i) => [i.itemId, i.qtyReceived]));
      const items = await tx.q(`SELECT i.*, mb.unit_cost FROM stock_transfer_item i JOIN medicine_batch mb ON mb.id = i.batch_id WHERE i.stock_transfer_id = $1 AND i.qty_shipped > 0`, [t.id]);
      for (const it of items) {
        const q = map.has(it.id) ? Number(map.get(it.id)) : Number(it.qty_shipped);
        if (q > Number(it.qty_shipped)) throw badRequest('Jumlah diterima melebihi jumlah dikirim');
        await tx.q('UPDATE stock_transfer_item SET qty_received = $2 WHERE id = $1', [it.id, q]);
        if (q > 0) await tx.q(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, ref_type, ref_id)
                               VALUES (app.next_document_no('INV', $1), $2, $3, $4, 'TRANSFER_IN', $5, $6, 'stock_transfer', $7)`, [scope, t.to_unit_id, it.medicine_id, it.batch_id, q, it.unit_cost, t.id]);
        const lost = Number(it.qty_shipped) - q;
        if (lost > 0) await tx.q(`SELECT app.log_access('STATUS_CHANGE', 'stock_transfer', $1, 'INVENTORY', $2)`, [t.id, `selisih penerimaan ${lost} pada item ${it.id}`]);
      }
      await tx.q(`UPDATE stock_transfer SET status = 'RECEIVED', received_by = app.current_user_id(), received_at = now() WHERE id = $1`, [t.id]);
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ purchase orders
  app.get('/pharmacy/purchase-orders/:id', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const po = await tx.one(`SELECT po.*, s.name AS supplier_name, u.name AS site_name FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN org_unit u ON u.id = po.org_unit_id WHERE po.id = $1`, [req.params.id]);
      if (!po) throw notFound('PO');
      const items = await tx.q(`SELECT i.*, m.name AS medicine, m.unit FROM purchase_order_item i JOIN medicine m ON m.id = i.medicine_id WHERE i.purchase_order_id = $1 ORDER BY m.name`, [po.id]);
      const transitions = await tx.q(`SELECT to_status, label, required_action FROM workflow_transition WHERE entity = 'purchase_order' AND from_status = $1`, [po.status]);
      const events = await tx.q(`SELECT w.*, u.full_name AS actor FROM workflow_event w LEFT JOIN app_user u ON u.id = w.actor_id WHERE w.entity_id = $1 ORDER BY w.occurred_at`, [po.id]);
      return { po, items, transitions, events };
    }));

  app.post('/pharmacy/purchase-orders', async (req) => {
    const b = parse(z.object({ siteId: zUuid, supplierId: zUuid, expectedDate: zDate.optional(), notes: z.string().max(500).optional(), submit: z.boolean().default(true),
      items: z.array(z.object({ medicineId: zUuid, qty: z.number().positive(), unitPrice: z.number().min(0) })).min(1).max(100) }), req.body);
    return db(req, async (tx) => {
      const total = b.items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
      const id = await tx.val(`INSERT INTO purchase_order (po_no, org_unit_id, supplier_id, expected_date, notes, total_amount, status)
                               VALUES (app.next_document_no('PO', app.tenant_code()), $1, $2, $3, $4, $5, 'DRAFT') RETURNING id`, [b.siteId, b.supplierId, b.expectedDate ?? null, b.notes ?? null, total]);
      for (const i of b.items) await tx.q('INSERT INTO purchase_order_item (purchase_order_id, medicine_id, qty_ordered, unit_price) VALUES ($1, $2, $3, $4)', [id, i.medicineId, i.qty, i.unitPrice]);
      if (b.submit) await tx.q(`UPDATE purchase_order SET status = 'SUBMITTED' WHERE id = $1`, [id]);
      return { id };
    });
  });

  app.post('/pharmacy/purchase-orders/:id/receive', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ items: z.array(z.object({ itemId: zUuid, qtyReceived: z.number().positive(), batchNo: z.string().min(1).max(40), expiryDate: zDate })).min(1) }), req.body);
    return db(req, async (tx) => {
      const po = await tx.one('SELECT * FROM purchase_order WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!po) throw notFound('PO');
      if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw badRequest('PO harus disetujui sebelum penerimaan barang');
      const scope = await docScope(tx, po.org_unit_id);
      for (const r of b.items) {
        const it = await tx.one('SELECT * FROM purchase_order_item WHERE id = $1 AND purchase_order_id = $2', [r.itemId, po.id]);
        if (!it) throw badRequest('Item PO tidak valid');
        if (Number(it.qty_received) + r.qtyReceived > Number(it.qty_ordered)) throw badRequest('Jumlah diterima melebihi jumlah dipesan');
        const batch = await upsertBatch(tx, it.medicine_id, r.batchNo, r.expiryDate, po.supplier_id, Number(it.unit_price));
        await tx.q(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, ref_type, ref_id)
                    VALUES (app.next_document_no('INV', $1), $2, $3, $4, 'RECEIPT', $5, $6, 'purchase_order', $7)`, [scope, po.org_unit_id, it.medicine_id, batch, r.qtyReceived, it.unit_price, po.id]);
        await tx.q('UPDATE purchase_order_item SET qty_received = qty_received + $2 WHERE id = $1', [it.id, r.qtyReceived]);
      }
      const complete = await tx.val<boolean>('SELECT bool_and(qty_received >= qty_ordered) FROM purchase_order_item WHERE purchase_order_id = $1', [po.id]);
      const next = complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
      if (next !== po.status) await tx.q('UPDATE purchase_order SET status = $2 WHERE id = $1', [po.id, next]);
      return { ok: true, status: next };
    });
  });

  // ------------------------------------------------------------ stock opname
  app.post('/pharmacy/opnames', async (req) => {
    const b = parse(z.object({ siteId: zUuid, notes: z.string().max(500).optional() }), req.body);
    return db(req, async (tx) => {
      const id = await tx.val(`INSERT INTO stock_opname (opname_no, org_unit_id, notes, status) VALUES (app.next_document_no('OPN', $1), $2, $3, 'DRAFT') RETURNING id`,
        [await docScope(tx, b.siteId), b.siteId, b.notes ?? null]);
      await tx.q(`INSERT INTO stock_opname_item (stock_opname_id, batch_id, system_qty, counted_qty)
                  SELECT $1, s.batch_id, s.qty_on_hand, s.qty_on_hand FROM inventory_stock s WHERE s.org_unit_id = $2 AND s.qty_on_hand > 0`, [id, b.siteId]);
      await tx.q(`UPDATE stock_opname SET status = 'COUNTING' WHERE id = $1`, [id]);
      return { id };
    });
  });

  app.get('/pharmacy/opnames/:id', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const o = await tx.one(`SELECT s.*, u.name AS site_name FROM stock_opname s JOIN org_unit u ON u.id = s.org_unit_id WHERE s.id = $1`, [req.params.id]);
      if (!o) throw notFound('Opname');
      const items = await tx.q(`SELECT i.id, i.batch_id, b.batch_no, b.expiry_date, m.name AS medicine, m.unit, i.system_qty, i.counted_qty, i.variance, i.notes
                                  FROM stock_opname_item i JOIN medicine_batch b ON b.id = i.batch_id JOIN medicine m ON m.id = b.medicine_id WHERE i.stock_opname_id = $1 ORDER BY m.name`, [o.id]);
      const transitions = await tx.q(`SELECT to_status, label, required_action FROM workflow_transition WHERE entity = 'stock_opname' AND from_status = $1`, [o.status]);
      return { opname: o, items, transitions };
    }));

  app.patch('/pharmacy/opnames/:id/counts', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ items: z.array(z.object({ itemId: zUuid, countedQty: z.number().min(0), notes: z.string().max(200).optional() })).min(1) }), req.body);
    return db(req, async (tx) => {
      const st = await tx.val('SELECT status FROM stock_opname WHERE id = $1', [req.params.id]);
      if (st !== 'COUNTING') throw badRequest('Hitungan hanya dapat diubah saat status COUNTING');
      for (const i of b.items) await tx.q('UPDATE stock_opname_item SET counted_qty = $2, notes = $3 WHERE id = $1 AND stock_opname_id = $4', [i.itemId, i.countedQty, i.notes ?? null, req.params.id]);
      return { ok: true };
    });
  });

  // posting an approved opname writes the variances as OPNAME_GAIN / OPNAME_LOSS
  app.post('/pharmacy/opnames/:id/post', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const o = await tx.one('SELECT * FROM stock_opname WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o) throw notFound('Opname');
      if (o.status !== 'APPROVED') throw badRequest('Opname harus disetujui sebelum diposting');
      const scope = await docScope(tx, o.org_unit_id);
      const items = await tx.q(`SELECT i.*, b.medicine_id, b.unit_cost, coalesce(s.qty_on_hand, 0) AS current_qty FROM stock_opname_item i JOIN medicine_batch b ON b.id = i.batch_id
                                  LEFT JOIN inventory_stock s ON s.org_unit_id = $2 AND s.batch_id = i.batch_id WHERE i.stock_opname_id = $1`, [o.id, o.org_unit_id]);
      let posted = 0;
      for (const i of items) {
        const delta = Number(i.counted_qty) - Number(i.current_qty);   // relative to stock now (movements during counting are respected)
        if (delta === 0) continue;
        await tx.q(`INSERT INTO inventory_transaction (txn_no, org_unit_id, medicine_id, batch_id, txn_type, qty, unit_cost, reason, ref_type, ref_id)
                    VALUES (app.next_document_no('INV', $1), $2, $3, $4, $5, $6, $7, $8, 'stock_opname', $9)`,
          [scope, o.org_unit_id, i.medicine_id, i.batch_id, delta > 0 ? 'OPNAME_GAIN' : 'OPNAME_LOSS', delta, i.unit_cost, `Stock opname ${o.opname_no}`, o.id]);
        posted++;
      }
      await tx.q(`UPDATE stock_opname SET status = 'POSTED' WHERE id = $1`, [o.id]);
      return { ok: true, adjustments: posted };
    }));
}
