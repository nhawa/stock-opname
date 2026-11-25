import bcrypt from 'bcrypt';

// Cost 12 matches the deterministic Task 01 seed hashes and is the policy for future hashes.
const dummyHash = '$2b$12$OhJKfyx1HvGW/dL7/JfI0ei7.5jQYjbIeK1f7jDGA.XhpUGrfnVsu';

export async function passwordMatches(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}

export async function performDummyPasswordCheck(password: string): Promise<void> {
  await bcrypt.compare(password, dummyHash);
}
