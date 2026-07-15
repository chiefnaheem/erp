import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { ErpModule } from './erp/erp.module';
import { RawModule } from './raw/raw.module';
import { SyncModule } from './sync/sync.module';
import { HealthModule } from './health/health.module';

// Resolved from the compiled file, not process.cwd(), so the worker loads the
// same config whether it is launched from here or from a parent directory.
const APP_ROOT = join(__dirname, '..');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // This app's own .env is the ONLY config source — it deliberately does not
      // read a parent repo's .env. That keeps behaviour identical whether the
      // folder sits inside the main repo or is lifted into its own.
      envFilePath: [join(APP_ROOT, '.env')],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ErpModule,
    RawModule,
    SyncModule,
    HealthModule,
  ],
})
export class AppModule {}
