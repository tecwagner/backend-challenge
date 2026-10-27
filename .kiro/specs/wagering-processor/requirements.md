# Requirements Document

## Introduction

O **Wagering Processor** é um serviço financeiro distribuído responsável por processar transações de apostas recebidas de múltiplos provedores de jogos. O sistema deve operar de forma correta sob entrega _at-least-once_, concorrência entre múltiplas instâncias, mensagens duplicadas, fora de ordem e falhas parciais de infraestrutura.

As prioridades são: correção financeira absoluta, concorrência segura por pessimistic locking (SELECT FOR UPDATE via MikroORM `LockMode.PESSIMISTIC_WRITE`), idempotência persistente, consistência entre saldo materializado e ledger, e processamento assíncrono com recuperação após falhas.

Stack: Bun 1.x · TypeScript strict · NestJS · PostgreSQL · MikroORM · AWS SQS via LocalStack · Docker Compose.

---

## Glossary

- **WageringProcessor**: o serviço como um todo; sistema sob especificação.
- **Wallet**: agregado raiz que encapsula o saldo de um jogador em uma moeda específica.
- **WagerTransaction**: entidade que representa uma operação de aposta enviada por um provedor.
- **WalletLedgerEntry**: registro imutável de cada movimentação de saldo de uma wallet.
- **InboxMessage**: registro persistente de uma mensagem SQS recebida, usado para deduplicação.
- **OutboxMessage**: registro persistente de um evento de integração a ser publicado.
- **Money**: value object imutável que representa um valor monetário com amount (string decimal) e currency (ISO-4217).
- **Provider**: sistema externo que submete transações de apostas ao WageringProcessor.
- **Player**: titular de uma ou mais wallets; identificado por `playerId`.
- **Round**: sessão de jogo identificada por `roundId` à qual transações pertencem.
- **idempotencyKey**: chave de idempotência fornecida pelo Provider, no formato `"{providerId}:{externalTransactionId}"`.
- **payloadHash**: hash SHA-256 de um JSON canônico (chaves ordenadas) dos campos de negócio da transação, excluindo metadados de transporte.
- **correlationId**: identificador de rastreamento propagado por toda a cadeia de processamento.
- **FailureCode**: código estável e legível por máquina que descreve o motivo de rejeição ou falha de uma transação.
- **Outbox Worker**: processo que lê OutboxMessages pendentes e as publica no SQS.
- **Pending Reference Worker**: processo agendado que reprocessa WagerTransactions em estado `PENDING_REFERENCE`.
- **BRL**: moeda padrão do sistema (Real Brasileiro, ISO-4217).
- **DLQ**: Dead Letter Queue — fila SQS de destino para mensagens que excederam o limite de tentativas.
- **EARS**: Easy Approach to Requirements Syntax — padrão de escrita de requisitos adotado neste documento.

---

## Requirements

### Requirement 1 — Modelagem Monetária

**User Story:** Como engenheiro do sistema, quero que todos os valores monetários sejam representados por um value object imutável e preciso, para que operações financeiras nunca percam precisão nem misturem moedas.

#### Acceptance Criteria

1. THE WageringProcessor SHALL representar todo valor monetário como uma instância de `Money`, composta por `amount` (string decimal com exatamente 2 casas) e `currency` (ISO-4217), sem uso de `number`, `float` ou `double`.
2. WHEN `Money.from` é chamado com `amount` contendo mais de 2 casas decimais, notação científica, string vazia, `NaN`, `Infinity` ou valor negativo, THE WageringProcessor SHALL lançar um erro de domínio e rejeitar a criação.
3. WHEN uma operação aritmética de `Money` é executada entre instâncias de moedas diferentes, THE WageringProcessor SHALL lançar um erro de domínio antes de qualquer cálculo.
4. THE `Money` SHALL ser imutável: cada operação (`add`, `subtract`, `negate`) SHALL retornar uma nova instância sem modificar as operandas originais.
5. WHEN `Money` é serializado para contratos externos ou payload de outbox, THE WageringProcessor SHALL produzir o formato `{ "amount": "XX.XX", "currency": "ISO" }` com escala fixa de 2 casas decimais.
6. THE WageringProcessor SHALL suportar múltiplas moedas no modelo de domínio, operando com BRL como moeda padrão enquanto todas as regras de conflito de moeda permanecerem testadas.

