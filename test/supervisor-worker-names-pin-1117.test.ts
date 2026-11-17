/**
 * Pin: the supervisor's hand-kept worker allow-list (`SUPERVISOR_WORKER_NAMES`
 * in src/commands/jobs/supervisor.ts) must match, exactly, the job names that
 * `registerBuiltinHandlers` (src/commands/jobs.ts) actually registers.
 *
 * Why this pin exists: the supervisor derives its wedge-watchdog name scope
 * from `registerBuiltinHandlers` at runtime (issue #1801), but the
 * `GBRAIN_WORKER_ONLY_NAMES` validator still checks a separate literal Set. A
 * drift in either direction is silent:
 *   - a name registered but absent from the Set: the supervisor refuses a
 *     legitimate allow-list before spawning;
 *   - a name in the Set with no handler: the worker it bounds can never claim
 *     that name, so an operator "restricting" to it gets an idle worker.
 *
 * The Set is module-private (not exported) and src/ cannot be edited for this
 * pin, so the test reads it the narrowest way available: the declaration text
 * in the module source (the source-reading seam already used by
 * test/extract-atoms-drain.test.ts and friends), and then cross-checks that
 * reading against the LIVE validator through the command boundary, exactly the
 * `runJobsSupervisor` seam used in test/jobs-worker-only-supervisor.test.ts.
 * The registration side comes from a real probe worker (never started, no
 * timers, no DB I/O) on an in-test PGLite engine, mirroring test/handlers.test.ts.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { runJobsSupervisor } from '../src/commands/jobs/supervisor.ts';
import { withEnv } from './helpers/with-env.ts';

const SUPERVISOR_SOURCE = join(import.meta.dir, '../src/commands/jobs/supervisor.ts');
const DECLARATION = 'const SUPERVISOR_WORKER_NAMES = new Set([';

/**
 * The Set is not exported. Read the one declaration in the module source and
 * scan its array body with a small tokenizer: line and block comments are
 * dropped, string literals in single quotes, double quotes or backticks are
 * collected, commas and whitespace are skipped, and anything else (a spread,
 * a constant, an escape, a template substitution, an unterminated literal)
 * throws. A moved or renamed declaration fails loudly instead of silently
 * returning an empty set.
 */
function readSupervisorWorkerNames(): Set<string> {
  return parseWorkerNameSet(readFileSync(SUPERVISOR_SOURCE, 'utf8'), SUPERVISOR_SOURCE);
}

function parseWorkerNameSet(source: string, label: string): Set<string> {
  const declarations = source.split(DECLARATION).length - 1;
  if (declarations !== 1) {
    throw new Error(`expected exactly one "${DECLARATION}" in ${label}, found ${declarations}`);
  }
  const names: string[] = [];
  let i = source.indexOf(DECLARATION) + DECLARATION.length; // first character after the '['
  for (;;) {
    if (i >= source.length) throw new Error(`unterminated ${DECLARATION} in ${label}`);
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === ']') break;
    if (ch === ',' || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      if (end < 0) throw new Error(`unterminated line comment in ${DECLARATION} in ${label}`);
      i = end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`unterminated block comment in ${DECLARATION} in ${label}`);
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) throw new Error(`unterminated ${ch} literal in ${DECLARATION} in ${label}`);
      const name = source.slice(i + 1, end);
      if (name.length === 0 || /[\\\n]/.test(name) || (ch === '`' && name.includes('${'))) {
        throw new Error(`name literal the pin cannot read in ${label}: ${source.slice(i, end + 1)}`);
      }
      names.push(name);
      i = end + 1;
      continue;
    }
    throw new Error(
      `unreadable text in the ${DECLARATION} body in ${label}: ${JSON.stringify(source.slice(i, i + 40))}`,
    );
  }
  if (source.slice(i, i + 3) !== ']);') throw new Error(`expected "]);" to close ${DECLARATION} in ${label}`);
  if (names.length === 0) throw new Error(`${DECLARATION} in ${label} yielded no names`);
  return new Set(names);
}

let engine: PGLiteEngine;
let registered: string[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const probe = new MinionWorker(engine, { queue: 'default', healthCheckInterval: 0 });
  await registerBuiltinHandlers(probe, engine, { quiet: true });
  registered = [...probe.registeredNames];
}, 180_000);

afterAll(async () => {
  await engine?.disconnect();
});

