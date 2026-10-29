# Implementation Plan: Wagering Processor

## Overview

Implementação incremental de um serviço financeiro distribuído em NestJS + Bun + MikroORM + PostgreSQL + SQS (LocalStack). As tarefas estão organizadas em três dias de trabalho, priorizando as áreas de maior pontuação: correção financeira (20pts), concorrência (20pts), idempotência (15pts) e mensageria (15pts).

Cada tarefa representa um commit atômico e referencia explicitamente os requisitos que cobre.

---

## Tasks

### Dia 1 — Core Crítico (Correção Financeira + Concorrência + Idempotência)

- [x] 1. Setup do projeto e infraestrutura base
  - [x] 1.1 Inicializar repositório Bun + NestJS com TypeScript strict
    - Criar `package.json` com Bun 1.x como runtime/test runner
    - Configurar `tsconfig.json` com `strict: true`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
    - Instalar dependências: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/nestjs`, `decimal.js`, `@aws-sdk/client-sqs`, `pino`, `prom-client`
    - Instalar devDependencies: `@types/node`, `bun-types`, `testcontainers`
    - _Requirements: stack obrigatória (README §4)_

  - [x] 1.2 Configurar Docker Compose com PostgreSQL e LocalStack
    - Criar `docker-compose.yml` com serviços `app`, `postgres:16-alpine` e `localstack/localstack:3`
    - Criar `docker-compose.test.yml` para ambiente de testes (PostgreSQL + LocalStack isolados)
    - Configurar variáveis de ambiente: `DATABASE_URL`, `AWS_ENDPOINT`, `QUEUE_URL`
    - _Requirements: stack obrigatória (README §4)_

  - [x] 1.3 Criar estrutura de pastas e `app.module.ts`
    - Criar estrutura `src/domain/`, `src/application/`, `src/infrastructure/`, `src/http/`, `src/shared/`
    - Criar `src/main.ts` com NestJS + Fastify adapter e graceful shutdown
    - Criar `src/app.module.ts` importando módulos de infraestrutura
    - _Requirements: 13.1, 13.2_

- [x] 2. Value Object Money e erros de domínio
  - [-] 2.1 Implementar `Money` value object imutável
    - Criar `src/domain/money/money.ts` com construtor privado e factories `from`, `zero`
    - Implementar operações `add`, `subtract`, `negate` retornando novas instâncias
    - Implementar `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`
    - Usar `decimal.js` com `Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_EVEN })`
    - Regex de validação: `/^\d+(\.\d{1,2})?$/` rejeita notação científica, vazio, negativo, > 2 casas
    - Criar `src/domain/money/money.errors.ts` com `InvalidMoneyError`, `CurrencyMismatchError`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 2.2 Escrever testes de propriedade para `Money` (Properties 1–4)
    - **Property 1: Inputs monetários inválidos são rejeitados**
    - **Validates: Requirements 1.2**
    - **Property 2: Conflito de moeda em operações aritméticas**
    - **Validates: Requirements 1.3**
    - **Property 3: Imutabilidade do Money**
    - **Validates: Requirements 1.4**
    - **Property 4: Round-trip de serialização do Money**
    - **Validates: Requirements 1.5**

  - [x] 2.3 Escrever testes unitários para `Money`
    - Cobrir: escala fixa 2 casas, entradas inválidas, conflito de moeda, imutabilidade, serialização
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 15.1_

- [x] 3. Agregado Wallet e WalletLedgerEntry
  - [x] 3.1 Implementar `Wallet` aggregate root
    - Criar `src/domain/wallet/wallet.aggregate.ts` com construtor privado
    - Implementar factories `open` (cria nova wallet, `version = 1`) e `rehydrate` (sem revalidação)
    - Implementar `debit(money, entry)` e `credit(money, entry)` — verificam saldo, incrementam `version`
    - Aplicar invariante: saldo nunca negativo (lançar `InsufficientBalanceError`)
    - Criar `src/domain/wallet/wallet.errors.ts`
    - _Requirements: 2.1, 2.4, 2.5, 5.1, 5.2_

  - [x] 3.2 Implementar `WalletLedgerEntry` imutável
    - Criar `src/domain/wallet/wallet-ledger-entry.ts` com construtor privado e sem métodos de transição
    - Implementar factory `create` validando aritmética `balanceBefore ± money === balanceAfter`
    - Implementar factory `rehydrate`
    - Implementar `isBalanced()` como consulta
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 3.3 Escrever testes de propriedade para `Wallet` e `WalletLedgerEntry` (Properties 5, 6, 13)
    - **Property 5: Saldo da Wallet nunca negativo**
    - **Validates: Requirements 2.5, 5.2**
    - **Property 6: version incrementa somente em mudança de saldo**
    - **Validates: Requirements 2.4**
    - **Property 13: Aritmética do ledger é sempre balanceada**
    - **Validates: Requirements 6.2**

  - [x] 3.4 Escrever testes unitários para `Wallet` e `WalletLedgerEntry`
    - Cobrir: invariantes, debit/credit, saldo insuficiente, versão, aritmética do ledger
    - _Requirements: 2.4, 2.5, 6.2, 15.1_

- [x] 4. WagerTransaction — entidade e ciclo de vida
  - [x] 4.1 Implementar enums e FailureCodes
    - Criar `src/domain/wager-transaction/wager-transaction.enums.ts` com `WagerTransactionKind` e `WagerTransactionStatus`
    - Criar `src/domain/wager-transaction/failure-codes.ts` com `FailureCode` enum completo
    - Documentar taxonomia de `FailureCode` em `ARCHITECTURE.md`
    - _Requirements: 3.4, 5.2, 5.7, 5.8, 5.9, 7.2_

  - [x] 4.2 Implementar `WagerTransaction` entity com máquina de estados
    - Criar `src/domain/wager-transaction/wager-transaction.entity.ts` com construtor privado
    - Implementar factory `create` (nasce em `PENDING`, valida exigência de referência por kind)
    - Implementar factory `rehydrate` (sem revalidação)
    - Implementar transições: `markProcessed`, `markPendingReference`, `reject`, `fail`
    - Transições em estados terminais lançam `InvalidTransactionStateError`
    - Bloquear `kind = OPENING` em `create` (apenas via `rehydrate`)
    - Implementar consultas: `isTerminal`, `affectsBalance`, `requiresReference`, `matchesPayload`, `ledgerDirectionFor`
    - Criar `src/domain/wager-transaction/wager-transaction.errors.ts`
    - _Requirements: 3.1, 3.4, 3.5, 3.6, 5.3, 5.4, 5.5, 5.6_

  - [x]* 4.3 Escrever testes de propriedade para `WagerTransaction` (Property 9)
    - **Property 9: Transições de estado — estados terminais são irreversíveis**
    - **Validates: Requirements 3.6**

  - [x]* 4.4 Escrever testes unitários para `WagerTransaction`
    - Cobrir: regras BET/WIN/LOSS/REFUND/ROLLBACK, estados terminais, OPENING bloqueado
    - _Requirements: 3.4, 3.5, 3.6, 15.1_

- [x] 5. InboxMessage, OutboxMessage e IntegrationEvents
  - [x] 5.1 Implementar `InboxMessage` e `OutboxMessage`
    - Criar `src/domain/outbox/inbox-message.ts` com factories `receive` e `rehydrate`, e `markProcessed`
    - Criar `src/domain/outbox/outbox-message.ts` com factories `enqueue` e `rehydrate`
    - Implementar `scheduleRetry(now)` com backoff `2^attempts * 1000ms` (máx 300s)
    - Implementar `markPublished`, `isPending`, `isDue`
    - _Requirements: 9.2, 10.1, 10.7_

  - [x] 5.2 Implementar `IntegrationEvent` base e subclasses de eventos
    - Criar `src/domain/events/integration-event.base.ts` como classe abstrata com `toJSON()`
    - Criar subclasses concretas: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`
    - Garantir `data` com apenas tipos JSON primitivos (MoneyProps como strings)
    - `eventType` e `version` fixados como propriedades do tipo da subclasse
    - _Requirements: 10.2, 11.1, 11.2, 11.3, 11.4_

  - [x]* 5.3 Escrever testes de propriedade para IntegrationEvents (Properties 19, 20)
    - **Property 19: Envelope IntegrationEvent contém todos os campos obrigatórios**
    - **Validates: Requirements 11.1**
    - **Property 20: Payload de IntegrationEvent é JSON puro**
    - **Validates: Requirements 11.2**

