# viju-erp-sync

A standalone NestJS worker whose only job is to **pull data from the YVIJUCRM
(Digiwin E10) ERP on an interval and persist it to the Viju database.**

It is **fully self-contained** — its own `package.json`, `node_modules`, Prisma
schema, generated client, `.env` and `.gitignore`. It reads no config from any
parent directory. The folder can be lifted into its own git repo as-is:

```bash
cp -r erp-sync /path/to/viju-erp-sync
cd /path/to/viju-erp-sync && git init && git add . && git commit -m "init"
```

> **Read [CONTRACT.md](./CONTRACT.md) first.** Four of the five things this worker
> is supposed to sync are currently **blocked** by gaps in the ERP API. Phases 2–5
> should not be built until those are resolved.

## Run

```bash
cp .env.example .env     # then fill in DATABASE_URL + ERP_*
npm install              # runs `prisma generate` via postinstall
npm run start:dev
```

Health check: `GET http://localhost:3100/health`

## Database ownership

This worker writes to the **same database as the main Viju API**. The main API
**owns the Prisma migrations** — this app must never run them. It only reads and
upserts.

Its `prisma/schema/` is a **copy** of the main API's schema. While the two live in
the same repo you can refresh it:

```bash
npm run schema:check    # diff against ../prisma/schema
npm run schema:pull     # copy ../prisma/schema over it, then regenerate
```

Once this app is extracted to its own repo those two scripts no longer apply, and
the schema copy must be kept in step with the main API by hand. **Schema drift is
the main risk of splitting the repos** — a required column added upstream will
break writes here.

## Data contract

Four entities are ERP-owned. Everything else in the schema — loading requests,
waybills, chat, tickets, notifications, staff — is app-owned and must **never** be
overwritten by a sync.

| Entity | Fields | Keyed on | ERP source |
|---|---|---|---|
| **Customer** | `name`, `outstandingBalance` (⛔ not `phone`/`region` — see CONTRACT) | `erpId` | `customer.query` |
| **Stock** | `productName`, `quantity` | `erpId` | ⛔ **no endpoint exists** |
| **Purchase** | `orderDate`, `totalItems`, `totalValue`, `status` | `erpId` (`DOC_NO`) | `sales_order_doc.query` |
| **PurchaseItem** | `productName`, `quantity`, `unitPrice`, `lineTotal` | parent | ⛔ **not exposed** |
| **Payment** | `date`, `amount`, `reference`, `runningBalance` | `erpId` (`DOC_NO`) | `collection_doc.query` (⛔ no customer link) |

Sync order matters — purchases and payments carry an FK to a customer:

```
Customers → Stock → Purchases (+ items) → Payments
```

Every write is an idempotent upsert on `erpId`, so a re-run is always safe and a
failed run can simply be retried.

## Phases

| Phase | Status |
|---|---|
| 0 — Map the ERP docs to the data contract; produce gap list | ✅ done → [CONTRACT.md](./CONTRACT.md) |
| 1 — Bootstrap: standalone app, config, Prisma, health endpoint | ✅ done |
| 2 — Typed ERP HTTP client (digi-* headers, auth, retries, pagination) | ✅ done |
| 3 — Sync jobs, idempotent upserts | ⛔ blocked on ERP answers |
| 4 — Cron scheduling + incremental pulls | ⛔ blocked (ERP may not support deltas) |
| 5 — Sync-run log, alerting, manual re-trigger, backfill | ⬜ |

## Probing the live ERP

The API docs are demonstrably incomplete — they never even state the base URL —
so some of the "blockers" in CONTRACT.md may be undocumented rather than absent.
The probe asks the ERP directly instead of guessing:

```bash
npm run probe        # read-only; writes probe-output.json
```

It needs a real `ERP_BASE_URL` and `ERP_API_KEY`. It issues only `.query` and
`.read` calls and writes nothing — to the ERP or to our database. Each check is
independent, so one dead endpoint doesn't cost you the other answers.

It tries to settle, with evidence:

| Check | Question it answers |
|---|---|
| `2.` | Does `customer.query` really omit **phone** and **region**? |
| `2b.` | Does `customer.read` return more than `customer.query` does? |
| `3.` | **Do sales orders expose LINE ITEMS?** (the biggest unknown) |
| `4.` | Is `SALES_DELIVERY` a usable source of "loaded" cartons? |
| `5.` | Is a `COLLECTION_DOC` linkable to a customer? |
| `6.` | Does `isGetCount` work, and what is the count field called? |
| `7.` | What `conditions` syntax does the ERP accept → is delta sync possible? |

Check 3 is the one to read first. If order lines exist, the per-product Stock
Balance Breakdown is unblocked; if they don't, that feature has no data source.

## Client notes

`ErpClient` (`src/erp/erp.client.ts`) handles the E10 protocol's sharp edges:

- **HTTP 200 does not mean success.** E10 returns 200 for business errors too —
  only `execution.code === '0'` means it worked. Business errors throw
  `ErpApiError` and are **not** retried; 5xx/timeouts throw `ErpTransportError`
  and **are**, with exponential backoff.
- **Headers are rebuilt per call**, not once at startup — `digi-service` carries
  the method name (it is how E10 routes) and `digi-host` carries a timestamp.
- **Pagination stops on a short page**, not on a total, because the count field
  name is undocumented. `queryAll()` yields page-by-page so a large table is
  never held in memory.

Covered by `src/erp/erp.client.spec.ts`, which runs the client against a mock E10
server: `npm test`.

Jobs are scheduled with `@nestjs/schedule` (in-process cron) but each sync is
written as a standalone job class, so moving to BullMQ later is a wiring change
rather than a rewrite.

## Gotcha: do not name an env var `PORT`

The worker's port is `SYNC_PORT`, not `PORT`, and that is deliberate.

`@prisma/client` loads a `.env` into `process.env` on import, and NestJS
`ConfigModule` lets `process.env` win over `.env` files. While this app sat inside
the main repo, a key named `PORT` silently resolved to the **main API's 3025** and
the two apps fought over one socket — no ordering of `envFilePath` could fix it.

The app now reads only its own `.env`, so the hazard is gone, but the distinct name
is kept as a guard in case the folder is ever nested inside another app again.
