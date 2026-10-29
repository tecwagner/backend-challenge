# Decisões de Arquitetura

## ORM — MikroORM

O MikroORM foi escolhido em detrimento do TypeORM por três razões diretamente relevantes para este desafio:

1. **Unit of Work + Identity Map** — um único `EntityManager` rastreia todas as alterações dentro de um handler de requisição/mensagem e as persiste atomicamente, tornando natural manter wallet, ledger, inbox e outbox na mesma transação sem precisar passar manualmente um objeto de conexão.
2. **`EntityManager.transactional()` + `LockMode`** — o pessimistic locking (`LockMode.PESSIMISTIC_WRITE`) é uma API de primeira classe, não um contorno via query raw.
3. **`fork()` explícito** — cada worker concorrente faz fork do seu próprio `EntityManager`, evitando contaminação cruzada do Identity Map entre requisições concorrentes.

## Precisão Monetária — decimal.js e Mapeamento do Money

O uso do tipo primitivo `number` do JavaScript (padrão IEEE-754 de ponto flutuante de precisão dupla de 64 bits) é estritamente proibido em qualquer ponto do sistema financeiro. Operações como `0.1 + 0.2 === 0.30000000000000004` introduziriam erros cumulativos inaceitáveis em saldos e lançamentos contábeis.

A biblioteca **`decimal.js`** foi escolhida como motor de precisão monetária pelas seguintes razões:
1. **Aritmética decimal de precisão arbitrária**: Cálculos de soma, subtração, comparação e negação são executados em base 10 sem perdas ou aproximações binárias.
2. **Modo de arredondamento determinístico**: Suporta arredondamento bancário (`ROUND_HALF_EVEN`), eliminando viés estatístico de arredondamento.
3. **Imutabilidade e Encapsulamento**: O Value Object `Money` encapsula a instância interna do `Decimal`, garantindo que todo método (`add`, `subtract`, `negate`) retorne sempre uma nova instância imutável.
4. **Proteção em Três Camadas**:
   - **Camada de Domínio / Memória**: `decimal.js` via Value Object `Money`.
   - **Camada de Banco de Dados**: Colunas `balance_amount` e `money_amount` tipadas como `NUMERIC(19,4)` no PostgreSQL, oferecendo até 15 dígitos inteiros e 4 casas decimais para precisão contábil.
   - **Camada de Transporte / Contratos**: Serialização estrita como string decimal formatada com exatamente 2 casas (ex: `"100.00"`) nos DTOs HTTP e envelopes SQS, prevenindo que clients JSON desserializem valores como números de ponto flutuante.

A entidade ORM armazena os valores como `string` e os reidrata via `Money.from({ amount, currency })`. Nenhum tipo monetário mágico do ORM é utilizado.

## Estratégia de concorrência

A unidade de concorrência é o `walletId`. A estratégia escolhida é **pessimistic locking** (`SELECT … FOR UPDATE`) na linha da wallet no início de toda transação que altera saldo. Isso garante acesso serializado por wallet enquanto permite paralelismo total entre wallets distintas, satisfazendo a restrição contra lock global.

O optimistic locking (coluna `version`) é mantido como rede de segurança secundária: caso algum caminho concorrente contorne o row lock, a verificação de versão no momento do flush lançará um erro de conflito que o chamador pode retentar. O campo `version` é, portanto, tanto um invariante de domínio quanto uma guarda no nível do banco.

## Autenticação

A autenticação **não foi implementada** nesta entrega. A decisão foi tomada para preservar o timebox para correção financeira, concorrência e idempotência, que concentram o maior peso na avaliação.

O ponto de extensão está explícito:

- `src/http/guards/auth.guard.ts` — um `AuthGuard` no-op que aprova todas as requisições. Substituir por um guard JWT/OIDC integrado ao Keycloak ou Zitadel para habilitar autenticação.
- `src/infrastructure/auth/provider-identity.port.ts` — interface `ProviderIdentityPort` que o guard implementaria para resolver e validar a identidade do provedor a partir do token.

Design recomendado para produção: Keycloak (ou Zitadel) como IdP, tokens OIDC/JWT em toda requisição HTTP, e mensagens SQS tratadas como canal interno confiável (identidade do provedor validada pelo payload da mensagem contra as regras de domínio, sem reautenticação na camada de transporte).

## Taxonomia de FailureCode

Toda transação rejeitada ou com falha permanente carrega um `FailureCode` — uma string estável e legível por máquina que o provedor pode usar para decidir se reenvia, corrige o payload ou escala o problema.

