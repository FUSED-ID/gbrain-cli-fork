import type { WalRepairReceipt } from './pglite-repair.ts';

/**
 * The loud stderr notice printed when connect() auto-repaired the data dir in
 * place. Exported for the serial regression test.
 */
export function buildWalRepairNotice(receipt: WalRepairReceipt): string {
  return [
    '⚠️  gbrain repaired this brain\'s PGLite WAL in place.',
    `    Data dir: ${receipt.dataDir}`,
    `    Cause: torn WAL/checkpoint state from an unclean shutdown (issue #223 class).`,
    `    Transactions not checkpointed before the corruption may be lost, and`,
    `    indexes are not rebuilt: pages written just before the crash can be`,
    `    missing from vector search while keyword search still finds them.`,
    `    Pre-repair backup: ${receipt.backupPath}`,
    `    Next: rebuild the vector indexes with \`gbrain reindex --vectors\`,`,
    `    then run \`gbrain doctor\` to verify brain integrity.`,
    `    Disable auto-repair with GBRAIN_PGLITE_WAL_REPAIR=off.`,
  ].join('\n');
}

/**
 * #2084: PGLite's Emscripten runtime hijacks `process.exitCode` as ITS status
 * channel: instantiation REPLACES the property with an accessor whose getter
 * falls back to the WASM runtime status (99 while alive, the exit status after
 * close) whenever no explicit value was assigned, and assigning `undefined`
 * resets to that fallback, so "unset" cannot be restored. Pre-fix, every clean
 * PGLite run carried a bogus 99 until close zeroed it, and an errored op's
 * exit 1 survived only by accident of write ordering.
 *
 * Containment: around PGlite.create(), snapshot the pre-call value and restore
 * it, pinning an explicit 0 when nothing was set, because restoring
 * `undefined` would surface the WASM fallback instead. This keeps the GLOBAL
 * tidy for external readers; the CLI's own verdict never reads it (it lives in
 * the owned channel: setCliExitVerdict/currentExitCode, cli-force-exit.ts.
 * In-memory brains run initdb whose status lands on a later tick, past any
 * snapshot). db.close() stays unwrapped (see the comment at the close site).
 */
export async function preservingProcessExitCode<T>(fn: () => Promise<T>): Promise<T> {
  const pre = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = typeof pre === 'number' || typeof pre === 'string' ? pre : 0;
  }
}
