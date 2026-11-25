import type { Database } from '../types.js';
import type { AuthenticatedUser, UserWithPassword } from './types.js';

interface UserRow {
  id: string;
  store_id: string;
  email: string;
  name: string;
  role: UserWithPassword['role'];
  password_hash: string;
}

const activeUserColumns = `
  SELECT u.id, u.store_id, u.email, u.name, u.role, u.password_hash
  FROM users u
  JOIN stores s ON s.id = u.store_id
  WHERE u.is_active = true AND s.is_active = true`;

export async function findActiveUserByEmail(database: Database, email: string): Promise<UserWithPassword | null> {
  const result = await database.query<UserRow>(`${activeUserColumns} AND u.email = $1`, [email]);
  return result.rows[0] ? toUserWithPassword(result.rows[0]) : null;
}

export async function findActiveUserById(database: Database, id: string): Promise<AuthenticatedUser | null> {
  const result = await database.query<UserRow>(`${activeUserColumns} AND u.id = $1`, [id]);
  return result.rows[0] ? toAuthenticatedUser(result.rows[0]) : null;
}

function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  return { id: row.id, storeId: row.store_id, email: row.email, name: row.name, role: row.role };
}

function toUserWithPassword(row: UserRow): UserWithPassword {
  return { ...toAuthenticatedUser(row), passwordHash: row.password_hash };
}
