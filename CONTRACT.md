# Phase 0 — ERP contract mapping & gap analysis

ERP: **YVIJUCRM**, a Digiwin **E10** external REST API (`digi-data-exchange-protocol 1.0`).

This document maps every ERP method onto the data the Viju app needs, and records
what the ERP **cannot** currently supply.

> **Revised against the current API docs (`api_docs/`, 2026-08-17.)** Three of the
> five gaps below have since CLOSED: the customer object now carries `PhoneNumber`
> and `Region`, collections now carry `CUSTOMER_CODE`, and sales orders now return
> their detail lines. The sections below record both the original finding and what
> replaced it, because the reasoning behind the design decisions they forced (see
> §1) still applies.

---

## Verdict at a glance

| Our entity | ERP source | Status |
|---|---|---|
| **Customer** | `yvijucrm.customer.query` | ✅ **Unblocked** — `PhoneNumber` + `Region` now returned |
| **Stock** | *(none)* | ⛔ **Blocked** — no product/inventory endpoint exists |
| **Purchase** (header) | `yvijucrm.sales_order_doc.query` | ⚠️ Mappable, with caveats |
| **PurchaseItem** (lines) | `yvijucrm.sales_order_doc.query` | ⛔ **Blocked** — no per-line amount in the feed (§1b) |
| **Payment** | `yvijucrm.collection_doc.query` | ✅ **Unblocked** — `CUSTOMER_CODE` now returned |

Stock remains the one hard blocker with no ERP source at all.

---

## 1. Customer — ✅ unblocked

`yvijucrm.customer.query` returns:
`CUSTOMER_ID`, `CUSTOMER_CODE`, `CUSTOMER_NAME`, `CUSTOMER_FULL_NAME`,
`GENERAL_CURRENCY_ID`, `Owner_Dept`, `Owner_Emp`, `PhoneNumber`, `Region`,
`BP_CLUSTER_CODE`, `BP_CLUSTER_NAME`.

| Our field | ERP source | Status |
|---|---|---|
| `erpId` | `CUSTOMER_CODE` | ✅ |
| `name` | `CUSTOMER_FULL_NAME` | ✅ |
| `phone` | `PhoneNumber` | ✅ (was the blocker) |
| `email` | — | ⚠️ absent (nullable, tolerable) |
| `region` | `BP_CLUSTER_CODE` | ✅ resolved 2026-08-23 — **not** `Region`, see §1a |
| `accountStatus` | — | ⚠️ absent (app-owned; sync never writes it) |
| `outstandingBalance` | `customer_credit` | ✅ resolved 2026-08-23 — computed, see §1a |

**What this originally blocked, and why it still matters.** `phone` is the
**login identifier** (phone + OTP auth). While it was absent the sync could not
create customers at all, which forced the design now in the code: customers are
onboarded *in the app*, then linked to the ERP by `CUSTOMER_CODE`, and the sync
only *updates* ERP-owned fields on customers that already exist. Now that
`PhoneNumber` is supplied, ERP-driven creation is possible — but it is still
gated behind `ERP_CUSTOMER_PHONE_FIELD` being resolvable and a region mapping,
and switching to create-on-sync is a decision that needs sign-off rather than a
silent change. `Region` values are Chinese/empty in practice, hence
`ERP_REGION_MAP` and the `ERP_REGION_DEFAULT` fallback.

**`outstandingBalance`:** still not on the customer object. Two candidates now
exist and they identify the customer differently — `customer_credit.CREDIT_PAY`
("used credit", joined by `CUSTOMER_CODE`) and
`customer_credit_line.AR_AMT` ("accounts receivable", joined by the `CUSTOMER_ID`
Guid). Both are ingested so they can be compared on real data; neither is wired
to a projection. `CUSTOMER_CREDIT` may return **multiple rows per customer** (one
per credit area / currency), so which row wins is still undefined. Note also that
`SALES_RETURN`, `AR_REFUND_DOC` and `OTHER_RECEIVABLE_DOC` all move a customer's
balance — if we compute rather than read the balance, all of them must be
accounted for.

---

## 1a. Customer — measured against the live feed (2026-08-23)

Three of the questions above were answered by querying `erp_raw` directly rather
than by re-reading the docs. All three are now implemented in
`ProjectionRepository`.

