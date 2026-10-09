# Palmora Health

*People Health Our Priority* — the clinic & occupational-health platform formerly developed as PCMS (Plantation Clinic Management System).

An enterprise multi-tenant clinic & occupational-health platform for palm-oil plantation groups
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

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/stockopnameapp-maker/pcms?quickstart=1)

Open this repository in **GitHub Codespaces**: green **Code** button → **Codespaces** → **Create codespace on main**.
The first start takes about 3–5 minutes (install, database, demo data). A terminal then shows
**"Palmora Health siap. Buka: https://…app.github.dev"** — click that link (or open the **Ports** tab → globe icon next to port **8080**).
If nothing appears, open a terminal (Ctrl+`) and run `bash .devcontainer/start.sh`.
Log in as `kas.superadmin` / `Demo@12345`. Stop the codespace when you're done (free accounts include monthly hours).

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

npm run db:reset      # create roles + database, run 19 migrations, load demo data (~25 s)
npm run build         # build the web app into apps/web/dist
npm start             # API + web on http://localhost:8080
```

The Mac app (`Palmora-Health-<version>.dmg`) is built from `packaging/macos/`.
Internal identifiers keep the original `pcms` name (npm workspaces `@pcms/*`, database `pcms`, roles `pcms_owner`/`pcms_app`, `PCMS_*` env vars, QR code prefixes) so existing installs and data keep working.

Development with hot reload: `npm run dev:api` and `npm run dev:web` (Vite on :5173, proxies `/api` to :8080).

Tests (against the demo database): `npm test` — runs `db:test` (43) and `test:api` (46).
Type checks: `npm run typecheck`.

## Demo users

Demo organisation: **Kalimantan Agro Sukses Group** → PT Borneo Citra Persada Jaya (BCPJ) and PT Borneo Citra Persada Abadi (BCPA), each with
Klinik Central (also serving the PKS) and Klinik Rayon A–F. Password for all 178 demo users: `Demo@12345`

| User | Role | Lands on |
|---|---|---|
| `kas.corporate` | Corporate management | Group dashboard, finance, reports |
| `kas.meddirector` | Medical Director | Health intelligence, alerts, MCU, break-glass review |
| `kas.estate.bcpj-ra` | Estate manager (Rayon A, PT BCPJ) | Estate dashboard, accident approvals |
| `kas.dr.bcpj-ra-kln` | Doctor + clinic manager, Klinik Rayon A | Queue, EMR, lab, approvals |
| `kas.dr.bcpj-central` | Doctor + clinic manager, Klinik Central | Same, for the PKS and head office |
| `kas.nurse1.bcpj-ra-kln` | Nurse | Registration & triage |
| `kas.apt.bcpj-ra-kln` | Pharmacist | Prescriptions, stock, transfers |
| `kas.hrmanager.bcpj` | HR manager | Employees, sick-leave letters (no diagnoses) |
| `kas.hseofficer.bcpj-ra` | HSE officer | Accidents & investigations |
| `kas.employee` | Employee | Self-service portal, QR card, appointments |
| `kas.superadmin` | Super admin | Users, roles, organisation structure, audit |

Tenant isolation is still tested against a second Group that the test runner creates temporarily and removes afterwards.

## Repository layout

```
docs/ARCHITECTURE.md   blueprint, decisions, test evidence, production notes (Bahasa Indonesia)
packages/db/           schema, RLS policies, roles, migrations 0001–0019, seed, DB tests
apps/api/              Fastify API (src/core, src/modules, src/jobs) + API tests
apps/web/              React SPA (src/lib, src/components, src/pages)
```

## Before production

Replace every demo credential; keep `JWT_SECRET` and `FIELD_ENCRYPTION_KEY` in a secret manager (the API refuses to
start in production without strong values); put the API behind TLS; enable PITR backups; run jobs on one instance only
(`JOBS_ENABLED`). See *Catatan produksi & batasan* in the architecture document for known gaps.
