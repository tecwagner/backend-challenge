import { randomUUID } from 'crypto';

/** Minimal shape required from an IntegrationEvent to enqueue it. */
export interface EnqueueableEvent {
  eventId: string;
  aggregateId: string;
  eventType: string;
  occurredAt: Date;
  toJSON(): Record<string, unknown>;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const MAX_BACKOFF_MS = 300_000; // 300 s

/**
 * OutboxMessage persists an integration event for reliable, at-least-once
 * publishing after the originating transaction commits.
 *
 * Backoff: min(2^attempts * 1000 ms, 300 000 ms)
 *
 * Requirements: 10.1, 10.7
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: EnqueueableEvent): OutboxMessage {
    return new OutboxMessage(
      randomUUID(),
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      new Date(), // immediately eligible
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (this._nextAttemptAt === undefined) return true;
    return now >= this._nextAttemptAt;
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Increments attempts and schedules next retry with exponential backoff. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delayMs = Math.min(Math.pow(2, this._attempts) * 1_000, MAX_BACKOFF_MS);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
