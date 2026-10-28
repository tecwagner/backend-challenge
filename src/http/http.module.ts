import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApplicationModule } from '../application/application.module.js';
import { WalletController } from './controllers/wallet.controller.js';
import { WageringController } from './controllers/wagering.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { AuthGuard } from './guards/auth.guard.js';
import { DomainExceptionFilter } from './filters/domain-exception.filter.js';
import { PROVIDER_IDENTITY_PORT } from '../infrastructure/auth/provider-identity.port.js';
import { ProviderIdentityAdapter } from '../infrastructure/auth/provider-identity.adapter.js';

@Module({
  imports: [ApplicationModule],
  controllers: [WalletController, WageringController, HealthController],
  providers: [
    AuthGuard,
    DomainExceptionFilter,
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: ProviderIdentityAdapter,
    },
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
  exports: [
    AuthGuard,
    DomainExceptionFilter,
    PROVIDER_IDENTITY_PORT,
  ],
})
export class HttpApiModule {}
