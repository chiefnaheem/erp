# Prompt — fix the ERP projector so updates reach the app tables

> Paste everything below into an agent working in the **middle / ingest-projector
> server** repository (the service that pulls from the ERP every 30 minutes).
> It does not apply to the Viju backend API repo.

---

## Task

You are working on the ingest service that pulls from the Viju ERP every 30
minutes and writes into the Postgres database that the Viju backend API reads.

**Symptom:** new ERP data appears, but *changes to existing records* never show
up in the app. Distributor names, phone numbers, regions, order statuses and
balances stay frozen at whatever they were when the row was first seen.

**Diagnosis to verify first — do not take it on trust.** The ingest half is
believed healthy: raw rows land in `erp_raw.*` with fresh `changed_at` /
`last_seen_at`. The *projection* half — copying `erp_raw.*` into the
application tables — appears to be insert-only (no `DO UPDATE`), and to be
barely running at all. Evidence from the API side: the feed holds ~1,851
customers while only ~4 have ever been projected into `Customer`.

Run these before changing anything, and report what they return:

```sql
-- 1. Is the projector doing any work at all?
SELECT job, status, finished_at, rows_fetched, rows_projected
  FROM erp_raw.sync_run
 ORDER BY id DESC
 LIMIT 20;

-- 2. How far behind is each entity?
SELECT (SELECT count(DISTINCT payload->>'CUSTOMER_CODE')
          FROM erp_raw.raw_customer)                       AS erp_customers,
       (SELECT count(*) FROM "Customer")                   AS projected_customers,
       (SELECT count(DISTINCT payload->>'DOC_NO')
          FROM erp_raw.raw_sales_order)                    AS erp_orders,
       (SELECT count(*) FROM "Purchase")                   AS projected_orders;

-- 3. Are raw rows actually being refreshed? (rules out an ingest fault)
SELECT max(last_seen_at) AS customers_last_seen FROM erp_raw.raw_customer;
SELECT max(changed_at)   AS credit_last_changed FROM erp_raw.raw_customer_credit;
SELECT max(changed_at)   AS orders_last_changed FROM erp_raw.raw_sales_order;
```

`rows_fetched` high with `rows_projected` at or near zero, plus fresh
`last_seen_at`, confirms it. **If the numbers contradict the diagnosis, stop and
report — do not implement a fix for a problem that is not there.**

---

## What to build

Make every projector an **idempotent upsert** keyed on the ERP natural key, and
make each run's bookkeeping honest.

### 1. Upsert on the ERP key, never insert-only

| Target table | ERP natural key | Source |
|---|---|---|
| `"Customer"` | `"erpId"` ← `payload->>'CUSTOMER_CODE'` | `erp_raw.raw_customer` |
| `"Purchase"` | `"erpId"` ← `payload->>'DOC_NO'` | `erp_raw.raw_sales_order` (one row **per order line** — aggregate by `DOC_NO`) |
| `"Payment"` | `"erpId"` (nullable unique) | payment feed |
| `"Stock"` | `"erpId"` | stock feed |

`id` on every one of these is an application-generated UUID — **never key on
it, never write it on update.** Use `INSERT … ON CONFLICT ("erpId") DO UPDATE`.

`"PurchaseItem"` has **no natural key and no unique constraint**. Do not try to
upsert it: inside the same transaction as its parent, delete the purchase's
items and re-insert them, so a line removed in the ERP disappears here too.

### 2. Only overwrite ERP-owned columns

This is the part a naive `DO UPDATE SET` gets wrong and it will cause data loss.
The application owns some columns on `"Customer"` and the ERP must never
clobber them:

| Column | Owner | On update |
|---|---|---|
| `name`, `phone`, `region` | **ERP** | overwrite |
| `outstandingBalance` | **ERP** (derived — see §4) | overwrite |
| `erpId` | **ERP** | it is the key; never changes |
| `email` | app (customer sets it) | **leave alone** |
| `password`, `failedLoginAttempts`, `lockedUntil` | app (auth) | **leave alone** |
| `profilePhotoUrl` | app | **leave alone** |
| `accountStatus` | app (an admin sets `ON_HOLD`) | **leave alone** |
| `assignedOfficerId` | app (admin assigns/reassigns officers) | **leave alone** |
| `createdAt` | app | **leave alone** |

So the customer upsert's update clause touches `name`, `phone`, `region`,
`outstandingBalance`, `updatedAt` — and nothing else.

**`"Staff"` is entirely off limits.** Admin, regional admin, account officer and
loading officer accounts are internally managed by the backend; the ERP must
never create a staff row, nor write `role`, `region` or `isActive`.

### 3. Drive each run from a `changed_at` watermark

Do not re-project the whole feed every 30 minutes, and do not skip rows that
already exist. Per job, keep the high-water mark of the last successfully
projected `changed_at` / `last_seen_at`, and select only rows newer than it:

```sql
WHERE r.changed_at > $watermark
```

Advance the watermark **only** on a committed, successful run. Design the whole
pass so re-running it is harmless — an upsert plus a watermark gives you that
for free, and it means a crashed run costs nothing but a repeat.

Keep a way to force a full re-projection (ignore the watermark), because the
first run after this fix must backfill ~1,847 customers that were never
projected.

### 4. Two field mappings that are currently wrong

**`Customer.region`** — the ERP sends a numeric `BP_CLUSTER_CODE`. Map it:

```
1 → LAGOS    2 → EASTERN    3 → SOUTH_SOUTH    4 → WESTERN    5 → NORTH
```

