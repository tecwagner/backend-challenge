import { EntitySchema } from '@mikro-orm/core';

export interface OutboxMessageOrmEntity {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageOrmEntity>({
  name: 'OutboxMessage',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', columnType: 'timestamptz', nullable: true },
  },
});
