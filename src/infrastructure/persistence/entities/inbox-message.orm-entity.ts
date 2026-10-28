import { EntitySchema } from '@mikro-orm/core';

export interface InboxMessageOrmEntity {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageOrmEntity>({
  name: 'InboxMessage',
  tableName: 'inbox_messages',
  properties: {
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: { type: 'Date', fieldName: 'received_at', columnType: 'timestamptz' },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});
