import { randomUUID } from 'crypto';
import type { FastifyReply } from 'fastify';
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction/process-wager-transaction.use-case.js';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepositoryPort,
} from '../../application/ports/wager-transaction.repository.port.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction.enums.js';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.entity.js';
import { IdempotencyConflictError } from '../../application/errors/application.errors.js';
import {
  CreateWagerTransactionRequestDto,
  type WagerTransactionDetailsDto,
  type WagerTransactionResponseDto,
} from '../dtos/wagering.dto.js';

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly wagerTxRepo: WagerTransactionRepositoryPort,
  ) {}

  /**
   * POST /wagering/transactions
   * Processes a wagering transaction (BET, WIN, LOSS, REFUND, ROLLBACK) with
   * persistent idempotency and pessimistic locking.
   *
   * Requirements: 3.1, 3.2, 4.1, 4.2
   */
  @Post('wagering/transactions')
  async createTransaction(
    @Body() body: CreateWagerTransactionRequestDto,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<WagerTransactionResponseDto> {
    const rawIdempotencyKey =
      headers['idempotency-key'] ??
      headers['Idempotency-Key'] ??
      headers['IDEMPOTENCY-KEY'];

    if (!rawIdempotencyKey || rawIdempotencyKey.trim().length === 0) {
      throw new UnprocessableEntityException('Idempotency-Key header is required');
    }

    const idempotencyKey = rawIdempotencyKey.trim();
    const correlationId =
      headers['x-correlation-id'] ??
      headers['X-Correlation-Id'] ??
      randomUUID();

    try {
      const result = await this.processWagerTransactionUseCase.execute({
        idempotencyKey,
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId,
        gameId: body.gameId,
        kind: body.kind,
        money: {
          amount: body.money.amount,
          currency: body.money.currency.toUpperCase(),
        },
        referenceExternalTransactionId: body.referenceExternalTransactionId,
        correlationId,
      });

      if (result.status === WagerTransactionStatus.PendingReference) {
        res.status(HttpStatus.ACCEPTED); // 202
      } else if (result.status === WagerTransactionStatus.Rejected) {
        res.status(HttpStatus.UNPROCESSABLE_ENTITY); // 422
      } else {
        res.status(HttpStatus.OK); // 200
      }

      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance,
        idempotentReplay: result.idempotentReplay,
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      };
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  /**
   * GET /wagering/transactions/:transactionId
   * Retrieves transaction details by internal UUID.
   *
   * Requirements: 3.7
   */
  @Get('wagering/transactions/:transactionId')
  async getTransactionById(
    @Param('transactionId', new ParseUUIDPipe({ version: '4' })) transactionId: string,
  ): Promise<WagerTransactionDetailsDto> {
    const tx = await this.wagerTxRepo.findById(transactionId);
    if (!tx) {
      throw new NotFoundException(`Transaction not found: ${transactionId}`);
    }

    return this.mapToDetailsDto(tx);
  }

  /**
   * GET /providers/:providerId/wagering/transactions/:externalTransactionId
   * Retrieves transaction details by provider and external transaction ID.
   *
   * Requirements: 3.8
   */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionDetailsDto> {
    const tx = await this.wagerTxRepo.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new NotFoundException(
        `Transaction not found for provider '${providerId}' and external ID '${externalTransactionId}'`,
      );
    }

    return this.mapToDetailsDto(tx);
  }

  private mapToDetailsDto(tx: WagerTransaction): WagerTransactionDetailsDto {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      processedAt: tx.processedAt?.toISOString() ?? null,
      createdAt: tx.createdAt.toISOString(),
    };
  }
}
