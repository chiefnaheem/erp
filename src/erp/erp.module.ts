import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ErpClient } from './erp.client';
import { ErpConnectivityService } from './erp.connectivity';
import { ErpDebugProbe } from './erp.debug';

@Module({
  imports: [HttpModule],
  providers: [ErpClient, ErpConnectivityService, ErpDebugProbe],
  exports: [ErpClient],
})
export class ErpModule {}