- [X] 6. Schema do banco e migrations
  - [X] 6.1 Criar migration inicial com tabelas e constraints
    - Criar `migrations/Migration001_initial_schema.ts` com DDL completo
    - Tabela `wallets`: `CHECK (balance_amount >= 0)`, `UNIQUE (player_id, currency)`
    - Tabela `wager_transactions`: `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, CHECK de status e kind
    - Tabela `wallet_ledger_entries`: `UNIQUE (transaction_id, wallet_id)`, `CHECK (balance_arithmetic)`
    - Tabela `inbox_messages`: `UNIQUE (consumer_name, message_id)`
    - Tabela `outbox_messages` com índice parcial `WHERE published_at IS NULL`
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [X] 6.2 Criar migration de índices de performance
    - Criar `migrations/Migration002_indexes.ts`
    - Índice parcial em `wager_transactions (status, next_attempt_at) WHERE status = 'PENDING_REFERENCE'`
    - Índices em `wallet_ledger_entries (wallet_id, created_at DESC)`
    - _Requirements: 14.7, 8.2_

- [X] 7. ORM Entities e Repositórios
  - [X] 7.1 Criar MikroORM entities (`@Entity` decorators)
    - Criar `src/infrastructure/persistence/entities/wallet.orm-entity.ts`
    - Criar `src/infrastructure/persistence/entities/wager-transaction.orm-entity.ts`
    - Criar `src/infrastructure/persistence/entities/wallet-ledger-entry.orm-entity.ts`
    - Criar `src/infrastructure/persistence/entities/inbox-message.orm-entity.ts`
    - Criar `src/infrastructure/persistence/entities/outbox-message.orm-entity.ts`
    - Configurar `mikro-orm.config.ts` com `NUMERIC(19,4)` para campos monetários
    - _Requirements: 14.1–14.7_

  - [X] 7.2 Implementar portas de repositório (interfaces)
    - Criar `src/application/ports/wallet.repository.port.ts` com `findByIdForUpdate`, `save`
    - Criar `src/application/ports/wager-transaction.repository.port.ts`
    - Criar `src/application/ports/ledger.repository.port.ts` (sem `delete`)
    - Criar `src/application/ports/outbox.repository.port.ts`
    - Criar `src/application/ports/inbox.repository.port.ts`
    - Criar `src/application/ports/unit-of-work.port.ts` com `transactional<T>`
    - _Requirements: 6.3, 14.6_

  - [X] 7.3 Implementar repositórios concretos com MikroORM
    - Criar `src/infrastructure/persistence/repositories/wallet.repository.ts`
    - Implementar `findByIdForUpdate` usando `LockMode.PESSIMISTIC_WRITE`
    - Criar repositórios para `WagerTransaction`, `Ledger`, `Outbox`, `Inbox`
    - Criar `src/infrastructure/persistence/unit-of-work.adapter.ts` wrappando `EntityManager.transactional()`
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 8. Use Cases — CreateWallet e ProcessWagerTransaction
  - [x] 8.1 Implementar `PayloadHashService` e `IdempotencyService`
    - Criar `src/application/services/payload-hash.service.ts` com SHA-256 de JSON canônico (chaves ordenadas, campos de negócio apenas)
    - Criar `src/application/services/idempotency.service.ts` checando `idempotencyKey` + `payloadHash`
    - Documentar algoritmo em `ARCHITECTURE.md`
    - _Requirements: 3.3, 4.1, 4.2, 4.5_

  - [x] 8.2 Implementar `CreateWalletUseCase`
    - Criar `src/application/use-cases/create-wallet/create-wallet.use-case.ts`
    - Abrir Wallet com `Wallet.open()`, gerar `WagerTransaction` kind `OPENING` se `initialBalance > 0`
    - Gerar `WalletLedgerEntry` CREDIT correspondente na mesma transação SQL
    - Persistir via `UnitOfWorkPort.transactional()`
    - _Requirements: 2.1, 2.2, 2.3, 6.1_

  - [x] 8.3 Implementar `ProcessWagerTransactionUseCase`
    - Criar `src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case.ts`
    - Verificar idempotência (replay ou conflito) antes de adquirir lock
    - Adquirir `SELECT FOR UPDATE` na Wallet via `findByIdForUpdate`
    - Aplicar regras de BET/WIN/LOSS/REFUND/ROLLBACK via Wallet aggregate
    - Criar `WalletLedgerEntry` quando há efeito no saldo
    - Enfileirar `OutboxMessage` com evento correspondente
    - Persistir tudo atomicamente via `UnitOfWorkPort.transactional()`
    - _Requirements: 3.1, 4.1, 4.2, 4.5, 5.1–5.11, 6.1, 7.1, 9.1, 10.1, 10.6_

  - [x]* 8.4 Escrever testes de propriedade para idempotência e concorrência (Properties 10, 12, 15)
    - **Property 10: Idempotência persistente — replay retorna resposta original**
    - **Validates: Requirements 4.1**
    - **Property 12: Transações REJECTED não alteram saldo nem geram ledger**
    - **Validates: Requirements 5.11, 6.1**
    - **Property 15: Cenário de concorrência — exatamente um PROCESSED**
    - **Validates: Requirements 7.3**

  - [x]* 8.5 Escrever testes unitários para `ProcessWagerTransactionUseCase`
    - Cobrir: BET/WIN/LOSS/REFUND/ROLLBACK, idempotência, replay, conflito de payload
    - _Requirements: 4.1, 4.2, 5.1–5.11, 15.1_

- [x] 9. Use Cases — ReconcileWallet e ReprocessPendingReferences
  - [x] 9.1 Implementar `ReconcileWalletUseCase`
    - Criar `src/application/use-cases/reconcile-wallet/reconcile-wallet.use-case.ts`
    - Recalcular saldo somando todas as `WalletLedgerEntries` do ledger a partir de zero
    - Comparar com `wallet.balance` materializado
    - Logar divergência, incrementar métrica `wagering_reconciliation_divergences_total`
    - Retornar `{ consistent, storedBalance, calculatedBalance, difference, checkedEntries }`
    - _Requirements: 6.4, 6.5, 6.6_

  - [x] 9.2 Implementar `ReprocessPendingReferencesUseCase`
    - Criar `src/application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case.ts`
    - Buscar transações `PENDING_REFERENCE` com `nextAttemptAt <= NOW`
    - Tentar resolver referência por `(providerId, referenceExternalTransactionId)`
    - Se resolvida: aplicar efeito financeiro na mesma transação SQL
    - Se não resolvida após limite (5 tentativas): `reject` com `FailureCode.REFERENCE_EXPIRED` + OutboxMessage
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x]* 9.3 Escrever testes de propriedade para reprocessamento (Property 17)
    - **Property 17: Reprocessamento de PENDING_REFERENCE é idempotente**
    - **Validates: Requirements 8.5**

- [x] 10. Checkpoint Dia 1 — Verificação do core
  - Garantir que todos os testes unitários e de propriedade do domínio passam: `bun run test`
  - Garantir que as migrations rodam sem erro com `bun run migration:run` (requer Docker)
  - Perguntar ao usuário se há dúvidas antes de avançar para Dia 2.

---

### Dia 2 — Mensageria, Concorrência e API HTTP

- [x] 11. API HTTP — Controllers e DTOs
  - [x] 11.1 Implementar `WalletController` e DTOs
    - Criar `src/http/controllers/wallet.controller.ts` com rotas: `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `POST /wallets/:walletId/reconciliation`
    - Criar request/response DTOs com `class-validator` para `POST /wallets`
    - Implementar cursor opaco e estável para paginação do ledger (base64 de `{ id, createdAt }`)
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7, 6.4_

  - [x] 11.2 Implementar `WageringController` e DTOs
    - Criar `src/http/controllers/wagering.controller.ts` com rotas: `POST /wagering/transactions`, `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
    - Extrair `Idempotency-Key` header (422 se ausente)
    - Mapear `correlationId` do contexto de requisição
    - _Requirements: 3.1, 3.2, 3.7, 3.8, 4.1, 4.2_

  - [x] 11.3 Implementar `HealthController`, `AuthGuard` no-op e `DomainExceptionFilter`
    - Criar `src/http/controllers/health.controller.ts` com `GET /health/live` e `GET /health/ready`
    - `GET /health/ready` verifica conectividade PostgreSQL e SQS
    - Criar `src/http/guards/auth.guard.ts` (no-op, permite todas as requisições)
    - Criar `src/infrastructure/auth/provider-identity.adapter.ts` como implementação stub de `ProviderIdentityPort`
    - Criar `src/http/filters/domain-exception.filter.ts` mapeando erros de domínio para HTTP status codes conforme tabela do design
    - _Requirements: 12.4, 12.5, 13.1, 13.2, 13.4_

- [x] 12. SQS Consumer — Inbox persistente e graceful shutdown
  - [x] 12.1 Implementar `SqsClient` wrapper
    - Criar `src/infrastructure/messaging/sqs.client.ts` wrappando `@aws-sdk/client-sqs`
    - Métodos: `receiveMessages`, `deleteMessage`, `changeMessageVisibility`, `sendMessage`
    - Configurar long-polling (20s), max 10 mensagens por receive
    - _Requirements: 9.1, 9.3_

  - [x] 12.2 Implementar `SqsConsumerService` com inbox e graceful shutdown
    - Criar `src/infrastructure/messaging/sqs-consumer.service.ts`
    - Loop de long-polling com `ReceiveMessage`
    - Por mensagem: `INSERT inbox_message ON CONFLICT DO NOTHING` na mesma transação SQL do processamento
    - `ack` (deleteMessage) **somente após commit** bem-sucedido
    - Erro de negócio (`REJECTED`): ack sem envio à DLQ
    - Erro transitório: sem ack (visibility timeout re-entrega)
    - `SIGTERM`: aguardar mensagens em andamento até 30s (`gracefulShutdown()`)
    - Reutilizar `ProcessWagerTransactionUseCase`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

- [x] 13. Outbox Worker — SKIP LOCKED e backoff
  - [x] 13.1 Implementar `OutboxPublisherWorker`
    - Criar `src/infrastructure/messaging/outbox-publisher.worker.ts`
    - Loop com intervalo configurável (`OUTBOX_POLL_INTERVAL_MS`, padrão 1s)
    - `SELECT * FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= NOW() FOR UPDATE SKIP LOCKED LIMIT 10`
    - Publicar no SQS com `eventId` como `MessageDeduplicationId`
    - Após publicação: `UPDATE SET published_at = NOW()` na mesma transação
    - Falha: `scheduleRetry(now)` com backoff exponencial, persistir para nova tentativa
    - Max attempts configurável (`OUTBOX_MAX_ATTEMPTS`, padrão 10)
    - _Requirements: 10.3, 10.4, 10.5, 10.6, 10.7_

- [x] 14. Pending Reference Worker
  - [x] 14.1 Implementar `PendingReferenceWorker`
    - Criar `src/infrastructure/workers/pending-reference.worker.ts`
    - Cron configurável (`PENDING_REF_CRON`, padrão a cada 30s) via `@nestjs/schedule`
    - Delegar para `ReprocessPendingReferencesUseCase`
    - Backoff: `2^n * 60s` (1min, 2min, 4min, 8min, 16min), máx 5 tentativas
    - Após esgotamento: `REJECTED` com `FailureCode.REFERENCE_EXPIRED` + `OutboxMessage`
    - _Requirements: 8.2, 8.3, 8.4_

- [x] 15. Observabilidade — Logs Pino e métricas Prometheus
  - [x] 15.1 Implementar logger estruturado Pino
    - Criar `src/shared/logger/structured-logger.ts` com Pino JSON
    - Campos obrigatórios: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`
    - Criar `src/shared/correlation-id.middleware.ts` injetando `correlationId` em cada requisição
    - Garantir ausência de valores financeiros e dados sensíveis nos logs
    - _Requirements: 12.1, 12.2_

  - [x] 15.2 Implementar métricas Prometheus
    - Criar `src/shared/metrics/prometheus.service.ts` com `prom-client`
    - Expor métricas: `wagering_transactions_total{status,kind}`, `wagering_idempotent_replays_total`, `wagering_idempotency_conflicts_total`, `wagering_lock_conflicts_total`, `wagering_sqs_retries_total`, `wagering_dlq_messages_total`, `wagering_outbox_lag_seconds`, `wagering_transaction_duration_seconds`, `wagering_reconciliation_divergences_total`, `wagering_pending_reference_total`
    - Endpoint `GET /metrics` exposto pelo Prometheus scraper
    - _Requirements: 12.3_

