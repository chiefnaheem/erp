-- AR_TRANSFER_DOC (应收转销单) — added 2026-09-15 from api_docs/ar_transfer_doc.*.md
--
-- Same structure and change-detection semantics as every other per-object raw
-- table (see 003). Header-only: the ERP returns no subtable for this object, so
-- DOC_NO is unique across the feed (verified: 4,440 rows, 4,440 distinct DOC_NO)
-- and is what the raw rows are keyed on.
CREATE TABLE IF NOT EXISTS erp_raw.raw_ar_transfer (
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
  CONSTRAINT raw_ar_transfer_key_unique UNIQUE (object_type, erp_key)
);
CREATE INDEX IF NOT EXISTS raw_ar_transfer_pending_idx
  ON erp_raw.raw_ar_transfer (object_type) WHERE projected_at IS NULL;
