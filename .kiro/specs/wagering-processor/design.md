# Design Document — Wagering Processor

## Overview

O Wagering Processor é um serviço financeiro distribuído construído como monolito modular NestJS com Bun 1.x. Processa transações de apostas recebidas via HTTP e AWS SQS com garantias de idempotência persistente, pessimistic locking por `walletId` e Transactional Outbox/Inbox para consistência eventual.

Stack: **Bun 1.x · TypeScript strict · NestJS · PostgreSQL · MikroORM (LockMode.PESSIMISTIC_WRITE) · AWS SQS (LocalStack) · Docker Compose.**

---

## Estrutura de Pastas

```
src/
├── main.ts
├── app.module.ts
│
├── domain/                          # Núcleo — sem dependências de framework
│   ├── money/
│   │   ├── money.ts                 # Value object imutável
│   │   └── money.errors.ts
│   ├── wallet/
│   │   ├── wallet.aggregate.ts      # Aggregate Root
│   │   ├── wallet.errors.ts
│   │   └── wallet-ledger-entry.ts   # Imutável
│   ├── wager-transaction/
│   │   ├── wager-transaction.entity.ts
│   │   ├── wager-transaction.enums.ts
│   │   ├── wager-transaction.errors.ts
│   │   └── failure-codes.ts         # Enum estável legível por máquina
│   ├── outbox/
│   │   ├── outbox-message.ts
│   │   └── inbox-message.ts
│   └── events/
│       ├── integration-event.base.ts
│       ├── wager-transaction-processed.event.ts
│       ├── wager-transaction-rejected.event.ts
│       ├── wager-transaction-pending-reference.event.ts
│       └── wallet-balance-changed.event.ts
│
├── application/                     # Use cases — depende do domínio + portas
│   ├── ports/
│   │   ├── wallet.repository.port.ts
│   │   ├── wager-transaction.repository.port.ts
│   │   ├── outbox.repository.port.ts
│   │   ├── inbox.repository.port.ts
│   │   ├── ledger.repository.port.ts
│   │   ├── provider-identity.port.ts   # Ponto de extensão de autenticação
│   │   └── unit-of-work.port.ts
│   ├── use-cases/
│   │   ├── create-wallet/
│   │   │   ├── create-wallet.use-case.ts
│   │   │   └── create-wallet.dto.ts
│   │   ├── process-wager-transaction/
│   │   │   ├── process-wager-transaction.use-case.ts
│   │   │   └── process-wager-transaction.dto.ts
│   │   ├── reconcile-wallet/
│   │   │   └── reconcile-wallet.use-case.ts
│   │   └── reprocess-pending-references/
│   │       └── reprocess-pending-references.use-case.ts
│   └── services/
│       ├── idempotency.service.ts
│       └── payload-hash.service.ts
│
├── infrastructure/                  # Implementações de portas + Workers
│   ├── persistence/
│   │   ├── mikro-orm.config.ts
│   │   ├── unit-of-work.adapter.ts
│   │   ├── entities/               # MikroORM @Entity decorators
│   │   │   ├── wallet.orm-entity.ts
│   │   │   ├── wager-transaction.orm-entity.ts
│   │   │   ├── wallet-ledger-entry.orm-entity.ts
│   │   │   ├── inbox-message.orm-entity.ts
│   │   │   └── outbox-message.orm-entity.ts
│   │   ├── repositories/
│   │   │   ├── wallet.repository.ts
│   │   │   ├── wager-transaction.repository.ts
│   │   │   ├── ledger.repository.ts
│   │   │   ├── outbox.repository.ts
│   │   │   └── inbox.repository.ts
│   │   └── migrations/
│   │       ├── Migration001_initial_schema.ts
│   │       └── Migration002_indexes.ts
│   ├── messaging/
│   │   ├── sqs.client.ts            # Wrapper do @aws-sdk/client-sqs
│   │   ├── sqs-consumer.service.ts  # Long-polling + graceful shutdown
│   │   └── outbox-publisher.worker.ts
│   ├── workers/
│   │   └── pending-reference.worker.ts
│   └── auth/
│       ├── noop-auth.guard.ts
│       └── provider-identity.adapter.ts
│
├── http/                            # Camada HTTP — controllers + DTOs + guards
│   ├── controllers/
│   │   ├── wallet.controller.ts
│   │   ├── wagering.controller.ts
│   │   └── health.controller.ts
│   ├── dtos/
│   │   ├── create-wallet.request.dto.ts
│   │   ├── submit-transaction.request.dto.ts
│   │   └── *.response.dto.ts
│   ├── guards/
│   │   └── auth.guard.ts
│   └── filters/
│       └── domain-exception.filter.ts
│
└── shared/
    ├── logger/
    │   └── structured-logger.ts    # Pino JSON
    ├── metrics/
    │   └── prometheus.service.ts
    └── correlation-id.middleware.ts

migrations/                          # Arquivos de migration (fora de src/)
docker-compose.yml
docker-compose.test.yml
ARCHITECTURE.md
```

---

## Diagrama de Componentes

