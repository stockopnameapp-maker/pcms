import pg from 'pg';
import { config } from './config.js';
import { fromPg, unauthorized } from './errors.js';

// numeric/bigint → number; dates stay 'YYYY-MM-DD' strings (no timezone shifting)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
pg.types.setTypeParser(1082, (v) => v);

/** Runtime pool: role pcms_app (NOBYPASSRLS). Every query runs inside withContext(). */
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30_000, application_name: 'pcms-api' });

let _owner: pg.Pool | null = null;
/** Owner pool: ONLY for scheduled maintenance jobs (alert engine, partitions). Never used for user requests. */
export function ownerPool() {
  if (!config.ownerUrl) throw new Error('DATABASE_OWNER_URL not configured');
  _owner ??= new pg.Pool({ connectionString: config.ownerUrl, max: 2, application_name: 'pcms-jobs' });
  return _owner;
}

export interface Tx {
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  val<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  client: pg.PoolClient;
}

function wrap(client: pg.PoolClient): Tx {
  return {
    client,
    async q(sql, params = []) {
      try { return (await client.query(sql, params as any[])).rows; } catch (e) { throw fromPg(e); }
    },
    async one(sql, params = []) {
      try { return (await client.query(sql, params as any[])).rows[0]; } catch (e) { throw fromPg(e); }
    },
    async val(sql, params = []) {
      try { const r = (await client.query(sql, params as any[])).rows[0]; return r ? (Object.values(r)[0] as any) : undefined; } catch (e) { throw fromPg(e); }
    },
  };
}

export interface RequestContext {
  userId: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * The ONLY way user requests touch the database: one transaction, security
 * context set first (signed, tenant derived from the user), session validated,
 * then the handler. Row-Level Security does the rest.
 */
export async function withContext<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const tx = wrap(client);
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT app.set_context($1, $2, $3, $4)', [ctx.userId, ctx.ip ?? null, ctx.userAgent ?? null, ctx.requestId ?? null]);
    } catch (e: any) {
      throw e?.code === '28000' ? unauthorized('Akun tidak aktif atau terkunci') : fromPg(e);
    }
    if (ctx.sessionId) {
      const ok = await tx.val<boolean>('SELECT app.session_check($1, $2::interval)', [ctx.sessionId, `${config.idleMinutes} minutes`]);
      if (!ok) throw unauthorized('Sesi berakhir atau telah dicabut, silakan login kembali');
    }
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Transaction without a user context (login, public certificate verification). RLS returns nothing here. */
export async function anonymous<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(wrap(client));
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
