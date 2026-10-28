import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { Money, type MoneyProps } from '../../../domain/money/money.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../ports/unit-of-work.port.js';
import { WALLET_REPOSITORY, type WalletRepositoryPort } from '../../ports/wallet.repository.port.js';
import { LEDGER_REPOSITORY, type LedgerRepositoryPort } from '../../ports/ledger.repository.port.js';
import { METRICS, type MetricsPort } from '../../ports/metrics.port.js';
import { WalletNotFoundError } from '../../errors/application.errors.js';

export interface ReconcileWalletResult {
  consistent: boolean;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  checkedEntries: number;
}

/**
 * Recalculates wallet balance from the immutable ledger and compares it
 * with the materialized `wallets.balance`. Never silently corrects the balance.
 *
 * Requirements: 6.4, 6.5, 6.6
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepositoryPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    return this.uow.transactional(async () => {
      const wallet = await this.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const sum = await this.ledger.sumByWalletId(walletId);
      const currency = sum.checkedEntries === 0 ? wallet.currency : sum.currency;
      const calculated = Money.from({
        amount: normalizeAmount(sum.calculatedAmount),
        currency,
      });
      const stored = wallet.balance;
      const consistent = stored.equals(calculated);

      if (!consistent) {
        this.metrics.incrementReconciliationDivergences();
      }

      const difference = absDiff(stored, calculated);

      return {
        consistent,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: consistent
          ? Money.zero(wallet.currency).toJSON()
          : difference.toJSON(),
        checkedEntries: sum.checkedEntries,
      };
    });
  }
}

function normalizeAmount(raw: string): string {
  return new Decimal(raw).toFixed(2);
}

function absDiff(a: Money, b: Money): Money {
  if (a.equals(b)) {
    return Money.zero(a.currency);
  }
  return a.isLessThan(b) ? b.subtract(a) : a.subtract(b);
}
