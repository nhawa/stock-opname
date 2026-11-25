import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface TransactionDatabase extends Database {
  release(): void;
}

export interface TransactionCapableDatabase extends Database {
  connect(): Promise<PoolClient>;
}

export type DatabasePool = Pool;

export interface AppConfig {
  jwt: {
    secret: string;
    issuer: string;
    audience: string;
    expiresInSeconds: number;
  };
}
