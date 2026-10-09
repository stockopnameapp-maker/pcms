// Applies SQL migrations in order, each in its own transaction.
// Already-applied files are verified by checksum so history can't be silently edited.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const url = process.env.DATABASE_OWNER_URL;
if (!url) { console.error('DATABASE_OWNER_URL is not set'); process.exit(1); }

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query('REVOKE ALL ON public.schema_migrations FROM PUBLIC');
  const applied = new Map((await client.query('SELECT version, checksum FROM public.schema_migrations')).rows
    .map(r => [r.version, r.checksum]));

  const files = (await readdir(dir)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
  let count = 0;
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== sum) throw new Error(`Migration ${file} was modified after being applied`);
      continue;
    }
    process.stdout.write(`→ ${file} ... `);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)', [file, sum]);
      await client.query('COMMIT');
      console.log('ok'); count++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw new Error(`${file}: ${e.message}${e.position ? ` (at char ${e.position})` : ''}${e.where ? `\n${e.where}` : ''}`);
    }
  }
  console.log(count ? `Applied ${count} migration(s).` : 'Database is up to date.');
} finally {
  await client.end();
}