| Código | Status | Significado |
|---|---|---|
| `BALANCE_INSUFFICIENT` | `REJECTED` | O débito da BET produziria saldo negativo. |
| `BALANCE_REVERSAL_INSUFFICIENT` | `REJECTED` | O crédito de reversão REFUND/ROLLBACK produziria saldo negativo. Distinto de `BALANCE_INSUFFICIENT` porque a resposta operacional difere: uma reversão que produz saldo negativo indica uma preocupação de integridade de dados, não uma situação simples de saldo insuficiente. |
| `REFERENCE_NOT_FOUND` | `REJECTED` | A referência do REFUND/ROLLBACK esgotou o limite de tentativas sem ser resolvida. O provedor deve verificar se a transação referenciada existe no seu lado. |
| `REFERENCE_ALREADY_REVERSED` | `REJECTED` | A transação referenciada já foi revertida pelo mesmo tipo de operação. O replay idempotente da reversão retorna o resultado original; uma segunda reversão distinta recebe este código. |
| `REFERENCE_INVALID_KIND` | `REJECTED` | REFUND apontando para uma transação que não é BET, ou ROLLBACK apontando para um kind não suportado. |
| `REFERENCE_AMOUNT_MISMATCH` | `REJECTED` | O valor da reversão difere do valor da transação referenciada. Reversões parciais estão fora do escopo. |
| `REFERENCE_CONTEXT_MISMATCH` | `REJECTED` | A referência pertence a um provedor, player, wallet, moeda ou rodada diferente da transação de reversão. |
| `REFERENCE_NOT_PROCESSED` | `REJECTED` | A transação referenciada existe mas não está no estado `PROCESSED` (ex.: está `REJECTED` ou `PENDING`). |
| `IDEMPOTENCY_PAYLOAD_CONFLICT` | `REJECTED` | A mesma idempotency key foi reenviada com um hash de payload diferente. Isso é um conflito, não um replay. |
| `KIND_OPENING_FORBIDDEN` | `REJECTED` | Kind `OPENING` submetido via API ou fila. É um kind interno, criado apenas pelo use case de abertura de wallet. |
| `KIND_REFERENCE_REQUIRED` | `REJECTED` | REFUND ou ROLLBACK submetido sem `referenceExternalTransactionId`. |
| `CURRENCY_MISMATCH` | `REJECTED` | A moeda da transação difere da moeda da wallet. |
| `INFRA_PERMANENT` | `FAILED` | Erro de infraestrutura irrecuperável após esgotar as tentativas. A transação é terminal e auditável; o provedor deve contatar o suporte. |

### Orientação de retry para provedores

| Prefixo do código | Ação do provedor |
|---|---|
| `BALANCE_*` | Não retentar automaticamente; requer intervenção do usuário. |
| `REFERENCE_NOT_FOUND` | Verificar se a referência existe; reenviar somente após confirmação. |
| `REFERENCE_ALREADY_REVERSED` | Tratar como sucesso (idempotente); não reenviar. |
| `REFERENCE_*` (demais) | Corrigir o payload antes de reenviar. |
| `IDEMPOTENCY_PAYLOAD_CONFLICT` | Não reenviar com a mesma key; usar uma nova key se o payload mudou intencionalmente. |
| `KIND_*` | Corrigir o payload; não retentar como está. |
| `CURRENCY_MISMATCH` | Corrigir o payload; não retentar como está. |
| `INFRA_PERMANENT` | Contatar o suporte. |

## Política de retry para PENDING_REFERENCE

Transações em `PENDING_REFERENCE` são reprocessadas por um worker agendado com **backoff exponencial**: `min(2^tentativa × 1.000 ms, 300.000 ms)` (teto de 5 minutos). Máximo de tentativas: **10**. Após 10 tentativas sem sucesso, a transação transiciona para `REJECTED` com `FailureCode.ReferenceNotFound` e um evento `WagerTransactionRejected` é publicado via outbox.

Justificativa: 10 tentativas com o backoff definido cobrem aproximadamente 85 minutos de entrega fora de ordem, suficiente para a entrega at-least-once do SQS em condições normais. O teto evita crescimento ilimitado da fila.

## Transactional Outbox

Os eventos são gravados na tabela `outbox_messages` **dentro da mesma transação SQL** que a alteração financeira. Um worker separado faz polling das linhas não publicadas (`published_at IS NULL`) usando `SELECT … FOR UPDATE SKIP LOCKED` para permitir múltiplos publishers concorrentes sem publicação duplicada. Após um envio bem-sucedido ao SQS, a linha é marcada com `published_at = now()`.

Isso garante: nenhum evento é perdido se o processo morrer após o commit, e nenhum evento é publicado antes do commit.

