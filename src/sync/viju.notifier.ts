import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Post-run nudges to the Viju backend API.
 *
 * Both endpoints re-derive a column from the raw feed the projector has just
 * refreshed. They exist because the projector was unreliable, and they stay
 * wired up now that it is not — they are cheap, they take no body, and calling
 * them twice is the same as calling them once:
 *
 *   POST /api/v1/erp/sync/account-balance   re-derives balances from the credit feed
 *   POST /api/v1/erp/sync/order-status      re-derives Purchase.status from the order feed
 *
 * The second one is load-bearing rather than belt-and-braces: this service
 * deliberately does NOT write Purchase.status on update (the app's own LOADED /
 * DISPATCHED states have no ERP counterpart and would be clobbered), so the
 * backend's reconciler is what carries an ERP status change through.
 *
 * A failure here NEVER fails the sync run. The data is already committed; a
 * missed nudge costs one cycle of staleness, not correctness.
 */
@Injectable()
export class VijuNotifier {
  private readonly logger = new Logger(VijuNotifier.name);
  private warnedUnconfigured = false;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get baseUrl(): string | undefined {
    const raw = this.config.get<string>('VIJU_API_BASE_URL');
    return raw ? raw.replace(/\/+$/, '') : undefined;
  }

  /**
   * The backend's OWN `ERP_API_KEY` — the shared secret it expects in
   * `x-api-key`. Deliberately a separate variable from this app's ERP_API_KEY,
   * which is the ERP's digi-key: they are different secrets that happen to share
   * a name across the two repos, and sending one where the other is expected
   * would leak an ERP credential to the wrong host.
   */
  private get apiKey(): string | undefined {
    return this.config.get<string>('VIJU_API_KEY');
  }

  async notifySyncComplete(): Promise<void> {
    const baseUrl = this.baseUrl;
    const apiKey = this.apiKey;

    if (!baseUrl || !apiKey) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.warn(
          'VIJU_API_BASE_URL / VIJU_API_KEY are not set — skipping the post-sync ' +
            'reconcile calls. Purchase.status changes will not reach the app until ' +
            'the backend reconciler is triggered another way.',
        );
      }
      return;
    }

    await this.post(baseUrl, apiKey, '/api/v1/erp/sync/account-balance');
    await this.post(baseUrl, apiKey, '/api/v1/erp/sync/order-status');
  }

  private async post(baseUrl: string, apiKey: string, path: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const response = await firstValueFrom(
        this.http.post(
          `${baseUrl}${path}`,
          {},
          {
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            timeout: this.config.get<number>('VIJU_API_TIMEOUT_MS') ?? 30_000,
          },
        ),
      );
      this.logger.log(
        `${path} → ${response.status} in ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      const detail =
        (error as { response?: { status?: number } })?.response?.status ??
        (error instanceof Error ? error.message : String(error));
      this.logger.error(
        `${path} failed after ${Date.now() - startedAt}ms — ${detail}. ` +
          `The sync itself succeeded; this is a missed reconcile, not lost data.`,
      );
    }
  }
}
