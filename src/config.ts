import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().optional().transform((v) => v || undefined),
  JWT_AUDIENCE: z.string().optional().transform((v) => v || undefined),
  SNOWFLAKE_NODE_ID: z.coerce.number().int().min(0).max(1023).default(1),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(2_097_152),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(2_097_152),
  MAX_NODES: z.coerce.number().int().positive().default(5000),
  MAX_DEPTH: z.coerce.number().int().positive().default(32),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().positive().default(48),
  LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  OUTBOX_WORKER_ENABLED: bool.default(true),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(2000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration (check your .env file):\n${lines}`);
}

export const config = parsed.data;
