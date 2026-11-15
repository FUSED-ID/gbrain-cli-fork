import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parsePurgeArgs } from '../src/commands/pages.ts';
import { runSources } from '../src/commands/sources.ts';
import { runJobs } from '../src/commands/jobs.ts';
import { runFiles } from '../src/commands/files.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
import { purgeConsentRequest } from '../src/core/persistence/purge-deleted.ts';
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
    // v0.60.11 routes the live purge through the coordinator, which asks whether managed persistence is on.
    executeRaw: async () => [{ enabled: false }],
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
  const originalExit = process.exit;
  const lines: string[] = [];
  const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  const stderrLines: string[] = [];
  console.log = push;
  console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(' ')); };
  process.stdout.write = write;
  process.stderr.write = ((chunk: unknown) => { stderrLines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw new Error(`TEST_PROCESS_EXIT:${code ?? 0}`); }) as never;
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalOut;
    process.stderr.write = originalErrWrite;
    process.exit = originalExit;
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

describe('destructive guard dry-run declaration', () => {
  test('an allowed flag is not a dry-run capability without allowDryRun', () => {
    expect(() => requireDestructiveConsent({
      command: 'latent dry-run trap',
      scopeFlags: [],
      args: ['--dry-run'],
      allowedFlags: ['--dry-run'],
    })).toThrow(DestructiveConsentError);
  });

  test('every declared dry-run command still accepts its rehearsal flag', () => {
    const specs = [
      {
        command: 'files redirect',
        scopeFlags: [],
        positionalScope: { name: 'dir', required: true },
        args: ['/tmp/files', '--dry-run'],
      },
      {
        command: 'files clean',
        scopeFlags: [],
        positionalScope: { name: 'dir', required: true },
        args: ['/tmp/files', '--dry-run'],
        consentFlags: ['--yes'],
      },
      {
        command: 'jobs prune',
        scopeFlags: ['--older-than'],
        args: ['--older-than', '30d', '--dry-run'],
        consentFlags: ['--yes'],
      },
      {
        command: 'pages purge-deleted',
        scopeFlags: ['--older-than'],
        args: ['--older-than', '72', '--dry-run'],
      },
      {
        command: 'sources remove',
        scopeFlags: [],
        positionalScope: { name: 'id', required: true },
        args: ['source-a', '--dry-run'],
        consentFlags: ['--yes', '--confirm-destructive'],
      },
      {
        command: 'migrate embeddings',
        scopeFlags: ['--to'],
        valueFlags: ['--dim', '--reranker', '--batch-size', '--pace-max-concurrency'],
        args: ['--to', 'voyage:voyage-4', '--dry-run'],
        allowedFlags: ['--dry-run', '--json', '--no-embed', '--ignore-env-override', '--force-sunset-target', '--retarget', '--pace'],
        allowedPrefixes: ['--pace'],
        consentFlags: ['--yes', '--non-interactive'],
      },
    ];

    for (const spec of specs) {
      expect(() => requireDestructiveConsent({ ...spec, allowDryRun: true })).not.toThrow();
    }
  });
});

describe('pages purge-deleted v0.60.473 argument seam', () => {
  test('the parser preserves the explicit cutoff and read-only flags', () => {
    expect(parsePurgeArgs(['--older-than', '72', '--dry-run', '--json'])).toMatchObject({
      olderThanHours: 72,
      dryRun: true,
      json: true,
    });
  });

  test('the upstream parser keeps the 72 hour default when no cutoff is supplied', () => {
    expect(parsePurgeArgs([]).olderThanHours).toBe(72);
  });

  test('the strict parser refuses an unrecognized argument before planning', () => {
    try {
      parsePurgeArgs(['--older-than', '72', '--nonsense']);
      throw new Error('expected invalid argument refusal');
    } catch (error) {
      expect(error).toHaveProperty('code', 'invalid_params');
      expect((error as Error).message).toContain('not an argument');
    }
  });

  test('the coordinated consent request carries the approved and preview commands', () => {
    const request = purgeConsentRequest(3, 72, false, ['--older-than', '72', '--yes']);
    expect(request.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--yes']);
    expect(request.preview_argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--dry-run', '--json']);
  });
});

describe('wrapped destructive subcommand help', () => {
  const noTouchEngine = { executeRaw: async () => { throw new Error('engine access'); } } as unknown as BrainEngine;

  test('sources remove --help never reaches the source engine', async () => {
    const output = await captureLogs(() => runSources(noTouchEngine, ['remove', '--help']));
    expect(output).toContain('remove <id>');
  });

  test('sources purge help falls back to the upstream sources help path', async () => {
    const output = await captureLogs(() => runSources(noTouchEngine, ['purge', '--help']));
    expect(output).toContain('gbrain sources \u2014 manage multi-source brain configuration');
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
    const output = await captureLogs(async () => {
      try { await runReinitPglite(['--help']); } catch (error) {
        expect((error as Error).message).toBe('TEST_PROCESS_EXIT:0');
      }
    });
    expect(output).toContain('Usage: gbrain reinit-pglite');
    // The destructive-action warning lives in the real printHelp, and cli.ts
    // requires that it reach the reader.
    expect(output).toContain('Wipe the PGLite brain');
    expect(output).toContain('--embedding-dimensions');
  });

  test('migrate without --to refuses before migration setup', async () => {
    try {
      await runMigrateEngine(noTouchEngine, ['--help']);
      throw new Error('expected migrate argument refusal');
    } catch (error) {
      expect(error).toHaveProperty('code', 'invalid_params');
      expect((error as Error).message).toContain('needs --to');
    }
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

  test('reinit-pglite --help never reads config or the brain path', async () => {
    const output = await captureLogs(async () => {
      try { await runReinitPglite(['--help']); } catch (error) {
        expect((error as Error).message).toBe('TEST_PROCESS_EXIT:0');
      }
    });
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

  test('jobs prune --help never creates a queue schema or prunes', async () => {
    const output = await captureLogs(() => runJobs(noTouchEngine, ['prune', '--help']));
    expect(output).toContain('gbrain jobs prune');
  });

  test('auth revoke-client --help never opens configured SQL', async () => {
    const output = await captureLogs(() => runAuth(['revoke-client', '--help']));
    expect(output).toContain('GBrain Token Management');
  });

  test('forget without a fact id exits before any fact expires', async () => {
    const output = await captureLogs(async () => {
      try { await runForget(noTouchEngine, []); } catch (error) {
        expect((error as Error).message).toBe('TEST_PROCESS_EXIT:1');
      }
    });
    void output;
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
