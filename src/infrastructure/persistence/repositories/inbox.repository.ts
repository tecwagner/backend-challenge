import { EntityManager } from '@mikro-orm/core';
import type { InboxRepositoryPort } from '../../../application/ports/inbox.repository.port.js';
import { InboxMessage } from '../../../domain/outbox/inbox-message.js';
import {
  InboxMessageSchema,
  type InboxMessageOrmEntity,
} from '../entities/inbox-message.orm-entity.js';

export class InboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insertOrFind(
    message: InboxMessage,
  ): Promise<{ message: InboxMessage; isDuplicate: boolean }> {
    const conn = this.em.getConnection();

    // INSERT ON CONFLICT DO NOTHING — atômico, sem race condition entre instâncias.
    const result = await conn.execute(
      `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [message.messageId, message.consumerName, message.payloadHash, message.receivedAt],
    );

    const inserted = (result as { rowCount?: number; affectedRows?: number })?.rowCount === 1
      || (result as { rowCount?: number; affectedRows?: number })?.affectedRows === 1;

    if (inserted) {
      return { message, isDuplicate: false };
    }

    const existing = await this.em.findOne(InboxMessageSchema, {
      messageId: message.messageId,
      consumerName: message.consumerName,
    });

    const row = existing!;
    return {
      message: InboxMessage.rehydrate({
        messageId: row.messageId,
        consumerName: row.consumerName,
        payloadHash: row.payloadHash,
        receivedAt: row.receivedAt,
        processedAt: row.processedAt,
      }),
      isDuplicate: true,
    };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const conn = this.em.getConnection();
    await conn.execute(
      `UPDATE inbox_messages SET processed_at = ?
       WHERE consumer_name = ? AND message_id = ?`,
      [message.processedAt ?? new Date(), message.consumerName, message.messageId],
    );
  }
}
