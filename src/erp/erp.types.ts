// Wire types for the YVIJUCRM (Digiwin E10) external REST API,
// digi-data-exchange-protocol 1.0.
//
// Every call POSTs a `std_data` envelope and receives one back. Success is
// signalled by execution.code === '0' in the BODY — the HTTP status is 200 even
// for business errors, so the status code alone must never be trusted.

/** Method names, per the API index. */
export const ERP_METHOD = {
  CUSTOMER_QUERY: 'yvijucrm.customer.query',
  CUSTOMER_READ: 'yvijucrm.customer.read',
  CUSTOMER_CREDIT_QUERY: 'yvijucrm.customer_credit.query',
  CUSTOMER_CREDIT_READ: 'yvijucrm.customer_credit.read',
  SALES_ORDER_QUERY: 'yvijucrm.sales_order_doc.query',
  SALES_ORDER_READ: 'yvijucrm.sales_order_doc.read',
  SALES_DELIVERY_QUERY: 'yvijucrm.sales_delivery.query',
  SALES_DELIVERY_READ: 'yvijucrm.sales_delivery.read',
  SALES_RETURN_QUERY: 'yvijucrm.sales_return.query',
  SALES_RETURN_READ: 'yvijucrm.sales_return.read',
  COLLECTION_QUERY: 'yvijucrm.collection_doc.query',
  COLLECTION_READ: 'yvijucrm.collection_doc.read',
  AR_REFUND_QUERY: 'yvijucrm.ar_refund_doc.query',
  AR_REFUND_READ: 'yvijucrm.ar_refund_doc.read',
  OTHER_RECEIVABLE_QUERY: 'yvijucrm.other_receivable_doc.query',
  OTHER_RECEIVABLE_READ: 'yvijucrm.other_receivable_doc.read',
  CUSTOMER_CREDIT_LINE_QUERY: 'yvijucrm.customer_credit_line.query',
  CUSTOMER_CREDIT_LINE_READ: 'yvijucrm.customer_credit_line.read',
} as const;

export type ErpMethod = (typeof ERP_METHOD)[keyof typeof ERP_METHOD];

/** Every `.query` method in the API index, in the doc's own order. */
export const ERP_QUERY_METHODS: ErpMethod[] = [
  ERP_METHOD.SALES_ORDER_QUERY,
  ERP_METHOD.CUSTOMER_CREDIT_QUERY,
  ERP_METHOD.SALES_DELIVERY_QUERY,
  ERP_METHOD.SALES_RETURN_QUERY,
  ERP_METHOD.COLLECTION_QUERY,
  ERP_METHOD.AR_REFUND_QUERY,
  ERP_METHOD.OTHER_RECEIVABLE_QUERY,
  ERP_METHOD.CUSTOMER_QUERY,
  ERP_METHOD.CUSTOMER_CREDIT_LINE_QUERY,
];

/**
 * The `data_keys` fields each `.read` method REQUIRES, per the API doc's "输入字段"
 * (input fields) table. These are NOT uniform: a sales order is keyed on DOC_NO
 * alone, but a collection additionally needs all six organisation codes, and
 * customer_credit needs eight fields including the credit area.
 *
 * Sending a partial key set is why an otherwise-correct `.read` gets rejected.
 * Use readKeysFor() to assemble one and find out what is missing up front.
 */
const ORG_KEY_FIELDS = [
  'Owner_Org_RTK',
  'Owner_Org_COMPANY_COMPANY_CODE',
  'Owner_Org_PLANT_PLANT_CODE',
  'Owner_Org_SALES_CENTER_SALES_CENTER_CODE',
  'Owner_Org_SUPPLY_CENTER_SUPPLY_CENTER_CODE',
  'Owner_Org_SERVICE_CENTER_SERVICE_CENTER_CODE',
] as const;

