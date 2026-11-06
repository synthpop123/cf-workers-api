/**
 * The write counter behind every tokens write (migrations/tokens/
 * 0006_generation.sql). D1 runs each batch as one transaction, but the
 * work around a batch is not inside it: a submission merges in memory
 * against rows it read in an earlier statement, and the view is composed
 * from D1 and published to KV, which has no transactions at all. The
 * counter is what lets both notice that another write landed in between.
 *
 *   - Every write batch bumps it (`bump`), so its value names the data.
 *   - A merge-then-write batch opens with `guard(read)`, which aborts the
 *     whole batch unless the counter still holds what the merge read.
 *   - The /tokens/site snapshot reads it around composing
 *     (`Snapshot.generation`, lib/snapshot.ts) and never leaves a body
 *     composed across a write as the published one.
 */

/** `{ generation, wiped }` — the counter and its value at the last wipe. */
export interface TokensState {
  generation: number;
  wiped: number;
}

export const STATE_SQL = `SELECT generation, wiped_generation AS wiped FROM tokens_state WHERE id = 1`;

export async function readState(db: D1Database): Promise<TokensState> {
  const row = await db.prepare(STATE_SQL).first<TokensState>();
  if (!row) throw new Error("tokens_state is missing its row (migration 0006)");
  return row;
}

export async function readGeneration(db: D1Database): Promise<number> {
  return (await readState(db)).generation;
}

/**
 * Fails — and so rolls back the batch it opens — when the counter no
 * longer reads `expected`. SQLite has no conditional RAISE outside a
 * trigger, so the failure is a constraint: the row it would insert
 * breaks `generation NOT NULL` (and the primary key), and it is only
 * selected when the counter has moved.
 */
export function guard(db: D1Database, expected: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tokens_state (id, generation)
       SELECT 1, NULL WHERE (SELECT generation FROM tokens_state WHERE id = 1) IS NOT ?1`
    )
    .bind(expected);
}

export function bump(db: D1Database): D1PreparedStatement {
  return db.prepare(`UPDATE tokens_state SET generation = generation + 1 WHERE id = 1`);
}

/** The wipe's bump, which also records where the wipe stands. */
export function bumpForWipe(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `UPDATE tokens_state SET generation = generation + 1, wiped_generation = generation + 1
     WHERE id = 1`
  );
}