- [x] 16. Checkpoint Dia 2 — Integração da camada HTTP e mensageria
  - Subir `docker compose up` e verificar que `POST /wallets` e `POST /wagering/transactions` respondem corretamente
  - Verificar que uma mensagem SQS publicada manualmente é consumida e processa a transação
  - Perguntar ao usuário se há dúvidas antes de avançar para Dia 3.

---

### Dia 3 — Testes, Observabilidade Avançada e Documentação

- [ ] 17. Testes de integração com PostgreSQL e LocalStack reais
  - [x] 17.1 Configurar harness de testes de integração com Testcontainers
    - Criar `test/integration/setup.ts` com `GenericContainer` para PostgreSQL e LocalStack
    - Configurar `docker-compose.test.yml` como alternativa ao Testcontainers
    - Adicionar script `bun run test:integration` no `package.json`
    - _Requirements: 15.2, 15.5_

  - [x] 17.2 Escrever testes de integração: migrations e constraints de banco
    - Verificar que todas as constraints `UNIQUE` e `CHECK` são aplicadas no banco
    - Verificar que `DELETE` em `wallet_ledger_entries` é bloqueado no repositório
    - _Requirements: 14.1–14.7, 15.2_

  - [x] 17.3 Escrever testes de integração: atomicidade wallet/ledger/inbox/outbox
    - Verificar que wallet + ledger + inbox + outbox são persistidos ou revertidos juntos
    - Simular kill do processo após commit para verificar recuperação pelo Outbox Worker
    - _Requirements: 10.1, 10.4, 15.2_

  - [x] 17.4 Escrever testes de integração: deduplicação via InboxMessage e redelivery SQS
    - Reenviar mesma mensagem SQS e verificar zero efeito financeiro duplicado
    - _Requirements: 9.8, 4.4, 15.2_

  - [x] 17.5 Escrever testes de integração: Outbox Worker com publishers concorrentes
    - Dois workers tentam publicar o mesmo `OutboxMessage` simultaneamente (SKIP LOCKED)
    - Verificar que evento é publicado exatamente uma vez (ou at-most-twice com deduplicação no consumidor)
    - _Requirements: 10.3, 15.2_

  - [x] 17.6 Escrever testes de integração: retry e DLQ do SQS Consumer
    - Simular erro transitório repetido até atingir `maxReceiveCount`
    - Verificar redirecionamento automático para `wager-transactions-dlq.fifo`
    - _Requirements: 9.5, 9.6, 15.2_

  - [ ]* 17.7 Escrever testes de integração: recuperação após reinicialização
    - Inserir `OutboxMessage` pendente diretamente no banco e reiniciar o worker
    - Verificar que o evento é publicado após reinício
    - _Requirements: 10.4, 15.2_

