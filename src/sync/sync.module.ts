import { Module } from '@nestjs/common';
import { ErpModule } from '../erp/erp.module';
import { RawModule } from '../raw/raw.module';
import {
  PaymentProjectionJob,
  PurchaseItemProjectionJob,
  StockProjectionJob,
} from './jobs/blocked.jobs';
import {
  ArRefundIngestJob,
  CollectionIngestJob,
  CustomerCreditIngestJob,
  CustomerIngestJob,
  OtherReceivableIngestJob,
  SalesDeliveryIngestJob,
  SalesOrderIngestJob,
  SalesReturnIngestJob,
} from './jobs/ingest.jobs';
import {
  CustomerProjectionJob,
  PurchaseProjectionJob,
} from './jobs/projection.jobs';
import { SyncScheduler } from './sync.scheduler';
import { SyncService } from './sync.service';

@Module({
  imports: [ErpModule, RawModule],
  providers: [
    CustomerIngestJob,
    SalesOrderIngestJob,
    CollectionIngestJob,
    SalesDeliveryIngestJob,
    CustomerCreditIngestJob,
    SalesReturnIngestJob,
    ArRefundIngestJob,
    OtherReceivableIngestJob,
    CustomerProjectionJob,
    PurchaseProjectionJob,
    StockProjectionJob,
    PurchaseItemProjectionJob,
    PaymentProjectionJob,
    SyncService,
    SyncScheduler,
  ],
  exports: [SyncService],
})
export class SyncModule {}
