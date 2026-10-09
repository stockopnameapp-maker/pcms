-- =============================================================================
-- PCMS bootstrap — run ONCE as a PostgreSQL superuser (or cloud admin role).
-- Creates the two database roles and the database. Passwords come from psql
-- variables so they are never committed:
--   psql -v owner_pw='...' -v app_pw='...' -f bootstrap.sql
-- =============================================================================

-- pcms_owner : owns every object, runs migrations & seeding. BYPASSRLS so that
--              maintenance jobs (migrations, partition upkeep) are not blocked.
--              NEVER used by the running API.
-- pcms_app   : the only role the API connects with. NOBYPASSRLS + not owner,
--              so Row-Level Security is always enforced on it.
SELECT format('CREATE ROLE pcms_owner LOGIN BYPASSRLS PASSWORD %L', :'owner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcms_owner') \gexec
SELECT format('CREATE ROLE pcms_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcms_app') \gexec

SELECT 'CREATE DATABASE ' || :'dbname' || ' OWNER pcms_owner ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname') \gexec

\connect :dbname
REVOKE ALL ON DATABASE :dbname FROM PUBLIC;
GRANT CONNECT ON DATABASE :dbname TO pcms_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO pcms_owner;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
