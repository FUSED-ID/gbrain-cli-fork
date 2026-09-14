/**
 * D1 policy fix, migrate-engine regression coverage.
 *
 * `gbrain migrate` (copyMigrationSources, then copyPageToTarget per page)
 * copies `sources` before any page lands, so on a fresh target nothing
 * "already exists" yet. Before this lane, the D1 guard's only escape was
 * "does this slug already exist in the target source", so a fresh-target
 * migration refused every person-shaped page. copyPageToTarget now passes
 * migrationWrite: true, which exempts the write from the guard entirely.
 * This pins that a person-shaped page migrates onto a fresh, unarmed target
 * (no lg-private source, no policy files at all) without being refused.
 */

import { describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPageToTarget } from '../src/commands/migrate-engine.ts';

describe('copyPageToTarget — D1 guard exemption on a fresh migration target', () => {
  test('a person-shaped page migrates onto a fresh, policy-unarmed target', async () => {
    const source = new PGLiteEngine();
    const target = new PGLiteEngine();
    await source.connect({});
    await target.connect({});
    await source.initSchema();
    await target.initSchema();
    try {
      await target.executeRaw(
        `UPDATE sources
         SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{facts_visibility}', '"world"'::jsonb)
         WHERE id = 'default'`,
      );
      // Target has NO lg-private source and no policy files at all: were the
      // guard live for this write, assertPrivateRoutingArmed would throw
      // "NOT ARMED". migrationWrite must skip the guard before that ever runs.

      await source.putPage('wiki/migrated-contact/_author', {
        type: 'note',
        title: 'Migrated Contact',
        compiled_truth: 'A business contact page being migrated.',
        timeline: '',
        frontmatter: {},
      }, { sourceId: 'default' });

      const page = await source.getPage('wiki/migrated-contact/_author', { sourceId: 'default' });
      if (!page) throw new Error('seed page missing from source');

      await copyPageToTarget(source, target, page);

      const migrated = await target.getPage('wiki/migrated-contact/_author', { sourceId: 'default' });
      expect(migrated?.compiled_truth).toBe('A business contact page being migrated.');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  }, 60_000);

  test('without migrationWrite, the same fresh target refuses the write (control)', async () => {
    const target = new PGLiteEngine();
    await target.connect({});
    await target.initSchema();
    try {
      await target.executeRaw(
        `UPDATE sources
         SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{facts_visibility}', '"world"'::jsonb)
         WHERE id = 'default'`,
      );
      await expect(target.putPage('wiki/control-contact/_author', {
        type: 'note',
        title: 'Control Contact',
        compiled_truth: 'body',
        timeline: '',
        frontmatter: {},
      }, { sourceId: 'default' })).rejects.toThrow(/NOT ARMED/);
    } finally {
      await target.disconnect();
    }
  }, 60_000);
});
