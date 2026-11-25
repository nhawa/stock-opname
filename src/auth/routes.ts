import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig, Database } from '../types.js';
import { authenticate } from './middleware.js';
import { login } from './service.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
}).strict();

export function createAuthRouter(database: Database, config: AppConfig): Router {
  const router = Router();

  router.post('/login', async (request, response, next) => {
    try {
      if (!request.is('application/json')) {
        response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Login requires JSON.' } });
        return;
      }
      const body = loginSchema.parse(request.body);
      const result = await login(database, config, body.email, body.password);
      response.status(200).json({ ...result, tokenType: 'Bearer' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', authenticate(database, config), (request, response) => {
    const { id, storeId, email, name, role } = request.auth!;
    response.status(200).json({ id, storeId, email, name, role });
  });

  router.post('/logout', authenticate(database, config), (_request, response) => {
    response.status(204).send();
  });

  return router;
}
