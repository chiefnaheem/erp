import { Module } from '@nestjs/common';
import { ErpModule } from '../erp/erp.module';
import { RawModule } from '../raw/raw.module';
import {
  PaymentProjectionJob,
  PurchaseItemProjectionJob,
  StockProjectionJob,
} from './jobs/blocked.jobs';
import {
  CollectionIngestJob,
  CustomerCreditIngestJob,
  CustomerIngestJob,
  SalesDeliveryIngestJob,
  SalesOrderIngestJob,
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
