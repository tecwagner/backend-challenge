import { Migration } from '@mikro-orm/migrations';

export class Migration004_wager_transaction_attempts extends Migration {
  override async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE wager_transactions
        ADD COLUMN attempts SMALLINT NOT NULL DEFAULT 0;

      ALTER TABLE wager_transactions
        ADD CONSTRAINT wt_attempts_non_negative CHECK (attempts >= 0);
    `);
  }

  override async down(): Promise<void> {
    await this.execute(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS wt_attempts_non_negative;

      ALTER TABLE wager_transactions
        DROP COLUMN attempts;
    `);
  }
}
