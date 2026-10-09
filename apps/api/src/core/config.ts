import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// minimal .env loader; real environment variables always win
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing environment variable ${k}`);
  return v;
};

export const config = {
  root,
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL'),
  ownerUrl: process.env.DATABASE_OWNER_URL,
  jwtSecret: env('JWT_SECRET'),
  fieldKey: process.env.FIELD_ENCRYPTION_KEY || '',
  accessTtl: env('ACCESS_TOKEN_TTL', '15m'),
  refreshDays: Number(env('REFRESH_TOKEN_DAYS', '7')),
  idleMinutes: Number(env('SESSION_IDLE_MINUTES', '30')),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(',').map(s => s.trim()),
  storageDir: path.resolve(root, env('STORAGE_DIR', './storage')),
  webDist: process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : path.resolve(root, '../web/dist'),
  jobsEnabled: env('JOBS_ENABLED', 'true') === 'true',
  alertIntervalMin: Number(env('ALERT_ENGINE_INTERVAL_MINUTES', '15')),
  maxUploadMb: 25,
};

if (config.env === 'production') {
  if (config.jwtSecret.length < 32 || config.jwtSecret.startsWith('dev-') || config.jwtSecret.startsWith('change-me'))
    throw new Error('JWT_SECRET must be a strong secret in production');
  if (Buffer.from(config.fieldKey, 'base64').length !== 32) throw new Error('FIELD_ENCRYPTION_KEY (32 bytes, base64) is required in production');
  if (/pcms_owner/.test(config.databaseUrl)) throw new Error('DATABASE_URL must use the RLS-restricted pcms_app role');
}
