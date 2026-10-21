import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params);
}

/** Executa `work` dentro de uma transação: commit no sucesso, rollback em qualquer erro. */
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error: unknown) {
    failure = error;
    // Se o rollback também falhar (conexão caída), não esconde o erro original.
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    // release(erro) descarta a conexão em vez de devolvê-la quebrada ao pool.
    client.release(failure instanceof Error ? failure : undefined);
  }
}
