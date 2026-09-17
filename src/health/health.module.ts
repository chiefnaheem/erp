import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { HealthController } from './health.controller';

@Module({
  // For the freshness verdict only — see HealthController. Nothing in
  // SyncModule imports this one, so there is no cycle.
  imports: [SyncModule],
  controllers: [HealthController],
})
export class HealthModule {}
