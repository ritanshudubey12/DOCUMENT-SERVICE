import { AppError } from './errors';

const MAX_BIGINT = 9223372036854775807n; // PostgreSQL BIGINT max
const ID_RE = /^[1-9]\d{0,18}$/;

/** True for a canonical positive decimal string that fits in a signed 64-bit integer. */
export function isBigintId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v) && BigInt(v) <= MAX_BIGINT;
}

/** Validates a BIGINT identifier received over HTTP. IDs are never converted to Number. */
export function parseId(v: unknown, name: string): string {
  if (!isBigintId(v)) throw new AppError('INVALID_IDENTIFIER', `${name} must be a positive 64-bit integer string`);
  return v;
}

/** JSON.stringify replacer: a raw bigint must never reach the wire; emit it as a string. */
export const bigintReplacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);