- [ ] 18. Testes de concorrência com paralelismo real
  - [ ] 18.1 Configurar harness de testes de concorrência
    - Criar `test/concurrency/setup.ts` reutilizando containers de integração
    - Adicionar script `bun run test:concurrency` no `package.json`
    - _Requirements: 15.3, 15.5_

  - [ ]* 18.2 Teste de concorrência: 50 envios paralelos da mesma aposta resultam em 1 débito
    - Criar wallet, enviar mesma `BET` 50x em paralelo (Promise.all)
    - Verificar: exatamente 1 `PROCESSED`, 49 `idempotentReplay: true`, saldo correto
    - Verificar invariante: `wallet.balance == saldo reconstruído pelo ledger`
    - _Requirements: 7.3, 15.3, 15.4_

  - [ ]* 18.3 Teste de concorrência: duas apostas de 80 BRL sobre saldo de 100 BRL
    - Cenário obrigatório da seção 8 do README
    - Verificar: 1 `PROCESSED`, 1 `REJECTED (INSUFFICIENT_BALANCE)`, saldo final `20.00`, exatamente 1 ledger entry
    - Verificar invariante final
    - _Requirements: 7.3, 15.3, 15.4_

  - [ ]* 18.4 Teste de concorrência: wallets distintas processadas em paralelo
    - Criar N wallets, disparar operações simultâneas em cada uma
    - Verificar que nenhuma wallet interfere na outra
    - _Requirements: 7.5, 15.3_

  - [ ]* 18.5 Teste de concorrência: ≥ 3 instâncias da aplicação simultâneas
    - Subir 3 instâncias via Docker Compose (scale: 3)
    - Enviar batch de transações para a mesma wallet em paralelo
    - Verificar consistência final e invariante de ledger
    - _Requirements: 7.4, 15.3, 15.4_

  - [ ]* 18.6 Teste de concorrência: worker morto após commit e antes do ack
    - Simular crash do consumer após `COMMIT` mas antes de `deleteMessage`
    - Re-entregar mensagem e verificar que inbox detecta duplicata (zero efeito financeiro)
    - _Requirements: 9.3, 9.8, 15.3_

  - [ ]* 18.7 Teste de concorrência: dois publishers sobre a mesma outbox
    - Dois workers Outbox rodando simultâneos com SKIP LOCKED
    - Verificar que não há publicação dupla permanente (deduplicação via eventId)
    - _Requirements: 10.3, 15.3_

  - [ ]* 18.8 Teste de concorrência: ROLLBACK/REFUND entregue antes da referência
    - Enviar `REFUND` antes da `BET` correspondente
    - Verificar transição `PENDING → PENDING_REFERENCE → PROCESSED` após reprocessamento
    - Verificar invariante final de ledger
    - _Requirements: 8.1, 8.2, 15.3_

  - [ ]* 18.9 Escrever testes de propriedade para isolamento e redelivery (Properties 11, 16)
    - **Property 11: Redelivery SQS não duplica efeitos financeiros**
    - **Validates: Requirements 4.4, 9.8**
    - **Property 16: Isolamento entre wallets distintas**
    - **Validates: Requirements 7.5**

  - [ ]* 18.10 Escrever testes de propriedade para outbox e reconciliação (Properties 14, 18)
    - **Property 14: Reconciliação — saldo materializado igual ao saldo do ledger**
    - **Validates: Requirements 6.4**
    - **Property 18: Publicação de OutboxMessage é idempotente para o consumidor**
    - **Validates: Requirements 10.3, 10.5**

  - [ ]* 18.11 Escrever testes de propriedade para paginação do ledger (Properties 7, 8)
    - **Property 7: Paginação do ledger — completude e ausência de duplicatas**
    - **Validates: Requirements 2.7**
    - **Property 8: Hash canônico é determinístico independente da ordem de chaves**
    - **Validates: Requirements 3.3**

