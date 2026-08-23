import { Global, Module } from '@nestjs/common';
import { DbWatchdog } from './db-watchdog.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, DbWatchdog],
  exports: [PrismaService],
})
export class PrismaModule {}
