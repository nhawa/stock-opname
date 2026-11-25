import { AppError } from '../errors.js';
import type { AppConfig, Database } from '../types.js';
import { passwordMatches, performDummyPasswordCheck } from './password.js';
import { findActiveUserByEmail } from './repository.js';
import { createAccessToken } from './token.js';

export async function login(
  database: Database,
  config: AppConfig,
  email: string,
  password: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const user = await findActiveUserByEmail(database, email);
  if (!user) {
    await performDummyPasswordCheck(password);
    throw invalidCredentials();
  }

  if (!(await passwordMatches(password, user.passwordHash))) {
    throw invalidCredentials();
  }

  return {
    accessToken: createAccessToken(user.id, config),
    expiresIn: config.jwt.expiresInSeconds,
  };
}

function invalidCredentials(): AppError {
  return new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
}
