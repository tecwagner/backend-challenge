import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PrometheusService } from './prometheus.service.js';

/**
 * Controller exposing Prometheus scraper endpoint GET /metrics.
 * Unauthenticated so standard Prometheus scrapers can collect metrics.
 *
 * Requirements: 12.3
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly prometheus: PrometheusService) {}

  @Get()
  async getMetrics(@Res({ passthrough: true }) res: FastifyReply): Promise<string> {
    if (typeof res.header === 'function') {
      res.header('Content-Type', this.prometheus.getContentType());
    }
    return await this.prometheus.getMetrics();
  }
}
