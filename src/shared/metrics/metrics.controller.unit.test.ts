import { describe, expect, it, mock } from 'bun:test';
import { MetricsController } from './metrics.controller.js';
import type { PrometheusService } from './prometheus.service.js';

describe('MetricsController', () => {
  it('Requirement 12.3: GET /metrics sets Content-Type and returns Prometheus metrics output', async () => {
    const mockPrometheus = {
      getMetrics: mock(async () => '# HELP wagering_transactions_total\n'),
      getContentType: mock(() => 'text/plain; version=0.0.4; charset=utf-8'),
    } as unknown as PrometheusService;

    const controller = new MetricsController(mockPrometheus);

    let headerName: string | undefined;
    let headerValue: string | undefined;
    const mockRes: any = {
      header(name: string, value: string) {
        headerName = name;
        headerValue = value;
      },
    };

    const result = await controller.getMetrics(mockRes);

    expect(result).toBe('# HELP wagering_transactions_total\n');
    expect(headerName).toBe('Content-Type');
    expect(headerValue).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});
