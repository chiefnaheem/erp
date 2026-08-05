-- The projection generates primary keys with gen_random_uuid(), which on this
-- Postgres build is provided by the pgcrypto extension (the server predates the
-- built-in gen_random_uuid()). Ensure it's present so projections can insert.
--
-- NOTE: earlier projections used md5(...)::uuid as a fallback, which produced
-- values shaped like UUIDs but with an invalid version/variant — rejected by the
-- app's @IsUUID() validator. Those rows were backfilled to valid v4 UUIDs, and
-- this makes the proper generator available going forward.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
