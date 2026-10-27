import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  clientUrl: process.env['DATABASE_URL'] ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
  entities: ['dist/**/*.entity.js'],
  entitiesTs: ['src/**/*.entity.ts'],
  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    pathTs: 'src/infrastructure/persistence/migrations',
  },
  debug: process.env['NODE_ENV'] === 'development',
});
