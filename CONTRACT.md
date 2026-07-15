# Phase 0 — ERP contract mapping & gap analysis

ERP: **YVIJUCRM**, a Digiwin **E10** external REST API (`digi-data-exchange-protocol 1.0`).

This document maps every ERP method onto the data the Viju app needs, and records
what the ERP **cannot** currently supply. Four gaps are **blocking** — they have
no workaround on our side and need the ERP team to answer or extend the API.

---

## Verdict at a glance

| Our entity | ERP source | Status |
|---|---|---|
| **Customer** | `yvijucrm.customer.query` | ⛔ **Blocked** — no `phone`, no `region` |
| **Stock** | *(none)* | ⛔ **Blocked** — no product/inventory endpoint exists |
| **Purchase** (header) | `yvijucrm.sales_order_doc.query` | ⚠️ Mappable, with caveats |
| **PurchaseItem** (lines) | *(none)* | ⛔ **Blocked** — orders expose no line items |
| **Payment** | `yvijucrm.collection_doc.query` | ⛔ **Blocked** — no customer link |

Only the Purchase *header* is cleanly syncable today.

---

## 1. Customer — ⛔ blocked

`yvijucrm.customer.query` returns only:
`CUSTOMER_ID`, `CUSTOMER_CODE`, `CUSTOMER_NAME`, `CUSTOMER_FULL_NAME`,
`GENERAL_CURRENCY_ID`, `Owner_Dept`, `Owner_Emp`.

| Our field | ERP source | Status |
|---|---|---|
| `erpId` | `CUSTOMER_CODE` | ✅ |
| `name` | `CUSTOMER_FULL_NAME` | ✅ |
| `phone` | — | ⛔ **absent, but REQUIRED + UNIQUE in our DB** |
| `email` | — | ⚠️ absent (nullable, tolerable) |
| `region` | — | ⛔ **absent, but REQUIRED** (`LAGOS`/`SOUTH_WEST`/`SOUTH_EAST`/`NORTH`) |
| `accountStatus` | — | ⚠️ absent (defaults to `ACTIVE`) |
| `outstandingBalance` | `customer_credit.CREDIT_PAY`? | ⚠️ unconfirmed — see below |

**Why this blocks:** `phone` is not just a column — it is the **login identifier**
(phone + OTP auth). The ERP cannot give it to us, so **the sync cannot create
customers.**

**Consequence — a real change of design.** Customers must be onboarded *in the
app* (phone/OTP), then **linked** to the ERP by `CUSTOMER_CODE`. The sync job
then only *updates* ERP-owned fields on already-existing customers
(`name`, `outstandingBalance`) and must **never insert**. This is the opposite of
the upsert-on-`erpId` model we assumed in Phase 1, and it needs sign-off.

**`outstandingBalance`:** not on the customer object at all. Best candidate is
`customer_credit.CREDIT_PAY` ("used credit amount"). Unconfirmed, and
`CUSTOMER_CREDIT` may return **multiple rows per customer** (one per credit area
/ currency), so which row wins is undefined. Note also that `SALES_RETURN`,
`AR_REFUND_DOC` and `OTHER_RECEIVABLE_DOC` all move a customer's balance — if we
compute rather than read the balance, all of them must be accounted for.

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
| `totalItems` | `PIECES`? | ⚠️ ambiguous |

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

**`PIECES`** is described only as "Number of pieces" — unclear whether that is
cartons or order lines. Our `totalItems` is displayed to customers, so this
matters.

### 3b. Line items — ⛔ blocked

`sales_order_doc.query` returns **header fields only**. No detail/line array is
documented, and `sales_order_doc.read` is described merely as *"Returns the same
DOC_NO on success"*, which tells us nothing about its payload.

So `PurchaseItem` — `productName`, `quantity`, `unitPrice`, `lineTotal` — has
**no source**.

**This is the most damaging gap.** `PurchaseItem` is what powers:

- the **Stock Balance Breakdown** screen (per-product "X Cartons Remaining")
- `GET /customers/me/stock-balance`
- the per-product officer stock view

Without order lines, **the entire per-product breakdown feature has no data.**

---

## 4. Payment — ⛔ blocked, no customer link

`yvijucrm.collection_doc.query`:

| Our field | ERP source | Status |
|---|---|---|
| `erpId` | `DOC_NO` | ✅ |
| `date` | `DOC_DATE` | ✅ |
| `amount` | `COLLECTION_AMT_TC` | ✅ |
| `reference` | `DOC_NO` | ✅ |
| `customerErpId` | — | ⛔ **absent** |
| `runningBalance` | — | ⚠️ absent (we'd have to compute it) |

**`COLLECTION_DOC` has no customer field.** The documented header carries
`SETTLEMENT_OBJECT_TYPE` (an Int32) and `EMPLOYEE_ID` / `ADMIN_UNIT_ID`, but no
`CUSTOMER_ID`. The customer is presumably on the document's **lines**, which are
not exposed.

A payment we cannot attribute to a customer is useless to us — `Payment.customerId`
is a required FK. **Blocked.**

---

## 5. Cross-cutting issues

**No base URL.** The docs never state the endpoint. Methods appear to dispatch
through the `digi-service` header's `name` field against a single POST endpoint.
**We need the actual URL** before any call can be made.

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