```mermaid
graph TB
    subgraph Clients
        HTTP_CLIENT[Provider HTTP]
        SQS_PRODUCER[SQS Producer]
    end

    subgraph NestJS Application
        subgraph HTTP Layer
            AUTH_GUARD[AuthGuard no-op]
            WALLET_CTRL[WalletController]
            WAGER_CTRL[WageringController]
            HEALTH_CTRL[HealthController]
            EXC_FILTER[DomainExceptionFilter]
        end

        subgraph Application Layer
            CREATE_WALLET_UC[CreateWalletUseCase]
            PROCESS_TX_UC[ProcessWagerTransactionUseCase]
            RECONCILE_UC[ReconcileWalletUseCase]
            REPROCESS_UC[ReprocessPendingReferencesUseCase]
            IDEMPOTENCY_SVC[IdempotencyService]
            HASH_SVC[PayloadHashService]
        end

        subgraph Domain
            MONEY[Money VO]
            WALLET_AGG[Wallet Aggregate]
            WAGER_TX[WagerTransaction]
            LEDGER_ENTRY[WalletLedgerEntry]
            INBOX_MSG[InboxMessage]
            OUTBOX_MSG[OutboxMessage]
            INT_EVENTS[IntegrationEvents]
        end

        subgraph Infrastructure
            MIKRO_ORM[MikroORM / EntityManager]
            UOW[UnitOfWork Adapter]
            SQS_CONSUMER[SQS Consumer Service]
            OUTBOX_WORKER[Outbox Publisher Worker]
            PENDING_WORKER[Pending Reference Worker]
            PROV_ID_PORT[ProviderIdentityPort Adapter]
            LOGGER[Pino Structured Logger]
            METRICS[Prometheus Metrics]
        end
    end

    subgraph External
        POSTGRES[(PostgreSQL)]
        SQS_FIFO[SQS wager-transactions.fifo]
        SQS_DLQ[SQS wager-transactions-dlq.fifo]
        SQS_EVENTS[SQS integration-events.fifo]
        LOCALSTACK[LocalStack]
    end

    HTTP_CLIENT --> AUTH_GUARD --> WALLET_CTRL & WAGER_CTRL
    HTTP_CLIENT --> HEALTH_CTRL
    SQS_PRODUCER --> SQS_FIFO

    WALLET_CTRL --> CREATE_WALLET_UC
    WAGER_CTRL --> PROCESS_TX_UC & RECONCILE_UC
    SQS_CONSUMER --> PROCESS_TX_UC
    PENDING_WORKER --> REPROCESS_UC

    CREATE_WALLET_UC & PROCESS_TX_UC & RECONCILE_UC --> UOW
    PROCESS_TX_UC --> IDEMPOTENCY_SVC & HASH_SVC
    PROCESS_TX_UC --> WALLET_AGG & WAGER_TX & LEDGER_ENTRY & OUTBOX_MSG & INBOX_MSG

    UOW --> MIKRO_ORM --> POSTGRES
    OUTBOX_WORKER --> MIKRO_ORM
    OUTBOX_WORKER --> SQS_EVENTS

    SQS_CONSUMER --> SQS_FIFO
    SQS_CONSUMER -.->|ack after commit| SQS_FIFO
    SQS_FIFO -.->|max attempts| SQS_DLQ

    LOCALSTACK --> SQS_FIFO & SQS_DLQ & SQS_EVENTS
```

---

## Diagrama de Estados — WagerTransaction

```mermaid
stateDiagram-v2
    [*] --> PENDING : create() — validação de contrato OK

    PENDING --> PROCESSED : processamento bem-sucedido\n(BET/WIN/LOSS/REFUND/ROLLBACK)
    PENDING --> REJECTED : violação de regra de negócio\n(saldo insuficiente, referência inválida,\nvalor divergente, reversão duplicada)
    PENDING --> PENDING_REFERENCE : referência não encontrada\n(REFUND/ROLLBACK)
    PENDING --> FAILED : erro permanente de infraestrutura

    PENDING_REFERENCE --> PROCESSED : referência encontrada no reprocessamento
    PENDING_REFERENCE --> REJECTED : limite de tentativas esgotado\n(FailureCode.REFERENCE_EXPIRED)

    PROCESSED --> [*] : terminal
    REJECTED --> [*] : terminal
    FAILED --> [*] : terminal

    note right of PROCESSED : Gera OutboxMessage\nWagerTransactionProcessed\n+WalletBalanceChanged (se BET/WIN/REFUND/ROLLBACK)
    note right of REJECTED : Gera OutboxMessage\nWagerTransactionRejected
    note right of PENDING_REFERENCE : Gera OutboxMessage\nWagerTransactionPendingReference
```

---

## Schema do Banco de Dados

### Tabela: `wallets`

```sql
CREATE TABLE wallets (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id       UUID        NOT NULL,
    currency        CHAR(3)     NOT NULL,                        -- ISO-4217
    balance_amount  NUMERIC(19,4) NOT NULL DEFAULT 0,
    version         INTEGER     NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
    CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
);

CREATE INDEX idx_wallets_player_id ON wallets (player_id);
```

> `NUMERIC(19,4)` garante precisão exata sem ponto flutuante. 4 casas internas → reduz risco de truncamento em operações intermediárias; serializamos sempre com 2 casas para contratos externos.

### Tabela: `wager_transactions`

