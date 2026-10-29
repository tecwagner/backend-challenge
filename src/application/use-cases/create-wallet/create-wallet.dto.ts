import type { MoneyProps } from '../../../domain/money/money.js';

export interface CreateWalletCommand {
  playerId: string;
  currency: string;
  initialBalance?: MoneyProps | undefined;
  correlationId: string;
}

export interface CreateWalletResult {
  walletId: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
}
