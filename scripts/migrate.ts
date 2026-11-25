import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  throw new Error('Usage: tsx scripts/migrate.ts <up|down>');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Copy .env.example or export it before running migrations.');
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(rootDir, 'db', 'migrations');
const client = new Client({ connectionString: databaseUrl });

async function migrationFiles(suffix: '.up.sql' | '.down.sql'): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((file) => /^\d+_[a-z0-9_]+\.(up|down)\.sql$/.test(file) && file.endsWith(suffix))
    .sort();
}

async function main(): Promise<void> {
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    if (direction === 'up') {
      const applied = new Set(
        (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name),
      );
      for (const file of await migrationFiles('.up.sql')) {
        const name = file.replace(/\.up\.sql$/, '');
        if (applied.has(name)) continue;
        await client.query('BEGIN');
        try {
          await client.query(await readFile(path.join(migrationsDir, file), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
          console.log(`Applied ${name}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      return;
    }

    const latest = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1',
    );
    if (latest.rowCount === 0) {
      console.log('No migration to roll back.');
      return;
    }
    const name = latest.rows[0].name;
    const file = `${name}.down.sql`;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(path.join(migrationsDir, file), 'utf8'));
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
      console.log(`Rolled back ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
