import { z } from 'zod';
import type { AppConfig } from './types.js';

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('stock-opname-api'),
  JWT_AUDIENCE: z.string().min(1).default('stock-opname-client'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
  COUNT_RESERVATION_ACTIVE_SECONDS: z.coerce.number().int().positive().max(86_400).default(90),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
});

export interface RuntimeConfig extends AppConfig {
  databaseUrl: string;
  port: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error('Invalid server configuration.');
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    jwt: {
      secret: parsed.data.JWT_SECRET,
      issuer: parsed.data.JWT_ISSUER,
      audience: parsed.data.JWT_AUDIENCE,
      expiresInSeconds: parsed.data.JWT_EXPIRES_IN_SECONDS,
    },
    stockOpname: {
      countReservationActiveSeconds: parsed.data.COUNT_RESERVATION_ACTIVE_SECONDS,
    },
  };
}
