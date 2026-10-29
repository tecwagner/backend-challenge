import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  startTestEnvironment,
  stopTestEnvironment,
  cleanDatabase,
  type TestEnvironmentContext,
} from './setup.js';

describe('Integration Test Harness (Setup & Containers)', () => {
  let context: TestEnvironmentContext;

  beforeAll(async () => {
    context = await startTestEnvironment();
  }, 60_000);

  afterAll(async () => {
    await stopTestEnvironment();
  }, 30_000);

  it('Requirement 15.2: connects to real PostgreSQL and executes migrations', async () => {
    expect(context.databaseUrl).toBeDefined();
    expect(context.orm).toBeDefined();

    const conn = context.orm.em.getConnection();
    const rows = await conn.execute<Array<{ tablename: string }>>(`
      SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename ASC;
    `);

    const tableNames = rows.map((r) => r.tablename);
    expect(tableNames).toContain('wallets');
    expect(tableNames).toContain('wager_transactions');
    expect(tableNames).toContain('wallet_ledger_entries');
    expect(tableNames).toContain('inbox_messages');
    expect(tableNames).toContain('outbox_messages');
  });

  it('Requirement 15.2: connects to LocalStack and provisions FIFO queues', async () => {
    expect(context.sqsEndpoint).toBeDefined();
    expect(context.queueUrl).toContain('wager-transactions.fifo');
    expect(context.dlqUrl).toContain('wager-transactions-dlq.fifo');
    expect(context.integrationEventsQueueUrl).toContain('integration-events.fifo');
  });

  it('Requirement 15.2: cleanDatabase truncates tables without violating constraints', async () => {
    await cleanDatabase(context.orm);

    const conn = context.orm.em.getConnection();
    const result = await conn.execute<Array<{ count: string }>>('SELECT COUNT(*) as count FROM wallets;');
    expect(Number(result[0]?.count)).toBe(0);
  });
});
