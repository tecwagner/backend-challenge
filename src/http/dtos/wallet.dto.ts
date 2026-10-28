import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class InitialBalanceDto {
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

export class CreateWalletRequestDto {
  @IsDefined()
  @IsNotEmpty()
  @IsUUID('4', { message: 'playerId must be a valid UUID v4' })
  playerId!: string;

  @IsDefined()
  @IsNotEmpty()
  @IsString()
  @Length(3, 3, { message: 'currency must be a 3-character ISO-4217 code' })
  currency!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InitialBalanceDto)
  initialBalance?: InitialBalanceDto;
}

export class GetLedgerQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}

export interface MoneyValueDto {
  amount: string;
  currency: string;
}

export interface WalletResponseDto {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyValueDto;
  version: number;
}

export interface LedgerEntryResponseDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: MoneyValueDto;
  balanceBefore: MoneyValueDto;
  balanceAfter: MoneyValueDto;
  createdAt: string;
}

export interface LedgerPageResponseDto {
  items: LedgerEntryResponseDto[];
  nextCursor: string | null;
}

export interface ReconcileWalletResponseDto {
  consistent: boolean;
  storedBalance: MoneyValueDto;
  calculatedBalance: MoneyValueDto;
  difference: MoneyValueDto;
  checkedEntries: number;
}
