/** Bind the configured held source as an exact queue exclusion. */
export function workerSourceEligibleSql(sourceColumn: string, params: unknown[],
  heldSource = process.env.GBRAIN_WORKER_HELD_SOURCE): string {
  return heldSource ? `${sourceColumn} <> $${params.push(heldSource)}::text` : 'TRUE';
}

/** An older effect can lack source_id. Its request records the original source. */
export function workerEffectSourceEligibleSql(params: unknown[], heldSource?: string): string {
  return workerSourceEligibleSql(
    'COALESCE(e.source_id,(SELECT origin.source_id FROM persistence_requests origin WHERE origin.id=e.request_id))',
    params, heldSource);
}
