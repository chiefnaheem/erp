-- Projection bookkeeping: watermarks + quarantine.
--
-- Until now the projection step had no memory of its own. It relied entirely on
-- raw_*.projected_at, which the ingest resets whenever a payload hash moves — so
-- a row that could never be projected (unmappable region, duplicate phone) was
-- retried forever with no record of WHY, and a row that had already been seen
-- could not be re-scanned on demand.
--
-- Two tables close that gap:
--
--   projection_watermark  the high-water mark of changed_at per projection job.
--                         Advanced ONLY when a run commits. Deleting a job's row
--                         is how you force a full re-projection.
--
--   projection_quarantine every row the projector deliberately refused, with the
--                         reason. This is the answer to "why is this distributor
--                         missing from the portal?" — previously unanswerable.
--
-- Everything here is additive, lives in erp_raw, and is CREATE ... IF NOT EXISTS
-- so re-running the file is a no-op.

CREATE TABLE IF NOT EXISTS erp_raw.projection_watermark (
  job            TEXT PRIMARY KEY,
  watermark      TIMESTAMPTZ NOT NULL,
  rows_projected BIGINT      NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (job, ERP key). last_seen_at is bumped every time the row is
-- refused again, so a stale quarantine entry is obvious from its timestamp.
CREATE TABLE IF NOT EXISTS erp_raw.projection_quarantine (
  id            BIGSERIAL PRIMARY KEY,
  job           TEXT        NOT NULL,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  reason        TEXT        NOT NULL,
  detail        TEXT,
  payload       JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  CONSTRAINT projection_quarantine_key_unique UNIQUE (job, erp_key)
);

CREATE INDEX IF NOT EXISTS projection_quarantine_open_idx
  ON erp_raw.projection_quarantine (job, reason)
  WHERE resolved_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes the watermark scan needs.
--
-- "WHERE changed_at > $watermark" over 365k sales-order lines is a sequential
-- scan without these, every projection tick.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS raw_customer_changed_at_idx
  ON erp_raw.raw_customer (changed_at);
CREATE INDEX IF NOT EXISTS raw_customer_credit_changed_at_idx
  ON erp_raw.raw_customer_credit (changed_at);
CREATE INDEX IF NOT EXISTS raw_sales_order_changed_at_idx
  ON erp_raw.raw_sales_order (changed_at);
CREATE INDEX IF NOT EXISTS raw_collection_changed_at_idx
  ON erp_raw.raw_collection (changed_at);

-- A sales order is N rows sharing one DOC_NO. Once the watermark has picked out
-- the changed LINES, the projector must re-read every OTHER line of the same
-- order to aggregate its status and quantities — that lookup is by DOC_NO.
CREATE INDEX IF NOT EXISTS raw_sales_order_doc_no_idx
  ON erp_raw.raw_sales_order ((payload->>'DOC_NO'));

-- Customer projection filters on the tenant cluster and joins the credit feed
-- on CUSTOMER_CODE.
CREATE INDEX IF NOT EXISTS raw_customer_cluster_idx
  ON erp_raw.raw_customer ((payload->>'BP_CLUSTER_CODE'));
CREATE INDEX IF NOT EXISTS raw_customer_credit_customer_code_idx
  ON erp_raw.raw_customer_credit ((payload->>'CUSTOMER_CODE'));
