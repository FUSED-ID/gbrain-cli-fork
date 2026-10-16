import { SCHEMA_SQL } from './schema-embedded.generated.ts';
import { applyChunkEmbeddingIndexPolicy } from './vector-index.ts';
import { applyFtsLanguagePolicy } from './fts-language.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';

/**
 * #6278: how long a cancelled statement may stay unsettled after its cancel request before the reserved
 * connection is discarded to settle it client-side. A transaction-mode pooler (Supavisor :6543) may not
 * forward the cancel, leaving the backend in ClientRead where no server timeout applies.
 */
export const DEFAULT_CANCEL_SETTLE_MS = 2_000;
export function cancelSettleMs(): number {
  const raw = Number(process.env.GBRAIN_CANCEL_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : DEFAULT_CANCEL_SETTLE_MS;
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function getPostgresSchema(
  dims: number = DEFAULT_EMBEDDING_DIMENSIONS,
  model: string = DEFAULT_EMBEDDING_MODEL,
): string {
  const parsedDims = Number(dims);
  if (!Number.isInteger(parsedDims) || parsedDims <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dims}`);
  }
  const sanitizedModel = escapeSqlStringLiteral(String(model));
  return applyFtsLanguagePolicy(applyChunkEmbeddingIndexPolicy(SCHEMA_SQL, parsedDims))
    .replace(/vector\(1536\)/g, `vector(${parsedDims})`)
    .replace(/'text-embedding-3-large'/g, `'${sanitizedModel}'`)
    .replace(/\('embedding_dimensions', '1536'\)/g, `('embedding_dimensions', '${parsedDims}')`);
}

// CONNECTION_ERROR_PATTERNS / isConnectionError were used by the per-call
// executeRaw retry that #406 originally shipped. Eng-review D3 dropped that
// retry as unsound (regex idempotence-boundary doesn't hold for writable
// CTEs or side-effecting SELECTs). Recovery now happens at the supervisor
// level (3-strikes-then-reconnect). The unit tests in
// test/connection-resilience.test.ts retain a self-contained copy of the
// helper so the regression-against-future-reintroduction guard still works.
// See TODOS.md item: "err.code-based connection-error matching" for the
// follow-up that will reintroduce a typed retry mechanism.

