import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPages } from '../src/commands/pages.ts';
import { runSources } from '../src/commands/sources.ts';
import { runJobs } from '../src/commands/jobs.ts';
import { runFiles } from '../src/commands/files.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { runReinitPglite } from '../src/commands/reinit-pglite.ts';
import { runAuth } from '../src/commands/auth.ts';
import { runForget } from '../src/commands/recall.ts';
import { DestructiveConsentError } from '../src/core/destructive-guard.ts';
import { requireDestructiveConsent } from '../src/core/destructive-guard.ts';

type PurgeCall = { hours: number; opts?: unknown };

function makePurgeStub() {
  const calls: PurgeCall[] = [];
  const engine = {
    purgeDeletedPages: async (hours: number, opts?: unknown) => {
      calls.push({ hours, opts });
      return { count: 0, slugs: [], pages: [] };
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

async function expectRefusal(run: () => Promise<unknown>, missing: string): Promise<void> {
  try {
    await run();
    throw new Error('expected destructive consent refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(DestructiveConsentError);
    expect((error as DestructiveConsentError).exitCode).toBe(2);
    expect((error as Error).message).toContain(missing);
    expect((error as Error).message).toContain('Corrected command:');
  }
}

/**
 * Captures every way these commands print help: console.log (sources,
 * reinit-pglite) and process.stdout.write (migrate embeddings). The first cut
 * captured console.log only, which made this helper agree with a two-line stub
 * and go blank the moment the real printHelp() was restored, which is exactly
 * what happened on 2026-09-17.
 *
 * stderr is DELIBERATELY not captured. Refusal messages go to stderr, and a
 * refusal message contains the usage line, so capturing both streams would let
 * a refusal satisfy a help assertion. Help paths must print to stdout.
 */
async function captureLogs(run: () => Promise<unknown>): Promise<string> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  const stderrLines: string[] = [];
  console.log = push;
  console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(' ')); };
  process.stdout.write = write;
  process.stderr.write = ((chunk: unknown) => { stderrLines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalOut;
    process.stderr.write = originalErrWrite;
  }
  void stderrLines;
  return lines.join('\n');
}

function migrateEngineConsent(args: string[]) {
  return requireDestructiveConsent({
    command: 'migrate',
    scopeFlags: ['--to'],
    valueFlags: ['--url', '--path'],
    args,
    usage: 'Usage: gbrain migrate --to <supabase|pglite> [--url <url>] [--path <path>] [--force --yes-i-mean-it]',
    allowedFlags: ['--force'],
    consentFlags: ['--yes-i-mean-it'],
    enforceConsent: args.includes('--force'),
  });
}

describe('pages purge-deleted consent', () => {
  test('--help prints usage and never calls the purge arm', async () => {
    const { engine, calls } = makePurgeStub();
    const output = await captureLogs(() => runPages(engine, ['purge-deleted', '--help']));
    expect(output).toContain('Usage: gbrain pages purge-deleted');
    expect(calls).toHaveLength(0);
  });

  test('missing scope and consent refuses without touching the engine', async () => {
    const { engine, calls } = makePurgeStub();
    await expectRefusal(() => runPages(engine, ['purge-deleted']), 'explicit scope');
    expect(calls).toHaveLength(0);
  });

  test('explicit scope without consent refuses', async () => {
    const { engine, calls } = makePurgeStub();
    await expectRefusal(() => runPages(engine, ['purge-deleted', '--older-than', '72']), 'explicit consent');
    expect(calls).toHaveLength(0);
  });

  test('dry-run is allowed with explicit scope and records dryRun', async () => {
    const { engine, calls } = makePurgeStub();
    await runPages(engine, ['purge-deleted', '--older-than', '72', '--dry-run']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ hours: 72, opts: { dryRun: true } });
  });

  test('literal consent executes exactly once', async () => {
    const { engine, calls } = makePurgeStub();
    await runPages(engine, ['purge-deleted', '--older-than', '72', '--yes-i-mean-it']);
    expect(calls).toHaveLength(1);
    expect(calls[0].hours).toBe(72);
    expect(calls[0].opts).toBeUndefined();
  });

  test('consent without scope refuses', async () => {
    const { engine, calls } = makePurgeStub();
    await expectRefusal(() => runPages(engine, ['purge-deleted', '--yes-i-mean-it']), 'explicit scope');
    expect(calls).toHaveLength(0);
  });

  test('unrecognized arguments refuse before the purge arm', async () => {
    const { engine, calls } = makePurgeStub();
    await expectRefusal(
      () => runPages(engine, ['purge-deleted', '--older-than', '72', '--nonsense', '--yes-i-mean-it']),
      'recognized argument',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('wrapped destructive subcommand help', () => {
  const noTouchEngine = {} as BrainEngine;

  test('sources remove --help never reaches the source engine', async () => {
    const output = await captureLogs(() => runSources(noTouchEngine, ['remove', '--help']));
    expect(output).toContain('remove <id>');
  });

  test('sources purge help never reaches the source engine', async () => {
    const output = await captureLogs(() => runSources(noTouchEngine, ['purge', 'help']));
    expect(output).toContain('Usage: gbrain sources purge');
  });

  test('migrate embeddings help never reaches planning', async () => {
    const output = await captureLogs(() => runMigrateEmbeddings(noTouchEngine, ['help']));
    expect(output).toContain('Usage: gbrain migrate embeddings');
    // It must be the REAL help, not the guard's two-line stub. The stub said
    // "Run gbrain migrate embeddings --help for the complete flag list", so
    // --help told you to run --help. Pin a flag only the real help documents,
    // and pin the stub's self-referential sentence as forbidden.
    expect(output).toContain('--status');
    expect(output).toContain('--reranker');
    expect(output).not.toContain('for the complete flag list');
  });

  test('reinit-pglite help prints the real help, warning included', async () => {
    const { runReinitPglite } = await import('../src/commands/reinit-pglite.ts');
    const output = await captureLogs(() => runReinitPglite(['--help']));
    expect(output).toContain('Usage: gbrain reinit-pglite');
    // The destructive-action warning lives in the real printHelp, and cli.ts
    // requires that it reach the reader.
    expect(output).toContain('Wipe the PGLite brain');
    expect(output).toContain('--embedding-dimensions');
  });

  test('migrate --help never reaches migration setup', async () => {
    const output = await captureLogs(() => runMigrateEngine(noTouchEngine, ['--help']));
    expect(output).toContain('Usage: gbrain migrate');
  });

  test('migrate --force alone refuses before the executing arm', () => {
    try {
      migrateEngineConsent(['--to', 'pglite', '--path', '/tmp/stub-target', '--force']);
      throw new Error('expected destructive consent refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DestructiveConsentError);
      expect((error as DestructiveConsentError).exitCode).toBe(2);
      expect((error as DestructiveConsentError).message).toContain('explicit consent');
      expect((error as DestructiveConsentError).correctedCommand).toBe(
        'gbrain migrate --to pglite --path /tmp/stub-target --force --yes-i-mean-it',
      );
    }
  });

  test('migrate --force with literal consent reaches the executing arm', () => {
    expect(() => migrateEngineConsent([
      '--to', 'pglite', '--path', '/tmp/stub-target', '--force', '--yes-i-mean-it',
    ])).not.toThrow();
  });

  test('reinit-pglite help never reads config or the brain path', async () => {
    const output = await captureLogs(() => runReinitPglite(['help']));
    expect(output).toContain('Usage: gbrain reinit-pglite');
  });

  test('files redirect --help never inspects the directory', async () => {
    const output = await captureLogs(() => runFiles(noTouchEngine, ['redirect', '--help']));
    expect(output).toContain('Usage: gbrain files redirect');
  });

  test('files clean --help never inspects the directory', async () => {
    const output = await captureLogs(() => runFiles(noTouchEngine, ['clean', '--help']));
    expect(output).toContain('Usage: gbrain files clean');
  });

  test('jobs prune help never creates a queue schema or prunes', async () => {
    const output = await captureLogs(() => runJobs(noTouchEngine, ['prune', 'help']));
    expect(output).toContain('Usage: gbrain jobs prune');
  });

  test('auth revoke-client help never opens configured SQL', async () => {
    const output = await captureLogs(() => runAuth(['revoke-client', 'help']));
    expect(output).toContain('Usage: gbrain auth revoke-client');
  });

  test('forget help never expires a fact', async () => {
    const output = await captureLogs(() => runForget(noTouchEngine, ['help']));
    expect(output).toContain('Usage: gbrain forget');
  });

  test('forget accepts a fact id without destructive consent', () => {
    expect(() => requireDestructiveConsent({
      command: 'forget',
      scopeFlags: [],
      positionalScope: { name: 'fact-id', required: true },
      valueFlags: ['--reason'],
      args: ['42'],
      enforceConsent: false,
    })).not.toThrow();
  });
});
