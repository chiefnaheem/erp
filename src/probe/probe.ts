/**
 * ERP probe — answers the open questions in CONTRACT.md against the LIVE ERP.
 *
 * The API docs are demonstrably incomplete (they never even state the base URL),
 * so several "blockers" may simply be undocumented rather than absent. This
 * script finds out by asking the ERP directly, and writes everything it sees to
 * probe-output.json.
 *
 *   npm run probe
 *
 * It is READ-ONLY. It issues only `.query` and `.read` calls and writes nothing
 * to the ERP or to our database.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ErpClient } from '../erp/erp.client';
import { ERP_METHOD } from '../erp/erp.types';

const log = new Logger('Probe');

/** Fields the docs claim each object returns — anything else is a discovery. */
const DOCUMENTED: Record<string, string[]> = {
  customer: [
    'CUSTOMER_ID',
    'CUSTOMER_CODE',
    'CUSTOMER_NAME',
    'CUSTOMER_FULL_NAME',
    'GENERAL_CURRENCY_ID',
    'Owner_Dept',
    'Owner_Emp',
  ],
};

/** Keys that would resolve a blocker if they turn up. */
const WANTED = {
  customerPhone: /phone|tel|mobile|contact/i,
  customerRegion: /region|area|zone|state|territory|dept/i,
  orderLineItems: /detail|line|item|product|material|goods|rows/i,
  collectionCustomer: /customer/i,
};

