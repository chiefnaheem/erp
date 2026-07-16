import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErpClient } from './erp.client';
import { ErpApiError, ErpTransportError } from './erp.errors';
import { ERP_METHOD } from './erp.types';

/**
 * On startup, make one lightweight real call to the ERP and log whether it
 * connected. This is the first thing to look for in the logs after wiring in
 * ERP_BASE_URL / ERP_API_KEY — it answers "can this app actually reach the ERP?"
 * before waiting for the first scheduled sync.
 *
 * It never crashes boot: a failed check is logged and the app still comes up and
 * serves /health, so the worker can be deployed ahead of working credentials.
 */
@Injectable()
export class ErpConnectivityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ErpConnectivityService.name);

  constructor(
    private readonly erp: ErpClient,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const url = this.config.get<string>('ERP_BASE_URL');

    if (!this.config.get<boolean>('SYNC_ENABLED')) {
      this.logger.log(
        `ERP connectivity check skipped (SYNC_ENABLED=false). Target would be ${url}`,
      );
      return;
    }

    this.logger.log(`Checking ERP connectivity at ${url} …`);

    try {
      // customer.query with pageSize 1 is the lightest real call that proves the
      // URL, the digi-key, and the protocol all work end to end.
      const page = await this.erp.query(ERP_METHOD.CUSTOMER_QUERY, { pageSize: 1 });
      this.logger.log(
        `✅ Successfully connected to ERP at ${url} — customer.query responded ` +
          `(execution code ${page.execution.code}, ${page.rows.length} row sampled).`,
      );
    } catch (error) {
      if (error instanceof ErpTransportError) {
        // Could not reach the URL at all — wrong host, DNS, firewall, timeout.
        this.logger.error(
          `❌ Could NOT reach the ERP at ${url}. Check ERP_BASE_URL and network access. ${error.message}`,
        );
      } else if (error instanceof ErpApiError) {
        // Reached the ERP, but it rejected the call — usually a bad digi-key or
        // insufficient permission. Connectivity is fine; credentials are not.
        this.logger.warn(
          `⚠️ Reached the ERP at ${url}, but the call was rejected — likely a bad ` +
            `ERP_API_KEY or permission issue. ${error.message}`,
        );
      } else {
        this.logger.error(
          `❌ ERP connectivity check failed at ${url}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      // Deliberately not rethrown — the app must still boot.
    }
  }
}
