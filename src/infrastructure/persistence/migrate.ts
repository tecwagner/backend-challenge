import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config.js';

const command = process.argv[2] ?? 'up';

const orm = await MikroORM.init(config);
const migrator = orm.migrator;

try {
  if (command === 'up' || command === 'migration:up') {
    const migrations = await migrator.up();
    if (migrations.length === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Ran ${migrations.length} migration(s):`);
      migrations.forEach((m) => console.log(' -', m.name));
    }
  } else if (command === 'down' || command === 'migration:down') {
    const migration = await migrator.down();
    console.log('Rolled back:', migration);
  } else if (command === 'status' || command === 'migration:status') {
    const pending = await migrator.getPending();
    const executed = await migrator.getExecuted();
    console.log(`Executed: ${executed.length}, Pending: ${pending.length}`);
    pending.forEach((m) => console.log(' pending:', m.name));
  } else {
    console.error(`Unknown command: ${command}. Use: up | down | status`);
    process.exit(1);
  }
} finally {
  await orm.close();
}
