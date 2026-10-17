import type { Migration } from './types.ts';

// Wiki pages contain Markdown text but use their own page_kind so importers
// can preserve source semantics. They share the Markdown text projection.
export const v239: Migration = {
  version: 239,
  name: 'wiki_page_projections',
  idempotent: true,
  sql: `
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_page_kind_check;
      ALTER TABLE pages ADD CONSTRAINT pages_page_kind_check
        CHECK (page_kind IN ('markdown','wiki','code','image'));

      INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,p.slug,p.knowledge_revision,'canonical_change'
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.deleted_at IS NULL AND NOT s.archived AND p.page_kind='wiki'
        AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
      ON CONFLICT(source_incarnation,slug) DO UPDATE
        SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now();`,
};
