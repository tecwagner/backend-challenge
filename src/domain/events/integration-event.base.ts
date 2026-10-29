import { randomUUID } from 'crypto';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
  data: T;
}

export type IntegrationEventJSON<T> = {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  data: T;
};

/**
 * Abstract base for all integration events written to the outbox.
 *
 * Subclasses fix `eventType` and `version` as readonly literal properties.
 * `data` must contain only JSON-primitive types — no Money instances.
 *
 * Requirements: 10.2, 11.1, 11.2
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) {
      (this as { causationId?: string }).causationId = props.causationId;
    }
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze(props.data);
  }

  toJSON(): IntegrationEventJSON<T> {
    const json: IntegrationEventJSON<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
    if (this.causationId !== undefined) {
      json.causationId = this.causationId;
    }
    return json;
  }
}
