import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';

export interface TestEnvironmentContext {
  databaseUrl: string;
  sqsEndpoint: string;
  queueUrl: string;
  dlqUrl: string;
  integrationEventsQueueUrl: string;
  orm: MikroORM;
  sqsClient: SQSClient;
}

let postgresContainer: StartedTestContainer | null = null;
let localstackContainer: StartedTestContainer | null = null;
let activeOrm: MikroORM | null = null;
let activeSqsClient: SQSClient | null = null;
let activeContext: TestEnvironmentContext | null = null;

/**
 * Checks whether an external TCP port is accepting connections (used to detect docker-compose.test.yml).
 */
async function isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Starts or connects to the integration test environment (PostgreSQL + LocalStack SQS).
 *
 * Supports two modes (Requirements 15.2, 15.5):
 * 1. Docker Compose Test (alternative): If `TEST_USE_DOCKER_COMPOSE=true` or ports 5433/4567 are listening.
 * 2. Testcontainers (default): Automatically spins up ephemeral containers.
 */
export async function startTestEnvironment(): Promise<TestEnvironmentContext> {
  if (activeContext) {
    return activeContext;
  }

  let databaseUrl: string;
  let sqsEndpoint: string;

  // Check if docker-compose.test.yml is running on host ports 5433 (Postgres) and 4567 (LocalStack)
  const isComposePostgresUp = await isPortOpen('localhost', 5433);
  const isComposeLocalStackUp = await isPortOpen('localhost', 4567);
  const useDockerCompose =
    process.env['TEST_USE_DOCKER_COMPOSE'] === 'true' ||
    (isComposePostgresUp && isComposeLocalStackUp);

  if (useDockerCompose) {
    console.log('[Integration Setup] Using existing docker-compose.test.yml containers (Postgres :5433, LocalStack :4567)...');
    databaseUrl = process.env['TEST_DATABASE_URL'] ?? 'postgresql://wagering:wagering@localhost:5433/wagering_test';
    sqsEndpoint = process.env['TEST_AWS_ENDPOINT'] ?? 'http://localhost:4567';
  } else {
    console.log('[Integration Setup] Starting ephemeral containers via Testcontainers...');

    // 1. PostgreSQL container (postgres:16-alpine)
    postgresContainer = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'wagering',
        POSTGRES_PASSWORD: 'wagering',
        POSTGRES_DB: 'wagering_test',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const pgHost = postgresContainer.getHost();
    const pgPort = postgresContainer.getMappedPort(5432);
    databaseUrl = `postgresql://wagering:wagering@${pgHost}:${pgPort}/wagering_test`;

    // 2. LocalStack container (localstack/localstack:3)
    localstackContainer = await new GenericContainer('localstack/localstack:3')
      .withEnvironment({
        SERVICES: 'sqs',
        DEBUG: '0',
        PERSISTENCE: '0',
      })
      .withExposedPorts(4566)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const lsHost = localstackContainer.getHost();
    const lsPort = localstackContainer.getMappedPort(4566);
    sqsEndpoint = `http://${lsHost}:${lsPort}`;
  }

  // 3. Configure environment variables for runtime
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['AWS_ENDPOINT'] = sqsEndpoint;
  process.env['AWS_REGION'] = 'us-east-1';
  process.env['AWS_ACCESS_KEY_ID'] = 'test';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'test';

  // 4. Initialize SQS Client
  activeSqsClient = new SQSClient({
    endpoint: sqsEndpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    },
  });

  // 5. Ensure FIFO queues exist
  const { queueUrl, dlqUrl, integrationEventsQueueUrl } = await ensureQueues(activeSqsClient);

  process.env['QUEUE_URL'] = queueUrl;
  process.env['DLQ_URL'] = dlqUrl;
  process.env['INTEGRATION_EVENTS_QUEUE_URL'] = integrationEventsQueueUrl;

  // 6. Initialize MikroORM and run migrations
  activeOrm = await MikroORM.init({
    ...config,
    clientUrl: databaseUrl,
    debug: false,
  });

  console.log('[Integration Setup] Running database migrations...');
  await activeOrm.migrator.up();
  console.log('[Integration Setup] Migrations executed successfully.');

  activeContext = {
    databaseUrl,
    sqsEndpoint,
    queueUrl,
    dlqUrl,
    integrationEventsQueueUrl,
    orm: activeOrm,
    sqsClient: activeSqsClient,
  };

  return activeContext;
}

