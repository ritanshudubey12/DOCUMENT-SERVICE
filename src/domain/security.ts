import { AppError } from '../common/errors';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const UNSAFE_PATTERNS: Array<[RegExp, string]> = [
  [/<\s*\/?\s*(script|iframe|object|embed|style|link|meta|base|form)\b/i, 'disallowed HTML tag'],
  [/<[^>]*\bon[a-z]+\s*=/i, 'inline event handler'],
  [/(java|vb)script\s*:/i, 'script URL'],
  [/data\s*:\s*text\/html/i, 'data:text/html URL'],
  [/expression\s*\(/i, 'CSS expression'],
  [/url\s*\(/i, 'CSS url()'],
];

export function isSafeUrl(url: string): boolean {
  const t = url.trim();
  if (t.length === 0 || t.length > 2048) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return false;
  if (t.startsWith('#')) return true;
  if (t.startsWith('/')) return !t.startsWith('//');
  return /^(https?:|mailto:|tel:)/i.test(t);
}

/** Rejects prototype-polluting keys anywhere in a patch/payload. */
export function assertSafeKeys(value: unknown, where: string, depth = 0): void {
  if (depth > 64) throw new AppError('ACTION_INVALID', `${where} is nested too deeply`);
  if (Array.isArray(value)) return value.forEach((v) => assertSafeKeys(v, where, depth + 1));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) throw new AppError('ACTION_INVALID', `${where} contains forbidden key "${k}"`);
      assertSafeKeys(v, where, depth + 1);
    }
  }
}

/** Scans every string in a structure for script/markup injection patterns. */
export function assertSafeContent(value: unknown, where: string, depth = 0): void {
  if (depth > 64) throw new AppError('ACTION_INVALID', `${where} is nested too deeply`);
  if (typeof value === 'string') {
    for (const [re, reason] of UNSAFE_PATTERNS) {
      if (re.test(value)) throw new AppError('UNSAFE_CONTENT', `Unsafe content in ${where}: ${reason}`, { where, reason });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => assertSafeContent(v, where, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) assertSafeContent(v, where, depth + 1);
  }
}

export function assertSafeLink(href: string, where: string): void {
  if (!isSafeUrl(href)) {
    throw new AppError('UNSAFE_CONTENT', `Unsafe URL in ${where}: only http, https, mailto, tel, #anchor and /relative are allowed`, {
      where,
      reason: 'unsafe_url',
    });
  }
}
