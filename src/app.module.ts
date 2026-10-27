import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

/**
 * AppModule — módulo raiz da aplicação.
 *
 * Importa módulos de infraestrutura conforme forem implementados.
 * Os marcadores "TODO" indicam onde novos módulos devem ser registrados:
 *
 *  - ScheduleModule     → task 14.1 (PendingReferenceWorker)
 *  - SqsModule          → task 12.x (SqsConsumerService)
 *  - HttpModule (HTTP)  → task 11.x (WalletController, WageringController, HealthController)
 *  - MetricsModule      → task 15.2 (PrometheusService)
 *  - LoggerModule       → task 15.1 (StructuredLogger)
 */
@Module({
  imports: [
    // ---------------------------------------------------------------------------
    // Persistência — MikroORM
    // Configuração carregada de src/infrastructure/persistence/mikro-orm.config.ts
    // via `configPaths` ou variável de ambiente MIKRO_ORM_CLI_CONFIG.
    // ---------------------------------------------------------------------------
    MikroOrmModule.forRoot({
      driver: PostgreSqlDriver,
      clientUrl: process.env['DATABASE_URL'] ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
      entities: [],
      autoLoadEntities: true,
      discovery: { warnWhenNoEntities: false },
      migrations: {
        path: 'src/infrastructure/persistence/migrations',
      },
    }),

    // TODO: ScheduleModule.forRoot() — task 14.1
    // TODO: SqsModule                — task 12.1
    // TODO: HttpApiModule            — task 11.x
    // TODO: MetricsModule            — task 15.2
    // TODO: LoggerModule             — task 15.1
  ],
})
export class AppModule {}
