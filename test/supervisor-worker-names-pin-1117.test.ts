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
  const source = stripComments(readFileSync(SUPERVISOR_SOURCE, 'utf8'), SUPERVISOR_SOURCE);
  assertIdentifierUses(source, SUPERVISOR_SOURCE);
  return parseWorkerNameSet(source, SUPERVISOR_SOURCE);
}

/**
 * Fable 2026-11-17 P2-L3-1: a name the reader cannot see must not pass. In the
 * comment-stripped source the identifier must occur exactly twice: the one
 * declaration and the one `.has(` use in the validator. A later `.add(`, an
 * alias, a bracket access or a second declaration makes a third occurrence.
 */
const IDENTIFIER = 'SUPERVISOR_WORKER_NAMES';

function assertIdentifierUses(source: string, label: string): void {
  const uses = [...source.matchAll(/(?<![\w$])SUPERVISOR_WORKER_NAMES(?![\w$])/g)].map(m => m.index!);
  if (uses.length !== 2) {
    throw new Error(
      `expected ${IDENTIFIER} exactly twice in the comment-stripped ${label} ` +
        `(declaration and one .has( use), found ${uses.length}`,
    );
  }
  if (!source.startsWith(DECLARATION, uses[0]! - 'const '.length)) {
    throw new Error(`first ${IDENTIFIER} in ${label} is not "${DECLARATION}"`);
  }
  if (!source.startsWith(`${IDENTIFIER}.has(`, uses[1]!)) {
    throw new Error(`second ${IDENTIFIER} in ${label} is not "${IDENTIFIER}.has("`);
  }
}

/** JavaScript ends a line comment at any of these, not only at \n (Fable P3-L3-2). */
const LINE_TERMINATORS = '\n\r\u2028\u2029';

/**
 * Remove line and block comments from TypeScript source, keeping string and
 * template literals (with nested `${...}`) intact, so a commented-out copy of
 * the declaration can never be the one that is read (Fable P2-L3-1). Regex
 * literals are not modelled: a misread there yields a loud failure (a wrong
 * identifier count or unreadable Set text), not a silent pass.
 */
function stripComments(source: string, label: string): string {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`${what} in ${label}`);
  };
  const template = (): string => {
    let out = '`';
    i += 1;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        return `${out}\``;
      }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        out += `\${${code(true)}}`;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return fail('unterminated template literal');
  };
  const code = (untilBrace: boolean): string => {
    let out = '';
    let depth = 0;
    while (i < source.length) {
      const ch = source[i]!;
      const next = source[i + 1];
      if (untilBrace && ch === '}') {
        if (depth === 0) return out;
        depth -= 1;
      } else if (untilBrace && ch === '{') {
        depth += 1;
      }
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < source.length && !LINE_TERMINATORS.includes(source[i]!)) i += 1;
        out += ' ';
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated block comment');
        i = end + 2;
        out += ' ';
        continue;
      }
      if (ch === "'" || ch === '"') {
        const start = i;
        i += 1;
        while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
        if (i >= source.length) fail(`unterminated ${ch} literal`);
        i += 1;
        out += source.slice(start, i);
        continue;
      }
      if (ch === '`') {
        out += template();
        continue;
      }
      out += ch;
      i += 1;
    }
    if (untilBrace) fail('unterminated template substitution');
    return out;
  };
  return code(false);
}

function parseWorkerNameSet(rawSource: string, label: string): Set<string> {
  const source = stripComments(rawSource, label);
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
    // Comments were removed by stripComments; these two branches only guard a caller that skips it.
    if (ch === '/' && next === '/') {
      let end = i + 2;
      while (end < source.length && !LINE_TERMINATORS.includes(source[end]!)) end += 1;
      i = end;
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

  /**
   * Fable 2026-11-17 P2-L3-1 and P3-L3-2: names the reader cannot see. A
   * `.add(` after the declaration, an old declaration left in a block comment
   * beside a live typed one, and a line comment ended by CR, U+2028 or U+2029
   * with a name after it on the same physical line must all fail the pin.
   */
  test('a name outside the read declaration or behind a non-LF line end fails the pin', () => {
    const decl = `${DECLARATION}\n  'a', 'b',\n]);\n`;
    const use = 'if (!SUPERVISOR_WORKER_NAMES.has(name)) refuse();\n';
    const read = (src: string) => {
      const stripped = stripComments(src, 'synthetic');
      assertIdentifierUses(stripped, 'synthetic');
      return [...parseWorkerNameSet(stripped, 'synthetic')].sort();
    };
    expect(read(decl + use)).toEqual(['a', 'b']);
    expect(read(`/* old: ${DECLARATION} 'x' ]); */\n// ${IDENTIFIER}.add('y')\n` + decl + use)).toEqual(['a', 'b']);
    expect(() => read(decl + `${IDENTIFIER}.add('ghost');\n` + use)).toThrow(/exactly twice/);
    expect(() => read(decl + `const alias = ${IDENTIFIER};\n` + use)).toThrow(/exactly twice/);
    expect(() => read(`/* ${decl} */\nconst SUPERVISOR_WORKER_NAMES = new Set<string>([\n  'a', 'b', 'ghost',\n]);\n` + use)).toThrow();
    for (const end of ['\r', '\u2028', '\u2029']) {
      const src = `${DECLARATION}\n  'a', 'b', // note${end}  'ghost',\n]);\n` + use;
      expect(read(src)).toEqual(['a', 'b', 'ghost']);
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