/**
 * Creates the required SQS FIFO queues with DLQ redrive policy if not already existing.
 */
async function ensureQueues(
  client: SQSClient,
): Promise<{ queueUrl: string; dlqUrl: string; integrationEventsQueueUrl: string }> {
  // DLQ Queue
  try {
    await client.send(
      new CreateQueueCommand({
        QueueName: 'wager-transactions-dlq.fifo',
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          VisibilityTimeout: '60',
        },
      }),
    );
  } catch {
    // Already exists
  }

  const dlqUrlRes = await client.send(
    new GetQueueUrlCommand({ QueueName: 'wager-transactions-dlq.fifo' }),
  );
  const dlqUrl = dlqUrlRes.QueueUrl!;

  const dlqAttrRes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = dlqAttrRes.Attributes?.['QueueArn'] ?? 'arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo';

  // Main Queue
  try {
    await client.send(
      new CreateQueueCommand({
        QueueName: 'wager-transactions.fifo',
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          VisibilityTimeout: '60',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: 5,
          }),
        },
      }),
    );
  } catch {
    // Already exists
  }

  const mainUrlRes = await client.send(
    new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
  );
  const queueUrl = mainUrlRes.QueueUrl!;

  // Integration Events Queue
  try {
    await client.send(
      new CreateQueueCommand({
        QueueName: 'integration-events.fifo',
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          VisibilityTimeout: '60',
        },
      }),
    );
  } catch {
    // Already exists
  }

  const eventsUrlRes = await client.send(
    new GetQueueUrlCommand({ QueueName: 'integration-events.fifo' }),
  );
  const integrationEventsQueueUrl = eventsUrlRes.QueueUrl!;

  return { queueUrl, dlqUrl, integrationEventsQueueUrl };
}

/**
 * Truncates all domain tables in cascade to ensure a clean state between test cases.
 */
export async function cleanDatabase(orm?: MikroORM): Promise<void> {
  const targetOrm = orm ?? activeOrm;
  if (!targetOrm) return;

  const conn = targetOrm.em.getConnection();
  await conn.execute(`
    TRUNCATE TABLE
      wallet_ledger_entries,
      outbox_messages,
      inbox_messages,
      wager_transactions,
      wallets
    RESTART IDENTITY CASCADE;
  `);
}

/**
 * Purges messages from all 3 test queues.
 */
export async function purgeTestQueues(sqsClient?: SQSClient): Promise<void> {
  const client = sqsClient ?? activeSqsClient;
  if (!client || !activeContext) return;

  const queues = [
    activeContext.queueUrl,
    activeContext.dlqUrl,
    activeContext.integrationEventsQueueUrl,
  ];

  for (const qUrl of queues) {
    try {
      await client.send(new PurgeQueueCommand({ QueueUrl: qUrl }));
    } catch {
      // SQS Purge has a 60s cooldown limit; ignore if throttled
    }
  }
}

/**
 * Shuts down ORM, SQS client, and Testcontainers (if any were started).
 */
export async function stopTestEnvironment(): Promise<void> {
  if (activeOrm) {
    await activeOrm.close();
    activeOrm = null;
  }

  if (activeSqsClient) {
    activeSqsClient.destroy();
    activeSqsClient = null;
  }

  if (postgresContainer) {
    await postgresContainer.stop();
    postgresContainer = null;
  }

  if (localstackContainer) {
    await localstackContainer.stop();
    localstackContainer = null;
  }

  activeContext = null;
}
