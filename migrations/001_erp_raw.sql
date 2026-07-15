-- erp_raw — owned exclusively by erp-sync.
--
-- The main Viju API owns `public`. This worker owns `erp_raw` and nothing else.
-- Everything here is additive and idempotent: it creates a NEW schema and never
-- touches, alters, or reads `public` DDL.
--
-- Applied automatically on boot by RawMigrator.

CREATE SCHEMA IF NOT EXISTS erp_raw;

-- ─────────────────────────────────────────────────────────────────────────────
-- raw_record — verbatim ERP payloads, one row per ERP object.
--
-- Deliberately schemaless (JSONB) rather than typed columns. The ERP's API docs
-- are incomplete, so any typed mirror we wrote today would be wrong tomorrow.
-- Storing the payload as-is means an undocumented field that turns up later is
-- already captured, not silently dropped.
--
-- content_hash is what makes interval polling affordable. The ERP has NO delta
-- support (no modified-date on CUSTOMER / SALES_ORDER_DOC / COLLECTION_DOC), so
-- every cycle is a full sweep. Hashing the payload lets us tell a genuinely
-- changed row from one we've already seen, and skip the write.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_raw.raw_record (
  id            BIGSERIAL PRIMARY KEY,

  object_type   TEXT        NOT NULL,  -- 'CUSTOMER' | 'SALES_ORDER' | 'COLLECTION' | ...
  erp_key       TEXT        NOT NULL,  -- CUSTOMER_CODE / DOC_NO — the ERP's own identifier
  payload       JSONB       NOT NULL,  -- exactly what the ERP returned
  content_hash  TEXT        NOT NULL,  -- sha256 of the canonicalised payload

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- bumped every sweep
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- bumped only when the hash moves

  -- NULL = pulled from the ERP but not yet projected into public.*
  projected_at  TIMESTAMPTZ,
  project_error TEXT,

  CONSTRAINT raw_record_object_key_unique UNIQUE (object_type, erp_key)
);

-- Drives the projection step: "what has the ERP changed that public.* hasn't seen?"
CREATE INDEX IF NOT EXISTS raw_record_pending_projection_idx
  ON erp_raw.raw_record (object_type)
  WHERE projected_at IS NULL;

CREATE INDEX IF NOT EXISTS raw_record_changed_at_idx
  ON erp_raw.raw_record (object_type, changed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- sync_run — one row per job execution. The audit trail for "why is this number
-- wrong" and the basis for failure alerting.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_raw.sync_run (
  id              BIGSERIAL PRIMARY KEY,
  job             TEXT        NOT NULL,
  status          TEXT        NOT NULL,  -- 'RUNNING' | 'SUCCESS' | 'FAILED'

  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,

  rows_fetched    INTEGER     NOT NULL DEFAULT 0,  -- pulled from the ERP
  rows_changed    INTEGER     NOT NULL DEFAULT 0,  -- hash actually moved
  rows_projected  INTEGER     NOT NULL DEFAULT 0,  -- written into public.*
  rows_skipped    INTEGER     NOT NULL DEFAULT 0,  -- unmappable (see error_detail)

  error           TEXT,
  error_detail    JSONB
);

CREATE INDEX IF NOT EXISTS sync_run_job_started_idx
  ON erp_raw.sync_run (job, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- sync_cursor — incremental watermarks, IF the ERP ever supports filtering.
-- Today `conditions` syntax is undocumented and the objects we care about carry
-- no modified-date, so this stays empty and we full-sweep. It exists so that
-- turning deltas on later is a config change, not a migration.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_raw.sync_cursor (
  job          TEXT PRIMARY KEY,
  cursor_value TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- customer_link — resolves the ERP's two different customer identifiers.
--
-- Sales orders and deliveries reference a customer by CUSTOMER_ID (a Guid), but
-- customer.read is keyed on CUSTOMER_CODE (a string) — which is what we store as
-- public.Customer.erpId. Without this mapping an order cannot find its customer.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_raw.customer_link (
  erp_customer_guid TEXT PRIMARY KEY,   -- CUSTOMER_ID
  erp_customer_code TEXT NOT NULL,      -- CUSTOMER_CODE → public.Customer.erpId
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_link_code_idx
  ON erp_raw.customer_link (erp_customer_code);
