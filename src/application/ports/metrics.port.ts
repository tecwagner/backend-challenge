/**
 * Narrow metrics surface used by application use cases.
 * The Prometheus implementation lands in task 15.2; a no-op adapter is wired until then.
 *
 * Requirements: 6.5, 12.3
 */
export interface MetricsPort {
  incrementReconciliationDivergences(): void;
}

export const METRICS = Symbol('MetricsPort');

export class NoopMetrics implements MetricsPort {
  incrementReconciliationDivergences(): void {
    // Intentionally empty until PrometheusService is implemented (task 15.2).
  }
}