export const READ_KEY_FIELDS: Record<string, readonly string[]> = {
  [ERP_METHOD.SALES_ORDER_READ]: ['DOC_NO'],
  [ERP_METHOD.SALES_DELIVERY_READ]: ['DOC_NO'],
  [ERP_METHOD.SALES_RETURN_READ]: ['DOC_NO'],
  [ERP_METHOD.CUSTOMER_READ]: ['CUSTOMER_CODE'],
  [ERP_METHOD.COLLECTION_READ]: [...ORG_KEY_FIELDS, 'DOC_NO'],
  [ERP_METHOD.AR_REFUND_READ]: [...ORG_KEY_FIELDS, 'DOC_NO'],
  [ERP_METHOD.OTHER_RECEIVABLE_READ]: [...ORG_KEY_FIELDS, 'DOC_NO'],
  [ERP_METHOD.CUSTOMER_CREDIT_READ]: [
    ...ORG_KEY_FIELDS,
    'CREDIT_AREA_ID_CREDIT_AREA_CODE',
    'CUSTOMER_ID_CUSTOMER_CODE',
  ],
  [ERP_METHOD.CUSTOMER_CREDIT_LINE_READ]: [
    'CUSTOMER_ID_CUSTOMER_CODE',
    'COMPANY_ID_COMPANY_CODE',
    'CURRENCY_ID_CURRENCY_CODE',
    'CREDIT_MODE',
  ],
};

/**
 * Build a complete `data_keys` entry for a `.read`, reporting which documented
 * fields are missing rather than letting the ERP reject the call opaquely.
 *
 * Values not supplied are emitted as '' — the doc's own sample for
 * sales_order_doc.read sends `{"DOC_NO": ""}`, so an empty string is a legal
 * placeholder, but a caller that meant to supply a value gets it flagged.
 */
export function readKeysFor(
  method: ErpMethod,
  values: Record<string, string | undefined>,
): { keys: Record<string, string>; missing: string[] } {
  const fields = READ_KEY_FIELDS[method] ?? Object.keys(values);
  const keys: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of fields) {
    const value = values[field];
    if (value === undefined || value === '') missing.push(field);
    keys[field] = value ?? '';
  }

  return { keys, missing };
}

export interface ErpExecution {
  code: string; // '0' === success
  sql_code?: string;
  description?: string;
  token_id?: string;
}

export interface ErpEnvelope<TParam> {
  std_data: {
    execution: ErpExecution;
    parameter: TParam;
  };
}

/** `query` methods return rows; `isGetCount: true` should also return a total. */
export interface ErpQueryParameter<TRow> {
  rows?: TRow[];
  // Field name for the total is NOT documented. We probe for it at runtime rather
  // than guessing — see ErpClient.extractTotal().
  [key: string]: unknown;
}