```sql
CREATE TABLE wager_transactions (
    id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id                     VARCHAR(128) NOT NULL,
    external_transaction_id         VARCHAR(256) NOT NULL,
    idempotency_key                 VARCHAR(512) NOT NULL,
    payload_hash                    CHAR(64)     NOT NULL,       -- SHA-256 hex
    wallet_id                       UUID        NOT NULL REFERENCES wallets(id),
    player_id                       UUID        NOT NULL,
    round_id                        VARCHAR(256) NOT NULL,
    game_id                         VARCHAR(256) NOT NULL,
    kind                            VARCHAR(16)  NOT NULL,       -- BET|WIN|LOSS|REFUND|ROLLBACK|OPENING
    money_amount                    NUMERIC(19,4) NOT NULL,
    money_currency                  CHAR(3)      NOT NULL,
    reference_external_tx_id        VARCHAR(256),               -- nullable
    reference_transaction_id        UUID,                       -- resolvido internamente
    status                          VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
    failure_code                    VARCHAR(64),
    attempts                        SMALLINT     NOT NULL DEFAULT 0,
    next_attempt_at                 TIMESTAMPTZ,
    processed_at                    TIMESTAMPTZ,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT wt_idempotency_key_unique UNIQUE (idempotency_key),
    CONSTRAINT wt_provider_external_unique UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT wt_status_check CHECK (status IN (
        'PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'
    )),
    CONSTRAINT wt_kind_check CHECK (kind IN (
        'BET','WIN','LOSS','REFUND','ROLLBACK','OPENING'
    ))
);

CREATE INDEX idx_wt_wallet_id          ON wager_transactions (wallet_id);
CREATE INDEX idx_wt_status_next_attempt ON wager_transactions (status, next_attempt_at)
    WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_wt_provider_external  ON wager_transactions (provider_id, external_transaction_id);
CREATE INDEX idx_wt_created_at         ON wager_transactions (created_at DESC);
```

### Tabela: `wallet_ledger_entries`

```sql
CREATE TABLE wallet_ledger_entries (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID        NOT NULL REFERENCES wallets(id),
    transaction_id      UUID        NOT NULL REFERENCES wager_transactions(id),
    direction           VARCHAR(6)  NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    money_amount        NUMERIC(19,4) NOT NULL,
    money_currency      CHAR(3)     NOT NULL,
    balance_before_amount NUMERIC(19,4) NOT NULL,
    balance_before_currency CHAR(3) NOT NULL,
    balance_after_amount  NUMERIC(19,4) NOT NULL,
    balance_after_currency CHAR(3) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT wle_tx_wallet_unique UNIQUE (transaction_id, wallet_id),
    CONSTRAINT wle_balance_arithmetic CHECK (
        (direction = 'CREDIT'  AND balance_after_amount = balance_before_amount + money_amount)
        OR
        (direction = 'DEBIT'   AND balance_after_amount = balance_before_amount - money_amount)
    )
);

CREATE INDEX idx_wle_wallet_created ON wallet_ledger_entries (wallet_id, created_at DESC);
CREATE INDEX idx_wle_transaction_id ON wallet_ledger_entries (transaction_id);

-- Sem trigger de DELETE: o repositório simplesmente não expõe delete().
-- Protecção adicional via RULE ou política RLS pode ser adicionada como diferencial.
```

> A constraint `wle_balance_arithmetic` no banco garante a aritmética mesmo que o código de aplicação tenha um bug — linha de defesa em profundidade.

### Tabela: `inbox_messages`

```sql
CREATE TABLE inbox_messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      VARCHAR(256) NOT NULL,
    consumer_name   VARCHAR(128) NOT NULL,
    payload_hash    CHAR(64)    NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,

    CONSTRAINT inbox_consumer_message_unique UNIQUE (consumer_name, message_id)
);

CREATE INDEX idx_inbox_message_id ON inbox_messages (message_id);
```

### Tabela: `outbox_messages`

```sql
CREATE TABLE outbox_messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id    UUID        NOT NULL,
    event_type      VARCHAR(128) NOT NULL,
    payload         JSONB       NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    attempts        SMALLINT    NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_pending ON outbox_messages (next_attempt_at)
    WHERE published_at IS NULL;
CREATE INDEX idx_outbox_aggregate_id ON outbox_messages (aggregate_id);
```

---

## Estratégia de Concorrência Detalhada

### Princípio Central

A unidade de concorrência é a **row da `wallets`** identificada por `walletId`. Todo processamento financeiro que envolva leitura+decisão sobre saldo deve:

1. Iniciar uma transação SQL explícita via `EntityManager.transactional()`.
2. Fazer `SELECT ... FOR UPDATE` na wallet (`LockMode.PESSIMISTIC_WRITE`).
3. Executar a decisão financeira (checar saldo, aplicar débito/crédito).
4. Persistir wallet + ledger + transaction + outbox/inbox atomicamente.
5. Fazer `COMMIT`.

```
Thread A (BET 80):              Thread B (BET 80):
BEGIN                           BEGIN
SELECT wallet FOR UPDATE        SELECT wallet FOR UPDATE  ← BLOQUEIA aqui
(saldo=100, ok → debita)
UPDATE wallet SET balance=20
INSERT ledger_entry
INSERT wager_transaction(PROCESSED)
INSERT outbox_message
COMMIT                          ← Thread B acorda
                                (saldo=20, insuficiente → REJEITA)
                                UPDATE wager_transaction(REJECTED)
                                INSERT outbox_message
                                COMMIT
```

