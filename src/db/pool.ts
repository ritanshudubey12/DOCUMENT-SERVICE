import { Pool, type PoolClient } from 'pg';
import { config } from '../config';

export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 20 });

// pg returns BIGINT (int8) as decimal strings by default, which is exactly what we want:
// never parsed into a lossy JavaScript Number.

export interface Queryable {
  query: PoolClient['query'];
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
