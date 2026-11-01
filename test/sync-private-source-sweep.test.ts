import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { withRegisteredLocalWriter } from '../src/core/persistence/identity.ts';
import { readOnlySameContentScreen } from '../src/core/persistence/sync-convergence.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import type { ManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import type { ShadowLevel, ShadowPath } from '../src/core/persistence/sync-pass.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rules = (slug: string) => `# people\n\n## Family deny-list\n\n| slug | name |\n| --- | --- |\n| \`${slug}\` | Alice Example |\n`;
const filing = '# filing rules\n';
const page = '---\ntype: concept\ntitle: notes/alice\n---\n\nThe same body.\n';

describe('private-source inventory during a legacy sweep slice', () => {
  test('a policy change before screen preparation does not produce a shared-source match', async () => {
    await managedBrain(async ({ engine, root }) => {
      await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
      const snapshot = await engine.readPageSnapshot('notes/alice', { sourceId: 'default' });
      expect(snapshot).not.toBeNull();
      const binding = await getWorktreeBinding(engine, 'default');
      const [source] = await engine.executeRaw<{ incarnation: string; last_commit: string | null; config: Record<string, unknown> }>(
        'SELECT incarnation::text AS incarnation,last_commit,config FROM sources WHERE id=$1', ['default']);
      const context: ManagedSyncContext = { binding: binding!, root, gitRoot: root, sourceId: 'default', incarnation: source!.incarnation,
        source: { last_commit: source!.last_commit, config: source!.config } };
      const entry = {
        path: 'notes/alice.md', slug: 'notes/alice', pageId: snapshot!.page.id, revision: snapshot!.revision,
        state: { mode: 'working', level: 'working-level', present: true, dirty: null, diskOid: null, levelSha256: null, page: { live: true, revision: snapshot!.revision, originMatches: true } },
        result: { cls: 'legacy_unverified', settled: false, action: 'import', classAction: 'owner' },
      } as unknown as ShadowPath;
      const level = { sourceId: 'default', incarnation: source!.incarnation, root, gitRoot: root, mode: 'working', scope: '', slugMode: 'git-root',
        baselineCommit: null, head: 'working', kind: 'full', kindBlockers: [], full: true, paths: [entry] } as unknown as ShadowLevel;
      let snapshotRead = false, flipped = false;
      const flip = async () => {
        if (flipped) return;
        flipped = true;
        writeFileSync(join(root, '..', 'private', '_excluded-people.md'), rules('notes/alice'));
        await engine.executeRaw('UPDATE sources SET config=jsonb_set(config,\'{private_routing,excluded_people_markdown}\',$2::jsonb) WHERE id=$1', ['lg-private', JSON.stringify(rules('notes/alice'))]);
      };
      const wrapped = new Proxy(engine, { get(target, key) {
        if (key === 'listAllSources') return async (...args: Parameters<NonNullable<BrainEngine['listAllSources']>>) => { const result = await target.listAllSources!(...args); snapshotRead = true; return result; };
        if (key === 'getConfig') return async (...args: Parameters<BrainEngine['getConfig']>) => { const result = await target.getConfig(...args); if (snapshotRead) await flip(); return result; };
        if (key === 'executeRaw') return async (...args: Parameters<BrainEngine['executeRaw']>) => {
          const result = await target.executeRaw(...args);
          if (typeof args[0] === 'string' && args[0].includes('SELECT id, config, local_path FROM sources ORDER BY')) snapshotRead = true;
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as BrainEngine;
      const verdicts = await withRegisteredLocalWriter(engine, 'cli', async () => {
        const screen = readOnlySameContentScreen(wrapped, context, { noEmbed: true, noExtract: true, noSchemaPack: true });
        return screen(level, [entry]);
      });
      expect(flipped).toBe(true);
      expect(verdicts.get(entry.path)).toBe('unknown');
    }, { setup: async ({ engine, root }) => {
      const privateRoot = join(root, '..', 'private');
      mkdirSync(privateRoot, { recursive: true });
      writeFileSync(join(privateRoot, '_excluded-people.md'), rules('people/bob'));
      writeFileSync(join(privateRoot, '_brain-filing-rules.md'), filing);
      mkdirSync(join(root, 'notes'), { recursive: true });
      writeFileSync(join(root, 'notes/alice.md'), page);
      git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'alice');
      await engine.executeRaw(`UPDATE sources SET config=jsonb_set(jsonb_set(COALESCE(config,'{}'::jsonb),'{federated}','true'::jsonb),'{facts_visibility}','"world"'::jsonb) WHERE id='default'`);
      await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES('lg-private','LG private',NULL,jsonb_build_object('private_routing',jsonb_build_object('excluded_people_markdown',$1::text,'filing_rules_markdown',$2::text)))`, [rules('people/bob'), filing]);
    } });
  }, 180_000);
});
