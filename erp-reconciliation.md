# ERP data vs what the app needs — after the July 28 update

The ERP team acted on the gaps we sent them. This is where each of our required
fields now stands. Short version: most of what was blocking us is now provided.
Two things are still open, and one operational risk needs a decision.

## What got fixed

**Customer phone and region.** `customer.query` now returns `PhoneNumber` and
`Region` directly. This was the big blocker — phone is our login, region is
required — and both are now there. The worker reads them by default.

**Payments can now be attributed to a customer.** `collection.query` now returns
`CUSTOMER_CODE`. Previously the payment record had no customer on it at all, so we
couldn't record payments. Now we can.

**Order line items exist.** `sales_order.query` now returns the product lines
(`ITEM_DESCRIPTION`, `BUSINESS_QTY`, etc.), not just the header. That's what the
per-product Stock Balance screen needs.

**Order quantity.** The old `PIECES` field was 0 on basically every order. There's
now `QTY_TOTAL` on the header, which we use instead.

**Header change.** The `acct` value in the request header changed from `CRM` to
`dcms`. Updated.

## Where each app field stands now

| App needs | Source in ERP now | Status |
|---|---|---|
| Customer code / name | CUSTOMER_CODE / CUSTOMER_FULL_NAME | Good |
| Customer phone | PhoneNumber (new) | Good — verify coverage on real data |
| Customer region | Region (new) | Good — needs value mapping (see below) |
| Customer email | — | Still missing, but optional for us |
| Customer balance | customer_credit.CREDIT_PAY (now has CUSTOMER_CODE) | Good |
| Order number / date / amount / status | DOC_NO / ORDER_DATE / AMT_UNINCLUDE_TAX_OC + TAX_OC / ApproveStatus | Good |
| Order total items | QTY_TOTAL (new) | Good |
| Order → product breakdown | sales_order line items (new) | Available, not wired yet (see below) |
| Product unit price / line total | not clearly in the line fields | Open question |
| Stock / on-hand quantity | — | Still no source |
| Payment amount / date | COLLECTION_AMT_TC / DOC_DATE | Good |
| Payment → customer | CUSTOMER_CODE (new) | Good |
| Payment running balance | — | No source; we write 0 as a placeholder |

## Still open

**1. Region values need mapping.** The ERP sends `Region` as free text. Our app
uses a fixed set: LAGOS, SOUTH_WEST, SOUTH_EAST, NORTH. If the ERP's value is
exactly one of those it maps automatically; anything else (e.g. "Lagos Mainland",
"West") needs a line in `ERP_REGION_MAP`. The worker logs every value it can't map
on the first run, so one run tells us the full list to map. Until a customer's
region maps, that customer isn't created (region is required).

**2. Order line items aren't wired yet, on purpose.** The lines exist, but the docs
don't say HOW they come back — as a nested array inside each order, or as one flat
row per line. That difference matters: if it's flat rows, our current "one row per
order" storage would keep only one line and silently drop the rest. I'm not wiring
the per-product projection until we see one real response and confirm the shape.
The startup log now prints the sales-order structure, so a single restart answers
it. Also note: the documented line fields have product and quantity, but no obvious
per-line price or amount, so `unitPrice` / `lineTotal` may still be missing even
once lines are wired. Worth confirming with the ERP team.

**3. Stock levels still have no source.** There's still no product/inventory feed,
so on-hand stock numbers (the officer stock screens) have nothing behind them. The
customer-facing per-product "cartons remaining" is different — that's
paid-minus-loaded, which we can compute from order lines once they're wired, so it
isn't blocked by this. Only true warehouse stock levels are.

**4. Payment running balance is a placeholder.** Payments record fine, but the ERP
doesn't give a running balance, so we store 0. If the app relies on that number,
we either compute it ourselves from the payment history or ask the ERP for it.

## The operational risk — read this before running a full sync

The raw tables already hold ~880,000 rows, and that's before line items. Adding
line items multiplies the size of the order data. The database, the API, and nginx
all run on the same server, and that box already ran out of disk once this week —
which took down the database and the website. Pulling more, larger data onto it
will make that worse.

Before running another full sync we should decide one of:

- move the sync's raw storage onto its own database/disk, off the shared box, or
- stop keeping the full raw payload for every historical document (keep only what
  the app projects, or only recent/changed records), or
- at minimum, cap and monitor disk so a fill can't take the DB down again.

The pull working is good news. Filling the production disk with it is not.

## What I changed in the worker

- `acct` header → `dcms`
- Customer creation now reads `PhoneNumber` / `Region` by default, with region
  value mapping + logging of unmapped values
- Order `totalItems` now reads `QTY_TOTAL`
- Payments now project to the app (collection → Payment via `CUSTOMER_CODE`);
  running balance is a placeholder 0
- Order line-item projection left off until the response shape is confirmed
- Stock projection still off (no source)

## What you need to do

- In `.env`: set `ERP_ACCOUNT=dcms`, and update the per-object API keys if the ERP
  team rotated them in this version (query and read now have separate keys).
- Restart once and check the log for: the sales-order structure (to settle the
  line-item shape) and any "Unmapped ERP Region values" line (to build the region
  map).
- Decide the storage question above before the next full sync.
