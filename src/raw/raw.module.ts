import { Module } from '@nestjs/common';
import { ProjectionRepository } from './projection.repository';
import { RawMigrator } from './raw.migrator';
import { RawRepository } from './raw.repository';

@Module({
  providers: [RawMigrator, RawRepository, ProjectionRepository],
  exports: [RawRepository, ProjectionRepository],
})
export class RawModule {}
