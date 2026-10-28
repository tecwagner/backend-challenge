import type { MoneyProps } from '../../../domain/money/money.js';
import type { FailureCode } from '../../../domain/wager-transaction/failure-codes.js';
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.enums.js';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode | undefined;
}