/** `read` methods return results under parameter.result.success. */
export interface ErpReadParameter<TRow> {
  result?: {
    success?: TRow[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * The `conditions` syntax is documented NOWHERE in the API docs — no example
 * exists. Treated as opaque until the ERP team confirms it or the probe finds it.
 */
export type ErpCondition = Record<string, unknown>;
export type ErpOrder = Record<string, unknown>;

export interface ErpQueryOptions {
  pageNo?: number;
  pageSize?: number;
  isGetCount?: boolean;
  isGetSchema?: boolean;
  conditions?: ErpCondition[];
  orders?: ErpOrder[];
}

export interface ErpPage<TRow> {
  rows: TRow[];
  pageNo: number;
  pageSize: number;
  /** null when the ERP does not return a count (field name undocumented). */
  total: number | null;
  execution: ErpExecution;
}

// ─── Row shapes ────────────────────────────────────────────────────────────
// Only the fields we actually consume are typed. Every row is indexed so
// undocumented extras survive to the probe output rather than being dropped.

export interface ErpCustomerRow {
  CUSTOMER_ID: string; // Guid — what sales orders reference
  CUSTOMER_CODE: string; // String — what customer.read is keyed on → our erpId
  CUSTOMER_NAME?: string;
  CUSTOMER_FULL_NAME?: string;
  GENERAL_CURRENCY_ID?: string;
  Owner_Dept?: string;
  Owner_Emp?: string;
  [key: string]: unknown;
}

/**
 * A sales-order row is HEADER + ONE DETAIL LINE, flattened.
 *
 * The doc's return-field table for sales_order_doc.query lists the detail
 * table's own primary key (SALES_ORDER_DOC_D_ID) and SequenceNumber alongside
 * the header fields, and its sample response shows them in a single flat object.
 * So the ERP returns one row PER ORDER LINE, and DOC_NO is NOT unique across
 * rows — which is why the raw store keys on SALES_ORDER_DOC_D_ID.
 */
export interface ErpSalesOrderRow {
  SALES_ORDER_DOC_ID: string;
  /** Detail-line primary key — unique per row, unlike DOC_NO. */
  SALES_ORDER_DOC_D_ID?: string;
  SequenceNumber?: number;
  DOC_NO: string; // → our Purchase.erpId (repeats across a multi-line order)
  DOC_DATE?: string;
  ORDER_DATE?: string;
  CUSTOMER_ID?: string; // Guid, NOT the CUSTOMER_CODE — see CONTRACT.md
  ApproveStatus?: string; // values undocumented
  AMT_UNINCLUDE_TAX_OC?: string | number;
  TAX_OC?: string | number;
  QTY_TOTAL?: string | number; // header total (2026-07-28 update)
  PIECES?: number; // cartons or line count? undocumented
  // ── Detail-line fields ────────────────────────────────────────────────────
  ITEM_ID?: string;
  ITEM_DESCRIPTION?: string;
  ITEM_SPECIFICATION?: string;
  BUSINESS_QTY?: string | number;
  BUSINESS_UNIT_ID?: string;
  DELIVERED_BUSINESS_QTY?: string | number;
  [key: string]: unknown;
}

/**
 * CUSTOMER_CREDIT_LINE — the 9th documented object, per customer/company/currency.
 *
 * Carries AR_AMT (应收账款金额, accounts-receivable amount), which is a more
 * direct source for a customer's outstanding balance than CUSTOMER_CREDIT's
 * CREDIT_PAY ("used credit") that we settled for. Ingested so the two can be
 * compared on real data.
 */
export interface ErpCustomerCreditLineRow {
  CUSTOMER_CREDIT_LINE_ID: string;
  COMPANY_ID?: string;
  CUSTOMER_ID?: string; // Guid — resolve via customer_link
  CREDIT_MODE?: string;
  CURRENCY_ID?: string;
  AR_AMT?: string | number; // accounts receivable
  ADV_AMT?: string | number; // advance receipts
  BD_AMT?: string | number; // bad debt
  BR_AMT?: string | number; // notes receivable
  SO_AMT?: string | number; // undelivered order value
  SD_AMT?: string | number; // unsettled delivery value
  SR_AMT?: string | number; // unsettled return value
  [key: string]: unknown;
}

export interface ErpCollectionRow {
  COLLECTION_DOC_ID: string;
  DOC_NO: string; // → our Payment.erpId
  DOC_DATE?: string;
  COLLECTION_AMT_TC?: string | number;
  COLLECTION_AMT_FC?: string | number;
  SETTLEMENT_OBJECT_TYPE?: number;
  // NOTE: no CUSTOMER_ID is documented on this object. That is the blocker.
  [key: string]: unknown;
}

export interface ErpSalesDeliveryRow {
  SALES_DELIVERY_ID: string;
  DOC_NO: string;
  DOC_DATE?: string;
  TRANSACTION_DATE?: string;
  CUSTOMER_ID?: string;
  ISSUED_STATUS?: string;
  DESTINATION?: string;
  PIECES?: number; // likely the true source of "loaded cartons"
  [key: string]: unknown;
}

export interface ErpCustomerCreditRow {
  CUSTOMER_CREDIT_ID: string;
  CUSTOMER_ID?: string;
  CREDIT_AMT?: string | number; // credit limit
  CREDIT_PAY?: string | number; // used credit → candidate for outstandingBalance
  CURRENCY_ID?: string;
  LastModifiedDate?: string;
  [key: string]: unknown;
}
