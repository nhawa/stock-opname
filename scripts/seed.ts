import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ connectionString: databaseUrl });

async function main(): Promise<void> {
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(await readFile(path.join(rootDir, 'db', 'seeds', '001_development.sql'), 'utf8'));
      await client.query('COMMIT');
      console.log('Development seed applied.');
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