type Findings = Record<string, unknown>;
const findings: Findings = {};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const erp = app.get(ErpClient);

  log.log('Probing the live ERP — read-only.\n');

  await check('0. connectivity + auth', async () => {
    const page = await erp.query(ERP_METHOD.CUSTOMER_QUERY, { pageSize: 1 });
    return {
      reachable: true,
      executionCode: page.execution.code,
      description: page.execution.description,
      tokenId: page.execution.token_id,
      rowsReturned: page.rows.length,
    };
  });

  // ── Q2: can we get a customer's phone and region? ───────────────────────
  await check('2. CUSTOMER — are phone/region actually returned?', async () => {
    const page = await erp.query<Record<string, unknown>>(
      ERP_METHOD.CUSTOMER_QUERY,
      { pageSize: 1 },
    );
    const row = page.rows[0];
    if (!row) return { note: 'no customer rows returned' };

    const keys = Object.keys(row);
    const undocumented = keys.filter((k) => !DOCUMENTED.customer.includes(k));

    return {
      allKeysReturned: keys,
      undocumentedKeys: undocumented,
      phoneLikeKeys: keys.filter((k) => WANTED.customerPhone.test(k)),
      regionLikeKeys: keys.filter((k) => WANTED.customerRegion.test(k)),
      VERDICT_phone: keys.some((k) => WANTED.customerPhone.test(k))
        ? 'FOUND — customer creation may be unblocked'
        : 'ABSENT — customers cannot be created from ERP',
      sampleRow: row,
    };
  });

  // Does .read return MORE than .query? (docs never show read's payload)
  // This is THE decisive check for the ERP-driven onboarding model: if phone and
  // region live anywhere, customer.read is the most likely place.
  await check('2b. CUSTOMER.read — where do phone + region live?', async () => {
    const page = await erp.query<Record<string, unknown>>(
      ERP_METHOD.CUSTOMER_QUERY,
      { pageSize: 1 },
    );
    const code = page.rows[0]?.CUSTOMER_CODE as string | undefined;
    if (!code) return { note: 'no CUSTOMER_CODE to read with' };

    const raw = await erp.raw(ERP_METHOD.CUSTOMER_READ, {
      dataKeys: [{ CUSTOMER_CODE: code }],
    });

    // Flatten the entire response and surface every key whose NAME or VALUE looks
    // like a phone or a region — the field we need may be nested or oddly named.
    const flat = flatten(raw);
    const phoneHits = Object.entries(flat).filter(
      ([k, v]) => WANTED.customerPhone.test(k) || looksLikePhone(v),
    );
    const regionHits = Object.entries(flat).filter(([k]) =>
      WANTED.customerRegion.test(k),
    );

    return {
      customerCodeUsed: code,
      queryFieldCount: Object.keys(page.rows[0] ?? {}).length,
      readFieldCount: Object.keys(flat).length,
      VERDICT_readRicher:
        Object.keys(flat).length > Object.keys(page.rows[0] ?? {}).length
          ? 'YES — customer.read returns more than customer.query'
          : 'NO — read is no richer than query',
      phoneCandidates: phoneHits.map(([k, v]) => ({ field: k, sample: v })),
      regionCandidates: regionHits.map(([k, v]) => ({ field: k, sample: v })),
      VERDICT_phoneSource: phoneHits.length
        ? `FOUND → set ERP_CUSTOMER_PHONE_FIELD=${phoneHits[0][0]}`
        : 'NOT on customer.read — check delivery TELEPHONE / order contacts / UDFs below',
      VERDICT_regionSource: regionHits.length
        ? `FOUND → set ERP_CUSTOMER_REGION_FIELD=${regionHits[0][0]}`
        : 'NOT on customer.read — may be a UDF or an address/contact object',
      rawResponse: raw,
    };
  });

  // If phone isn't on the customer object, is it on the documents that DO carry
  // a customer? SALES_DELIVERY has a documented TELEPHONE; orders have contacts.
  await check('2c. phone on OTHER objects (delivery/order)?', async () => {
    const out: Record<string, unknown> = {};

    for (const [label, method] of [
      ['SALES_DELIVERY', ERP_METHOD.SALES_DELIVERY_QUERY],
      ['SALES_ORDER', ERP_METHOD.SALES_ORDER_QUERY],
    ] as const) {
      const page = await erp.query<Record<string, unknown>>(method, { pageSize: 1 });
      const row = page.rows[0] ?? {};
      const phoneKeys = Object.keys(row).filter(
        (k) => WANTED.customerPhone.test(k) || looksLikePhone(row[k]),
      );
      out[label] = {
        phoneLikeKeys: phoneKeys,
        samples: phoneKeys.map((k) => ({ field: k, value: row[k], customerId: row.CUSTOMER_ID })),
      };
    }

    out.NOTE =
      'A phone on a document is per-transaction, not the customer master. Usable ' +
      'as a fallback (join via CUSTOMER_ID) but confirm it is stable per customer.';
    return out;
  });

  // ── Q3 (BIGGEST): do sales orders expose line items? ────────────────────
  await check('3. SALES_ORDER — do LINE ITEMS exist?', async () => {
    const page = await erp.query<Record<string, unknown>>(
      ERP_METHOD.SALES_ORDER_QUERY,
      { pageSize: 1 },
    );
    const row = page.rows[0];
    if (!row) return { note: 'no sales order rows returned' };

    const docNo = row.DOC_NO as string;
    const queryKeys = Object.keys(row);

    // The decisive call: does .read return the order's detail lines?
    const raw = await erp.raw(ERP_METHOD.SALES_ORDER_READ, {
      dataKeys: [{ DOC_NO: docNo }],
    });

    const rawText = JSON.stringify(raw);
    const lineLikeKeysInRead = [...new Set(rawText.match(/"([A-Za-z_]+)":/g) ?? [])]
      .map((m) => m.slice(1, -2))
      .filter((k) => WANTED.orderLineItems.test(k));

    return {
      docNoUsed: docNo,
      queryKeys,
      approveStatusSample: row.ApproveStatus,
      piecesSample: row.PIECES,
      dateSamples: { DOC_DATE: row.DOC_DATE, ORDER_DATE: row.ORDER_DATE },
      lineLikeKeysInReadResponse: lineLikeKeysInRead,
      VERDICT_lineItems: lineLikeKeysInRead.length
        ? 'POSSIBLE — read() returned line-ish keys, inspect rawReadResponse'
        : 'ABSENT — per-product breakdown has no source',
      rawReadResponse: raw,
    };
  });

  // ── Q5: how is a payment linked to a customer? ──────────────────────────
  await check('5. COLLECTION_DOC — any customer link?', async () => {
    const page = await erp.query<Record<string, unknown>>(
      ERP_METHOD.COLLECTION_QUERY,
      { pageSize: 1 },
    );
    const row = page.rows[0];
    if (!row) return { note: 'no collection rows returned' };

    const keys = Object.keys(row);
    const customerish = keys.filter((k) => WANTED.collectionCustomer.test(k));

    const raw = await erp.raw(ERP_METHOD.COLLECTION_READ, {
      dataKeys: [{ DOC_NO: row.DOC_NO as string }],
    });

    return {
      allKeysReturned: keys,
      customerLikeKeys: customerish,
      VERDICT_customerLink: customerish.length
        ? 'FOUND — payments may be attributable'
        : 'ABSENT at header level — check rawReadResponse for lines',
      rawReadResponse: raw,
    };
  });

  // ── Q6/Q7: pagination count + incremental filtering ─────────────────────
  await check('6. isGetCount — does it return a total, and under what key?', async () => {
    const raw = await erp.raw(ERP_METHOD.CUSTOMER_QUERY, {
      pageSize: 1,
      pageNo: 1,
      isGetCount: true,
      isGetSchema: false,
      conditions: [],
      orders: [],
    });
    const param = (raw as any)?.std_data?.parameter ?? {};
    return {
      parameterKeys: Object.keys(param).filter((k) => k !== 'rows'),
      note: 'a numeric key here is the total-count field the docs omit',
      rawParameterMinusRows: { ...param, rows: `<${param.rows?.length ?? 0} rows omitted>` },
    };
  });

  await check('7. conditions — is incremental sync possible?', async () => {
    // The conditions syntax is undocumented. Try the most conventional shape and
    // record exactly how the ERP rejects it — the error message usually reveals
    // the expected format.
    const attempts: Record<string, unknown> = {};
    const shapes = [
      { label: 'field/op/value', value: [{ field: 'CUSTOMER_CODE', op: 'like', value: '%' }] },
      { label: 'name/operator/value', value: [{ name: 'CUSTOMER_CODE', operator: '=', value: 'x' }] },
      { label: 'column/condition/data', value: [{ column: 'CUSTOMER_CODE', condition: '=', data: 'x' }] },
    ];

    for (const shape of shapes) {
      try {
        const raw = await erp.raw(ERP_METHOD.CUSTOMER_QUERY, {
          pageSize: 1,
          pageNo: 1,
          isGetCount: false,
          isGetSchema: false,
          conditions: shape.value,
          orders: [],
        });
        const exec = (raw as any)?.std_data?.execution;
        attempts[shape.label] = {
          code: exec?.code,
          description: exec?.description,
          rowsReturned: (raw as any)?.std_data?.parameter?.rows?.length ?? 0,
          accepted: exec?.code === '0',
        };
      } catch (error) {
        attempts[shape.label] = { threw: describe(error) };
      }
    }
    return {
      attempts,
      note: 'if none are accepted, ask the ERP team for one worked conditions example',
    };
  });

  // ── Q4: is there ANY stock/product data hiding anywhere? ────────────────
  await check('4. SALES_DELIVERY — the likely source of "loaded" cartons', async () => {
    const page = await erp.query<Record<string, unknown>>(
      ERP_METHOD.SALES_DELIVERY_QUERY,
      { pageSize: 1 },
    );
    const row = page.rows[0];
    if (!row) return { note: 'no delivery rows returned' };
    return {
      allKeysReturned: Object.keys(row),
      customerId: row.CUSTOMER_ID,
      pieces: row.PIECES,
      issuedStatus: row.ISSUED_STATUS,
      sampleRow: row,
    };
  });

  await check('outstandingBalance — CUSTOMER_CREDIT.CREDIT_PAY viable?', async () => {
    const page = await erp.query<Record<string, unknown>>(
      ERP_METHOD.CUSTOMER_CREDIT_QUERY,
      { pageSize: 5 },
    );
    return {
      rowsReturned: page.rows.length,
      rowsPerCustomer: page.rows.map((r) => ({
        CUSTOMER_ID: r.CUSTOMER_ID,
        CREDIT_AMT: r.CREDIT_AMT,
        CREDIT_PAY: r.CREDIT_PAY,
        CURRENCY_ID: r.CURRENCY_ID,
        LastModifiedDate: r.LastModifiedDate,
      })),
      note: 'multiple rows for one CUSTOMER_ID means we must decide which wins',
    };
  });

  const outPath = join(__dirname, '..', '..', 'probe-output.json');
  writeFileSync(outPath, JSON.stringify(findings, null, 2));

  log.log(`\n${'─'.repeat(60)}`);
  log.log(`Full output written to ${outPath}`);
  log.log('Answers to the blocking questions:');
  for (const [name, result] of Object.entries(findings)) {
    const verdicts = Object.entries((result ?? {}) as Record<string, unknown>)
      .filter(([k]) => k.startsWith('VERDICT_'))
      .map(([k, v]) => `      ${k.replace('VERDICT_', '')}: ${v}`);
    if (verdicts.length) log.log(`  ${name}\n${verdicts.join('\n')}`);
  }

  await app.close();
}

async function check(name: string, fn: () => Promise<unknown>) {
  log.log(`▶ ${name}`);
  try {
    const result = await fn();
    findings[name] = result;
    log.log(`  ✅ ok`);
  } catch (error) {
    findings[name] = { FAILED: describe(error) };
    // Keep going — one dead endpoint shouldn't cost us the other answers.
    log.warn(`  ❌ ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Flatten a nested response to dot-path → value, so a buried field is still found. */
function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') Object.assign(out, flatten(v, path));
      else out[path] = v;
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => Object.assign(out, flatten(v, `${prefix}[${i}]`)));
  }
  return out;
}

/** A value that looks like a Nigerian/international phone number. */
function looksLikePhone(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const digits = String(value).replace(/[^\d]/g, '');
  return digits.length >= 10 && digits.length <= 15 && /^[0+\d]/.test(String(value).trim());
}

main().catch((error) => {
  log.error(`Probe aborted: ${describe(error)}`);
  process.exit(1);
});
