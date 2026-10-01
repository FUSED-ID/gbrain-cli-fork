import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSchema } from '../src/commands/schema.ts';
import { withEnv } from './helpers/with-env.ts';

function throwingExit(code?: number): never {
  throw new Error(`__exit_${code ?? 0}`);
}

describe('schema downgrade fallback', () => {
  test('refuses without history and preserves config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'schema-downgrade-guard-'));
    const configDir = join(home, '.gbrain');
    const configPath = join(configDir, 'config.json');
    const initial = JSON.stringify({ engine: 'pglite', schema_pack: 'gbrain-lgv-v2' }, null, 2);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, initial);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = spyOn(process, 'exit').mockImplementation(throwingExit as typeof process.exit);

    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(runSchema(['downgrade'])).rejects.toThrow('__exit_1');
      });
      expect(readFileSync(configPath, 'utf8')).toBe(initial);
      expect(existsSync(join(configDir, 'schema-pack-history.jsonl'))).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no previous active pack'));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