describe('supervisor worker-name allow-list pin', () => {
  test('registerBuiltinHandlers registers exactly SUPERVISOR_WORKER_NAMES', () => {
    const allowed = readSupervisorWorkerNames();
    const registeredNames = [...registered].sort();
    const allowedNames = [...allowed].sort();

    // The count is quoted in RESULT.md; keep it visible in the test output.
    console.log(
      `[supervisor-names-pin-1117] compared ${registeredNames.length} registered handler names ` +
        `against ${allowedNames.length} SUPERVISOR_WORKER_NAMES entries`,
    );

    const registeredButNotAllowed = registeredNames.filter(name => !allowed.has(name));
    const allowedButNotRegistered = allowedNames.filter(name => !registered.includes(name));

    if (
      registeredButNotAllowed.length > 0 ||
      allowedButNotRegistered.length > 0 ||
      registeredNames.length !== allowedNames.length
    ) {
      throw new Error(
        [
          'SUPERVISOR_WORKER_NAMES drifted from registerBuiltinHandlers.',
          `registered by registerBuiltinHandlers (${registeredNames.length}): ${registeredNames.join(', ')}`,
          `SUPERVISOR_WORKER_NAMES (${allowedNames.length}): ${allowedNames.join(', ')}`,
          `registered but missing from SUPERVISOR_WORKER_NAMES: ${registeredButNotAllowed.join(', ') || '(none)'}`,
          `in SUPERVISOR_WORKER_NAMES but not registered: ${allowedButNotRegistered.join(', ') || '(none)'}`,
        ].join('\n'),
      );
    }

    expect(registeredNames).toEqual(allowedNames);
  });

  /**
   * Cross-check the source read against the live validator: every name on
   * either side must be accepted by `runJobsSupervisor`'s
   * `GBRAIN_WORKER_ONLY_NAMES` check, and a synthetic name must be refused.
   * Both verdicts exit before config load, engine use or any child spawn: the
   * accepted path stops at the unknown-subcommand refusal, the refused path at
   * the env allow-list refusal.
   */
  test('the live supervisor allow-list agrees with the parsed Set', async () => {
    const allowed = readSupervisorWorkerNames();

    for (const name of [...registered].sort()) {
      expect(await supervisorVerdict(name)).toBe('allowed');
    }
    for (const name of [...allowed].sort()) {
      expect(await supervisorVerdict(name)).toBe('allowed');
    }
    expect(await supervisorVerdict('definitely-not-a-worker-name-1117')).toBe('refused');
  }, 60_000);

  /**
   * The reader itself: comments inside the Set are not names, every quote
   * style is a name, and text the reader cannot classify fails the pin.
   */
  test('the Set reader drops comments, reads all three quote styles and refuses anything else', () => {
    const wrap = (body: string) => `const x = 1;\n${DECLARATION}\n  ${body}\n]);\n`;
    const parsed = parseWorkerNameSet(wrap("'a', \"b\", `c`, // 'd'\n  /* 'e' */ 'f',"), 'synthetic');
    expect([...parsed].sort()).toEqual(['a', 'b', 'c', 'f']);
    for (const bad of ['...EXTRA_NAMES', 'NAME_CONSTANT', '`x${y}`', "'a\\'b'", "'open"]) {
      expect(() => parseWorkerNameSet(wrap(`'a', ${bad},`), 'synthetic')).toThrow();
    }
  });
});

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

/**
 * `allowed` when the live supervisor accepts the name in
 * GBRAIN_WORKER_ONLY_NAMES, `refused` when its own --only refusal fires.
 */
async function supervisorVerdict(name: string): Promise<'allowed' | 'refused'> {
  const output: string[] = [];
  const errorSpy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    output.push(parts.map(String).join(' '));
  });
  const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as never);
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);

  try {
    await withEnv({ GBRAIN_WORKER_ONLY_NAMES: name }, async () => {
      try {
        await runJobsSupervisor({
          args: ['supervisor', 'zzz-probe-non-subcommand'],
          engine: {} as never,
          engineOrNull: null,
        });
      } catch (error) {
        if (!(error instanceof ExitSignal)) throw error;
      }
    });
  } finally {
    errorSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  const text = output.join('\n');
  if (text.includes('does not support --only')) return 'refused';
  if (text.includes('Unknown supervisor subcommand')) return 'allowed';
  throw new Error(`unexpected supervisor probe output for '${name}':\n${text}`);
}