---

### Requirement 2 — Gestão de Wallets

**User Story:** Como Provider, quero criar e consultar wallets de jogadores, para que o saldo de cada jogador esteja disponível para processamento de apostas.

#### Acceptance Criteria

1. WHEN `POST /wallets` é recebido com `playerId` e `initialBalance` válidos, THE WageringProcessor SHALL criar uma Wallet com saldo inicial, gerar uma WagerTransaction interna do kind `OPENING` e uma WalletLedgerEntry `CREDIT` correspondente, tudo na mesma transação SQL.
2. THE WageringProcessor SHALL garantir no schema do banco que existe no máximo uma Wallet por combinação `(playerId, currency)`, rejeitando duplicatas como conflito HTTP 409.
3. WHEN `POST /wallets` é recebido com um par `(playerId, currency)` já existente, THE WageringProcessor SHALL retornar conflito sem criar nova wallet nem alterar a existente.
4. THE WageringProcessor SHALL inicializar `version` em `1` após a criação da Wallet e incrementar `version` somente quando o saldo da Wallet mudar.
5. THE WageringProcessor SHALL garantir que o saldo de uma Wallet nunca seja negativo, aplicando essa restrição tanto em código de domínio quanto como constraint no schema do banco.
6. WHEN `GET /wallets/:walletId` é recebido, THE WageringProcessor SHALL retornar `id`, `playerId`, `balance` e `version` da Wallet correspondente.
7. WHEN `GET /wallets/:walletId/ledger` é recebido com parâmetros `cursor` e `limit` (padrão 50), THE WageringProcessor SHALL retornar uma página de WalletLedgerEntries com cursor estável e opaco para paginação, em ordem cronológica.

---

### Requirement 3 — WagerTransaction: Criação e Ciclo de Vida

**User Story:** Como Provider, quero submeter transações de apostas e receber uma resposta determinística, para que eu possa rastrear o estado de cada operação.

#### Acceptance Criteria

1. WHEN `POST /wagering/transactions` é recebido com campos obrigatórios válidos e header `Idempotency-Key` presente, THE WageringProcessor SHALL criar uma WagerTransaction em estado `PENDING`, processar imediatamente e retornar o resultado com `transactionId`, `status`, `balance` e `idempotentReplay: false`.
2. THE WageringProcessor SHALL exigir o header `Idempotency-Key` em `POST /wagering/transactions`, retornando HTTP 422 quando ausente.
3. THE WageringProcessor SHALL armazenar `payloadHash` como SHA-256 de um JSON canônico (chaves ordenadas) dos campos de negócio, excluindo header e metadados de transporte, e documentar o algoritmo em `ARCHITECTURE.md`.
4. WHEN uma WagerTransaction do kind `REFUND` ou `ROLLBACK` é criada sem `referenceExternalTransactionId`, THE WageringProcessor SHALL rejeitar a transação com `status: REJECTED` e um `FailureCode` específico para referência ausente em contrato.
5. THE WageringProcessor SHALL garantir que WagerTransaction do kind `OPENING` não possa ser submetida via API HTTP nem via mensagem SQS, retornando erro de domínio se tentada.
6. THE WageringProcessor SHALL aplicar as transições de estado de WagerTransaction somente conforme a tabela: `PENDING → PROCESSED`, `PENDING → REJECTED`, `PENDING → PENDING_REFERENCE`, `PENDING_REFERENCE → PROCESSED`, `PENDING_REFERENCE → REJECTED`; estados `PROCESSED`, `REJECTED` e `FAILED` são terminais e não aceitam novas transições.
7. WHEN `GET /wagering/transactions/:transactionId` é recebido, THE WageringProcessor SHALL retornar os dados da WagerTransaction correspondente ao id interno.
8. WHEN `GET /providers/:providerId/wagering/transactions/:externalTransactionId` é recebido, THE WageringProcessor SHALL retornar a WagerTransaction identificada por `(providerId, externalTransactionId)`.

