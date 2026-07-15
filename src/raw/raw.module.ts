import { Module } from '@nestjs/common';
import { RawMigrator } from './raw.migrator';
import { RawRepository } from './raw.repository';

@Module({
  providers: [RawMigrator, RawRepository],
  exports: [RawRepository],
})
export class RawModule {}
