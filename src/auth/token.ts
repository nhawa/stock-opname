import jwt, { type JwtPayload } from 'jsonwebtoken';
import { AppError } from '../errors.js';
import type { AppConfig } from '../types.js';

export function createAccessToken(userId: string, config: AppConfig): string {
  return jwt.sign({}, config.jwt.secret, {
    algorithm: 'HS256',
    subject: userId,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    expiresIn: config.jwt.expiresInSeconds,
  });
}

export function verifyAccessToken(token: string, config: AppConfig): string {
  try {
    const payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });

    if (typeof payload === 'string' || !isUuid(payload.sub)) {
      throw new Error('Invalid subject');
    }
    return payload.sub;
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Authentication is required.');
  }
}

function isUuid(value: JwtPayload['sub']): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
