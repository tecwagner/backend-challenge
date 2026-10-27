import { Migration } from '@mikro-orm/migrations';

export class Migration002_indexes extends Migration {
  override async up(): Promise<void> {
    // Worker de reprocessamento varre apenas transações aguardando referência,
    // ordenadas por próxima tentativa — índice parcial elimina o full scan.
    await this.execute(`
      CREATE INDEX wt_pending_reference_idx
        ON wager_transactions (created_at ASC)
        WHERE status = 'PENDING_REFERENCE';
    `);

    // Paginação do ledger por wallet em ordem cronológica inversa (cursor-based).
    await this.execute(`
      CREATE INDEX wle_wallet_created_idx
        ON wallet_ledger_entries (wallet_id, created_at DESC);
    `);

    // Lookup de transação por provedor + id externo (resolução de referências).
    await this.execute(`
      CREATE INDEX wt_provider_external_idx
        ON wager_transactions (provider_id, external_transaction_id);
    `);
  }

  override async down(): Promise<void> {
    await this.execute(`
      DROP INDEX IF EXISTS wt_pending_reference_idx;
      DROP INDEX IF EXISTS wle_wallet_created_idx;
      DROP INDEX IF EXISTS wt_provider_external_idx;
    `);
  }
}
