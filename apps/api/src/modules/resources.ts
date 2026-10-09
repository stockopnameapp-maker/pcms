import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodTypeAny } from 'zod';
import { authenticate, db, page, parse, requirePerm, sendFile } from '../core/http.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import type { Tx } from '../core/db.js';
import { toTimestamp } from '../core/time.js';
import { FieldDef, RESOURCES, RESOURCE_MAP, ResourceDef } from './resources.def.js';
import { HOOKS } from './resources.hooks.js';
import { exportRows } from './export.js';

// ------------------------------------------------------------------ validation from field definitions
const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);

function fieldSchema(f: FieldDef): ZodTypeAny {
  let s: ZodTypeAny;
  switch (f.type) {
    case 'number': {
      let n = z.coerce.number({ message: 'harus berupa angka' });
      if (f.min !== undefined) n = n.min(f.min, `minimal ${f.min}`);
      if (f.max !== undefined) n = n.max(f.max, `maksimal ${f.max}`);
      s = n; break;
    }
    case 'boolean': s = z.boolean(); break;
    case 'date': s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format tanggal YYYY-MM-DD'); break;
    case 'datetime': s = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'format tanggal & jam tidak valid').transform(toTimestamp); break;
    case 'time': s = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'format jam HH:MM'); break;
    case 'select': s = z.enum(f.options!.map((o) => o.value) as [string, ...string[]], { message: 'pilihan tidak valid' }); break;
    case 'ref': s = f.ref === 'icd10' ? z.string().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/, 'kode ICD-10 tidak valid') : z.string().uuid('referensi tidak valid'); break;
    case 'tags': s = z.union([z.array(z.string().trim().min(1)), z.string().transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))]); break;
    default: {
      let t = z.string().trim().max(f.maxLength ?? 500, `maksimal ${f.maxLength ?? 500} karakter`);
      if (f.pattern) t = t.regex(new RegExp(f.pattern), f.patternMessage ?? 'format tidak valid');
      s = t;
    }
  }
  return f.required ? z.preprocess(emptyToNull, s) : z.preprocess(emptyToNull, s.nullable().optional());
}

function bodySchema(r: ResourceDef, mode: 'create' | 'update') {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of r.fields) {
    if (mode === 'create' && f.create === false) continue;
    if (mode === 'update' && f.update === false) continue;
    const s = fieldSchema(f);
    shape[f.name] = mode === 'update' ? s.optional() : s;
  }
  return z.object(shape).strict();
}

// ------------------------------------------------------------------ SQL building
interface ListQuery { sql: string; params: unknown[] }

