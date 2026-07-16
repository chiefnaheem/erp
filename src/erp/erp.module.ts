import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ErpClient } from './erp.client';
import { ErpConnectivityService } from './erp.connectivity';

@Module({
  imports: [HttpModule],
  providers: [ErpClient, ErpConnectivityService],
  exports: [ErpClient],
})
export class ErpModule {}
