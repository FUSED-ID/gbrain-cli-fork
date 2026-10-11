import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

describe('runMigrateEngine --force consent', () => {
  afterEach(() => {
    _resetCliExitVerdictForTests();
  });

  test('refuses before wiping a non-empty target without consent', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-consent-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-consent-target-')), 'brain.pglite');
    const previousHome = process.env.GBRAIN_HOME;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const previousExitCode = process.exitCode;
    let source: PGLiteEngine | null = null;
    let target: PGLiteEngine | null = null;
    const originalError = console.error;

    try {
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      target = new PGLiteEngine();
      await target.connect({ database_path: targetDbPath });
      await target.initSchema();
      await target.putPage('target-only', {
        type: 'note', title: 'Target only', compiled_truth: 'Must survive refusal.', timeline: '', frontmatter: {},
      });
      await target.disconnect();
      target = null;

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('source-page', {
        type: 'note', title: 'Source', compiled_truth: 'Source copy.', timeline: '', frontmatter: {},
      });
      console.error = () => {};

      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath, '--force']);

      expect(currentExitCode()).toBe(3);
      target = new PGLiteEngine();
      await target.connect({ database_path: targetDbPath });
      const pages = await target.executeRaw<{ slug: string }>('SELECT slug FROM pages ORDER BY slug');
      expect(pages).toEqual([{ slug: 'target-only' }]);
    } finally {
      console.error = originalError;
      if (source) await source.disconnect();
      if (target) await target.disconnect();
      process.exitCode = previousExitCode;
      if (previousHome !== undefined) process.env.GBRAIN_HOME = previousHome; else delete process.env.GBRAIN_HOME;
      if (previousDatabaseUrl !== undefined) process.env.DATABASE_URL = previousDatabaseUrl; else delete process.env.DATABASE_URL;
      if (previousGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = previousGbrainDatabaseUrl; else delete process.env.GBRAIN_DATABASE_URL;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, 60000);
});
