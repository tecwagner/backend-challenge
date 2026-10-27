import { Migration } from '@mikro-orm/migrations';

export class Migration001_initial_schema extends Migration {
  override async up(): Promise<void> {
    await this.execute(`
      CREATE TABLE wallets (
        id            UUID        PRIMARY KEY,
        player_id     UUID        NOT NULL,
        currency      CHAR(3)     NOT NULL,
        balance_amount NUMERIC(19,2) NOT NULL DEFAULT 0,
        version       INTEGER     NOT NULL DEFAULT 1,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency)
      );
    `);

    await this.execute(`
      CREATE TABLE wager_transactions (
        id                              UUID        PRIMARY KEY,
        provider_id                     TEXT        NOT NULL,
        external_transaction_id         TEXT        NOT NULL,
        idempotency_key                 TEXT        NOT NULL,
        payload_hash                    TEXT        NOT NULL,
        wallet_id                       UUID        NOT NULL REFERENCES wallets(id),
        player_id                       UUID        NOT NULL,
        round_id                        TEXT        NOT NULL,
        game_id                         TEXT        NOT NULL,
        kind                            TEXT        NOT NULL,
        money_amount                    NUMERIC(19,2) NOT NULL,
        money_currency                  CHAR(3)     NOT NULL,
        reference_external_transaction_id TEXT      NULL,
        reference_transaction_id        UUID        NULL,
        status                          TEXT        NOT NULL DEFAULT 'PENDING',
        failure_code                    TEXT        NULL,
        processed_at                    TIMESTAMPTZ NULL,
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT wt_idempotency_key_uq         UNIQUE (idempotency_key),
        CONSTRAINT wt_provider_external_uq        UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wt_money_amount_positive       CHECK (money_amount > 0),
        CONSTRAINT wt_status_valid                CHECK (status IN (
          'PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'
        )),
        CONSTRAINT wt_kind_valid                  CHECK (kind IN (
          'OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'
        )),
        CONSTRAINT wt_reference_required          CHECK (
          (kind NOT IN ('REFUND', 'ROLLBACK')) OR
          (reference_external_transaction_id IS NOT NULL)
        ),
        CONSTRAINT wt_failure_code_terminal       CHECK (
          (failure_code IS NULL) OR (status IN ('REJECTED', 'FAILED'))
        )
      );
    `);

    await this.execute(`
      CREATE TABLE wallet_ledger_entries (
        id               UUID          PRIMARY KEY,
        wallet_id        UUID          NOT NULL REFERENCES wallets(id),
        transaction_id   UUID          NOT NULL REFERENCES wager_transactions(id),
        direction        TEXT          NOT NULL,
        money_amount     NUMERIC(19,2) NOT NULL,
        money_currency   CHAR(3)       NOT NULL,
        balance_before   NUMERIC(19,2) NOT NULL,
        balance_after    NUMERIC(19,2) NOT NULL,
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

        CONSTRAINT wle_transaction_wallet_uq  UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wle_direction_valid        CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wle_money_amount_positive  CHECK (money_amount > 0),
        CONSTRAINT wle_balance_before_nn      CHECK (balance_before >= 0),
        CONSTRAINT wle_balance_after_nn       CHECK (balance_after >= 0),
        CONSTRAINT wle_balance_arithmetic     CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + money_amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - money_amount)
        )
      );
    `);

    await this.execute(`
      CREATE TABLE inbox_messages (
        message_id      TEXT        NOT NULL,
        consumer_name   TEXT        NOT NULL,
        payload_hash    TEXT        NOT NULL,
        received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at    TIMESTAMPTZ NULL,

        CONSTRAINT inbox_consumer_message_uq UNIQUE (consumer_name, message_id)
      );
    `);

    await this.execute(`
      CREATE TABLE outbox_messages (
        id               UUID        PRIMARY KEY,
        aggregate_id     TEXT        NOT NULL,
        event_type       TEXT        NOT NULL,
        payload          JSONB       NOT NULL,
        occurred_at      TIMESTAMPTZ NOT NULL,
        attempts         INTEGER     NOT NULL DEFAULT 0,
        next_attempt_at  TIMESTAMPTZ NULL,
        published_at     TIMESTAMPTZ NULL,

        CONSTRAINT outbox_attempts_nn CHECK (attempts >= 0)
      );

      CREATE INDEX outbox_pending_idx
        ON outbox_messages (next_attempt_at ASC)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    await this.execute(`
      DROP INDEX IF EXISTS outbox_pending_idx;
      DROP TABLE IF EXISTS outbox_messages;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
    `);
  }
}