---

### Requirement 4 — Idempotência Persistente

**User Story:** Como Provider, quero que operações repetidas retornem o mesmo resultado da primeira vez, para que retries de rede não causem efeitos duplicados.

#### Acceptance Criteria

1. WHEN `POST /wagering/transactions` é recebido com `idempotencyKey` já processada e payload idêntico (`payloadHash` coincidente), THE WageringProcessor SHALL retornar a resposta original com `idempotentReplay: true` sem reprocessar a transação.
2. WHEN `POST /wagering/transactions` é recebido com `idempotencyKey` já existente mas `payloadHash` diferente, THE WageringProcessor SHALL retornar HTTP 409 indicando conflito de idempotência sem processar a nova transação.
3. THE WageringProcessor SHALL persistir a idempotência em banco de dados (índice único em `idempotencyKey`), não apenas em memória, de forma que reinícios de instância não percam o histórico de deduplicação.
4. WHEN uma mensagem SQS com `messageId` já registrado no inbox de um mesmo `consumerName` é recebida, THE WageringProcessor SHALL ignorar o reprocessamento sem efeito no estado financeiro.
5. THE WageringProcessor SHALL garantir que a verificação de idempotência e a persistência da transação ocorram na mesma transação SQL, prevenindo janelas de concorrência entre check e write.

---

### Requirement 5 — Regras de Negócio por Operação

**User Story:** Como sistema financeiro, quero que cada tipo de transação aplique exatamente o efeito correto no saldo e ledger, para que a integridade financeira seja mantida.

#### Acceptance Criteria

1. WHEN uma WagerTransaction do kind `BET` é processada e o saldo da Wallet é suficiente, THE WageringProcessor SHALL debitar o valor da Wallet e criar uma WalletLedgerEntry com `direction: DEBIT`.
2. WHEN uma WagerTransaction do kind `BET` é processada e o saldo da Wallet é insuficiente, THE WageringProcessor SHALL rejeitar a transação com `status: REJECTED` e `FailureCode` específico para saldo insuficiente, sem alterar saldo nem gerar ledger.
3. WHEN uma WagerTransaction do kind `WIN` é processada, THE WageringProcessor SHALL creditar o valor na Wallet e criar uma WalletLedgerEntry com `direction: CREDIT`.
4. WHEN uma WagerTransaction do kind `LOSS` é processada, THE WageringProcessor SHALL registrar a transação como `PROCESSED` sem alterar o saldo da Wallet e sem criar WalletLedgerEntry.
5. WHEN uma WagerTransaction do kind `REFUND` é processada e a referência é uma `BET` com `status: PROCESSED` do mesmo `(providerId, playerId, walletId, currency, roundId)`, THE WageringProcessor SHALL creditar na Wallet o valor igual ao da referência e criar uma WalletLedgerEntry com `direction: CREDIT`.
6. WHEN uma WagerTransaction do kind `ROLLBACK` é processada e a referência é uma `BET`, `WIN` ou `REFUND` com `status: PROCESSED` do mesmo `(providerId, playerId, walletId, currency, roundId)`, THE WageringProcessor SHALL inverter o efeito da referência na Wallet e criar uma WalletLedgerEntry na direção inversa.
7. IF o valor de um `REFUND` ou `ROLLBACK` for diferente do valor da transação referenciada, THEN THE WageringProcessor SHALL rejeitar com `status: REJECTED` e `FailureCode` específico para divergência de valor.
8. IF um `REFUND` ou `ROLLBACK` tentaria reduzir o saldo abaixo de zero, THEN THE WageringProcessor SHALL rejeitar com `status: REJECTED` e `FailureCode` distinto do código de saldo insuficiente de `BET`, mantendo o registro auditável.
9. IF uma referência já foi revertida por uma operação do mesmo tipo, THEN THE WageringProcessor SHALL rejeitar a nova tentativa de reversão com `status: REJECTED` e `FailureCode` específico para reversão duplicada.
10. THE WageringProcessor SHALL resolver a referência de `REFUND`/`ROLLBACK` exclusivamente pela chave `(providerId, referenceExternalTransactionId)`, verificando que a referência pertença ao mesmo `playerId`, `walletId`, `currency` e `roundId`.
11. WHEN uma WagerTransaction `REJECTED` é registrada, THE WageringProcessor SHALL garantir que nenhum saldo seja alterado e nenhuma WalletLedgerEntry seja criada para essa transação.

