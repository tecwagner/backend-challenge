import { describe, expect, it } from 'bun:test';
import { Registry } from 'prom-client';
import { PrometheusService } from './prometheus.service.js';

describe('PrometheusService', () => {
  it('Requirement 12.3: registers and exposes all 10 required Prometheus metrics', async () => {
    const registry = new Registry();
    const service = new PrometheusService({ registry, collectDefault: false });

    // 1. wagering_transactions_total{status,kind}
    service.incrementTransactions('PROCESSED', 'BET');
    service.incrementTransactions('REJECTED', 'BET');

    // 2. wagering_idempotent_replays_total{kind}
    service.incrementIdempotentReplays('BET');

    // 3. wagering_idempotency_conflicts_total
    service.incrementIdempotencyConflicts();

    // 4. wagering_lock_conflicts_total
    service.incrementLockConflicts();

    // 5. wagering_sqs_retries_total
    service.incrementSqsRetries();

    // 6. wagering_dlq_messages_total
    service.incrementDlqMessages();

    // 7. wagering_outbox_lag_seconds
    service.setOutboxLag(4.5);

    // 8. wagering_transaction_duration_seconds{kind,status}
    service.observeTransactionDuration(0.042, { kind: 'BET', status: 'PROCESSED' });

    // 9. wagering_reconciliation_divergences_total
    service.incrementReconciliationDivergences();

    // 10. wagering_pending_reference_total
    service.setPendingReferences(3);

    const output = await service.getMetrics();

    expect(output).toContain('wagering_transactions_total{status="PROCESSED",kind="BET"} 1');
    expect(output).toContain('wagering_transactions_total{status="REJECTED",kind="BET"} 1');
    expect(output).toContain('wagering_idempotent_replays_total{kind="BET"} 1');
    expect(output).toContain('wagering_idempotency_conflicts_total 1');
    expect(output).toContain('wagering_lock_conflicts_total 1');
    expect(output).toContain('wagering_sqs_retries_total 1');
    expect(output).toContain('wagering_dlq_messages_total 1');
    expect(output).toContain('wagering_outbox_lag_seconds 4.5');
    expect(output).toContain('wagering_transaction_duration_seconds_bucket');
    expect(output).toContain('wagering_reconciliation_divergences_total 1');
    expect(output).toContain('wagering_pending_reference_total 3');
  });

  it('getContentType returns Prometheus exposition format content-type', () => {
    const service = new PrometheusService({ registry: new Registry(), collectDefault: false });
    expect(service.getContentType()).toContain('text/plain');
  });
});
