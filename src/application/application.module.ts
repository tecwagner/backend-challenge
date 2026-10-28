import { Module } from '@nestjs/common';
import { METRICS, NoopMetrics } from './ports/metrics.port.js';
import { PayloadHashService } from './services/payload-hash.service.js';
import { IdempotencyService } from './services/idempotency.service.js';
import { CreateWalletUseCase } from './use-cases/create-wallet/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from './use-cases/process-wager-transaction/process-wager-transaction.use-case.js';
import { ReconcileWalletUseCase } from './use-cases/reconcile-wallet/reconcile-wallet.use-case.js';
import { ReprocessPendingReferencesUseCase } from './use-cases/reprocess-pending-references/reprocess-pending-references.use-case.js';

@Module({
  providers: [
    PayloadHashService,
    IdempotencyService,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    ReprocessPendingReferencesUseCase,
    { provide: METRICS, useClass: NoopMetrics },
  ],
  exports: [
    PayloadHashService,
    IdempotencyService,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    ReprocessPendingReferencesUseCase,
  ],
})
export class ApplicationModule {}
