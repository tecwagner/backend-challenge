import { EntityManager } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepositoryPort } from '../../../application/ports/outbox.repository.port.js';
import { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import {
  OutboxMessageSchema,
  type OutboxMessageOrmEntity,
} from '../entities/outbox-message.orm-entity.js';

export class OutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async save(message: OutboxMessage): Promise<void> {
    this.em.persist(
      this.em.create(OutboxMessageSchema, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload as Record<string, unknown>,
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt,
      }),
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // SELECT FOR UPDATE SKIP LOCKED — publishers concorrentes não colidem.
    const sqlEm = this.em as SqlEntityManager;
    const rows = await sqlEm.execute<
      Array<{
        id: string;
        aggregateId: string;
        eventType: string;
        payload: Record<string, unknown>;
        occurredAt: Date;
        attempts: number;
        nextAttemptAt: Date | null;
        publishedAt: Date | null;
      }>
    >(
      `SELECT id,
              aggregate_id   AS "aggregateId",
              event_type     AS "eventType",
              payload,
              occurred_at    AS "occurredAt",
              attempts,
              next_attempt_at AS "nextAttemptAt",
              published_at   AS "publishedAt"
       FROM outbox_messages
       WHERE published_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY next_attempt_at ASC NULLS FIRST
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );

    return rows.map((r: {
      id: string;
      aggregateId: string;
      eventType: string;
      payload: Record<string, unknown>;
      occurredAt: Date;
      attempts: number;
      nextAttemptAt: Date | null;
      publishedAt: Date | null;
    }) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregateId,
        eventType: r.eventType,
        payload: r.payload,
        occurredAt: new Date(r.occurredAt),
        attempts: Number(r.attempts),
        nextAttemptAt: r.nextAttemptAt ? new Date(r.nextAttemptAt) : undefined,
        publishedAt: r.publishedAt ? new Date(r.publishedAt) : undefined,
      }),
    );
  }

  async update(message: OutboxMessage): Promise<void> {
    const sqlEm = this.em as SqlEntityManager;
    await sqlEm.execute(
      `UPDATE outbox_messages
       SET attempts = ?, next_attempt_at = ?, published_at = ?
       WHERE id = ?`,
      [
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
        message.id,
      ],
    );
  }
}
