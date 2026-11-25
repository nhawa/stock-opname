import { Pool, type PoolClient } from 'pg';
import { AppError } from './errors.js';
import type { TransactionCapableDatabase } from './types.js';

const RETRIABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function withTransaction<T>(
  database: TransactionCapableDatabase,
  callback: (client: PoolClient) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = await database.connect();
    let began = false;

    try {
      await client.query('BEGIN');
      began = true;
      const result = await callback(client);
      try {
        await client.query('COMMIT');
      } catch {
        // PostgreSQL may have committed before a network error reached the client.
        // Never replay automatically; the caller must retry its idempotency key.
        throw new AppError(503, 'COMMIT_OUTCOME_UNKNOWN', 'Transaction outcome is unknown. Retry with the same idempotency key.');
      }
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The original error remains the useful failure.
        }
      }

      if (error instanceof AppError) throw error;

      const code = getDatabaseErrorCode(error);
      if (code && RETRIABLE_TRANSACTION_CODES.has(code) && attempt < maxAttempts) {
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  throw new AppError(503, 'TRANSACTION_RETRY_EXHAUSTED', 'Transaction could not be completed.');
}

function getDatabaseErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
