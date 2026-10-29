import { Global, Module } from '@nestjs/common';
import { METRICS } from '../../application/ports/metrics.port.js';
import { PrometheusService } from './prometheus.service.js';
import { MetricsController } from './metrics.controller.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    PrometheusService,
    {
      provide: METRICS,
      useExisting: PrometheusService,
    },
  ],
  exports: [PrometheusService, METRICS],
})
export class MetricsModule {}