### Granularidade

- Lock **por row** (`walletId`) — wallets distintas são processadas em paralelo sem bloqueio cruzado.
- Sem lock global; sem mutex em memória; sem Redis para locking.

### Timeout e Retry

- `lock_timeout` PostgreSQL: **5 segundos** por tentativa (configurável via env `DB_LOCK_TIMEOUT_MS`).
- Se `LockNotAvailableError` → retornar HTTP 503 (entrada HTTP) ou lançar exceção que volta o visibility timeout do SQS (entrada SQS).
- `statement_timeout`: **30 segundos** como proteção adicional.

### Otimistic vs Pessimistic

Adotamos **pessimistic locking** porque:
- O domínio de apostas tem alta contenção em hot wallets (jogador com muitas rodadas simultâneas).
- Optimistic locking exigiria retry da transação inteira ao detectar conflito de versão, aumentando latência e complexidade.
- MikroORM `LockMode.PESSIMISTIC_WRITE` mapeia diretamente para `SELECT FOR UPDATE` no PostgreSQL, sem complexidade adicional.
- Trade-off aceito: menor throughput em hot wallets vs. garantia de correção sem retry.

### Idempotência como Segunda Camada

A constraint `UNIQUE (idempotency_key)` no banco atua como **segunda linha de defesa**: mesmo que dois processos passem pelo lock simultâneo (improvável com SELECT FOR UPDATE), apenas um conseguirá inserir a transação — o outro recebe uma `UniqueConstraintViolationException` que é tratada como replay bem-sucedido.

---

## Fluxo de Processamento — HTTP

```mermaid
sequenceDiagram
    participant Provider
    participant Controller
    participant ProcessTxUC as ProcessWagerTransactionUseCase
    participant DB as PostgreSQL (EntityManager)
    participant OutboxWorker

    Provider->>Controller: POST /wagering/transactions\nIdempotency-Key: key123
    Controller->>ProcessTxUC: execute(dto)

    ProcessTxUC->>DB: BEGIN (EntityManager.transactional)

    ProcessTxUC->>DB: SELECT wager_transaction WHERE idempotency_key = key123
    alt Replay idêntico (payloadHash matches)
        DB-->>ProcessTxUC: existing transaction
        ProcessTxUC-->>Controller: {idempotentReplay: true, ...original response}
        Controller-->>Provider: 200 OK
    else Conflito (payloadHash diferente)
        DB-->>ProcessTxUC: existing transaction (hash mismatch)
        ProcessTxUC-->>Controller: IdempotencyConflictError
        Controller-->>Provider: 409 Conflict
    else Nova transação
        DB-->>ProcessTxUC: null

        ProcessTxUC->>DB: SELECT wallet FOR UPDATE (LockMode.PESSIMISTIC_WRITE)
        DB-->>ProcessTxUC: wallet (locked)

        ProcessTxUC->>ProcessTxUC: WagerTransaction.create()\nwallet.debit() / wallet.credit()
        ProcessTxUC->>ProcessTxUC: WalletLedgerEntry.create()
        ProcessTxUC->>ProcessTxUC: OutboxMessage.enqueue(event)

        ProcessTxUC->>DB: INSERT wager_transaction (PROCESSED/REJECTED)
        ProcessTxUC->>DB: UPDATE wallet (balance, version)
        ProcessTxUC->>DB: INSERT wallet_ledger_entry (se houver)
        ProcessTxUC->>DB: INSERT outbox_message
        ProcessTxUC->>DB: COMMIT

        ProcessTxUC-->>Controller: {idempotentReplay: false, status, balance}
        Controller-->>Provider: 200 OK / 422 (rejected)
    end

    OutboxWorker->>DB: SELECT outbox WHERE published_at IS NULL FOR UPDATE SKIP LOCKED
    OutboxWorker->>SQS: SendMessage(event)
    OutboxWorker->>DB: UPDATE outbox SET published_at = NOW()
```

---

## Fluxo de Processamento — SQS

```mermaid
sequenceDiagram
    participant SQS as SQS FIFO
    participant Consumer as SqsConsumerService
    participant ProcessTxUC as ProcessWagerTransactionUseCase
    participant DB as PostgreSQL

    SQS->>Consumer: ReceiveMessage (long-poll, max 10)
    Consumer->>Consumer: parse + validate envelope

    loop Para cada mensagem
        Consumer->>DB: BEGIN

        Consumer->>DB: INSERT inbox_message (consumer_name, messageId)\nON CONFLICT → replay detectado

        alt Replay detectado via InboxMessage
            DB-->>Consumer: existing inbox record
            Consumer->>SQS: DeleteMessage (ack)
        else Nova mensagem
            Consumer->>ProcessTxUC: execute(dto from message)
            note over ProcessTxUC,DB: mesma lógica do fluxo HTTP\n(lock wallet, processar, outbox)

            alt Sucesso ou erro de negócio (REJECTED)
                ProcessTxUC->>DB: COMMIT (inclui inbox_message)
                Consumer->>SQS: DeleteMessage (ack)
            else Erro transitório
                ProcessTxUC->>DB: ROLLBACK
                note over Consumer,SQS: Sem ack → SQS re-entrega\napós visibilityTimeout
            end
        end
    end

    note over Consumer: SIGTERM:\nAguarda mensagens em andamento\n(30s graceful timeout)
```

