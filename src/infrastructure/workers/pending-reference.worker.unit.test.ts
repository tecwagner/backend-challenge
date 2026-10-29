import { describe, expect, it, mock } from 'bun:test';
import type { ReprocessPendingReferencesResult } from '../../application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';

describe('PendingReferenceWorker', () => {
  it('Requirement 8.2: delegates sweep to ReprocessPendingReferencesUseCase', async () => {
    let capturedNow: Date | undefined;
    let capturedLimit: number | undefined;

    const mockUseCase = {
      execute: mock(async (now?: Date, limit?: number): Promise<ReprocessPendingReferencesResult> => {
        capturedNow = now;
        capturedLimit = limit;
        return { processed: 2, rejected: 1, stillPending: 3 };
      }),
    } as any;

    const worker = new PendingReferenceWorker(mockUseCase);
    const testDate = new Date('2026-10-28T14:30:00.000Z');

    const result = await worker.runSweep(testDate, 25);

    expect(result.processed).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.stillPending).toBe(3);
    expect(capturedNow).toBe(testDate);
    expect(capturedLimit).toBe(25);
    expect(mockUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('handleCron executes runSweep and prevents overlapping runs', async () => {
    let resolveSweep!: () => void;
    const sweepPending = new Promise<void>((resolve) => {
      resolveSweep = resolve;
    });

    const mockUseCase = {
      execute: mock(async (): Promise<ReprocessPendingReferencesResult> => {
        await sweepPending;
        return { processed: 1, rejected: 0, stillPending: 0 };
      }),
    } as any;

    const worker = new PendingReferenceWorker(mockUseCase);

    // Start first cron execution (blocks until resolveSweep)
    const firstRunPromise = worker.handleCron();
    expect(worker.processing).toBe(true);

    // Second cron execution while first is in-flight: should skip
    await worker.handleCron();
    expect(mockUseCase.execute).toHaveBeenCalledTimes(1);

    // Release first run
    resolveSweep();
    await firstRunPromise;
    expect(worker.processing).toBe(false);
  });

  it('gracefully handles shutdown and stops subsequent runs', async () => {
    const mockUseCase = {
      execute: mock(async (): Promise<ReprocessPendingReferencesResult> => {
        return { processed: 0, rejected: 0, stillPending: 0 };
      }),
    } as any;

    const worker = new PendingReferenceWorker(mockUseCase);
    await worker.onApplicationShutdown('SIGTERM');

    const result = await worker.runSweep();
    expect(result.processed).toBe(0);
    expect(mockUseCase.execute).not.toHaveBeenCalled();

    await worker.handleCron();
    expect(mockUseCase.execute).not.toHaveBeenCalled();
  });
});
