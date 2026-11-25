export const roles = ['STAFF', 'MANAGER'] as const;
export type Role = (typeof roles)[number];

export interface AuthenticatedUser {
  id: string;
  storeId: string;
  email: string;
  name: string;
  role: Role;
}

export interface UserWithPassword extends AuthenticatedUser {
  passwordHash: string;
}