---

## Transactional Outbox / Inbox Detalhado

### Outbox — Garantia de Publicação

**Problema:** o processo pode morrer entre o `COMMIT` SQL e o `SendMessage` SQS.

**Solução:** a `outbox_messages` é parte da mesma transação SQL. Um worker separado faz a publicação com retry.

```
┌─────────────────────────────────────────────────────┐
│              Transação SQL única                     │
│                                                      │
│  INSERT wager_transactions                           │
│  UPDATE wallets                                      │
│  INSERT wallet_ledger_entries                        │
│  INSERT inbox_messages  (se entrada SQS)             │
│  INSERT outbox_messages                              │
│                         ──── COMMIT ────             │
└─────────────────────────────────────────────────────┘
          ↓  (após commit, eventualmente)
┌────────────────────────────┐
│    Outbox Publisher Worker  │
│                             │
│  SELECT * FROM outbox       │
│  WHERE published_at IS NULL │
│  AND next_attempt_at <= NOW │
│  FOR UPDATE SKIP LOCKED     │  ← múltiplos workers sem duplicata
│                             │
│  SQS.sendMessage(payload)   │
│                             │
│  UPDATE outbox              │
│  SET published_at = NOW()   │
└────────────────────────────┘
```

#### `SKIP LOCKED`

`FOR UPDATE SKIP LOCKED` permite que múltiplos workers Outbox varram a fila em paralelo sem bloqueio cruzado. Cada worker processa um subconjunto diferente de registros. Um registro publicado por Worker A não é visto por Worker B (já locked).

#### Backoff Exponencial

`OutboxMessage.scheduleRetry(now)`:
- `nextAttemptAt = now + 2^attempts * baseDelay` (base: 1s, máx: 5min)
- `attempts++`

#### Idempotência na Publicação

Mesmo que dois workers publiquem o mesmo `OutboxMessage` antes do `UPDATE published_at` ser visível (janela mínima), o consumidor usa o `InboxMessage` para deduplicar pelo `eventId` do envelope. O `messageId` SQS é o `eventId` do `IntegrationEvent`.

### Inbox — Deduplicação de Mensagens SQS

```
┌──────────────────────────────────────────────┐
│ SQS Message recebida (messageId = "msg-123") │
└──────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────┐
│ BEGIN transação SQL                          │
│                                              │
│ INSERT INTO inbox_messages                   │
│   (consumer_name, message_id, payload_hash)  │
│ ON CONFLICT (consumer_name, message_id) DO   │
│   NOTHING RETURNING id                       │
│                                              │
│ ← se retornou id → mensagem nova             │
│ ← se não retornou → já processada (skip)     │
└──────────────────────────────────────────────┘
          ↓ (apenas se nova)
┌──────────────────────────────────────────────┐
│ ProcessWagerTransactionUseCase.execute()     │
│ + COMMIT                                     │
└──────────────────────────────────────────────┘
          ↓
┌──────────────────────────────────────────────┐
│ SQS.deleteMessage() (ack)                    │
└──────────────────────────────────────────────┘
```

---

## Interfaces e Contratos Principais

### Porta: UnitOfWork

```typescript
// application/ports/unit-of-work.port.ts
export interface UnitOfWorkPort {
  /**
   * Executa o callback dentro de uma transação SQL com EntityManager isolado.
   * Faz COMMIT se o callback resolver; ROLLBACK se rejeitar.
   */
  transactional<T>(fn: (em: EntityManagerPort) => Promise<T>): Promise<T>;
}

export interface EntityManagerPort {
  wallets: WalletRepositoryPort;
  wagerTransactions: WagerTransactionRepositoryPort;
  ledger: LedgerRepositoryPort;
  outbox: OutboxRepositoryPort;
  inbox: InboxRepositoryPort;
}
```

### Porta: ProviderIdentityPort

```typescript
// application/ports/provider-identity.port.ts
export interface ProviderIdentity {
  providerId: string;
  scopes: string[];
}

export interface ProviderIdentityPort {
  /**
   * Resolve a identidade do provider a partir do contexto de autenticação.
   * Lança ProviderUnauthorizedError se a identidade não puder ser determinada.
   */
  resolveFromRequest(request: unknown): Promise<ProviderIdentity>;
}
```

### Use Case: ProcessWagerTransaction

```typescript
export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
}
```

### FailureCodes — Taxonomia

