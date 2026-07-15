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
} as const;

export type ErpMethod = (typeof ERP_METHOD)[keyof typeof ERP_METHOD];

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

export interface ErpSalesOrderRow {
  SALES_ORDER_DOC_ID: string;
  DOC_NO: string; // → our Purchase.erpId
  DOC_DATE?: string;
  ORDER_DATE?: string;
  CUSTOMER_ID?: string; // Guid, NOT the CUSTOMER_CODE — see CONTRACT.md
  ApproveStatus?: string; // values undocumented
  AMT_UNINCLUDE_TAX_OC?: string | number;
  TAX_OC?: string | number;
  PIECES?: number; // cartons or line count? undocumented
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
