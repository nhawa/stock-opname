import express, { type Express } from 'express';
import { createAuthRouter } from './auth/routes.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { createInventoryRouter } from './inventory/routes.js';
import { createStockOpnameRouter } from './stock-opname/routes.js';
import type { AppConfig, Database, TransactionCapableDatabase } from './types.js';

export function createApp(
  config: AppConfig,
  database: Database,
  configureRoutes?: (app: Express) => void,
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/auth', createAuthRouter(database, config));
  app.use('/api', createInventoryRouter(database as Database & Partial<TransactionCapableDatabase>, config));
  app.use('/api', createStockOpnameRouter(database as Database & Partial<TransactionCapableDatabase>, config));
  configureRoutes?.(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
