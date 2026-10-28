import { describe, expect, it } from 'bun:test';
import { HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { EntityManager } from '@mikro-orm/core';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { HealthController } from './health.controller.js';

function mockReply(): { reply: FastifyReply; getStatus: () => number } {
  let statusCode = 200;
  const reply = {
    status(code: number) {
      statusCode = code;
      return this;
    },
  } as unknown as FastifyReply;

  return {
    reply,
    getStatus: () => statusCode,
  };
}

describe('HealthController', () => {
  it('GET /health/live returns HTTP 200 with status ok and uptime', () => {
    const controller = new HealthController();
    const res = controller.getLive();

    expect(res.status).toBe('ok');
    expect(typeof res.uptime).toBe('number');
    expect(res.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /health/ready returns HTTP 200 when both PostgreSQL and SQS are up', async () => {
    const mockEm = {
      getConnection: () => ({
        execute: async () => [{ '?column?': 1 }],
      }),
    } as unknown as EntityManager;

    const mockSqs = {
      send: async () => ({ QueueUrls: ['http://localhost:4566/test'] }),
    } as unknown as SQSClient;

    const { reply, getStatus } = mockReply();
    const controller = new HealthController(mockEm, mockSqs);

    const res = await controller.getReady(reply);

    expect(getStatus()).toBe(HttpStatus.OK);
    expect(res.status).toBe('ok');
    expect(res.checks?.postgres).toBe('up');
    expect(res.checks?.sqs).toBe('up');
  });

  it('GET /health/ready returns HTTP 503 when PostgreSQL is down', async () => {
    const mockEm = {
      getConnection: () => ({
        execute: async () => {
          throw new Error('Connection refused');
        },
      }),
    } as unknown as EntityManager;

    const mockSqs = {
      send: async () => ({ QueueUrls: [] }),
    } as unknown as SQSClient;

    const { reply, getStatus } = mockReply();
    const controller = new HealthController(mockEm, mockSqs);

    const res = await controller.getReady(reply);

    expect(getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.status).toBe('error');
    expect(res.checks?.postgres).toBe('down');
    expect(res.checks?.sqs).toBe('up');
  });

  it('GET /health/ready returns HTTP 503 when SQS is down', async () => {
    const mockEm = {
      getConnection: () => ({
        execute: async () => [{ '?column?': 1 }],
      }),
    } as unknown as EntityManager;

    const mockSqs = {
      send: async () => {
        throw new Error('SQS unreachable');
      },
    } as unknown as SQSClient;

    const { reply, getStatus } = mockReply();
    const controller = new HealthController(mockEm, mockSqs);

    const res = await controller.getReady(reply);

    expect(getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.status).toBe('error');
    expect(res.checks?.postgres).toBe('up');
    expect(res.checks?.sqs).toBe('down');
  });

  it('GET /health/ready returns HTTP 503 when EntityManager is undefined', async () => {
    const mockSqs = {
      send: async () => ({ QueueUrls: [] }),
    } as unknown as SQSClient;

    const { reply, getStatus } = mockReply();
    const controller = new HealthController(undefined, mockSqs);

    const res = await controller.getReady(reply);

    expect(getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.checks?.postgres).toBe('down');
  });
});
