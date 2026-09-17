import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ErpModule } from '../erp/erp.module';
import { RawModule } from '../raw/raw.module';
import {
  PurchaseItemProjectionJob,
  StockProjectionJob,
} from './jobs/blocked.jobs';
import {
  ArRefundIngestJob,
  ArTransferIngestJob,
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
  PaymentProjectionJob,
  PurchaseProjectionJob,
} from './jobs/projection.jobs';
import { SyncController } from './sync.controller';
import { SyncScheduler } from './sync.scheduler';
import { SyncService } from './sync.service';
import { VijuNotifier } from './viju.notifier';

@Module({
  // HttpModule backs VijuNotifier's post-run calls to the Viju backend API.
  imports: [HttpModule, ErpModule, RawModule],
  controllers: [SyncController],
  providers: [
    CustomerIngestJob,
    SalesOrderIngestJob,
    CollectionIngestJob,
    SalesDeliveryIngestJob,
    CustomerCreditIngestJob,
    SalesReturnIngestJob,
    ArRefundIngestJob,
    ArTransferIngestJob,
    OtherReceivableIngestJob,
    CustomerProjectionJob,
    PurchaseProjectionJob,
    StockProjectionJob,
    PurchaseItemProjectionJob,
    PaymentProjectionJob,
    VijuNotifier,
    SyncService,
    SyncScheduler,
  ],
  exports: [SyncService, SyncScheduler],
})
export class SyncModule {}
