-- customer_phone — a contact number for customers whose ERP master has none.
--
-- ─── Why this exists ────────────────────────────────────────────────────────
--
-- yvijucrm.customer.query carries exactly one phone field, PhoneNumber (手机号码),
-- and on 2026-09-21 it was EMPTY for 3,825 of the 3,827 customers. That was
-- checked at source, not inferred from our copy: a live 200-customer sample off
-- the ERP came back with one number in it. The customer master simply has not
-- been populated.
--
-- The numbers that do exist sit on documents instead — sales_delivery and
-- sales_return both carry TELEPHONE (收货电话), the number the goods were
-- delivered against. That is a real, dialable contact for that customer, and for
-- the app it is the difference between a distributor who can be sent an OTP and
-- one who cannot log in at all.
--
-- So the ingest records those numbers here as the documents stream past, and the
-- customer projection falls back to this table when the master field is blank.
-- Maintained exactly like customer_link (001): a small side table written from
-- afterPage(), so the projection joins something tiny instead of scanning a
-- 1.24-million-row delivery table every three minutes.
--
-- This is a WORKAROUND for missing ERP data, not a replacement for it. The
-- master field remains the preferred source and always wins when it is filled
-- in — which is the real fix, and one only the ERP team can make.

CREATE TABLE IF NOT EXISTS erp_raw.customer_phone (
  erp_customer_code TEXT PRIMARY KEY,
  phone             TEXT        NOT NULL,
  -- Which document the number came off, so a wrong number can be traced back.
  source            TEXT        NOT NULL,
  -- The document's own date. Newest wins: a customer's contact number changes,
  -- and a 2016 delivery should never overwrite what a 2026 one says.
  doc_date          TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
