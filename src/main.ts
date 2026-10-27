import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Pino é o logger padrão do Fastify — configurado aqui para produção.
      // Em desenvolvimento, use pino-pretty como pipe: `bun run dev | pino-pretty`
      logger: {
        level: process.env['LOG_LEVEL'] ?? 'info',
        // Campos base incluídos em todo log (Requirement 12.1)
        base: { service: 'wagering-processor' },
        // Formato ISO-8601 para timestamps (Requirement 11.1)
        timestamp: (): string => `,"time":"${new Date().toISOString()}"`,
      },
    }),
    {
      // Desabilita o logger padrão do NestJS; usamos Pino via Fastify
      bufferLogs: false,
    },
  );

  // ---------------------------------------------------------------------------
  // Graceful shutdown (Requirement 9.7)
  // NestJS habilita os lifecycle hooks que permitem ao SqsConsumerService e
  // outros providers concluírem suas operações em andamento antes de encerrar.
  // ---------------------------------------------------------------------------
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3000);
  // Bind em 0.0.0.0 para funcionar corretamente dentro de containers Docker
  await app.listen(port, '0.0.0.0');

  logger.log(`Wagering Processor listening on port ${port}`);
}

// ---------------------------------------------------------------------------
// Tratamento explícito de sinais para graceful shutdown.
// O NestJS já lida com SIGTERM via enableShutdownHooks(), mas adicionamos
// SIGINT para suporte a Ctrl+C em desenvolvimento.
// ---------------------------------------------------------------------------
process.on('SIGINT', () => {
  logger.log('Received SIGINT — shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.log('Received SIGTERM — shutting down gracefully');
  process.exit(0);
});

bootstrap().catch((err: unknown) => {
  logger.error('Fatal error during bootstrap', err);
  process.exit(1);
});