**`region` comes from `BP_CLUSTER_CODE`, not `Region`.** The documented `Region`
field is blank on essentially every row, which is why the old design needed
`ERP_REGION_MAP` and an `ERP_REGION_DEFAULT` fallback. The real key is the
numeric cluster code:

| `BP_CLUSTER_CODE` | Region | Customers |
|---|---|---|
| `1` | `LAGOS` | 734 |
| `2` | `EASTERN` | 82 |
| `3` | `SOUTH_SOUTH` | 133 |
| `4` | `WESTERN` | 439 |
| `5` | `NORTH` | 463 |

`BP_CLUSTER_CODE` is also the **tenant discriminator**. The same ERP instance
serves other companies: `GZ020` alone accounts for 1,832 of the 3,747 customers
in the feed, plus `GZ001` (6) and `9` (58). Those are not Viju distributors and
are quarantined, never projected and never given a default region —
`Customer.region` is `NOT NULL` and much of the portal filters on it, so a
guessed region is a wrong answer that spreads. **1,851 of the 3,747 customers in
the feed are Viju's.**

⚠️ The `Region` enum in the live database is `LAGOS, EASTERN, SOUTH_SOUTH,
WESTERN, NORTH`. `prisma/schema/region.prisma` in this repo is a **stale mirror**
and still lists the retired `SOUTH_WEST` / `SOUTH_EAST`; its `OrderStatus` is
missing `LOADED` / `DISPATCHED` / `CLOSED`, and `PurchaseItem.itemCode` is
absent. Refresh it with `npm run schema:pull` from the main repo. The projection
casts enum labels in SQL (`::"Region"`) precisely so the database, not a stale
generated client, is the source of truth.

**`outstandingBalance` is computed, and `CREDIT_PAY` alone had the sign
backwards.**

```
Running Balance = CREDIT_AMT + CREDIT_AMT1 − CREDIT_PAY
```

taken from the newest credit record per customer (`ORDER BY EFFECTIVE_DATE DESC
NULLS LAST, id DESC`), in `numeric` and unrounded — the ERP carries up to 4 dp
and all of them must survive. `CREDIT_PAY` is credit *consumed*, so copying it
straight across (which the old projector did) inverted the balance for every
customer holding credit. Positive now means **funds available**, which is what
the portal assumes. Confirmed against the four onboarded customers: e.g.
`10110017` read `-33401031.14` and is now `33403031.4733`.

In practice `CUSTOMER_CREDIT` returns exactly **one row per customer** (1,831
rows, 1,831 distinct `CUSTOMER_CODE`), so the "which row wins" question is
currently moot — but the `DISTINCT ON` ordering above settles it if that changes.
A customer with no credit record is **left as-is, never zeroed**.

**⛔ `phone` is the binding constraint on customer coverage, and it is a data
problem.** `Customer.phone` is `UNIQUE` and is the login identifier. The feed
carries only **8 distinct phone numbers for the 1,851 Viju distributors** —
1,844 of them share the placeholder `0913580925`. Those are quarantined
(`NO_USABLE_PHONE`) with the conflicting party recorded, and convert into real
customers with no code change the moment the ERP supplies per-customer numbers.
Two further hazards found in the same data:

* ERP customer `10110001` (ABAYOMI) carries the number that `10110017` (ISEA
  INTEGRATED) already logs in with — a cross-row unique violation that would
  abort the whole batch on a different constraint than the one being
  conflict-targeted.
* `40510009` (LATLEK) carries `0707459177`, ten digits where a Nigerian mobile
  has eleven. Overwriting a working login with an unreachable number is worse
  than leaving it, so phones are normalised to `+234` E.164 and validated
  against `ERP_PHONE_PATTERN` before being written.

`ERP_CUSTOMER_SYNTHETIC_PHONE=true` trades this off: the quarantined customers
are created with a non-dialable `erp:<CUSTOMER_CODE>` placeholder, so they appear
in the portal's admin / regional-admin / officer views without a credential
anyone can log in with. Off by default.

---

## 1b. PurchaseItem — measured against the live feed (2026-08-23)

