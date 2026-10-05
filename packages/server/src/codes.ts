import { randomBytes, randomInt } from 'node:crypto';

// No vowels (and no Y), so random codes can't spell words, rude or otherwise.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const CUSTOM_CODE = /^[A-Z0-9][A-Z0-9_-]{1,23}$/;

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidCustomCode(code: string): boolean {
  return CUSTOM_CODE.test(code);
}

/** Random room code that isn't in use. Four letters gives 160,000 codes; grows if the space gets crowded. */
export function generateCode(inUse: (code: string) => boolean, length = 4): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!inUse(code)) return code;
  }
  return generateCode(inUse, length + 1);
}

/** Secret session token. */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Short public id, unique within a room. */
export function generateMemberId(): string {
  return randomBytes(6).toString('base64url');
}
