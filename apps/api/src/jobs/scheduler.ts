// Background jobs. They use the OWNER connection because they work across all
// tenants (alert engine, partition maintenance) — never on behalf of a user.
import { config } from '../core/config.js';
import { ownerPool } from '../core/db.js';

export async function runAlertEngine() {
  const r = await ownerPool().query('SELECT analytics.run_alert_engine() AS r');
  return r.rows[0].r;
}

export async function ensureAuditPartitions() {
  await ownerPool().query(`SELECT audit.ensure_partitions(date_trunc('month', current_date)::date, 3)`);
}

let timers: NodeJS.Timeout[] = [];
export function startScheduler(log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void }) {
  if (!config.jobsEnabled || !config.ownerUrl) return;
  const safe = (name: string, fn: () => Promise<unknown>) => async () => {
    try { const r = await fn(); log.info({ job: name, result: r }, 'job finished'); } catch (e) { log.error({ job: name, err: e }, 'job failed'); }
  };
  const alert = safe('alert-engine', runAlertEngine);
  const partitions = safe('audit-partitions', ensureAuditPartitions);
  timers.push(setInterval(alert, config.alertIntervalMin * 60_000));
  timers.push(setInterval(partitions, 24 * 3600_000));
  setTimeout(alert, 10_000);
  setTimeout(partitions, 15_000);
}
export function stopScheduler() { timers.forEach(clearInterval); timers = []; }