The remaining blocker is no longer only `ITEM_ID` → material-master resolution.
**The feed carries no per-line money at all.** `AMT_UNINCLUDE_TAX_OC` and
`TAX_OC` are *header* totals repeated verbatim on every line of an order: of
5,000 sampled `DOC_NO`s, **zero** had more than one distinct value across their
lines, and there is no unit-price field anywhere on the detail row.

`PurchaseItem.unitPrice` and `PurchaseItem.lineTotal` are both `NOT NULL`, so
projecting lines today would mean writing zeros or apportioning the header total
by quantity — inventing prices — into a screen a distributor reads as an invoice.
Quantity and description *are* available per line (`BUSINESS_QTY`,
`ITEM_DESCRIPTION`), so this becomes a small job the moment a price arrives.

**When it does, the write must be DELETE-then-INSERT of the purchase's items
inside the parent `Purchase`'s transaction, not an upsert.** `PurchaseItem` has
no natural key and no unique constraint, so there is nothing to conflict-target,
and re-inserting without deleting duplicates every line on every sync. Deleting
first is also what makes a line *removed* in the ERP disappear here.

Until then nothing in this service writes `public."PurchaseItem"`.

**Ask the ERP team for:** a per-line amount or unit price on
`sales_order_doc.query` (an `AMT`/`PRICE` field on the detail row).

---

## 2. Stock — ⛔ blocked, no endpoint exists

**There is no product, material, item, inventory, or stock method anywhere in the
API index.** The eight available objects are all *documents* (orders, deliveries,
returns, collections, refunds, receivables) plus customer and customer-credit.

Everything below currently has **no ERP data source whatsoever**:

- the `Stock` table
- `GET /officers/stock`
- `GET /officers/customers/:id/stock`
- `AVAILABLE` / `LOW_STOCK` / `OUT_OF_STOCK` status

**Needs:** a new ERP method exposing the material master (product code + name) and
on-hand quantity per warehouse/plant. Until then, stock must be maintained
manually or via the existing `POST /erp/sync/stock` push webhook.

---

## 3. Purchase — ⚠️ header mappable, ⛔ line items missing

### 3a. Header — workable

| Our field | ERP source | Status |
|---|---|---|
| `erpId` | `DOC_NO` | ✅ |
| `orderDate` | `ORDER_DATE` | ✅ |
| `totalValue` | `AMT_UNINCLUDE_TAX_OC` + `TAX_OC` | ✅ (confirm OC = NGN) |
| `customerErpId` | `CUSTOMER_ID` (**Guid**) | ⚠️ **ID mismatch** |
| `status` | `ApproveStatus` | ⚠️ **semantic mismatch** |
| `totalItems` | `QTY_TOTAL` (header) / `BUSINESS_QTY` (line) | ⚠️ unit unconfirmed |

**ID mismatch.** Orders reference the customer by `CUSTOMER_ID` (a **Guid**), but
`customer.read` is keyed on `CUSTOMER_CODE` (a **string**) — which is what we'd
store as `erpId`. To join an order to a customer we must keep the Guid too.
*Fix on our side:* store both (`erpId` = `CUSTOMER_CODE`, plus a new
`erpGuid` = `CUSTOMER_ID`) so orders and deliveries can resolve.

**Semantic mismatch.** `ApproveStatus` is an **approval** status, not a
**fulfilment** status. Our `OrderStatus` is `PENDING | PROCESSING | SHIPPED |
DELIVERED | CANCELLED` — `SHIPPED`/`DELIVERED` are fulfilment states that almost
certainly come from `SALES_DELIVERY`, not from the order's approval flag. The
possible values of `ApproveStatus` are **not documented**. We need the enumeration
before we can map it.

**Quantity units.** `PIECES` is **not** a sales-order field — it is documented on
`SALES_DELIVERY` and `SALES_RETURN` only, which fits it being a shipped-carton
count. The order's own quantities are `QTY_TOTAL` on the header and
`BUSINESS_QTY` per line, both in the line's `BUSINESS_UNIT_ID` unit, which is a
Guid we cannot resolve without a unit master. Our `totalItems` is displayed to
customers, so the unit matters.

### 3b. Line items — ⚠️ data arrives, projection not written

