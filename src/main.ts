import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('ErpSync');
  const config = app.get(ConfigService);

  // In-flight sync jobs must finish before the process exits, or we leave
  // half-written batches behind on a rolling deploy.
  app.enableShutdownHooks();

  const port = config.getOrThrow<number>('SYNC_PORT');
  await app.listen(port);

  logger.log(`erp-sync listening on :${port}`);
  logger.log(`ERP base URL: ${config.get<string>('ERP_BASE_URL')}`);
  if (!config.get<boolean>('SYNC_ENABLED')) {
    logger.warn('SYNC_ENABLED=false — jobs are registered but will not run');
  }
}

void bootstrap();
