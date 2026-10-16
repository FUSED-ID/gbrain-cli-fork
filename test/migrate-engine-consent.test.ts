import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const openedEngines: PGLiteEngine[] = [];

beforeAll(() => {
  // Each attempt opens its own engine through openEngine.
});

function openEngine(): PGLiteEngine {
  const created = new PGLiteEngine();
  openedEngines.push(created);
  return created;
}

afterAll(async () => {
  for (const created of openedEngines) {
    try {
      await created.disconnect();
    } catch {
      // The test already disconnected this engine.
    }
  }
});

describe('runMigrateEngine --force consent', () => {
  afterEach(() => {
    _resetCliExitVerdictForTests();
  });

  test('refuses before wiping a non-empty target without consent', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-consent-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-consent-target-')), 'brain.pglite');
    const previousExitCode = process.exitCode;
    let source: PGLiteEngine | null = null;
    let target: PGLiteEngine | null = null;
    const originalError = console.error;

    try {
      await withEnv({
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: undefined,
        GBRAIN_HOME: gbrainHome,
      }, async () => {
        _resetCliExitVerdictForTests();
        saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

        target = openEngine();
        await target.connect({ database_path: targetDbPath });
        await target.initSchema();
        await target.putPage('target-only', {
          type: 'note', title: 'Target only', compiled_truth: 'Must survive refusal.', timeline: '', frontmatter: {},
        });
        await target.disconnect();
        target = null;

        source = openEngine();
        await source.connect({});
        await source.initSchema();
        await source.putPage('source-page', {
          type: 'note', title: 'Source', compiled_truth: 'Source copy.', timeline: '', frontmatter: {},
        });
        console.error = () => {};

        await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath, '--force']);

        expect(currentExitCode()).toBe(3);
        target = openEngine();
        await target.connect({ database_path: targetDbPath });
        const pages = await target.executeRaw<{ slug: string }>('SELECT slug FROM pages ORDER BY slug');
        expect(pages).toEqual([{ slug: 'target-only' }]);
      });
    } finally {
      console.error = originalError;
      if (source) await source.disconnect();
      if (target) await target.disconnect();
      process.exitCode = previousExitCode;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, 60000);
});