```typescript
export enum FailureCode {
  // Saldo
  INSUFFICIENT_BALANCE         = 'INSUFFICIENT_BALANCE',
  REVERSAL_WOULD_NEGATIVE      = 'REVERSAL_WOULD_NEGATIVE',

  // Referência
  REFERENCE_REQUIRED           = 'REFERENCE_REQUIRED',
  REFERENCE_NOT_FOUND          = 'REFERENCE_NOT_FOUND',
  REFERENCE_EXPIRED            = 'REFERENCE_EXPIRED',      // PENDING_REFERENCE expirado
  REFERENCE_ALREADY_REVERSED   = 'REFERENCE_ALREADY_REVERSED',
  REFERENCE_AMOUNT_MISMATCH    = 'REFERENCE_AMOUNT_MISMATCH',
  REFERENCE_INVALID_KIND       = 'REFERENCE_KIND_NOT_ALLOWED', // REFUND só aceita BET
  REFERENCE_WRONG_CONTEXT      = 'REFERENCE_WRONG_CONTEXT', // provider/player/wallet/round diferente

  // Domínio
  CURRENCY_MISMATCH            = 'CURRENCY_MISMATCH',
  INVALID_KIND_OPENING         = 'INVALID_KIND_OPENING',   // OPENING via API/SQS

  // Infraestrutura (FAILED, não REJECTED)
  INFRASTRUCTURE_PERMANENT     = 'INFRASTRUCTURE_PERMANENT',
}
```

---

## Modelos de Domínio — Decisões de Implementação

### Money — Biblioteca Decimal

