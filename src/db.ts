import { Pool, type PoolClient } from 'pg';
import { AppError } from './errors.js';
import type { TransactionCapableDatabase } from './types.js';

const RETRIABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);

export interface TransactionOptions {
  maxAttempts?: number;
  isolationLevel?: 'read committed' | 'serializable';
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function withTransaction<T>(
  database: TransactionCapableDatabase,
  callback: (client: PoolClient) => Promise<T>,
  maxAttempts?: number,
): Promise<T>;
export async function withTransaction<T>(
  database: TransactionCapableDatabase,
  callback: (client: PoolClient) => Promise<T>,
  options?: TransactionOptions,
): Promise<T>;
export async function withTransaction<T>(
  database: TransactionCapableDatabase,
  callback: (client: PoolClient) => Promise<T>,
  optionsOrAttempts: number | TransactionOptions = 3,
): Promise<T> {
  const options = normalizeTransactionOptions(optionsOrAttempts);
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const client = await database.connect();
    let began = false;

    try {
      await client.query(options.isolationLevel === 'serializable' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
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
      if (code && RETRIABLE_TRANSACTION_CODES.has(code)) {
        if (attempt < options.maxAttempts) continue;
        throw new AppError(503, 'TRANSACTION_RETRY_EXHAUSTED', 'Transaction could not be completed.');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  throw new AppError(503, 'TRANSACTION_RETRY_EXHAUSTED', 'Transaction could not be completed.');
}

function normalizeTransactionOptions(optionsOrAttempts: number | TransactionOptions): Required<TransactionOptions> {
  if (typeof optionsOrAttempts === 'number') {
    return { maxAttempts: optionsOrAttempts, isolationLevel: 'read committed' };
  }
  return {
    maxAttempts: optionsOrAttempts.maxAttempts ?? 3,
    isolationLevel: optionsOrAttempts.isolationLevel ?? 'read committed',
  };
}

function getDatabaseErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
