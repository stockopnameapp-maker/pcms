import { buildServer } from './server.js';
import { config } from './core/config.js';
import { pool } from './core/db.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
app.log.warn(`PCMS API listening on :${config.port} (${config.env})`);
startScheduler(app.log);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopScheduler();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
