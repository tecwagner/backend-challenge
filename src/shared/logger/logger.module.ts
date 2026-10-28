import { Global, Module } from '@nestjs/common';
import { StructuredLogger } from './structured-logger.js';
import { CorrelationIdMiddleware } from '../correlation-id.middleware.js';

@Global()
@Module({
  providers: [StructuredLogger, CorrelationIdMiddleware],
  exports: [StructuredLogger, CorrelationIdMiddleware],
})
export class LoggerModule {}
