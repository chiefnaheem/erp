-- Per-object raw tables: each ERP endpoint's responses are dumped into its own
-- table, instead of sharing the single erp_raw.raw_record. Same structure and
-- change-detection semantics as raw_record (001), one table per object.
--
-- raw_record (001) is left in place but no longer written to; it can be dropped
-- once nothing references the old data.
--
-- All statements are CREATE ... IF NOT EXISTS, so re-running is a no-op.

-- CUSTOMER
CREATE TABLE IF NOT EXISTS erp_raw.raw_customer (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_customer_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_customer_pending_idx ON erp_raw.raw_customer (object_type) WHERE projected_at IS NULL;

-- CUSTOMER_CREDIT
CREATE TABLE IF NOT EXISTS erp_raw.raw_customer_credit (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_customer_credit_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_customer_credit_pending_idx ON erp_raw.raw_customer_credit (object_type) WHERE projected_at IS NULL;

-- SALES_ORDER
CREATE TABLE IF NOT EXISTS erp_raw.raw_sales_order (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_sales_order_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_sales_order_pending_idx ON erp_raw.raw_sales_order (object_type) WHERE projected_at IS NULL;

-- SALES_DELIVERY
CREATE TABLE IF NOT EXISTS erp_raw.raw_sales_delivery (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_sales_delivery_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_sales_delivery_pending_idx ON erp_raw.raw_sales_delivery (object_type) WHERE projected_at IS NULL;

-- SALES_RETURN
CREATE TABLE IF NOT EXISTS erp_raw.raw_sales_return (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_sales_return_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_sales_return_pending_idx ON erp_raw.raw_sales_return (object_type) WHERE projected_at IS NULL;

-- COLLECTION
CREATE TABLE IF NOT EXISTS erp_raw.raw_collection (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_collection_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_collection_pending_idx ON erp_raw.raw_collection (object_type) WHERE projected_at IS NULL;

-- AR_REFUND
CREATE TABLE IF NOT EXISTS erp_raw.raw_ar_refund (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_ar_refund_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_ar_refund_pending_idx ON erp_raw.raw_ar_refund (object_type) WHERE projected_at IS NULL;

-- OTHER_RECEIVABLE
CREATE TABLE IF NOT EXISTS erp_raw.raw_other_receivable (
  id            BIGSERIAL PRIMARY KEY,
  object_type   TEXT        NOT NULL,
  erp_key       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at  TIMESTAMPTZ,
  project_error TEXT,
  CONSTRAINT raw_other_receivable_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_other_receivable_pending_idx ON erp_raw.raw_other_receivable (object_type) WHERE projected_at IS NULL;
