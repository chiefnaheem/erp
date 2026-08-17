-- CUSTOMER_CREDIT_LINE — the 9th object in the ERP API index
-- (yvijucrm.customer_credit_line.query / .read), which was never ingested.
--
-- It carries AR_AMT (accounts-receivable amount) per customer/company/currency,
-- a more direct source for a customer's outstanding balance than the CREDIT_PAY
-- ("used credit") figure on CUSTOMER_CREDIT that we currently use. Ingesting it
-- lets the two be compared against real data before anything is re-pointed.
--
-- Same structure and change-detection semantics as the other per-object tables
-- in 003. All statements are CREATE ... IF NOT EXISTS, so re-running is a no-op.

CREATE TABLE IF NOT EXISTS erp_raw.raw_customer_credit_line (
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
  CONSTRAINT raw_customer_credit_line_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_customer_credit_line_pending_idx ON erp_raw.raw_customer_credit_line (object_type) WHERE projected_at IS NULL;
