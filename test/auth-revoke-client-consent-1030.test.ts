/**
 * Pin for `gbrain auth revoke-client` consent (1030 follow-up).
 *
 * The generated `auth` registry row must contain `--yes-i-mean-it` and must
 * not contain `--confirm-destructive` or `--force-sunset-target`. A call
 * without the flag must refuse with the consent message and a non-zero exit
 * before configured SQL opens (same process.exit trap as
 * test/destructive-guard-consent.test.ts). The usage string must carry the flag.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { runAuth } from '../src/commands/auth.ts';

const AUTH_SRC = readFileSync(new URL('../src/commands/auth.ts', import.meta.url), 'utf8');

describe('auth revoke-client consent pin (1030)', () => {
  test('generated auth registry row lists --yes-i-mean-it only', () => {
    const flags = CLI_FLAG_REGISTRY['auth'];
    expect(flags).toBeDefined();
    expect(flags).toContain('--yes-i-mean-it');
    expect(flags).not.toContain('--confirm-destructive');
    expect(flags).not.toContain('--force-sunset-target');
  });

  test('usage string carries --yes-i-mean-it', () => {
    expect(AUTH_SRC).toContain(
      "const usage = 'Usage: gbrain auth revoke-client <client_id> --yes-i-mean-it'",
    );
  });

  test('revoke-client without the flag refuses and never opens configured SQL', async () => {
    const originalError = console.error;
    const originalExit = process.exit;
    const stderr: string[] = [];
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => {
      throw new Error(`TEST_PROCESS_EXIT:${code ?? 0}`);
    }) as never;
    let exitCode = 0;
    try {
      await runAuth(['revoke-client', 'some_id']);
    } catch (error) {
      const message = (error as Error).message;
      expect(message.startsWith('TEST_PROCESS_EXIT:')).toBe(true);
      exitCode = Number(message.slice('TEST_PROCESS_EXIT:'.length));
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }
    const text = stderr.join('\n');
    expect(exitCode).not.toBe(0);
    expect(text).toContain('refusing destructive operation');
    expect(text).toContain('missing explicit consent');
    expect(text).toContain('--yes-i-mean-it');
    // withConfiguredSql prints this and exits 1 when no brain is configured.
    // Seeing it would mean the refusal ran after configured SQL was opened.
    expect(text).not.toContain('No GBrain config found');
    expect(text).not.toContain('No database connection');
  });
});
