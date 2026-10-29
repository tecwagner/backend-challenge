import {
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  ReprocessPendingReferencesUseCase,
  type ReprocessPendingReferencesResult,
} from '../../application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case.js';

export const DEFAULT_PENDING_REF_CRON = '*/30 * * * * *'; // Every 30 seconds

/**
 * Scheduled worker that sweeps pending reference transactions due for reevaluation.
 *
 * Requirements: 8.2, 8.3, 8.4
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isShuttingDown = false;
  private isProcessing = false;
  private currentSweepPromise?: Promise<ReprocessPendingReferencesResult> | undefined;

  constructor(
    private readonly reprocessUseCase: ReprocessPendingReferencesUseCase,
  ) {}

  /**
   * Cron trigger configured via `PENDING_REF_CRON` environment variable,
   * defaulting to every 30 seconds (`* /30 * * * * *`).
   *
   * Requirement: 8.2
   */
  @Cron(process.env['PENDING_REF_CRON'] ?? DEFAULT_PENDING_REF_CRON)
  async handleCron(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    if (this.isProcessing) {
      this.logger.debug('Previous pending reference sweep still in progress, skipping iteration.');
      return;
    }

    this.isProcessing = true;
    try {
      await this.runSweep();
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Runs a single sweep delegating to ReprocessPendingReferencesUseCase.
   * Can be invoked directly by tests or on-demand triggers.
   */
  async runSweep(
    now: Date = new Date(),
    limit = 50,
  ): Promise<ReprocessPendingReferencesResult> {
    if (this.isShuttingDown) {
      return { processed: 0, rejected: 0, stillPending: 0 };
    }

    const sweepTask = this.reprocessUseCase.execute(now, limit);
    this.currentSweepPromise = sweepTask;

    try {
      const result = await sweepTask;
      if (result.processed > 0 || result.rejected > 0) {
        this.logger.log(
          `Pending reference sweep completed: ${result.processed} processed, ${result.rejected} rejected, ${result.stillPending} still pending.`,
        );
      }
      return result;
    } catch (err) {
      this.logger.error('Error during pending reference sweep', err);
      throw err;
    } finally {
      this.currentSweepPromise = undefined;
    }
  }

  get processing(): boolean {
    return this.isProcessing;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`onApplicationShutdown received signal: ${signal ?? 'none'}`);
    this.isShuttingDown = true;
    if (this.currentSweepPromise) {
      try {
        await this.currentSweepPromise;
      } catch {
        // Ignored on shutdown
      }
    }
  }
}