---

### Requirement 6 — Ledger Imutável

**User Story:** Como auditor financeiro, quero que cada movimentação de saldo seja registrada de forma permanente e verificável, para que a consistência entre saldo e histórico possa ser comprovada a qualquer momento.

#### Acceptance Criteria

1. THE WageringProcessor SHALL criar no máximo uma WalletLedgerEntry por WagerTransaction por Wallet.
2. THE WageringProcessor SHALL garantir que `WalletLedgerEntry.balanceBefore ± WalletLedgerEntry.money == WalletLedgerEntry.balanceAfter`, verificando essa aritmética na factory `create` antes da persistência.
3. THE WageringProcessor SHALL proibir atualização ou exclusão de WalletLedgerEntries existentes, aplicando essa restrição no schema do banco (sem colunas mutáveis, sem suporte a DELETE na camada de repositório).
4. WHEN a reconciliação de uma Wallet é solicitada via `POST /wallets/:walletId/reconciliation`, THE WageringProcessor SHALL recalcular o saldo aplicando todas as WalletLedgerEntries do ledger a partir de zero e comparar com o saldo materializado.
5. WHEN a reconciliação detecta divergência entre saldo materializado e saldo calculado pelo ledger, THE WageringProcessor SHALL registrar a divergência em log estruturado, incrementar métrica de divergência e retornar `consistent: false` com os valores detalhados sem corrigir silenciosamente o saldo.
6. WHEN a reconciliação detecta consistência, THE WageringProcessor SHALL retornar `consistent: true`, `difference: { "amount": "0.00", "currency": "BRL" }` e o total de entradas verificadas.

---

### Requirement 7 — Concorrência e Isolamento de Wallets

**User Story:** Como operador de plataforma, quero que múltiplas instâncias do serviço possam processar transações simultaneamente sem causar inconsistências, para que o sistema escale horizontalmente com segurança.

#### Acceptance Criteria

1. THE WageringProcessor SHALL adquirir um pessimistic lock (SELECT FOR UPDATE via `LockMode.PESSIMISTIC_WRITE`) sobre a Wallet antes de qualquer leitura de saldo utilizada em decisão financeira, dentro de `EntityManager.transactional()`.
2. THE WageringProcessor SHALL garantir que o lock de concorrência seja por `walletId` (granularidade de row-level locking no PostgreSQL), sem lock global compartilhado por todas as wallets.
3. WHEN duas apostas de `80.00 BRL` são processadas simultaneamente sobre uma Wallet com saldo de `100.00 BRL`, THE WageringProcessor SHALL resultar em exatamente uma `BET` com `status: PROCESSED`, a outra com `status: REJECTED` por saldo insuficiente, saldo final de `20.00 BRL` e exatamente uma WalletLedgerEntry de débito.
4. THE WageringProcessor SHALL manter correção quando três ou mais instâncias da aplicação processam transações concorrentemente sobre a mesma Wallet.
5. THE WageringProcessor SHALL permitir que Wallets de jogadores distintos sejam processadas em paralelo sem interferência.
6. IF uma transação concorrente falhar por conflito de lock ou timeout, THEN THE WageringProcessor SHALL retornar erro transitório (HTTP 503) ao chamador HTTP ou marcar a mensagem SQS para retry, sem persistir estado inconsistente.