- [ ] 19. Documentação final
  - [ ] 19.1 Atualizar `README.md` com setup e comandos
    - Pré-requisitos: Bun 1.x, Docker, Docker Compose
    - Comandos: `bun install`, `docker compose up`, `bun run migration:run`, `bun run dev`
    - Comandos de teste: `bun run test`, `bun run test:integration`, `bun run test:concurrency`
    - Variáveis de ambiente documentadas
    - _Requirements: documentação (README §14)_

  - [ ] 19.2 Criar `ARCHITECTURE.md` com decisões técnicas e trade-offs
    - Justificar: ORM (MikroORM), locking (pessimistic), decimal (decimal.js), outbox (SKIP LOCKED), hash (SHA-256 canônico), autenticação (no-op + ProviderIdentityPort)
    - Documentar taxonomia de `FailureCode`
    - Descrever ponto de extensão para Identity Provider (Keycloak/Zitadel)
    - Documentar limitações conhecidas e trade-offs aceitos
    - _Requirements: documentação (README §14), 13.2_

- [ ] 20. Checkpoint Final — Validação completa
  - Executar `bun run test` (unitários + propriedades) — todos devem passar
  - Executar `bun run test:integration` — todos devem passar com containers reais
  - Executar `bun run test:concurrency` — verificar invariante `wallet.balance == saldo do ledger` em todos os cenários
  - Verificar que nenhuma falha eliminatória está presente (ver README §14)
  - Perguntar ao usuário se há ajustes finais antes da entrega.

