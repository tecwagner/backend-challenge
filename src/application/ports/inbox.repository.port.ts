import type { InboxMessage } from '../../domain/outbox/inbox-message.js';

export interface InboxRepositoryPort {
  /**
   * Attempts to insert a new inbox record.
   * Returns the existing record if (consumerName, messageId) already exists,
   * allowing the caller to detect duplicate deliveries without throwing.
   */
  insertOrFind(message: InboxMessage): Promise<{ message: InboxMessage; isDuplicate: boolean }>;

  /** Persists the processedAt timestamp after successful processing. */
  markProcessed(message: InboxMessage): Promise<void>;
}

export const INBOX_REPOSITORY = Symbol('InboxRepositoryPort');
