-- Remove erp_raw.*.deferred_until.
--
-- A build earlier on 2026-09-16 added that column to bound the purchase
-- projection: the job re-read every row with projected_at IS NULL, and 1.94M of
-- the 1.99M sales-order rows are permanently in that state (their distributor
-- has not onboarded, so they are left queued on purpose rather than quarantined).
-- The column was to carry a "do not read this again until" stamp.
--
-- It was the wrong instrument HERE, for a reason specific to this data: a raw row
-- is a ~1.5KB JSONB payload, and Postgres rewrites the whole row to change one
-- field. Stamping the backlog would have written ~3GB of new tuples — on the
-- server whose disk had just run out, which is the very problem it was meant to
-- relieve. Measured on the one run that got through: 212,851 rows stamped.
--
-- Forward progress now comes from a scan cursor (erp_raw.sync_cursor, key
-- "scan:project:purchase"): each run reads the next slice by id and records where
-- it stopped, wrapping to the start when it reaches the end. One row written per
-- run instead of hundreds of thousands, and the same guarantee — no run collides
-- with the slice the previous one just read.
--
-- IF EXISTS, so this is a no-op on a database that never had the column, and
-- dropping a column is a catalogue update: it costs no disk and no table rewrite.

ALTER TABLE erp_raw.raw_customer          DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_customer_credit   DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_sales_order       DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_sales_delivery    DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_sales_return      DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_collection        DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_ar_refund         DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_other_receivable  DROP COLUMN IF EXISTS deferred_until;
ALTER TABLE erp_raw.raw_ar_transfer       DROP COLUMN IF EXISTS deferred_until;
