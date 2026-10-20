import { hash, verify, type Options } from '@node-rs/argon2';

// argon2id, OWASP-recommended parameters: 19 MiB memory, 2 iterations, 1 lane (decision D3).
// The library's Algorithm type is a const enum, so the numeric value is used: 2 = Argon2id.
const ARGON2ID = 2 as NonNullable<Options['algorithm']>;
export const PASSWORD_PARAMS: Options = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const hashPassword = (password: string): Promise<string> => hash(password, PASSWORD_PARAMS);

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

// Spends the same time as a real check when the account does not exist, so response timing does not
// reveal which usernames exist.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('zentrix-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '123456789', '12345678', 'qwerty123', 'qwertyuiop',
  'iloveyou', 'admin12345', 'welcome123', 'letmein123', 'football123', 'monkey12345', 'abc1234567', 'zentrix123',
  'passw0rd123', 'uganda12345', 'kampala123', 'money12345', '0987654321', '1111111111', 'aaaaaaaaaa',
]);

export function passwordProblems(password: string, context: { username?: string; email?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters.`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) problems.push('That password is too common.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if ((context.username && context.username.length >= 3 && lower.includes(context.username.toLowerCase())) ||
      (local && local.length >= 3 && lower.includes(local))) {
    problems.push('Do not include your username or email in the password.');
  }
  return problems;
}