---

### Requirement 8 — Referências Fora de Ordem (PENDING_REFERENCE)

**User Story:** Como Provider, quero que transações cuja referência ainda não chegou sejam reenfileiradas automaticamente, para que a ordem de chegada não cause perda permanente de operações válidas.

#### Acceptance Criteria

1. WHEN uma WagerTransaction do kind `REFUND` ou `ROLLBACK` é recebida e a transação referenciada não existe ainda, THE WageringProcessor SHALL persistir a transação com `status: PENDING_REFERENCE` sem alterar saldo ou ledger.
2. THE WageringProcessor SHALL executar um Pending Reference Worker com backoff exponencial que reprocessa todas as WagerTransactions com `status: PENDING_REFERENCE` cujo `nextAttemptAt` seja anterior ou igual ao momento atual.
3. THE WageringProcessor SHALL definir e documentar um limite máximo de tentativas ou TTL para reprocessamento de `PENDING_REFERENCE`; ao esgotar o limite, THE WageringProcessor SHALL transicionar a transação para `REJECTED` com `FailureCode` específico para referência inexistente após expiração.
4. WHEN uma WagerTransaction `PENDING_REFERENCE` é rejeitada por esgotamento de tentativas, THE WageringProcessor SHALL enfileirar um `OutboxMessage` com evento `WagerTransactionRejected` na mesma transação SQL.
5. THE WageringProcessor SHALL garantir que o reprocessamento de `PENDING_REFERENCE` seja idempotente: se a referência aparecer após múltiplos workers terem tentado, apenas um processamento efetivo ocorrerá.

---

### Requirement 9 — Processamento via SQS

**User Story:** Como Provider, quero enviar transações de apostas via fila SQS, para que o sistema processe operações de forma assíncrona e resiliente a picos de carga.

#### Acceptance Criteria

1. THE WageringProcessor SHALL consumir mensagens da fila `wager-transactions.fifo` usando o mesmo use case utilizado pela entrada HTTP.
2. THE WageringProcessor SHALL registrar um InboxMessage por `(consumerName, messageId)` na mesma transação SQL do processamento financeiro, garantindo deduplicação persistente de mensagens SQS.
3. THE WageringProcessor SHALL fazer `ack` (deleteMessage) da mensagem SQS somente após o commit bem-sucedido da transação SQL.
4. WHEN o processamento de uma mensagem SQS resulta em erro de negócio (violação de regra, rejeição de domínio), THE WageringProcessor SHALL fazer `ack` da mensagem sem envio à DLQ, pois o estado já foi persistido como `REJECTED`.
5. WHEN o processamento de uma mensagem SQS resulta em erro transitório de infraestrutura, THE WageringProcessor SHALL não fazer `ack`, permitindo que o SQS re-entregue a mensagem após o visibility timeout, respeitando backoff exponencial até o limite de tentativas.
6. WHEN o limite de tentativas de uma mensagem SQS é excedido, THE WageringProcessor SHALL permitir o redirecionamento automático para a fila `wager-transactions-dlq.fifo`.
7. WHEN o WageringProcessor recebe `SIGTERM`, THE WageringProcessor SHALL concluir as mensagens SQS em andamento ou estender a visibilidade antes de encerrar, sem perder transações em curso.
8. THE WageringProcessor SHALL garantir que redelivery de mensagem SQS já processada não duplique efeitos financeiros, detectando o `messageId` via InboxMessage.

---

### Requirement 10 — Transactional Outbox

**User Story:** Como sistema de eventos, quero que eventos de integração sejam publicados exatamente uma vez, para que consumidores downstream não percam nem dupliquem eventos após falhas.

#### Acceptance Criteria

