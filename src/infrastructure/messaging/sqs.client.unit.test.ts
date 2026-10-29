import { describe, expect, it, mock } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SqsClient } from './sqs.client.js';

describe('SqsClient', () => {
  const queueUrl = 'http://localhost:4566/000000000000/wager-transactions.fifo';

  it('receiveMessages sends ReceiveMessageCommand with 20s long-polling and 10 max messages by default', async () => {
    let capturedCmd: any;
    const mockSdkClient = {
      send: mock(async (cmd: any) => {
        capturedCmd = cmd;
        return {
          Messages: [
            { MessageId: 'msg-1', Body: '{"test": true}', ReceiptHandle: 'handle-1' },
          ],
        };
      }),
      destroy: mock(() => {}),
    } as unknown as SQSClient;

    const sqsClient = new SqsClient(mockSdkClient);
    const messages = await sqsClient.receiveMessages(queueUrl);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.MessageId).toBe('msg-1');
    expect(capturedCmd).toBeInstanceOf(ReceiveMessageCommand);
    expect(capturedCmd.input.QueueUrl).toBe(queueUrl);
    expect(capturedCmd.input.MaxNumberOfMessages).toBe(10);
    expect(capturedCmd.input.WaitTimeSeconds).toBe(20);
  });

  it('receiveMessages allows customizing maxMessages, waitTimeSeconds and visibilityTimeout', async () => {
    let capturedCmd: any;
    const mockSdkClient = {
      send: mock(async (cmd: any) => {
        capturedCmd = cmd;
        return { Messages: [] };
      }),
      destroy: mock(() => {}),
    } as unknown as SQSClient;

    const sqsClient = new SqsClient(mockSdkClient);
    const messages = await sqsClient.receiveMessages(queueUrl, 5, 10, 60);

    expect(messages).toHaveLength(0);
    expect(capturedCmd.input.MaxNumberOfMessages).toBe(5);
    expect(capturedCmd.input.WaitTimeSeconds).toBe(10);
    expect(capturedCmd.input.VisibilityTimeout).toBe(60);
  });

  it('deleteMessage sends DeleteMessageCommand with QueueUrl and ReceiptHandle', async () => {
    let capturedCmd: any;
    const mockSdkClient = {
      send: mock(async (cmd: any) => {
        capturedCmd = cmd;
        return {};
      }),
      destroy: mock(() => {}),
    } as unknown as SQSClient;

    const sqsClient = new SqsClient(mockSdkClient);
    await sqsClient.deleteMessage(queueUrl, 'handle-123');

    expect(capturedCmd).toBeInstanceOf(DeleteMessageCommand);
    expect(capturedCmd.input.QueueUrl).toBe(queueUrl);
    expect(capturedCmd.input.ReceiptHandle).toBe('handle-123');
  });

  it('changeMessageVisibility sends ChangeMessageVisibilityCommand with timeout', async () => {
    let capturedCmd: any;
    const mockSdkClient = {
      send: mock(async (cmd: any) => {
        capturedCmd = cmd;
        return {};
      }),
      destroy: mock(() => {}),
    } as unknown as SQSClient;

    const sqsClient = new SqsClient(mockSdkClient);
    await sqsClient.changeMessageVisibility(queueUrl, 'handle-456', 45);

    expect(capturedCmd).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect(capturedCmd.input.QueueUrl).toBe(queueUrl);
    expect(capturedCmd.input.ReceiptHandle).toBe('handle-456');
    expect(capturedCmd.input.VisibilityTimeout).toBe(45);
  });

  it('sendMessage sends SendMessageCommand with FIFO parameters', async () => {
    let capturedCmd: any;
    const mockSdkClient = {
      send: mock(async (cmd: any) => {
        capturedCmd = cmd;
        return { MessageId: 'sent-id-789' };
      }),
      destroy: mock(() => {}),
    } as unknown as SQSClient;

    const sqsClient = new SqsClient(mockSdkClient);
    const result = await sqsClient.sendMessage(
      queueUrl,
      JSON.stringify({ hello: 'world' }),
      'group-1',
      'dedup-1',
    );

    expect(result).toBe('sent-id-789');
    expect(capturedCmd).toBeInstanceOf(SendMessageCommand);
    expect(capturedCmd.input.QueueUrl).toBe(queueUrl);
    expect(capturedCmd.input.MessageBody).toBe('{"hello":"world"}');
    expect(capturedCmd.input.MessageGroupId).toBe('group-1');
    expect(capturedCmd.input.MessageDeduplicationId).toBe('dedup-1');
  });

  it('destroy calls sdk client destroy', () => {
    const destroyMock = mock(() => {});
    const mockSdkClient = {
      send: mock(async () => ({})),
      destroy: destroyMock,
    } as unknown as SQSClient;

    const sqsClient = new SqsClient(mockSdkClient);
    sqsClient.destroy();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
