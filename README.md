# PCMS — Plantation Clinic Management System

Enterprise multi-tenant clinic & occupational-health platform for palm-oil plantation groups
(Group → PT → Region → Estate/Mill → Division → Clinic).

**Status:** all 12 phases implemented and tested — 43 database security tests + 46 API integration tests,
role-by-role smoke crawl and browser checks. Full blueprint, design decisions, test evidence and known
limitations (in Bahasa Indonesia): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

| | |
|---|---|
| Database | PostgreSQL 16 — row-level security forced on every tenant table, signed request context, audit trail, workflow guards, analytics with small-cell suppression |
| API | Fastify 5 + TypeScript, runs as the RLS-restricted role `pcms_app`; JWT + rotating refresh tokens, TOTP MFA, field encryption |
| Web | React 18 + Vite SPA served by the API (one deployable) |

## Try it in the browser (no installation)

Open this repository in **GitHub Codespaces**: green **Code** button → **Codespaces** → **Create codespace on main**.
The first start takes about 3–5 minutes (install, database, demo data). PCMS then opens in a new browser tab;
if it doesn't, open the **Ports** tab and click the globe icon next to port **8080**.
Log in as `sng.superadmin` / `Demo@12345`. Stop the codespace when you're done (free accounts include monthly hours).

## Quick start

Requirements: PostgreSQL 16 (with contrib extensions — included in Homebrew `postgresql@16`, Postgres.app and the official packages) and Node.js ≥ 20.

macOS: `brew install postgresql@16 node && brew services start postgresql@16`. If the folder came from a downloaded zip and macOS
reports *Operation not permitted*, clear the quarantine flag once: `xattr -dr com.apple.quarantine /path/to/pcms`.

```bash
npm install           # installs all workspaces (vite, tsx, pg …) — run this first

cp packages/db/.env.example packages/db/.env     # PostgreSQL admin URL + role passwords
cp apps/api/.env.example    apps/api/.env        # DATABASE_URL / DATABASE_OWNER_URL must match the passwords above
#   JWT_SECRET=$(openssl rand -base64 48)
#   FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)   ← set before seeding

npm run db:reset      # create roles + database, run 18 migrations, load demo data (~25 s)
npm run build         # build the web app into apps/web/dist
npm start             # API + web on http://localhost:8080
```

Development with hot reload: `npm run dev:api` and `npm run dev:web` (Vite on :5173, proxies `/api` to :8080).

Tests (against the demo database): `npm test` — runs `db:test` (43) and `test:api` (46).
Type checks: `npm run typecheck`.

## Demo users

Password for all 182 demo users: `Demo@12345`

| User | Role | Lands on |
|---|---|---|
| `sng.corporate` | Corporate management | Group dashboard, finance, reports |
| `sng.meddirector` | Medical Director | Health intelligence, alerts, MCU, break-glass review |
| `sng.estate.snl-e01` | Estate manager (Kebun Sei Rokan) | Estate dashboard, accident approvals |
| `sng.dr.snl-e01-kln` | Doctor + clinic manager | Queue, EMR, lab, approvals |
| `sng.nurse1.snl-e01-kln` | Nurse | Registration & triage |
| `sng.apt.snl-e01-kln` | Pharmacist | Prescriptions, stock, transfers |
| `sng.hrmanager.snl` | HR manager | Employees, sick-leave letters (no diagnoses) |
| `sng.hseofficer.snl-e01` | HSE officer | Accidents & investigations |
| `sng.employee` | Employee | Self-service portal, QR card, appointments |
| `sng.superadmin` / `aag.superadmin` | Super admin of each group | Users, roles, audit — and proof that groups never see each other |

## Repository layout

```
docs/ARCHITECTURE.md   blueprint, decisions, test evidence, production notes (Bahasa Indonesia)
packages/db/           schema, RLS policies, roles, migrations 0001–0018, seed, DB tests
apps/api/              Fastify API (src/core, src/modules, src/jobs) + API tests
apps/web/              React SPA (src/lib, src/components, src/pages)
```

## Before production

Replace every demo credential; keep `JWT_SECRET` and `FIELD_ENCRYPTION_KEY` in a secret manager (the API refuses to
start in production without strong values); put the API behind TLS; enable PITR backups; run jobs on one instance only
(`JOBS_ENABLED`). See *Catatan produksi & batasan* in the architecture document for known gaps.
