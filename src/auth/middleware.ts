import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors.js';
import type { AppConfig, Database } from '../types.js';
import { findActiveUserById } from './repository.js';
import { verifyAccessToken } from './token.js';
import type { Role } from './types.js';

export function authenticate(database: Database, config: AppConfig): RequestHandler {
  return async (request, _response, next) => {
    try {
      const authorizationValues = request.rawHeaders.filter(
        (_value, index, headers) => index % 2 === 0 && headers[index].toLowerCase() === 'authorization',
      );
      if (authorizationValues.length !== 1 || typeof request.headers.authorization !== 'string') {
        throw new AppError(401, 'INVALID_TOKEN', 'Authentication is required.');
      }

      const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(request.headers.authorization);
      if (!match) throw new AppError(401, 'INVALID_TOKEN', 'Authentication is required.');

      const userId = verifyAccessToken(match[1], config);
      const user = await findActiveUserById(database, userId);
      if (!user) throw new AppError(401, 'INVALID_TOKEN', 'Authentication is required.');

      request.auth = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRoles(...allowedRoles: readonly Role[]): RequestHandler {
  return (request, _response, next) => {
    if (!request.auth) return next(new AppError(401, 'INVALID_TOKEN', 'Authentication is required.'));
    if (!allowedRoles.includes(request.auth.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'You are not allowed to perform this action.'));
    }
    next();
  };
}

export interface StoreOwnedResource {
  id: string;
  storeId: string;
}

export function requireStoreOwnership(resource: StoreOwnedResource, request: Request): void {
  if (!request.auth || resource.storeId !== request.auth.storeId) {
    throw new AppError(403, 'FORBIDDEN', 'You are not allowed to access this resource.');
  }
}

export function attachStoreOwnedResource(
  loader: (request: Request) => Promise<StoreOwnedResource | null>,
): RequestHandler {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      const resource = await loader(request);
      if (!resource) throw new AppError(404, 'NOT_FOUND', 'Resource not found.');
      requireStoreOwnership(resource, request);
      next();
    } catch (error) {
      next(error);
    }
  };
}