1. THE WageringProcessor SHALL persistir cada OutboxMessage na mesma transação SQL que persiste a WagerTransaction, alteração de Wallet, WalletLedgerEntry e InboxMessage, garantindo atomicidade total.
2. THE WageringProcessor SHALL publicar os seguintes eventos mínimos: `WagerTransactionProcessed` para toda transação aplicada (inclusive `LOSS`), `WagerTransactionRejected` para toda rejeição, `WalletBalanceChanged` somente quando o saldo da Wallet mudar, e `WagerTransactionPendingReference` quando a referência estiver ausente.
3. THE Outbox Worker SHALL varrer OutboxMessages com `publishedAt` nulo e `nextAttemptAt` anterior ou igual ao momento atual, publicar no SQS e marcar como publicado, operando corretamente com múltiplos publishers concorrentes sem publicar duplicatas permanentes.
4. WHEN o processo encerra após o commit SQL mas antes da publicação do OutboxMessage, THE WageringProcessor SHALL garantir que outra instância do Outbox Worker detecte e publique o evento pendente.
5. THE WageringProcessor SHALL garantir que a publicação duplicada de um mesmo OutboxMessage seja segura para o consumidor, por meio de `messageId` estável e deduplicação via InboxMessage no consumidor.
6. THE WageringProcessor SHALL não publicar nenhum evento no SQS antes do commit da transação SQL correspondente.
7. WHEN o Outbox Worker falha ao publicar um OutboxMessage, THE WageringProcessor SHALL incrementar `attempts`, calcular `nextAttemptAt` com backoff exponencial via `scheduleRetry` e persistir para nova tentativa futura.

---

### Requirement 11 — Eventos de Integração

**User Story:** Como consumidor de eventos, quero receber notificações estruturadas e versionadas sobre mudanças no sistema, para que integrações downstream possam reagir a eventos com segurança.

#### Acceptance Criteria

1. THE WageringProcessor SHALL serializar cada IntegrationEvent com o envelope: `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` (opcional), `occurredAt` (ISO-8601), `version` (inteiro) e `data`.
2. THE WageringProcessor SHALL garantir que `data` de qualquer IntegrationEvent contenha apenas tipos JSON primitivos (incluindo `MoneyProps` como strings), nunca instâncias de objetos de domínio como `Money`.
3. THE `WalletBalanceChanged` event SHALL incluir em `data`: `walletId`, `transactionId`, `direction`, `money` (MoneyProps), `balanceBefore` (MoneyProps), `balanceAfter` (MoneyProps) e `walletVersion`.
4. THE WageringProcessor SHALL fixar `eventType` e `version` como propriedades do tipo da subclasse de `IntegrationEvent`, não como strings soltas no call site.

---

### Requirement 12 — Observabilidade

**User Story:** Como operador de plataforma, quero logs estruturados e métricas sobre o processamento, para que problemas operacionais sejam diagnosticados rapidamente.

#### Acceptance Criteria

1. THE WageringProcessor SHALL emitir logs em formato JSON estruturado, incluindo os campos `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` em todas as entradas de log relevantes ao processamento financeiro.
2. THE WageringProcessor SHALL omitir valores financeiros completos e dados sensíveis dos logs, referenciando apenas identificadores e metadados operacionais.
3. THE WageringProcessor SHALL expor métricas cobrindo no mínimo: contagem de transações por status, duplicatas detectadas, retries de mensagem SQS, mensagens enviadas à DLQ, conflitos de lock, lag do outbox e latência de processamento de transação.
4. WHEN `GET /health/live` é recebido, THE WageringProcessor SHALL retornar HTTP 200 indicando que o processo está ativo, sem exigir autenticação.
5. WHEN `GET /health/ready` é recebido, THE WageringProcessor SHALL verificar alcançabilidade do PostgreSQL e do SQS e retornar HTTP 200 somente se ambos estiverem acessíveis, sem exigir autenticação.

---

### Requirement 13 — Autenticação e Identidade do Provider

**User Story:** Como arquiteto do sistema, quero que a autenticação seja um ponto de extensão explícito no código, para que possa ser implementada sem refatoração estrutural quando necessário.