Usar [`decimal.js`](https://github.com/MikeMcl/decimal.js) (ou `big.js`):

```typescript
import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_EVEN });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from({ amount, currency }: MoneyProps): Money {
    if (!amount || amount.trim() === '') throw new InvalidMoneyError('empty amount');
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new InvalidMoneyError(`invalid format: ${amount}`);
    const d = new Decimal(amount);
    if (d.isNaN() || !d.isFinite()) throw new InvalidMoneyError('NaN or Infinity');
    if (d.isNegative()) throw new InvalidMoneyError('negative amount');
    if (d.decimalPlaces() > 2) throw new InvalidMoneyError('too many decimal places');
    return new Money(d, currency.toUpperCase());
  }

  // ...operações retornam new Money(...)
  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }
}
```

A regex `/^\d+(\.\d{1,2})?$/` rejeita notação científica, strings vazias, negativos e mais de 2 casas.

### Wallet — Pessimistic Lock Flow

```typescript
// infrastructure/persistence/repositories/wallet.repository.ts
async findByIdForUpdate(walletId: string, em: EntityManager): Promise<Wallet> {
  const entity = await em.findOneOrFail(WalletOrmEntity, walletId, {
    lockMode: LockMode.PESSIMISTIC_WRITE,
    lockTableAliases: ['wallet'],
  });
  return WalletMapper.toDomain(entity);
}
```

### Payload Hash — SHA-256 Canônico

```typescript
// application/services/payload-hash.service.ts
import { createHash } from 'crypto';

const CANONICAL_FIELDS: (keyof TransactionPayload)[] = [
  'providerId', 'externalTransactionId', 'playerId',
  'walletId', 'roundId', 'gameId', 'kind',
  'money', 'referenceExternalTransactionId',
];

export function computePayloadHash(payload: TransactionPayload): string {
  const canonical = Object.fromEntries(
    CANONICAL_FIELDS
      .filter(k => payload[k] !== undefined)
      .sort() // garante ordenação de chaves
      .map(k => [k, payload[k]])
  );
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}
```

O header `Idempotency-Key` e metadados de transporte (`correlationId`, timestamps) **não** entram no hash.

---

## Mapeamento de Erros HTTP

| Situação | HTTP Status | Descrição |
|---|---|---|
| Payload inválido (validação de DTO) | 422 Unprocessable Entity | Campo obrigatório ausente, formato inválido |
| `Idempotency-Key` ausente | 422 Unprocessable Entity | Header obrigatório não fornecido |
| Replay idêntico | 200 OK | `idempotentReplay: true` |
| Conflito de idempotência (payload diferente) | 409 Conflict | Mesma key, payload diferente |
| Wallet duplicada | 409 Conflict | `(playerId, currency)` já existe |
| Recurso não encontrado | 404 Not Found | Wallet/Transaction inexistente |
| Rejeição por regra de negócio | 422 Unprocessable Entity | Retorna `status: REJECTED` e `failureCode` |
| Aceite com processamento pendente | 202 Accepted | `status: PENDING_REFERENCE` |
| Lock timeout / conflito de concorrência | 503 Service Unavailable | Retry recomendado |
| Erro de infraestrutura transitório | 503 Service Unavailable | Retry recomendado |
| Erro interno não esperado | 500 Internal Server Error | Sem detalhes sensíveis |

---

## Workers — Configuração e Ciclo de Vida

### Outbox Publisher Worker

```
Intervalo de polling: 1s (configurável: OUTBOX_POLL_INTERVAL_MS)
Batch size: 10 mensagens por ciclo (OUTBOX_BATCH_SIZE)
SELECT ... FOR UPDATE SKIP LOCKED → N workers sem conflito
Backoff: 2^n * 1000ms, máximo 300s
Max attempts: 10 (OUTBOX_MAX_ATTEMPTS)
```

### Pending Reference Worker

```
Cron: a cada 30s (configurável: PENDING_REF_CRON)
Max attempts: 5 (PENDING_REF_MAX_ATTEMPTS)
Backoff: 2^n * 60s (1min, 2min, 4min, 8min, 16min)
Após esgotamento: REJECTED com FailureCode.REFERENCE_EXPIRED
```

### SQS Consumer

```
Long-poll wait time: 20s
Max messages per receive: 10
Visibility timeout: 60s (renovado se processamento > 30s)
Max receive count antes de DLQ: 5
Graceful shutdown: espera mensagens em andamento (até 30s)
```

---

## Observabilidade

### Logs Estruturados (Pino)

Campos obrigatórios em todo log relevante ao processamento financeiro:

```json
{
  "level": "info",
  "correlationId": "uuid",
  "transactionId": "uuid",
  "walletId": "uuid",
  "providerId": "string",
  "messageId": "string|null",
  "event": "wager_transaction_processed",
  "status": "PROCESSED",
  "kind": "BET",
  "timestamp": "2026-07-29T15:00:00.000Z"
}
```

**Nunca logar:** `money.amount`, `balance`, dados do jogador além de `playerId`.

### Métricas (Prometheus via `prom-client`)

```
wagering_transactions_total{status, kind}           -- Counter
wagering_idempotent_replays_total{kind}             -- Counter
wagering_idempotency_conflicts_total                -- Counter
wagering_lock_conflicts_total                       -- Counter
wagering_sqs_retries_total                          -- Counter
wagering_dlq_messages_total                         -- Counter
wagering_outbox_lag_seconds                         -- Gauge (NOW - min(next_attempt_at))
wagering_transaction_duration_seconds{kind, status} -- Histogram
wagering_reconciliation_divergences_total           -- Counter
wagering_pending_reference_total                    -- Gauge
```

---

## Docker Compose

```yaml
# docker-compose.yml (produção local)
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://wagering:wagering@postgres:5432/wagering
      AWS_ENDPOINT: http://localstack:4566
      QUEUE_URL: http://localstack:4566/000000000000/wager-transactions.fifo
    depends_on: [postgres, localstack]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: wagering
      POSTGRES_USER: wagering
      POSTGRES_PASSWORD: wagering
    volumes: [postgres_data:/var/lib/postgresql/data]

  localstack:
    image: localstack/localstack:3
    ports: ["4566:4566"]
    environment:
      SERVICES: sqs
      DEFAULT_REGION: us-east-1
```

---

## Decisões Técnicas e Trade-offs

| Decisão | Escolha | Justificativa | Trade-off |
|---|---|---|---|
| Locking | Pessimistic (SELECT FOR UPDATE) | Alta contenção em hot wallets; sem retry complexo | Throughput menor em hot wallets; acceptable para apostas |
| ORM | MikroORM | Unit of Work explícito; `LockMode` nativo; `transactional()` idiomático | Curva de aprendizado maior que TypeORM |
| Decimal | `decimal.js` | Precisão arbitrária; amplamente testada; API imutável | Dependency adicional; performance marginal vs nativo |
| Armazenamento de Money | `NUMERIC(19,4)` separado de currency | Precisão exata no PG; 4 casas internas para segurança | Não usa tipo `money` do PG (impreciso) |
| Outbox | SKIP LOCKED | N workers sem coordenação; sem single point of failure | At-least-once; consumidor precisa de InboxMessage |
| FIFO Queue | SQS FIFO por `walletId` como `MessageGroupId` | Ordena mensagens da mesma wallet; reduz contenção | Não é garantia final; banco mantém invariantes |
| Autenticação | No-op AuthGuard + ProviderIdentityPort | Não compete com correção financeira; extensível sem refatoração | Zero segurança inicial; documentado em ARCHITECTURE.md |
| Hash | SHA-256 JSON canônico (chaves ordenadas) | Determinístico; resistente a reordenação de campos no provider | Sensível a adição de campos: nova versão do hash precisa de strategy de migração |
| Migrations | MikroORM Migrator (versionadas, reversíveis) | `up` + `down` por arquivo; versionamento por timestamp | Sem diff automático em produção; migrations manuais |

---

## Correctness Properties

*Uma propriedade é uma característica ou comportamento que deve se manter verdadeiro em todas as execuções válidas do sistema — essencialmente, uma afirmação formal sobre o que o sistema deve fazer. Propriedades servem como ponte entre especificações legíveis por humanos e garantias de correção verificáveis por máquina.*

### Property 1: Inputs monetários inválidos são rejeitados

*Para qualquer* string de amount que seja negativa, contenha mais de 2 casas decimais, use notação científica, seja vazia, seja `NaN` ou `Infinity`, `Money.from` deve lançar um erro de domínio.

**Validates: Requirements 1.2**

---

### Property 2: Conflito de moeda em operações aritméticas

*Para qualquer* par de instâncias de `Money` com moedas distintas `C1 ≠ C2`, qualquer operação aritmética (`add`, `subtract`) deve lançar um erro de domínio antes de realizar qualquer cálculo.

**Validates: Requirements 1.3**

---

### Property 3: Imutabilidade do Money

*Para qualquer* instância `m` de `Money` e qualquer operação aritmética aplicada sobre ela, a instância original `m` deve permanecer inalterada e a operação deve retornar uma nova instância distinta.

**Validates: Requirements 1.4**

---

### Property 4: Round-trip de serialização do Money

*Para qualquer* instância válida de `Money`, serializar com `toJSON()` e reconstruir com `Money.from(m.toJSON())` deve produzir uma instância equivalente (mesmo `amount` e `currency`).

**Validates: Requirements 1.5**

---

### Property 5: Saldo da Wallet nunca negativo

*Para qualquer* sequência de operações aplicadas a uma Wallet (BET, WIN, LOSS, REFUND, ROLLBACK), o saldo da Wallet deve sempre ser maior ou igual a zero após cada operação.

**Validates: Requirements 2.5, 5.2**

---

### Property 6: version incrementa somente em mudança de saldo

*Para qualquer* Wallet submetida a uma operação LOSS (que não altera saldo), a `version` da Wallet deve permanecer igual à anterior. *Para qualquer* Wallet submetida a uma operação BET ou WIN bem-sucedida (que altera saldo), a `version` deve ser incrementada em exatamente 1.

**Validates: Requirements 2.4**

---

### Property 7: Paginação do ledger — completude e ausência de duplicatas

*Para qualquer* Wallet com N entradas de ledger e tamanho de página L, coletar todas as páginas via cursor deve retornar exatamente N entradas sem duplicatas.

**Validates: Requirements 2.7**

---

### Property 8: Hash canônico é determinístico independente da ordem de chaves

*Para qualquer* payload de transação, permutar a ordem das chaves do JSON de entrada deve produzir exatamente o mesmo `payloadHash`.

**Validates: Requirements 3.3**

---

### Property 9: Transições de estado — estados terminais são irreversíveis

*Para qualquer* WagerTransaction em estado terminal (`PROCESSED`, `REJECTED`, `FAILED`), chamar qualquer método de transição (`markProcessed`, `markPendingReference`, `reject`, `fail`) deve lançar `InvalidTransactionStateError`.

**Validates: Requirements 3.6**

---

### Property 10: Idempotência persistente — replay retorna resposta original

*Para qualquer* transação T processada com sucesso, submeter T novamente com o mesmo `idempotencyKey` e `payloadHash` deve retornar `idempotentReplay: true`, o mesmo `transactionId`, o mesmo `status` e o mesmo `balance` sem reprocessar ou alterar o estado financeiro.

**Validates: Requirements 4.1**

---

### Property 11: Redelivery SQS não duplica efeitos financeiros

*Para qualquer* mensagem SQS com `messageId` já registrado no `inbox_messages` de um mesmo `consumerName`, re-entregar essa mensagem deve resultar em zero alterações no saldo da Wallet e zero novas entradas no ledger.

**Validates: Requirements 4.4, 9.8**

---

### Property 12: Transações REJECTED não alteram saldo nem geram ledger

*Para qualquer* WagerTransaction que resulta em status `REJECTED` (independentemente do `FailureCode`), o saldo da Wallet deve ser igual ao saldo anterior à operação e nenhuma `WalletLedgerEntry` deve existir com aquele `transactionId`.

**Validates: Requirements 5.11, 6.1**

---

### Property 13: Aritmética do ledger é sempre balanceada

*Para qualquer* `WalletLedgerEntry`, a invariante `balanceBefore ± money == balanceAfter` (CREDIT: +; DEBIT: −) deve sempre ser verdadeira.

**Validates: Requirements 6.2**

---

### Property 14: Reconciliação — saldo materializado igual ao saldo do ledger

*Para qualquer* Wallet com N entradas de ledger, o saldo recalculado aplicando todas as `WalletLedgerEntries` a partir de zero deve ser igual ao `balance` materializado na tabela `wallets`.

**Validates: Requirements 6.4**

---

### Property 15: Cenário de concorrência — exatamente um PROCESSED

*Para qualquer* Wallet com saldo B e dois pedidos de BET concorrentes com valor A onde `2A > B`, exatamente um deve resultar em `PROCESSED` e exatamente um deve resultar em `REJECTED` com `FailureCode.INSUFFICIENT_BALANCE`, com saldo final igual a `B − A` e exatamente uma `WalletLedgerEntry` de débito.

**Validates: Requirements 7.3**

---

### Property 16: Isolamento entre wallets distintas

*Para qualquer* par de Wallets `W1` e `W2` com IDs distintos, operações concorrentes sobre `W1` nunca devem alterar o saldo de `W2`.

**Validates: Requirements 7.5**

---

### Property 17: Reprocessamento de PENDING_REFERENCE é idempotente

*Para qualquer* WagerTransaction em estado `PENDING_REFERENCE`, N tentativas concorrentes de reprocessamento devem resultar em exatamente uma transição para `PROCESSED` (quando a referência existir) — nunca em múltiplas aplicações do efeito financeiro.

**Validates: Requirements 8.5**

---

### Property 18: Publicação de OutboxMessage é idempotente para o consumidor

*Para qualquer* `OutboxMessage`, N publicações concorrentes pelo Outbox Worker devem ser seguras para o consumidor downstream graças ao `eventId` estável e à deduplicação via `InboxMessage`.

**Validates: Requirements 10.3, 10.5**

---

### Property 19: Envelope IntegrationEvent contém todos os campos obrigatórios

*Para qualquer* subclasse de `IntegrationEvent`, `toJSON()` deve retornar um objeto contendo `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt` (ISO-8601 string), `version` (inteiro ≥ 1) e `data`.

**Validates: Requirements 11.1**

---

### Property 20: Payload de IntegrationEvent é JSON puro

*Para qualquer* instância de `IntegrationEvent`, `JSON.parse(JSON.stringify(e.toJSON()))` deve ser profundamente igual a `e.toJSON()` — sem perda de informação por serialização de objetos não-primitivos.

**Validates: Requirements 11.2**
