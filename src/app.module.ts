import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './infrastructure/persistence/mikro-orm.config.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { ApplicationModule } from './application/application.module.js';

/**
 * AppModule — módulo raiz da aplicação.
 *
 * Migrations são executadas manualmente via:
 *   bun run migration:run
 *
 * Os marcadores "TODO" indicam onde novos módulos devem ser registrados:
 *  - ScheduleModule     → task 14.1 (PendingReferenceWorker)
 *  - SqsModule          → task 12.x (SqsConsumerService)
 *  - HttpModule (HTTP)  → task 11.x (WalletController, WageringController, HealthController)
 *  - MetricsModule      → task 15.2 (PrometheusService)
 *  - LoggerModule       → task 15.1 (StructuredLogger)
 */
import { HttpApiModule } from './http/http.module.js';
import { SqsModule } from './infrastructure/messaging/sqs.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    PersistenceModule,
    ApplicationModule,
    HttpApiModule,
    SqsModule,

    // TODO: ScheduleModule.forRoot() — task 14.1
    // TODO: MetricsModule            — task 15.2
    // TODO: LoggerModule             — task 15.1
  ],
})
export class AppModule {}