## Hash canônico do payload (SHA-256)

O `payloadHash` é o hex SHA-256 de `JSON.stringify` de um objeto canônico contendo **somente** os campos de negócio:

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`.

Regras:

1. Header `Idempotency-Key`, `correlationId` e timestamps **não** entram no hash.
2. Campos `undefined` são omitidos (ex.: BET sem referência).
3. Em todo objeto aninhado (incluindo `money`), as chaves são ordenadas lexicograficamente antes do `JSON.stringify`.
4. `money` entra como `{ "amount": "XX.XX", "currency": "ISO" }` — strings, nunca `number`.

Isso torna o hash determinístico mesmo se o provedor reordenar as chaves do JSON.

Implementação: `src/application/services/payload-hash.service.ts`.

## Idempotência

A idempotency key (header `Idempotency-Key`, ou campo `idempotencyKey` na mensagem SQS) é a fonte da verdade. No primeiro recebimento, a transação é persistida com a key e um `payloadHash` (SHA-256 do JSON canônico com chaves ordenadas dos campos de negócio). No replay:

- mesma key + mesmo hash → retorna o resultado original, `idempotentReplay: true`.
- mesma key + hash diferente → `REJECTED` com `FailureCode.IdempotencyPayloadConflict`.

A constraint `UNIQUE (idempotency_key)` na tabela `wager_transactions` é a guarda no nível do banco; as verificações na camada de aplicação são um caminho rápido, não a garantia.

A deduplicação do inbox SQS usa uma tabela separada `inbox_messages` com `UNIQUE (consumer_name, message_id)`, impedindo que a mesma mensagem SQS seja processada duas vezes mesmo sob reentrega.

## Limitações Conhecidas e Trade-offs Aceitos

1. **Contenção de Lock por Carteira ("Hot Wallet") vs. Throughput**:
   - **Trade-off**: Disparar centenas de requisições concorrentes sobre a mesma carteira serializa a execução através do row lock `SELECT … FOR UPDATE`. Requisições que excederem o timeout configurado (`DB_LOCK_TIMEOUT_MS=5000`) recebem `HTTP 503 Service Unavailable`.
   - **Decisão**: A integridade contábil e a prevenção absoluta de saldo negativo superam a vazão irrestrita por carteira. O isolamento em nível de linha permite que milhares de carteiras distintas operem em paralelo sem contenção mútua.

2. **Reversões Parciais Fora do Escopo**:
   - **Trade-off**: Operações de `REFUND` e `ROLLBACK` exigem correspondência exata do valor (`money_amount`) em relação à transação referenciada. Se o valor diferir, a transação é rejeitada com `REFERENCE_AMOUNT_MISMATCH`.
   - **Decisão**: Evita a complexidade de gerenciar saldos residuais parciais de apostas e estornos fracionados no escopo deste desafio, mantendo a auditabilidade linear 1:1 entre estorno e aposta original.

3. **Latência do Polling da Outbox vs. CDC (Change Data Capture)**:
   - **Trade-off**: O `OutboxPublisherWorker` opera via polling periódico com `SKIP LOCKED` a cada `1.000 ms`, introduzindo uma latência média de ~500 ms entre o commit no banco e a entrega na fila SQS.
   - **Decisão**: Polling periódico com `SKIP LOCKED` oferece simplicidade operacional, robustez e distribuição nativa de carga entre múltiplas instâncias sem a complexidade de manter pipelines externos como Debezium/Kafka ou conexões dedicadas `LISTEN/NOTIFY` do PostgreSQL.

4. **Retenção da Tabela de Outbox**:
   - **Trade-off**: Registros na tabela `outbox_messages` permanecem após a publicação (`published_at IS NOT NULL`) para fins de auditoria, aumentando o volume de dados ao longo do tempo.
   - **Decisão**: Para ambientes de produção com milhões de transações diárias, a recomendação é implementar particionamento de tabela por mês (`RANGE (created_at)`) e uma rotina de arquivamento (cold storage) para registros publicados há mais de 30 dias.

5. **Autenticação Desacoplada com No-op Guard**:
   - **Trade-off**: O serviço não valida assinaturas criptográficas de tokens JWT na camada de transporte HTTP por padrão.
   - **Decisão**: Conforme previsto na Seção 2 do desafio, o foco foi concentrado na correção financeira e concorrência distribuída. As interfaces `AuthGuard` e `ProviderIdentityPort` foram desenhadas para plugar diretamente um Identity Provider OIDC (como Keycloak ou Zitadel) sem qualquer refatoração no domínio.
