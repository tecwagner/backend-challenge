import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import { Injectable, Optional } from '@nestjs/common';

export interface SendMessageOptions {
  messageGroupId?: string;
  messageDeduplicationId?: string;
}

export const SQS_CLIENT = Symbol('SqsClient');

/**
 * Wrapper for AWS SQS Client configuring 20s long-polling, 10 messages max,
 * visibility management, and FIFO queue parameters.
 *
 * Requirements: 9.1, 9.3, 9.5
 */
@Injectable()
export class SqsClient {
  private readonly client: SQSClient;

  constructor(@Optional() clientOrConfig?: SQSClient | SQSClientConfig) {
    if (clientOrConfig && (clientOrConfig instanceof SQSClient || typeof (clientOrConfig as SQSClient).send === 'function')) {
      this.client = clientOrConfig as SQSClient;
    } else {
      this.client = new SQSClient({
        region: process.env['AWS_REGION'] ?? 'us-east-1',
        endpoint: process.env['AWS_ENDPOINT'] ?? 'http://localhost:4566',
        credentials: {
          accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
          secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
        },
        ...clientOrConfig,
      });
    }
  }

  getClient(): SQSClient {
    return this.client;
  }

  /**
   * Receives up to `maxMessages` (default 10) messages with `waitTimeSeconds` (default 20s) long-polling.
   * Requirements: 9.1, 9.3
   */
  async receiveMessages(
    queueUrl: string,
    maxMessages: number = 10,
    waitTimeSeconds: number = 20,
    visibilityTimeout?: number,
  ): Promise<Message[]> {
    const cmd = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: waitTimeSeconds,
      ...(visibilityTimeout !== undefined ? { VisibilityTimeout: visibilityTimeout } : {}),
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    });

    const response = await this.client.send(cmd);
    return response.Messages ?? [];
  }

  /**
   * Deletes a message from the queue after successful commit.
   * Requirements: 9.3
   */
  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const cmd = new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    });
    await this.client.send(cmd);
  }

  /**
   * Changes the visibility timeout of an SQS message (used for backoff retry).
   * Requirements: 9.5
   */
  async changeMessageVisibility(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeout: number,
  ): Promise<void> {
    const cmd = new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: visibilityTimeout,
    });
    await this.client.send(cmd);
  }

  /**
   * Sends a message to the specified queue. Supports FIFO parameters.
   */
  async sendMessage(
    queueUrl: string,
    body: string,
    messageGroupIdOrOptions?: string | SendMessageOptions,
    messageDeduplicationId?: string,
  ): Promise<string | undefined> {
    let groupId: string | undefined;
    let deduplicationId: string | undefined;

    if (typeof messageGroupIdOrOptions === 'object' && messageGroupIdOrOptions !== null) {
      groupId = messageGroupIdOrOptions.messageGroupId;
      deduplicationId = messageGroupIdOrOptions.messageDeduplicationId;
    } else {
      groupId = messageGroupIdOrOptions;
      deduplicationId = messageDeduplicationId;
    }

    const cmd = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      ...(groupId ? { MessageGroupId: groupId } : {}),
      ...(deduplicationId ? { MessageDeduplicationId: deduplicationId } : {}),
    });

    const response = await this.client.send(cmd);
    return response.MessageId;
  }

  destroy(): void {
    this.client.destroy();
  }
}
