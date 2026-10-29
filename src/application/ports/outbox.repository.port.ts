import type { OutboxMessage } from '../../domain/outbox/outbox-message.js';

export interface OutboxRepositoryPort {
  /** Persists a new outbox message within the current transaction. */
  save(message: OutboxMessage): Promise<void>;

  /**
   * Claims up to `limit` unpublished messages due for publishing (nextAttemptAt <= now).
   * Uses SELECT FOR UPDATE SKIP LOCKED so concurrent publishers don't collide.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;

  /** Persists updated attempts/nextAttemptAt/publishedAt after a publish attempt. */
  update(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_REPOSITORY = Symbol('OutboxRepositoryPort');
