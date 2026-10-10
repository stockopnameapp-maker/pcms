import Fastify, { FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from './core/config.js';
import { pool } from './core/db.js';
import { AppError } from './core/errors.js';
import authRoutes from './modules/auth.js';
import resourceRoutes from './modules/resources.js';
import lookupRoutes from './modules/lookups.js';
import clinicalRoutes from './modules/clinical.js';
import pharmacyRoutes from './modules/pharmacy.js';
import operationsRoutes from './modules/operations.js';
import reportRoutes from './modules/reports.js';
import platformRoutes from './modules/platform.js';

export async function buildServer(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.env === 'production' ? 'info' : 'warn', redact: ['req.headers.authorization', 'body.password', 'body.refreshToken'] },
    genReqId: (req) => (req.headers['x-request-id'] as string)?.slice(0, 64) || randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] } },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: false, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], exposedHeaders: ['Content-Disposition'] });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', keyGenerator: (req) => req.headers.authorization?.slice(-24) ?? req.ip });
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      const cause = (err as any).cause;
      if (err.status >= 500) req.log.error({ err: cause ?? err }, 'internal error');
      else if (cause && err.status === 403) req.log.warn({ pg: { code: cause.code, message: cause.message, table: cause.table } }, 'database denied access');
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if ((err as FastifyError).statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Terlalu banyak permintaan, coba lagi sebentar', requestId: req.id } });
    if ((err as FastifyError).validation || (err as FastifyError).statusCode === 400 || (err as FastifyError).statusCode === 415)
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: err.message, requestId: req.id } });
    if ((err as FastifyError).statusCode === 413) return reply.code(413).send({ error: { code: 'TOO_LARGE', message: 'Ukuran permintaan terlalu besar', requestId: req.id } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Terjadi kesalahan pada server', requestId: req.id } });
  });
  app.addHook('onSend', async (req, reply) => { reply.header('X-Request-Id', req.id); });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (req, reply) => {
    try { await pool.query('SELECT 1'); return { status: 'ready' }; } catch { return reply.code(503).send({ status: 'database unavailable' }); }
  });

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(platformRoutes);
    await api.register(resourceRoutes);
    await api.register(lookupRoutes);
    await api.register(clinicalRoutes);
    await api.register(pharmacyRoutes);
    await api.register(operationsRoutes);
    await api.register(reportRoutes);
  }, { prefix: '/api/v1' });

  // single deployable: serve the built web app (SPA fallback)
  if (existsSync(config.webDist)) {
    // files are resolved per request (a rebuild needs no restart); hashed assets are immutable,
    // index.html is always revalidated so clients pick up a new release immediately
    await app.register(fastifyStatic, {
      root: config.webDist, wildcard: true, index: false,
      setHeaders: (res, filePath) => {
        res.header('Cache-Control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.get('/', (_req, reply) => { reply.header('Cache-Control', 'no-cache'); return reply.sendFile('index.html'); });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan' } });
      // a missing file (e.g. an old hashed asset) must 404, never fall back to HTML
      if (req.method !== 'GET' || /\.[a-z0-9]{1,8}$/i.test(req.url.split('?')[0])) return reply.code(404).type('text/plain').send('Not found');
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  }
  return app;
}
