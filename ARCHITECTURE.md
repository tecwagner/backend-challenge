# Decisões de Arquitetura

## ORM — MikroORM

O MikroORM foi escolhido em detrimento do TypeORM por três razões diretamente relevantes para este desafio:

1. **Unit of Work + Identity Map** — um único `EntityManager` rastreia todas as alterações dentro de um handler de requisição/mensagem e as persiste atomicamente, tornando natural manter wallet, ledger, inbox e outbox na mesma transação sem precisar passar manualmente um objeto de conexão.
2. **`EntityManager.transactional()` + `LockMode`** — o pessimistic locking (`LockMode.PESSIMISTIC_WRITE`) é uma API de primeira classe, não um contorno via query raw.
3. **`fork()` explícito** — cada worker concorrente faz fork do seu próprio `EntityManager`, evitando contaminação cruzada do Identity Map entre requisições concorrentes.

## Mapeamento do Money

`Money` é persistido em duas colunas: `amount NUMERIC(19,4)` e `currency CHAR(3)`. A entidade ORM armazena ambos como `string` e reidrata via `Money.from({ amount, currency })`. Nenhum tipo monetário do ORM é utilizado; a classe de domínio é dona de toda a aritmética.

`NUMERIC(19,4)` oferece 15 dígitos inteiros e 4 casas decimais. O domínio impõe 2 casas decimais na fronteira; os 2 dígitos extras no tipo do banco são uma margem de segurança para requisitos futuros de precisão sem necessidade de migration.

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

## Idempotência

A idempotency key (header `Idempotency-Key`, ou campo `idempotencyKey` na mensagem SQS) é a fonte da verdade. No primeiro recebimento, a transação é persistida com a key e um `payloadHash` (SHA-256 do JSON canônico com chaves ordenadas dos campos de negócio). No replay:

- mesma key + mesmo hash → retorna o resultado original, `idempotentReplay: true`.
- mesma key + hash diferente → `REJECTED` com `FailureCode.IdempotencyPayloadConflict`.

A constraint `UNIQUE (idempotency_key)` na tabela `wager_transactions` é a guarda no nível do banco; as verificações na camada de aplicação são um caminho rápido, não a garantia.

A deduplicação do inbox SQS usa uma tabela separada `inbox_messages` com `UNIQUE (consumer_name, message_id)`, impedindo que a mesma mensagem SQS seja processada duas vezes mesmo sob reentrega.
