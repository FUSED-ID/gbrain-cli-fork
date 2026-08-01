/**
 * Canonicalize page types emitted by older capture/enrichment producers.
 *
 * This is deliberately a small compatibility map, not a taxonomy engine:
 * source pipelines keep their existing behavior and only retired spellings
 * are translated at the common markdown-ingest seam.
 */
export const PIPELINE_PAGE_TYPE_MAP = {
  'research-note': 'analysis',
  contact: 'person',
  'project-artifact': 'document',
} as const;

export type PipelinePageType = keyof typeof PIPELINE_PAGE_TYPE_MAP;

export function normalizePipelinePageType(type: string): string {
  return PIPELINE_PAGE_TYPE_MAP[type as PipelinePageType] ?? type;
}