export function buildList(r: ResourceDef, q: any, opts: { limit?: number; offset?: number; ids?: string[] } = {}): ListQuery {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  if (r.softDelete !== false && hasDeletedAt(r)) where.push(`${r.alias}.deleted_at IS NULL`);
  if (r.where) where.push(`(${r.where})`);
  if (q.q && String(q.q).trim()) {
    const term = p(`%${String(q.q).trim()}%`);
    where.push(`(${r.search.map((c) => `${c}::text ILIKE ${term}`).join(' OR ')})`);
  }
  if (q.unitId && r.unitPath) where.push(`${r.unitPath} <@ (SELECT path FROM org_unit WHERE id = ${p(q.unitId)})`);
  for (const f of r.filters ?? []) {
    const v = q[f.name];
    if (v === undefined || v === '' || v === null) continue;
    where.push(f.sql.replace(/\$(?!\d)/g, p(String(v))));
  }
  if (opts.ids) where.push(`${r.alias}.id = ANY(${p(opts.ids)}::uuid[])`);
  const sortable = new Set([...r.columns.map((c) => c.name), r.sort]);
  const sort = sortable.has(q.sort) ? q.sort : r.sort;
  const dir = q.dir === 'asc' ? 'ASC' : q.dir === 'desc' ? 'DESC' : (/(_at|date)$/.test(sort) ? 'DESC' : 'ASC');
  const limit = opts.limit ?? 25, offset = opts.offset ?? 0;
  const sql = `SELECT ${r.select}, count(*) OVER() AS _total FROM ${r.from}
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY "${sort}" ${dir} NULLS LAST, ${r.alias}.id
               LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params };
}

const NO_DELETED_AT = new Set(['inventory_stock']);
const hasDeletedAt = (r: ResourceDef) => !NO_DELETED_AT.has(r.table);

async function getOne(tx: Tx, r: ResourceDef, id: string) {
  const { sql, params } = buildList(r, {}, { ids: [id], limit: 1 });
  const row = await tx.one(sql, params);
  if (!row) throw notFound(r.singular);
  delete row._total;
  return row;
}

function resolve(key: string) {
  const r = RESOURCE_MAP.get(key);
  if (!r) throw notFound('Resource');
  return r;
}

const dbValue = (f: FieldDef | undefined, v: unknown) => (f?.type === 'tags' && Array.isArray(v) ? v : v);

// ------------------------------------------------------------------ routes
export default async function resourceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // metadata for the web app (no SQL), plus what the user may do per resource
  app.get('/meta/resources', async (req) => db(req, async (tx) => {
    const perms = await tx.q<{ module: string; action: string }>('SELECT DISTINCT module, action FROM app.my_permissions()');
    const can = (m: string, a: string) => perms.some((p) => p.module === m && p.action === a);
    const transitions = await tx.q('SELECT entity, from_status, to_status, required_action, label FROM workflow_transition');
    return {
      resources: RESOURCES.map(({ select, from, unitPath, search, where, filters, ...r }) => ({
        ...r,
        filters: (filters ?? []).map(({ sql, ...f }) => f),
        scoped: !!unitPath,
        permissions: {
          read: can(r.module, 'READ'), create: !r.noCreate && can(r.module, 'CREATE'), update: !r.noUpdate && can(r.module, 'UPDATE'),
          delete: !r.noDelete && can(r.module, 'DELETE'), export: can(r.module, 'EXPORT'),
        },
      })),
      transitions,
    };
  }));

  app.get('/r/:key', async (req: FastifyRequest<{ Params: { key: string }; Querystring: any }>) => {
    const r = resolve(req.params.key);
    const pg = page(req.query);
    return db(req, async (tx) => {
      await requirePerm(tx, r.module, 'READ');
      const { sql, params } = buildList(r, req.query, { limit: pg.pageSize, offset: pg.offset });
      const rows = await tx.q(sql, params);
      const total = rows[0]?._total ?? 0;
      rows.forEach((x) => delete x._total);
      return { data: rows, page: pg.page, pageSize: pg.pageSize, total };
    });
  });

  app.get('/r/:key/export', async (req: FastifyRequest<{ Params: { key: string }; Querystring: any }>, reply) => {
    const r = resolve(req.params.key);
    const qq: any = req.query;
    const format = ['xlsx', 'csv', 'pdf'].includes(qq.format) ? qq.format : 'xlsx';
    const out = await db(req, async (tx) => {
      await requirePerm(tx, r.module, 'EXPORT');
      const { sql, params } = buildList(r, req.query, { limit: 50000 });
      const rows = await tx.q(sql, params);
      await tx.q(`SELECT app.log_access('EXPORT', $1, NULL, $2, $3)`, [r.table, r.module, `${format}; ${rows.length} rows; filters=${JSON.stringify(req.query).slice(0, 300)}`]);
      return exportRows(format, r.title, r.columns, rows);
    });
    return sendFile(reply, out.buffer, out.mime, `${r.key}-${new Date().toISOString().slice(0, 10)}.${format}`);
  });

  app.get('/r/:key/:id', async (req: FastifyRequest<{ Params: { key: string; id: string } }>) => {
    const r = resolve(req.params.key);
    parse(z.string().uuid(), req.params.id);
    return db(req, async (tx) => {
      await requirePerm(tx, r.module, 'READ');
      const row = await getOne(tx, r, req.params.id);
      let transitions: any[] = [], events: any[] = [];
      if (r.workflow && row.status) {
        transitions = await tx.q(`SELECT to_status, label, required_action FROM workflow_transition WHERE entity = $1 AND from_status = $2 ORDER BY to_status`, [r.workflow, row.status]);
      }
      events = await tx.q(`SELECT w.from_status, w.to_status, w.note, w.occurred_at, u.full_name AS actor FROM workflow_event w LEFT JOIN app_user u ON u.id = w.actor_id
                            WHERE w.entity_id = $1 ORDER BY w.occurred_at`, [req.params.id]);
      const attachments = await tx.q(`SELECT id, file_name, mime_type, size_bytes, created_at FROM attachment WHERE entity_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [req.params.id]);
      if (HOOKS[r.key]?.afterRead) await HOOKS[r.key]!.afterRead!(tx, row);
      return { data: row, transitions, events, attachments };
    });
  });

  app.post('/r/:key', async (req: FastifyRequest<{ Params: { key: string }; Body: any }>, reply) => {
    const r = resolve(req.params.key);
    if (r.noCreate) throw badRequest(`${r.title} tidak dibuat melalui formulir ini`);
    const body = parse(bodySchema(r, 'create'), req.body ?? {});
    const row = await db(req, async (tx) => {
      await requirePerm(tx, r.module, 'CREATE');
      const data: Record<string, unknown> = {};
      for (const f of r.fields) if (body[f.name] !== undefined && body[f.name] !== null) data[f.name] = dbValue(f, body[f.name]);
      for (const f of r.fields) if (data[f.name] === undefined && f.default !== undefined && f.create !== false) data[f.name] = f.default;
      const hook = HOOKS[r.key];
      if (hook?.beforeCreate) Object.assign(data, await hook.beforeCreate(tx, data, req));
      const keys = Object.keys(data);
      const ins = await tx.one(`INSERT INTO ${r.table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        keys.map((k) => data[k]));
      if (hook?.afterCreate) await hook.afterCreate(tx, ins!.id, data, req);
      return getOne(tx, r, ins!.id);
    });
    reply.code(201);
    return { data: row };
  });

  app.patch('/r/:key/:id', async (req: FastifyRequest<{ Params: { key: string; id: string }; Body: any }>) => {
    const r = resolve(req.params.key);
    if (r.noUpdate) throw badRequest(`${r.title} tidak dapat diubah melalui formulir ini`);
    const ifMatch = req.headers['if-match'];
    const { version, ...rest } = (req.body ?? {}) as any;
    const body = parse(bodySchema(r, 'update'), rest);
    return db(req, async (tx) => {
      await requirePerm(tx, r.module, 'UPDATE');
      const data: Record<string, unknown> = {};
      for (const f of r.fields) if (body[f.name] !== undefined) data[f.name] = dbValue(f, body[f.name]);
      const hook = HOOKS[r.key];
      if (hook?.beforeUpdate) Object.assign(data, await hook.beforeUpdate(tx, req.params.id, data, req));
      const keys = Object.keys(data);
      if (!keys.length) throw badRequest('Tidak ada perubahan');
      const expected = Number(ifMatch ?? version);
      const params: unknown[] = keys.map((k) => data[k]);
      params.push(req.params.id);
      let sql = `UPDATE ${r.table} SET ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')} WHERE id = $${params.length}`;
      if (Number.isFinite(expected) && expected > 0) { params.push(expected); sql += ` AND version = $${params.length}`; }
      const res = await tx.q(sql + ' RETURNING id', params);
      if (!res.length) {
        const exists = await tx.val(`SELECT version FROM ${r.table} WHERE id = $1`, [req.params.id]);
        if (exists !== undefined && Number.isFinite(expected)) throw conflict('Data telah diubah oleh pengguna lain. Muat ulang lalu coba lagi.');
        throw notFound(r.singular);
      }
      return { data: await getOne(tx, r, req.params.id) };
    });
  });

  app.delete('/r/:key/:id', async (req: FastifyRequest<{ Params: { key: string; id: string } }>) => {
    const r = resolve(req.params.key);
    if (r.noDelete) throw badRequest(`${r.title} tidak dapat dihapus`);
    return db(req, async (tx) => {
      await requirePerm(tx, r.module, 'DELETE');
      const sql = r.deleteMode === 'revoke'
        ? `UPDATE ${r.table} SET revoked_at = now(), revoked_by = app.current_user_id() WHERE id = $1 AND revoked_at IS NULL RETURNING id`
        : `UPDATE ${r.table} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`;
      const res = await tx.q(sql, [req.params.id]);
      if (!res.length) throw notFound(r.singular);
      return { ok: true };
    });
  });

  // generic workflow transition (status change); the database validates the
  // transition, the APPROVE permission and four-eyes rule, and writes the timeline
  app.post('/r/:key/:id/transition', async (req: FastifyRequest<{ Params: { key: string; id: string }; Body: any }>) => {
    const r = resolve(req.params.key);
    if (!r.workflow) throw badRequest('Resource ini tidak memiliki alur status');
    const b = parse(z.object({ to: z.string().regex(/^[A-Z_]{3,30}$/), note: z.string().max(1000).optional(), patch: z.record(z.string(), z.any()).optional() }), req.body);
    return db(req, async (tx) => {
      const extra: Record<string, unknown> = {};
      if (b.patch) {
        const allowed = new Set([...r.fields.map((f) => f.name), ...(HOOKS[r.key]?.transitionFields ?? [])]);
        for (const [k, v] of Object.entries(b.patch)) {
          if (!allowed.has(k)) throw badRequest(`Kolom ${k} tidak boleh diubah saat transisi`);
          extra[k] = v === '' ? null : v;
        }
      }
      const hook = HOOKS[r.key];
      if (hook?.beforeTransition) Object.assign(extra, await hook.beforeTransition(tx, req.params.id, b.to, extra, req));
      await tx.q(`SELECT set_config('app.workflow_note', $1, true)`, [b.note ?? '']);
      const keys = Object.keys(extra);
      const params: unknown[] = [b.to, ...keys.map((k) => extra[k]), req.params.id];
      const res = await tx.q(`UPDATE ${r.table} SET status = $1${keys.map((k, i) => `, "${k}" = $${i + 2}`).join('')} WHERE id = $${params.length} RETURNING id`, params);
      if (!res.length) throw notFound(r.singular);
      if (hook?.afterTransition) await hook.afterTransition(tx, req.params.id, b.to, req);
      return { data: await getOne(tx, r, req.params.id) };
    });
  });
}