#### Acceptance Criteria

1. THE WageringProcessor SHALL expor um `AuthGuard` configurável que na implementação inicial opere em modo no-op (permitindo todas as requisições), mas que possa ser substituído por uma implementação real sem alterar os controllers ou use cases.
2. THE WageringProcessor SHALL expor uma porta `ProviderIdentityPort` como ponto de extensão para validação da identidade do Provider, documentada em `ARCHITECTURE.md` com o desenho da integração com Identity Provider externo (Keycloak ou Zitadel).
3. THE WageringProcessor SHALL tratar mensagens SQS como canal interno confiável, mas SHALL continuar aplicando todas as validações de domínio sobre o campo `providerId` contido na mensagem.
4. THE WageringProcessor SHALL manter os endpoints `GET /health/live` e `GET /health/ready` abertos sem qualquer guarda de autenticação.

---

### Requirement 14 — Schema e Constraints de Banco de Dados

**User Story:** Como DBA, quero que as invariantes de domínio sejam aplicadas no schema do banco, para que nenhuma inserção ou atualização direta possa violar as regras de negócio.

#### Acceptance Criteria

1. THE WageringProcessor SHALL aplicar constraint `UNIQUE (player_id, currency)` na tabela de Wallets no schema do banco.
2. THE WageringProcessor SHALL aplicar constraint `CHECK (balance_amount >= 0)` na tabela de Wallets no schema do banco.
3. THE WageringProcessor SHALL aplicar constraint `UNIQUE (idempotency_key)` na tabela de WagerTransactions no schema do banco.
4. THE WageringProcessor SHALL aplicar constraint `UNIQUE (provider_id, external_transaction_id)` na tabela de WagerTransactions no schema do banco.
5. THE WageringProcessor SHALL aplicar constraint `UNIQUE (consumer_name, message_id)` na tabela de InboxMessages no schema do banco.
6. THE WageringProcessor SHALL proibir DELETE e UPDATE destrutivo na tabela de WalletLedgerEntries por meio de constraints ou ausência de operações de mutação no repositório correspondente.
7. THE WageringProcessor SHALL versionar as migrations de banco de dados de forma reversível, com scripts de `up` e `down` para cada alteração de schema.

---

### Requirement 15 — Testes

**User Story:** Como engenheiro de qualidade, quero uma suíte de testes que cubra correção financeira, concorrência real e recuperação de falhas, para que o sistema possa ser validado objetivamente.

#### Acceptance Criteria

1. THE WageringProcessor SHALL incluir testes de unidade cobrindo: operações e validações de `Money` (escala, arredondamento, entradas inválidas), invariantes da `Wallet`, regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, conflito de moeda e idempotency key com payload divergente.
2. THE WageringProcessor SHALL incluir testes de integração usando PostgreSQL e LocalStack reais em containers, cobrindo: migrations e constraints, atomicidade entre wallet/ledger/inbox/outbox, deduplicação via inbox, publishers concorrentes sobre a outbox, retry e DLQ, e recuperação após reinicialização.
3. THE WageringProcessor SHALL incluir testes de concorrência com paralelismo real (sem mocks sequenciais) cobrindo: 50 envios paralelos da mesma aposta resultando em exatamente um débito, duas apostas de `80.00 BRL` simultâneas sobre saldo de `100.00 BRL`, wallets distintas em paralelo, três ou mais instâncias simultâneas, worker morto após commit e antes do ack, dois publishers sobre a mesma outbox, `ROLLBACK`/`REFUND` entregue antes da referência e reinício com verificação de consistência final.
4. WHEN qualquer teste de concorrência conclui, THE WageringProcessor SHALL verificar a invariante: `wallet.balance == saldo reconstruído aplicando todas as WalletLedgerEntries do ledger`.
5. THE WageringProcessor SHALL disponibilizar os comandos `bun run test` (unidade), `bun run test:integration` (integração) e `bun run test:concurrency` (concorrência) no `package.json`.
