/**
 * Concurrency Test Harness Setup.
 * Reuses the integration test environment (Testcontainers / Docker Compose)
 * ensuring PostgreSQL with connection pooling and LocalStack SQS FIFO are active.
 *
 * Requirements: 15.3, 15.5
 */
export {
  startTestEnvironment,
  stopTestEnvironment,
  cleanDatabase,
  purgeTestQueues,
  type TestEnvironmentContext,
} from '../integration/setup.js';
