import { Injectable, Optional } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { MetricsPort } from '../../application/ports/metrics.port.js';

export interface PrometheusOptions {
  registry?: Registry;
  collectDefault?: boolean;
}

/**
 * Exposes core Prometheus operational metrics for the Wagering Processor.
 * Implements MetricsPort to connect domain/use case reconciliation tracking.
 *
 * Requirements: 6.5, 12.3
 */
@Injectable()
export class PrometheusService implements MetricsPort {
  private readonly registry: Registry;

  // 1. Transactions counter by status and kind
  readonly transactionsTotal: Counter<'status' | 'kind'>;

  // 2. Idempotent replays counter (with optional kind label)
  readonly idempotentReplaysTotal: Counter<'kind'>;

  // 3. Idempotency conflicts counter
  readonly idempotencyConflictsTotal: Counter;

  // 4. Lock conflicts counter
  readonly lockConflictsTotal: Counter;

  // 5. SQS retries counter
  readonly sqsRetriesTotal: Counter;

  // 6. DLQ messages counter
  readonly dlqMessagesTotal: Counter;

  // 7. Outbox lag seconds gauge
  readonly outboxLagSeconds: Gauge;

  // 8. Transaction duration histogram
  readonly transactionDurationSeconds: Histogram<'kind' | 'status'>;

  // 9. Reconciliation divergences counter
  readonly reconciliationDivergencesTotal: Counter;

  // 10. Pending references gauge
  readonly pendingReferencesTotal: Gauge;

  constructor(@Optional() options?: PrometheusOptions) {
    this.registry = options?.registry ?? new Registry();

    if (options?.collectDefault !== false && process.env['NODE_ENV'] !== 'test') {
      collectDefaultMetrics({ register: this.registry });
    }

    this.transactionsTotal = new Counter({
      name: 'wagering_transactions_total',
      help: 'Total number of wagering transactions processed by status and kind',
      labelNames: ['status', 'kind'],
      registers: [this.registry],
    });

    this.idempotentReplaysTotal = new Counter({
      name: 'wagering_idempotent_replays_total',
      help: 'Total number of idempotent replays served without financial effects',
      labelNames: ['kind'],
      registers: [this.registry],
    });

    this.idempotencyConflictsTotal = new Counter({
      name: 'wagering_idempotency_conflicts_total',
      help: 'Total number of idempotency conflicts detected (same key, different payload)',
      registers: [this.registry],
    });

    this.lockConflictsTotal = new Counter({
      name: 'wagering_lock_conflicts_total',
      help: 'Total number of concurrency / pessimistic lock conflicts encountered',
      registers: [this.registry],
    });

    this.sqsRetriesTotal = new Counter({
      name: 'wagering_sqs_retries_total',
      help: 'Total number of SQS message retries due to transient errors',
      registers: [this.registry],
    });

    this.dlqMessagesTotal = new Counter({
      name: 'wagering_dlq_messages_total',
      help: 'Total number of SQS messages routed to Dead Letter Queue',
      registers: [this.registry],
    });

    this.outboxLagSeconds = new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'Current lag in seconds of unpublished due messages in the outbox',
      registers: [this.registry],
    });

    this.transactionDurationSeconds = new Histogram({
      name: 'wagering_transaction_duration_seconds',
      help: 'Latency distribution of transaction execution in seconds',
      labelNames: ['kind', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.reconciliationDivergencesTotal = new Counter({
      name: 'wagering_reconciliation_divergences_total',
      help: 'Total count of detected wallet balance reconciliation divergences',
      registers: [this.registry],
    });

    this.pendingReferencesTotal = new Gauge({
      name: 'wagering_pending_reference_total',
      help: 'Current count of transactions in PENDING_REFERENCE state awaiting referenced transactions',
      registers: [this.registry],
    });
  }

  // --- Convenience helper methods ---

  incrementTransactions(status: string, kind: string): void {
    this.transactionsTotal.inc({ status, kind });
  }

  incrementIdempotentReplays(kind: string = 'unknown'): void {
    this.idempotentReplaysTotal.inc({ kind });
  }

  incrementIdempotencyConflicts(): void {
    this.idempotencyConflictsTotal.inc();
  }

  incrementLockConflicts(): void {
    this.lockConflictsTotal.inc();
  }

  incrementSqsRetries(): void {
    this.sqsRetriesTotal.inc();
  }

  incrementDlqMessages(): void {
    this.dlqMessagesTotal.inc();
  }

  setOutboxLag(seconds: number): void {
    this.outboxLagSeconds.set(Math.max(0, seconds));
  }

  observeTransactionDuration(seconds: number, labels?: { kind?: string; status?: string }): void {
    this.transactionDurationSeconds.observe(
      {
        kind: labels?.kind ?? 'unknown',
        status: labels?.status ?? 'unknown',
      },
      seconds,
    );
  }

  /**
   * Implements MetricsPort for ReconcileWalletUseCase.
   * Requirements: 6.5, 12.3
   */
  incrementReconciliationDivergences(): void {
    this.reconciliationDivergencesTotal.inc();
  }

  setPendingReferences(count: number): void {
    this.pendingReferencesTotal.set(Math.max(0, count));
  }

  // --- Registry retrieval for scraping ---

  async getMetrics(): Promise<string> {
    return await this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  getRegistry(): Registry {
    return this.registry;
  }

  clear(): void {
    this.registry.clear();
  }
}
