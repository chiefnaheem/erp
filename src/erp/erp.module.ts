import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ErpClient } from './erp.client';

@Module({
  imports: [HttpModule],
  providers: [ErpClient],
  exports: [ErpClient],
})
export class ErpModule {}
