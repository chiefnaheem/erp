-- Indexes to keep projection fast at scale.
--
-- The active-customer projection joins the raw tables to public."Customer" on a
-- value extracted from the JSON payload. Without a functional index that join is
-- a sequential scan of hundreds of thousands of rows every projection tick.
--
-- The partial (id) WHERE projected_at IS NULL index supports cursor draining
-- (WHERE projected_at IS NULL AND id > $cursor ORDER BY id) and shrinks as rows
-- get projected.
--
-- All CREATE ... IF NOT EXISTS, so re-running is a no-op.

-- Sales orders join to the customer via CUSTOMER_ID (a Guid) in the payload.
CREATE INDEX IF NOT EXISTS raw_sales_order_customer_id_idx
  ON erp_raw.raw_sales_order ((payload->>'CUSTOMER_ID'));

-- Collections join to the customer via CUSTOMER_CODE in the payload.
CREATE INDEX IF NOT EXISTS raw_collection_customer_code_idx
  ON erp_raw.raw_collection ((payload->>'CUSTOMER_CODE'));

-- Cursor draining: pending rows ordered by id.
CREATE INDEX IF NOT EXISTS raw_customer_pending_id_idx
  ON erp_raw.raw_customer (id) WHERE projected_at IS NULL;
CREATE INDEX IF NOT EXISTS raw_sales_order_pending_id_idx
  ON erp_raw.raw_sales_order (id) WHERE projected_at IS NULL;
CREATE INDEX IF NOT EXISTS raw_collection_pending_id_idx
  ON erp_raw.raw_collection (id) WHERE projected_at IS NULL;
