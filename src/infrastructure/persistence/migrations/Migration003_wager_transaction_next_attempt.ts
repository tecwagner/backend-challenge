import { Migration } from '@mikro-orm/migrations';

export class Migration003_wager_transaction_next_attempt extends Migration {
  override async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE wager_transactions
        ADD COLUMN next_attempt_at TIMESTAMPTZ NULL;
    `);

    // Recria o índice parcial incluindo next_attempt_at para que o worker
    // de reprocessamento possa filtrar por status + next_attempt_at sem full scan.
    await this.execute(`
      DROP INDEX IF EXISTS wt_pending_reference_idx;

      CREATE INDEX wt_pending_reference_idx
        ON wager_transactions (next_attempt_at ASC NULLS FIRST)
        WHERE status = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    await this.execute(`
      DROP INDEX IF EXISTS wt_pending_reference_idx;

      CREATE INDEX wt_pending_reference_idx
        ON wager_transactions (created_at ASC)
        WHERE status = 'PENDING_REFERENCE';

      ALTER TABLE wager_transactions
        DROP COLUMN next_attempt_at;
    `);
  }
}
