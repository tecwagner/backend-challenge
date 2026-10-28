import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { EntityManager } from '@mikro-orm/core';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface HealthCheckResult {
  status: 'ok' | 'error';
  uptime?: number;
  checks?: {
    postgres: 'up' | 'down';
    sqs: 'up' | 'down';
  };
}

export const SQS_CLIENT_TOKEN = Symbol('SQS_CLIENT_TOKEN');

@Controller('health')
export class HealthController {
  private readonly sqsClient: SQSClient;

  constructor(
    @Optional() private readonly em?: EntityManager,
    @Optional() @Inject(SQS_CLIENT_TOKEN) sqsClient?: SQSClient,
  ) {
    if (sqsClient) {
      this.sqsClient = sqsClient;
    } else {
      this.sqsClient = new SQSClient({
        region: process.env['AWS_REGION'] ?? 'us-east-1',
        endpoint: process.env['AWS_ENDPOINT'] ?? 'http://localhost:4566',
        credentials: {
          accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
          secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
        },
      });
    }
  }

  /**
   * GET /health/live
   * Liveness probe — indicates that the Node/Bun process is running.
   *
   * Requirement 12.4, 13.4: returns HTTP 200 without requiring authentication.
   */
  @Get('live')
  getLive(): HealthCheckResult {
    return {
      status: 'ok',
      uptime: process.uptime(),
    };
  }

  /**
   * GET /health/ready
   * Readiness probe — verifies reachability of PostgreSQL and AWS SQS.
   *
   * Requirement 12.5, 13.4: returns HTTP 200 only if both PostgreSQL and SQS
   * are reachable, without requiring authentication.
   */
  @Get('ready')
  async getReady(
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<HealthCheckResult> {
    const postgresUp = await this.checkPostgres();
    const sqsUp = await this.checkSqs();

    const isHealthy = postgresUp && sqsUp;

    if (!isHealthy) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE); // 503
    } else {
      res.status(HttpStatus.OK); // 200
    }

    return {
      status: isHealthy ? 'ok' : 'error',
      checks: {
        postgres: postgresUp ? 'up' : 'down',
        sqs: sqsUp ? 'up' : 'down',
      },
    };
  }

  private async checkPostgres(): Promise<boolean> {
    if (!this.em) {
      return false;
    }
    try {
      const conn = this.em.getConnection();
      await conn.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async checkSqs(): Promise<boolean> {
    try {
      const abortCtrl = new AbortController();
      const timeout = setTimeout(() => abortCtrl.abort(), 2000);

      await this.sqsClient.send(
        new ListQueuesCommand({ MaxResults: 1 }),
        { abortSignal: abortCtrl.signal },
      );
      clearTimeout(timeout);
      return true;
    } catch {
      return false;
    }
  }
}