Any other value (other-tenant codes, blank) is **not a Viju distributor**:
quarantine the row and do not project it. Never guess a region, never default
to LAGOS — `region` is not nullable and half the portal filters on it.

**`Customer.outstandingBalance`** — the current projector copies the ERP's raw
`CREDIT_PAY` straight into this column. `CREDIT_PAY` is credit *consumed*,
signed the other way, so this inverts the balance for every customer holding
credit (~80% of the feed). Compute it instead:

```
Running Balance = CREDIT_AMT + CREDIT_AMT1 − CREDIT_PAY
```

from the newest credit record per customer in `erp_raw.raw_customer_credit`
(`ORDER BY EFFECTIVE_DATE DESC NULLS LAST, id DESC`), treating missing/blank
terms as `0`. Do the arithmetic in `numeric`, not float, and **do not round** —
the ERP carries up to 4 dp and every one of them must survive
(`33403031.4733`, not `33403031.47`). The sign that falls out is the one the
portal assumes: **positive = funds available, negative = overdrawn**.

A customer with no credit record in the feed must be **left as-is**, never
zeroed.

**`Purchase.status`** — the current projector writes a constant `PROCESSING`.
Either derive it properly from the sales-order feed (aggregate per `DOC_NO`:
any line with `ApproveStatus <> 'Y'` → `PENDING`; every line with `CLOSE = '2'`
→ `CLOSED`; `sum(DELIVERED_BUSINESS_QTY) >= sum(BUSINESS_QTY) > 0` →
`DELIVERED`; otherwise `PROCESSING`) **or** leave `status` out of the update
clause entirely and let the backend's own reconciler own that column. Do not
keep writing a constant.

### 5. Make `sync_run` tell the truth

`erp_raw.sync_run` is the only window anyone has into this service. Per job,
per run, record `rows_fetched`, `rows_projected`, `status` and `finished_at`
honestly:

* a run that fetched rows and projected none is **not** `SUCCESS`;
* fail the run loudly on a projection error rather than swallowing it and
  writing `SUCCESS`;
* add a guard — if `rows_fetched > 0 AND rows_projected = 0`, mark the run
  failed and alert. That single check would have surfaced this months ago.

### 6. Ordering and concurrency

* Project **customers before purchases and payments** — those carry a
  `customerId` foreign key and will fail against a customer that is not there
  yet. Skip-and-retry the child row rather than aborting the whole run.
* Wrap each job in one transaction, and take a Postgres **advisory lock** per
  job so two instances (or an overlapping schedule) cannot project concurrently.
* Use a generous statement timeout: the first backfill run touches the whole
  customer set.

### 7. Watch for these when writing the upserts

* **`Customer.phone` is `UNIQUE`.** Two ERP customers with the same phone will
  make the upsert fail with a constraint violation on a *different* row than
  the one you are conflict-targeting. Detect it, quarantine the offender, log
  the pair — do not let one bad row abort the whole batch.
* **`Payment.erpId` is nullable and unique.** `ON CONFLICT` does not fire for
  NULLs, so rows with no `erpId` will duplicate on every run. Either require it
  or dedupe on `(customerId, date, amount, reference)`.
* `EFFECTIVE_DATE` and other ERP dates are text in the payload — cast
  explicitly and decide the timezone rather than relying on the server's.
* `updatedAt` should be stamped with the ERP row's own `changed_at` where you
  have it, not `now()` — the app surfaces that column as "last updated" and it
  should say when the *record* moved, not when you last looked.

### 8. Tell the backend when you are done

After a successful run, call these on the Viju backend (server-to-server,
header `x-api-key: <ERP_API_KEY>`, no body, safe to call repeatedly):

```
POST /api/v1/erp/sync/account-balance   # re-derives balances from the credit feed
POST /api/v1/erp/sync/order-status      # re-derives Purchase.status from the order feed
```

These exist because the projector was unreliable; they are cheap insurance and
should stay wired up even after this fix lands.

---

## Acceptance criteria

1. Change a distributor's name, phone or region in the ERP → within one cycle
   the change is visible in `"Customer"`, with `email`, `accountStatus`,
   `assignedOfficerId`, `profilePhotoUrl` and `password` untouched.
2. `SELECT count(*) FROM "Customer"` reaches parity with the distinct
   `CUSTOMER_CODE` count in `erp_raw.raw_customer` for codes 1–5 (~1,851), after
   one forced full re-projection.
3. Running the projector twice in a row over the same window changes nothing
   the second time — no duplicate `Purchase`, `Payment` or `PurchaseItem` rows.
4. A customer holding credit reads **positive** `outstandingBalance`, matching
   `CREDIT_AMT + CREDIT_AMT1 − CREDIT_PAY` to full precision.
5. A row whose `BP_CLUSTER_CODE` is not 1–5 is quarantined and reported, never
   projected.
6. A run that fetches rows and projects none is recorded as **failed** and
   alerts.
7. Killing the process mid-run leaves the database consistent and the next run
   completes the work.

## Out of scope

Do not change the Viju backend API repo — this is entirely an ingest-side fix.
Do not add columns to the application tables. Do not delete application rows
because they are absent from one ERP page; the feed is paged and a missing row
means "not in this batch", not "deleted".

## Deliverables

The projector changes, a migration for the watermark/quarantine tables if you
add them, the `rows_fetched > 0 AND rows_projected = 0` alert, and a short note
of the before/after counts from the verification queries above.