`sales_order_doc.query` now returns the detail line **in the same flat row as the
header**: `SALES_ORDER_DOC_D_ID`, `SequenceNumber`, `ITEM_TYPE`, `ITEM_ID`,
`ITEM_DESCRIPTION`, `ITEM_SPECIFICATION`, `BUSINESS_QTY`, `BUSINESS_UNIT_ID`,
`DELIVERED_BUSINESS_QTY`, `DISTRIBUTED_BUS_QTY`. A five-line order therefore
arrives as five rows repeating one `DOC_NO`, which is why ingest keys these rows
on `SALES_ORDER_DOC_D_ID` and not on `DOC_NO` — keying on the document number
silently collapsed every order to a single line.

| Our field | ERP source | Status |
|---|---|---|
| `quantity` | `BUSINESS_QTY` | ✅ |
| `productName` | `ITEM_DESCRIPTION` | ⚠️ description, not a product we hold |
| `unitPrice` | — | ⛔ no per-line price documented |
| `lineTotal` | — | ⛔ header carries the amounts, not the line |

So the lines are captured in `erp_raw.raw_sales_order`, but `PurchaseItem` is not
projected yet: `ITEM_ID` cannot be resolved to a product without the material
master (§2), and there is no per-line price. The per-product breakdown —
**Stock Balance Breakdown**, `GET /customers/me/stock-balance`, the officer
per-product view — therefore still has no complete source, though it is now
short of a mapping decision rather than short of data.

---

## 4. Payment — ✅ unblocked

`yvijucrm.collection_doc.query`:

