import { randomUUID } from 'crypto';
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet/reconcile-wallet.use-case.js';
import { WALLET_REPOSITORY, type WalletRepositoryPort } from '../../application/ports/wallet.repository.port.js';
import { LEDGER_REPOSITORY, type LedgerRepositoryPort } from '../../application/ports/ledger.repository.port.js';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../../application/errors/application.errors.js';
import {
  CreateWalletRequestDto,
  GetLedgerQueryDto,
  type LedgerPageResponseDto,
  type ReconcileWalletResponseDto,
  type WalletResponseDto,
} from '../dtos/wallet.dto.js';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    @Inject(WALLET_REPOSITORY) private readonly walletRepository: WalletRepositoryPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRepository: LedgerRepositoryPort,
  ) {}

  /**
   * POST /wallets
   * Creates a new wallet for a player in a specific currency.
   * If initialBalance > 0 is provided, an OPENING transaction and CREDIT ledger entry are created.
   *
   * Requirements: 2.1, 2.2, 2.3, 6.1
   */
  @Post()
  async createWallet(
    @Body() body: CreateWalletRequestDto,
    @Headers('x-correlation-id') correlationIdHeader?: string,
  ): Promise<WalletResponseDto> {
    const currency = body.currency.toUpperCase();

    if (body.initialBalance && body.initialBalance.currency.toUpperCase() !== currency) {
      throw new UnprocessableEntityException(
        `initialBalance currency (${body.initialBalance.currency}) must match wallet currency (${currency})`,
      );
    }

    const correlationId = correlationIdHeader ?? randomUUID();

    try {
      const result = await this.createWalletUseCase.execute({
        playerId: body.playerId,
        currency,
        initialBalance: body.initialBalance
          ? {
              amount: body.initialBalance.amount,
              currency,
            }
          : undefined,
        correlationId,
      });

      return {
        id: result.walletId,
        playerId: result.playerId,
        currency: result.currency,
        balance: result.balance,
        version: result.version,
      };
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  /**
   * GET /wallets/:walletId
   * Returns id, playerId, currency, balance, and version for a given wallet.
   *
   * Requirements: 2.6
   */
  @Get(':walletId')
  async getWallet(
    @Param('walletId', new ParseUUIDPipe({ version: '4' })) walletId: string,
  ): Promise<WalletResponseDto> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet not found: ${walletId}`);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  /**
   * GET /wallets/:walletId/ledger
   * Returns a cursor-paginated page of ledger entries in chronological order.
   *
   * Requirements: 2.7
   */
  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', new ParseUUIDPipe({ version: '4' })) walletId: string,
    @Query() query: GetLedgerQueryDto,
  ): Promise<LedgerPageResponseDto> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet not found: ${walletId}`);
    }

    const limit = query.limit ?? 50;
    const page = await this.ledgerRepository.findByWalletId(walletId, query.cursor, limit);

    return {
      items: page.entries.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor ?? null,
    };
  }

  /**
   * POST /wallets/:walletId/reconciliation
   * Reconstructs wallet balance from ledger history and compares with stored balance.
   *
   * Requirements: 6.4, 6.5, 6.6
   */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(
    @Param('walletId', new ParseUUIDPipe({ version: '4' })) walletId: string,
  ): Promise<ReconcileWalletResponseDto> {
    try {
      const result = await this.reconcileWalletUseCase.execute(walletId);
      return {
        consistent: result.consistent,
        storedBalance: result.storedBalance,
        calculatedBalance: result.calculatedBalance,
        difference: result.difference,
        checkedEntries: result.checkedEntries,
      };
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
