-- ─────────────────────────────────────────────────────────────────────────────
-- sweep_seen — the keys observed during one FULL sweep of an object.
--
-- Why this exists: a raw row is keyed on the ERP's own identifier, but for
-- several objects that identifier is not stable. customer_credit is the worst
-- case — the ERP edits EFFECTIVE_DATE in place, and because the key includes it
-- the edited record arrives as a NEW row while the old one stays forever. Five
-- customers ended up with a ghost row showing EFFECTIVE_DATE 0001-01-01 and a
-- zero credit line, long after the ERP had moved them to 2026-09-02.
--
-- No better key exists: CUSTOMER_CREDIT_ID collides, adding EFFECTIVE_DATE still
-- collides, and adding CREDIT_AMT1 makes the key change on every edit. The view
-- is a denormalised join with no line primary key.
--
-- So instead of chasing a perfect key, a full sweep records every key it saw and
-- afterwards deletes the rows it did NOT see. That reconciles both re-keyed
-- records and rows genuinely deleted in the ERP.
--
-- Rows here are transient — written during a sweep, dropped when it finishes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp_raw.sweep_seen (
  sweep_id    TEXT NOT NULL,
  object_type TEXT NOT NULL,
  erp_key     TEXT NOT NULL,
  PRIMARY KEY (sweep_id, erp_key)
);

CREATE INDEX IF NOT EXISTS sweep_seen_object_idx
  ON erp_raw.sweep_seen (object_type, sweep_id);