---

## Notes

- Tarefas marcadas com `*` são opcionais e podem ser puladas para um MVP mais rápido, mas **cobrem as áreas de maior pontuação** — recomendamos não pular as de propriedade/concorrência
- A invariante `wallet.balance == saldo reconstruído pelo ledger` deve ser verificada em **todo** teste de concorrência
- Cada commit deve ser atômico: nenhuma tarefa deixa código "órfão" não integrado
- Prioridade de pontuação: Properties 5, 10, 12, 13, 15 (correção financeira + concorrência) > Properties 1–4 (Money) > Properties 9, 17 (ciclo de vida)
- O `OPENING` kind existe apenas para geração interna em `CreateWalletUseCase` — nunca exposto via API ou SQS
- `NUMERIC(19,4)` no banco + `decimal.js` na aplicação + serialização como string de 2 casas nos contratos = três camadas de proteção contra imprecisão

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "4.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.1", "3.2", "4.2", "5.1", "5.2", "6.2"] },
    { "id": 3, "tasks": ["3.3", "3.4", "4.3", "4.4", "5.3", "7.1"] },
    { "id": 4, "tasks": ["7.2", "9.1"] },
    { "id": 5, "tasks": ["7.3", "8.1"] },
    { "id": 6, "tasks": ["8.2", "9.2"] },
    { "id": 7, "tasks": ["8.3"] },
    { "id": 8, "tasks": ["8.4", "8.5", "9.3"] },
    { "id": 9, "tasks": ["11.1", "11.2", "12.1", "13.1", "14.1", "15.1"] },
    { "id": 10, "tasks": ["11.3", "12.2", "15.2"] },
    { "id": 11, "tasks": ["17.1", "18.1"] },
    { "id": 12, "tasks": ["17.2", "17.3", "17.4", "17.5", "17.6", "17.7", "18.2", "18.3", "18.4", "18.5", "18.6", "18.7", "18.8", "18.9", "18.10", "18.11"] },
    { "id": 13, "tasks": ["19.1", "19.2"] }
  ]
}
```
