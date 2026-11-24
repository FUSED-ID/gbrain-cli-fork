/**
 * Fable GO on a319766 with follow-ups (2026-11-24, BG4):
 * 1. an operator entry point for the protected-page override: `gbrain repair ghost-pages ... --protected-page-override <reason>`,
 *    operator taken from the authenticated writer, never from the flag;
 * 2. JS and SQL agree on a colon after a slash, protecting it;
 * 3. the `<source>:<slug>` SQL form is anchored at the start;
 * 4. the override log line strips control characters and caps its length.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseRepairArgs, runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const GUARD = 'GBRAIN_PROTECTED_BINDER_GUARD';
const PATTERNS = 'GBRAIN_PROTECTED_SLUG_PATTERNS';
const BINDER = 'docs/binder-gbrain-conops-doc-family-2026-11-24-t5';
const mod = () => import('../src/core/persistence/protected-binder-pages.ts');
const logger = { info() {}, warn() {}, error() {} };

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

describe('2 and 3: JS and SQL agree, colon after a slash protected, source form anchored', () => {
  const cases = [
    'notes/x:binder-gbrain-conops-doc-family-1', `lg-private:${BINDER}`, 'default:binder-gbrain-conops-doc-family-2', BINDER,
    'binder-gbrain-conops-doc-family-3', 'notes/plain', 'notes/about-binder-gbrain-conops', 'a/b:xyz', 'src:xyz', 'xyz', 'a:b:xyz', 'q/xyz',
  ];
  test('the predicate and the SQL exclusion operands give the same verdict for every slug', async () => {
    const { isProtectedBinderPage, protectedSlugSqlPatterns } = await mod();
    await withEnv({ [GUARD]: undefined, [PATTERNS]: 'x*' }, async () => {
      const js = cases.map(slug => isProtectedBinderPage(slug));
      const sql = [] as boolean[];
      for (const slug of cases) sql.push((await engine.executeRaw<{ hit: boolean }>('SELECT $2 ~* ANY($1::text[]) AS hit', [protectedSlugSqlPatterns(), slug]))[0]!.hit);
      expect(sql).toEqual(js);
      expect(Object.fromEntries(cases.map((slug, i) => [slug, js[i]]))).toEqual({
        'notes/x:binder-gbrain-conops-doc-family-1': true, [`lg-private:${BINDER}`]: true, 'default:binder-gbrain-conops-doc-family-2': true, [BINDER]: true,
        'binder-gbrain-conops-doc-family-3': true, 'notes/plain': false, 'notes/about-binder-gbrain-conops': false,
        'a/b:xyz': false, 'src:xyz': true, xyz: true, 'a:b:xyz': false, 'q/xyz': false,
      });
    });
  });
});

describe('4: override log text is sanitised', () => {
  test('control characters and line breaks become spaces and the length is capped', async () => {
    const { sanitizeOverrideText } = await mod();
    expect(sanitizeOverrideText('retire\nghost\r\u0007page now')).toBe('retire ghost page now');
    const long = sanitizeOverrideText('r'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(163);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('1: gbrain repair ghost-pages --protected-page-override', () => {
  test('the flag parses on ghost-pages only and needs a reason', () => {
    expect(parseRepairArgs(['ghost-pages', '--source', 's', '--apply', '--expect', 'h', '--yes', '--protected-page-override', 'retire the moved Binder']).protectedPageOverride)
      .toBe('retire the moved Binder');
    expect(() => parseRepairArgs(['legacy-twins', '--source', 's', '--protected-page-override', 'why'])).toThrow();
    expect(() => parseRepairArgs(['ghost-pages', '--source', 's', '--protected-page-override', '  '])).toThrow();
  });

  test('a ghost Binder page is refused without the flag and retired with it; the log names the authenticated operator, sanitised', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-bg4-ghost-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `bg4-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), [GUARD]: undefined, GBRAIN_INTERACTIVE: '0', CI: '1' }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: BINDER, content: '---\ntype: note\ntitle: Binder\n---\n\nBinder body.\n', request_id: randomUUID() } });
        unlinkSync(join(root, `${BINDER}.md`));
        const live = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, BINDER]))[0]!.n === 1;
        const run = async (argv: string[]) => {
          const printed: string[] = []; const logged: string[] = [];
          const log = console.log, err = console.error, write = process.stdout.write;
          console.log = (...p: unknown[]) => { printed.push(p.map(String).join(' ')); };
          console.error = (...p: unknown[]) => { logged.push(p.map(String).join(' ')); };
          process.stdout.write = ((chunk: string | Uint8Array) => { printed.push(String(chunk)); return true; }) as typeof process.stdout.write;
          try { await runRepairCommand(engine, argv); } finally { console.log = log; console.error = err; process.stdout.write = write; _resetCliExitVerdictForTests(); }
          return { result: JSON.parse(printed.join('')).results[0], logged };
        };
        const preview = (await run(['ghost-pages', '--source', sourceId, '--json'])).result;
        expect(preview.listing.map((entry: { item: string }) => entry.item)).toEqual([`${sourceId}:${BINDER}`]);
        const apply = ['ghost-pages', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes', '--json'];
        const refused = (await run(apply)).result;
        expect(refused.applied).toBe(0);
        expect(JSON.stringify(refused)).toContain('permission_denied');
        expect(await live()).toBe(true);
        // The refused apply settled the approved set; the operator previews again and applies with the override.
        const again = (await run(['ghost-pages', '--source', sourceId, '--json'])).result;
        expect(again.listing.map((entry: { item: string }) => entry.item)).toEqual([`${sourceId}:${BINDER}`]);
        const allowed = await run(['ghost-pages', '--source', sourceId, '--apply', '--expect', again.preview_hash, '--yes', '--json',
          '--protected-page-override', 'retire the moved\nBinder']);
        expect(allowed.result).toMatchObject({ applied: 1, outcomes: { soft_deleted: 1 } });
        expect(await live()).toBe(false);
        const line = allowed.logged.find(l => l.includes('operator override'))!;
        expect(line).toContain(BINDER);
        expect(line).toContain('operator=local_cli:');
        expect(line).toContain('reason=retire the moved Binder');
        expect(line.includes('\n')).toBe(false);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
