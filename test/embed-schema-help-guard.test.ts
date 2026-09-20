import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runEmbed } from '../src/commands/embed.ts';
import { runSchema } from '../src/commands/schema.ts';
import { withEnv } from './helpers/with-env.ts';

function throwingExit(code?: number): never {
  throw new Error(`__exit_${code ?? 0}`);
}

describe('destructive command help guards', () => {
  test('embed help returns before every work path', async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const exitSpy = spyOn(process, 'exit').mockImplementation(throwingExit as typeof process.exit);
    const engine = new Proxy({}, {
      get() {
        throw new Error('embed touched the engine before handling help');
      },
    }) as BrainEngine;

    try {
      for (const args of [
        ['--help'],
        ['--all', '--help'],
        ['--slugs', 'a', 'b', '--help'],
        ['--background', '--stale', '--help'],
      ]) {
        await expect(runEmbed(engine, args)).resolves.toBeUndefined();
      }
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(logs).toHaveLength(4);
    expect(logs.every((line) => line.startsWith('Usage: gbrain embed '))).toBe(true);
  });

  test('schema help returns before all dispatcher subcommands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'schema-help-guard-'));
    const subcommands = [
      'active', 'list', 'show', 'validate', 'use', 'detect', 'suggest',
      'review-candidates', 'init', 'fork', 'edit', 'diff', 'graph', 'lint',
      'explain', 'review-orphans', 'downgrade', 'usage', 'stats', 'sync',
      'reload', 'add-type', 'remove-type', 'update-type', 'add-alias',
      'remove-alias', 'add-prefix', 'remove-prefix', 'add-link-type',
      'remove-link-type', 'set-extractable', 'set-expert-routing',
      'scaffold-extractable',
    ];
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        for (const subcommand of subcommands) {
          await runSchema([subcommand, '--help']);
        }
        expect(existsSync(join(home, '.gbrain', 'schema-packs', '--help'))).toBe(false);
      });
    } finally {
      logSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }

    expect(subcommands).toHaveLength(33);
    expect(logs).toHaveLength(33);
    expect(logs.every((line) => line.includes('gbrain schema — active schema pack management'))).toBe(true);
  });
});
