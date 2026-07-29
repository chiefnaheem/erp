# What the ERP data is missing for our app

I sampled real rows from every table after the sync pulled everything down. The
pull itself is fine. All eight ERP objects are landing in the database now
(customers, orders, deliveries, returns, collections, refunds, other receivables,
and credit). The problem isn't the sync.

The problem is that a handful of fields our app treats as required either aren't
in the ERP at all, or come back empty. Here's what I found going table by table.
Numbers are from the full dataset, not a single row.

## Customers

The ERP customer record only carries the customer code, name, currency, and a few
internal IDs. Nothing else. I checked all 3,748 records and the fields are the
same on every one.

What our app needs and doesn't get:

- **Phone number.** This is the main blocker. Our app logs customers in with
  phone + OTP, so phone is required and has to be unique. It isn't on the customer
  record at all. Phone numbers do show up on delivery documents, but only on about
  12% of them (20,014 of 172,800), and that's a per-delivery value, not the
  customer's number.
- **Region.** Also required by our app (Lagos, South West, South East, North).
  There's nothing in the ERP that maps to it.
- **Email.** Not there either, but our app treats email as optional, so this one
  doesn't matter.

I also checked the custom fields on the credit record (UDF021 through UDF026) in
case phone or region were hidden there. They're all empty.

Worth flagging: the customer list is mixed. Some are Nigerian businesses, some are
Chinese logistics companies. We'll likely need to filter down to the ones that
actually belong to us.

## Orders (our "purchases")

Mostly good. Order number, order date, customer, total amount, and status all come
through cleanly. Two gaps:

- **Carton / quantity count.** The PIECES field is 0 on almost every order —
  173,097 of 173,100 have it at zero. So we can't use it for "total items."
- **No product breakdown.** The order only has header totals. There are no line
  items: no product name, no quantity per product, no unit price. Our Stock
  Balance screen (the per-product "X cartons remaining") is built on exactly that
  data, and it isn't in the order.

## Stock / inventory

There is no product or stock endpoint in the ERP API at all. Nothing feeds our
Stock table or the stock screens. This one has no source to pull from.

## Payments (the ERP calls these "collections")

Amount and date come through fine. The blocker:

- **No customer.** The payment record has no customer field anywhere. I went
  through every field on the object. So there's no way to tell which customer a
  payment belongs to, and our app requires that link (a payment has to attach to a
  customer).
- **No running balance.** Not present either.

## One thing that is available

Customer outstanding balance. It's not on the customer record, but the credit
record has a "used credit" figure (CREDIT_PAY) that's populated for most customers
(1,486 of 1,831). That's a reasonable source for the balance we show.

## Summary

| What our app needs | In the ERP? | Notes |
|---|---|---|
| Customer code, name | Yes | Fine |
| Customer phone | No | Required for login. Only on ~12% of deliveries, per-delivery |
| Customer region | No | Required. No source |
| Customer email | No | Optional for us, so OK |
| Customer balance | Yes-ish | From credit record's CREDIT_PAY |
| Order number, date, amount, status | Yes | Fine |
| Order carton count | No | PIECES is 0 on ~all orders |
| Order product breakdown (line items) | No | Powers the Stock Balance screen |
| Product / stock levels | No | No endpoint exists |
| Payment amount, date | Yes | Fine |
| Payment → which customer | No | No customer field on payments |

## What this means

Three things block the app in a real way:

1. Customers can't be created from the ERP, because there's no phone (the login)
   and no region, both required. Without solving this, none of the orders can
   attach to a customer either.
2. The Stock Balance / per-product feature has no data, because orders carry no
   line items and there's no stock endpoint.
3. Payments can't be recorded, because they don't say which customer they belong
   to.

The rest (order headers, balances, amounts) is there and usable. The next
conversation to have is with the ERP side: where does a customer's phone and
region live, is there a product/stock feed anywhere, and how is a payment tied
back to a customer.
