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
| **PurchaseItem** (lines) | `yvijucrm.sales_order_doc.query` | ⚠️ Data arrives; projection not written (no material master) |
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
| `region` | `Region` | ✅ via `ERP_REGION_MAP` / `ERP_REGION_DEFAULT` |
| `accountStatus` | — | ⚠️ absent (defaults to `ACTIVE`) |
| `outstandingBalance` | `customer_credit.CREDIT_PAY`? | ⚠️ unconfirmed — see below |

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
