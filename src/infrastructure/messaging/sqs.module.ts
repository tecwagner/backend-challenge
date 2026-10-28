import { Global, Module } from '@nestjs/common';
import { SqsClient, SQS_CLIENT } from './sqs.client.js';
import { SqsConsumerService } from './sqs-consumer.service.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';
import { ApplicationModule } from '../../application/application.module.js';

@Global()
@Module({
  imports: [ApplicationModule],
  providers: [
    SqsClient,
    {
      provide: SQS_CLIENT,
      useExisting: SqsClient,
    },
    SqsConsumerService,
    OutboxPublisherWorker,
  ],
  exports: [SqsClient, SQS_CLIENT, SqsConsumerService, OutboxPublisherWorker],
})
export class SqsModule {}
