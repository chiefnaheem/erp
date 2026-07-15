-- Lease-based lock so only one sync cycle runs at a time, ACROSS replicas.
--
-- The ERP has no delta support, so every cycle is a full sweep of every order and
-- customer. Two overlapping sweeps would double the load on the ERP and race each
-- other's projections. An in-process boolean only guards a single instance — the
-- moment the worker is scaled to two replicas, or restarted while a sweep is in
-- flight, it stops helping.
--
-- A lease (rather than a Postgres advisory lock) is used deliberately: advisory
-- locks are session-scoped, and Prisma's connection pool gives no guarantee that
-- the unlock lands on the same connection that took the lock. A row with an
-- expiry is pool-safe, and self-heals if a worker dies holding it.

CREATE TABLE IF NOT EXISTS erp_raw.sync_lock (
  name         TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL,
  locked_by    TEXT,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
