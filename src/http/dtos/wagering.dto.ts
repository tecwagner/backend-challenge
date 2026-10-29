import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.enums.js';
import type { FailureCode } from '../../domain/wager-transaction/failure-codes.js';
import type { MoneyValueDto } from './wallet.dto.js';

export class WagerTransactionMoneyDto {
  @IsDefined()
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d+\.\d{2}$/, {
    message: 'amount must be a decimal string with exactly 2 decimal places (e.g. "100.00")',
  })
  amount!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsString()
  @Length(3, 3, { message: 'currency must be a 3-character ISO-4217 code' })
  currency!: string;
}

export class CreateWagerTransactionRequestDto {
  @IsDefined()
  @IsNotEmpty()
  @IsString()
  providerId!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsString()
  externalTransactionId!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsUUID('4', { message: 'playerId must be a valid UUID v4' })
  playerId!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsUUID('4', { message: 'walletId must be a valid UUID v4' })
  walletId!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsString()
  roundId!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsString()
  gameId!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsEnum(WagerTransactionKind, {
    message: 'kind must be one of: BET, WIN, LOSS, REFUND, ROLLBACK, OPENING',
  })
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerTransactionMoneyDto)
  money!: WagerTransactionMoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionResponseDto {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyValueDto;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface WagerTransactionDetailsDto {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyValueDto;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  processedAt: string | null;
  createdAt: string;
}