| Our field | ERP source | Status |
|---|---|---|
| `erpId` | `DOC_NO` | ✅ |
| `date` | `DOC_DATE` | ✅ |
| `amount` | `COLLECTION_AMT_TC` | ✅ |
| `reference` | `DOC_NO` | ✅ |
| `customerErpId` | `CUSTOMER_CODE` | ✅ (was the blocker) |
| `runningBalance` | — | ⚠️ absent (we'd have to compute it) |

The header now carries `CUSTOMER_CODE` and `CUSTOMER_NAME`. Note the join is by
**code**, not by Guid — so payments map straight onto `Customer.erpId` with no
`customer_link` lookup, unlike sales orders and deliveries which carry a
`CUSTOMER_ID` Guid.

There is **no `COLLECTION_DOC_ID`** in the documented field list — `DOC_ID` is
the document *type*, not the row's identity — so the raw store keys collections
on `DOC_NO`.

---

## 5. Cross-cutting issues

**No base URL in the docs.** The docs still never state the endpoint; it was
supplied separately and is `http://192.168.25.241:9990/CROSS/RESTful`. Every
method dispatches through the `digi-service` header's `name` field against that
single POST endpoint — confirmed in practice, and the name is **case-sensitive**
(an uppercase variant is rejected with an empty response body).

**Per-method digi-keys.** The docs issue a **different `digi-key` for every
method**, including `.query` vs `.read` of the same object, and the gateway
validates the key *against* the service name — a valid key paired with a
different method's name is rejected outright. Keys resolve
`ERP_API_KEY_<OBJECT>_<ACTION>` → `ERP_API_KEY_<OBJECT>` → `ERP_API_KEY`.

**A key is also bound to an ACCOUNT.** The `digi-host` `acct` value must match the
account the key was issued under, or the gateway rejects the request with an empty
body. The keys issued to us belong to **`CRM`**; the `acct: "dcms"` in the
`api_docs` samples goes with those docs' own sample keys and does **not** apply to
ours. Verified against the live gateway: our keys are accepted under `CRM` and
rejected under `dcms`. If the ERP team ever migrates us to `dcms`, every key must
be re-issued at the same time.

**Auth.** `digi-key: <API_KEY>` on every request, plus per-request `digi-host` and
`digi-service` JSON headers carrying a timestamp, server IP, and the method name.
The client must therefore build headers **per call**, not once at startup.
Responses return a `token_id` — unclear whether that is session state we must feed
back, or just a trace id. **Needs confirmation.**

**⚠️ Incremental sync may be impossible.** `conditions` exists on every query
method, but **its syntax is documented nowhere** — there is not one example. Worse,
the three objects we most need deltas on have **no modified-date field at all**:

| Object | Has `ModifiedDate`? |
|---|---|
| `CUSTOMER` | ❌ none |
| `SALES_ORDER_DOC` | ❌ none |
| `COLLECTION_DOC` | ❌ none |
| `CUSTOMER_CREDIT` | ✅ yes |
| `AR_REFUND_DOC` | ✅ yes |

If we cannot filter by modified date, **every cycle is a full paginated sweep of
every order and every customer** — which gets more expensive forever as the tables
grow. This directly threatens the Phase 4 design and could dictate a much longer
polling interval. **This is the second-most important question to resolve.**

**Timezone.** The `digi-host` header declares `"timezone":"+8"` and `"lang":"zh_CN"`
— it is a Chinese deployment. Viju runs in Lagos (**+1**). Dates could be **7 hours
off**. Confirm what timezone `DOC_DATE` / `ORDER_DATE` are actually returned in
before trusting any of them.

**Pagination.** `pageSize` / `pageNo`, with `isGetCount: true` for totals. ✅ Fine.

**Rate limits.** Undocumented.

---

## 6. ERP data we are NOT using — but probably should

**`SALES_DELIVERY` is likely the real source of "loaded" cartons.** It carries
`CUSTOMER_ID`, `PIECES`, `DESTINATION`, `TELEPHONE`, and `ISSUED_STATUS`
(outbound status). Today our app derives "loaded" from the **app-owned**
`LoadingRequest` table. The ERP's delivery documents are almost certainly the
authoritative record of what actually left the warehouse — and they are how we'd
get true `Loaded` figures for the Stock Balance screen.

Worth deciding deliberately: does `SALES_DELIVERY` **replace** our derived
"loaded" number, or reconcile against it?

`SALES_RETURN`, `AR_REFUND_DOC`, and `OTHER_RECEIVABLE_DOC` have no counterpart in
our schema at all, yet all three move a customer's balance.

---

## 7. Questions for the ERP team

**Blocking — cannot build without these:**

1. **What is the base URL / endpoint path?** It is not in the docs.
2. **How do we get a customer's phone number and region?** Neither is on
   `customer.query`. Without phone we cannot create customers at all.
3. **How do we get sales-order line items** (product, quantity, unit price, line
   total)? Does `sales_order_doc.read` return them? If not, is there a
   `sales_order_detail` method?
4. **Is there any product / inventory / stock endpoint?** Nothing in the index
   exposes materials or on-hand quantity.
5. **How is a `COLLECTION_DOC` linked to a customer?** There is no `CUSTOMER_ID`
   on the header.

**Important — shapes the design:**

6. **What is the `conditions` syntax?** Give one worked example (e.g. filter by
   modified date > X).
7. **Can `CUSTOMER`, `SALES_ORDER_DOC`, and `COLLECTION_DOC` be filtered
   incrementally?** They expose no modified-date field. If not, we are forced into
   full sweeps every cycle.
8. **What are the possible values of `ApproveStatus`?**
9. **What timezone are `DOC_DATE` / `ORDER_DATE` returned in** — +8 or local?
10. **Is `digi-key` a static API key, or must `token_id` be fed back** on
    subsequent calls?
11. **Are there rate limits?**
12. **Is `PIECES` cartons, or line count?**
13. **Is `AMT_*_OC` (transaction currency) always NGN?**

---

## 8. Recommendation

**Do not build Phases 2–5 yet.** Only the Purchase header is cleanly mappable;
customers, stock, order lines, and payments are all blocked. Building sync jobs
against four unknowns would mean rewriting them once the answers land.

**Push vs pull is now settled by the evidence:** the ERP exposes no webhook
capability — it is a pull-only REST API. So the puller becomes the primary
ingestion path. The existing `POST /erp/sync/*` webhooks in the main API
(`src/modules/erp/`) should be **kept**, because they are currently the *only* way
to get stock and order line items into the system at all.

**What we can build immediately, unblocked:** the Phase 2 HTTP client (headers,
auth, pagination, retries) against fixtures. It is needed no matter how the gaps
resolve, and it is what will let us probe the live ERP to answer questions 3, 5,
and 6 empirically — the docs may simply be incomplete, and one live call to
`sales_order_doc.read` would settle whether line items exist.
