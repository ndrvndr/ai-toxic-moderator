import { Pool, PoolClient } from 'pg';

export function createPool(connectionString: string) {
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
}
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export type { PoolClient } from 'pg';
