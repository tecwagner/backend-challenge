#!/usr/bin/env bash
# =============================================================================
# scripts/init-aws.sh
#
# Script de inicialização do LocalStack.
# Executado automaticamente pelo LocalStack após o serviço SQS estar pronto
# (diretório /etc/localstack/init/ready.d/).
#
# Cria as filas SQS FIFO necessárias para o Wagering Processor:
#
#   wager-transactions-dlq.fifo  — Dead Letter Queue (criada antes da principal)
#   wager-transactions.fifo      — Fila principal com redirecionamento para DLQ
#   integration-events.fifo      — Fila de eventos de integração (outbox)
#
# Configuração das filas:
#   - FIFO com ContentBasedDeduplication habilitado
#   - DLQ com maxReceiveCount = 5 (conforme design.md: SQS Consumer config)
#   - VisibilityTimeout = 60s (conforme design.md: SQS Consumer config)
#
# Referências:
#   - design.md §SQS Consumer: long-poll 20s, max 10 msgs, visibility 60s, maxReceiveCount 5
#   - README §10: Filas wager-transactions.fifo, wager-transactions-dlq.fifo
# =============================================================================

set -euo pipefail

# Endpoint do LocalStack (dentro do container é sempre localhost:4566)
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

AWS_CMD="aws --endpoint-url=${ENDPOINT} --region=${REGION}"

echo "==> [init-aws] Iniciando criação de filas SQS em ${ENDPOINT}..."

# ---------------------------------------------------------------------------
# 1. Dead Letter Queue — deve ser criada ANTES da fila principal
# ---------------------------------------------------------------------------
echo "--> Criando wager-transactions-dlq.fifo..."
$AWS_CMD sqs create-queue \
  --queue-name "wager-transactions-dlq.fifo" \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "true",
    "VisibilityTimeout": "60"
  }' \
  --output text \
  --query 'QueueUrl'

# Aguarda a fila estar disponível e obtém o ARN da DLQ
DLQ_URL=$($AWS_CMD sqs get-queue-url \
  --queue-name "wager-transactions-dlq.fifo" \
  --query 'QueueUrl' \
  --output text)

DLQ_ARN=$($AWS_CMD sqs get-queue-attributes \
  --queue-url "${DLQ_URL}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

echo "    DLQ ARN: ${DLQ_ARN}"

# ---------------------------------------------------------------------------
# 2. Fila principal — com redirecionamento para DLQ após 5 tentativas
# ---------------------------------------------------------------------------
echo "--> Criando wager-transactions.fifo..."
$AWS_CMD sqs create-queue \
  --queue-name "wager-transactions.fifo" \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"true\",
    \"VisibilityTimeout\": \"60\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" \
  --output text \
  --query 'QueueUrl'

# ---------------------------------------------------------------------------
# 3. Fila de eventos de integração (outbox publisher → consumidores externos)
# ---------------------------------------------------------------------------
echo "--> Criando integration-events.fifo..."
$AWS_CMD sqs create-queue \
  --queue-name "integration-events.fifo" \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "true",
    "VisibilityTimeout": "60"
  }' \
  --output text \
  --query 'QueueUrl'

# ---------------------------------------------------------------------------
# Verificação final
# ---------------------------------------------------------------------------
echo ""
echo "==> [init-aws] Filas criadas com sucesso:"
$AWS_CMD sqs list-queues --output table

echo ""
echo "==> [init-aws] Inicialização concluída."
