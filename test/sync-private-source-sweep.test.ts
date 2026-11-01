import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { withRegisteredLocalWriter } from '../src/core/persistence/identity.ts';
import { readOnlySameContentScreen } from '../src/core/persistence/sync-convergence.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { sweepLegacy, newPassApplyState } from '../src/core/persistence/sync-pass-apply.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { readSyncImportProvenance } from '../src/core/persistence/sync-holds.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { ManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import type { ShadowLevel, ShadowPath } from '../src/core/persistence/sync-pass.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rules = (slug: string) => `# people\n\n## Family deny-list\n\n| slug | name |\n| --- | --- |\n| \`${slug}\` | Alice Example |\n`;
const filing = '# filing rules\n';
const page = '---\ntype: concept\ntitle: notes/alice\n---\n\nThe same body.\n';

describe('private-source inventory during a legacy sweep slice', () => {
  test('unchanged policy matches, but a policy flip before record publication does not match', async () => {
    await managedBrain(async ({ engine, root }) => {
      await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
      const snapshot = await engine.readPageSnapshot('notes/alice', { sourceId: 'default' });
      expect(snapshot).not.toBeNull();
      const binding = await getWorktreeBinding(engine, 'default');
      const sourceRoot = binding!.local_path ?? root;
      const [source] = await engine.executeRaw<{ incarnation: string; last_commit: string | null; config: Record<string, unknown> }>(
        'SELECT incarnation::text AS incarnation,last_commit,config FROM sources WHERE id=$1', ['default']);
      const context: ManagedSyncContext = { binding: binding!, root: sourceRoot, gitRoot: sourceRoot, sourceId: 'default', incarnation: source!.incarnation,
        source: { last_commit: source!.last_commit, config: source!.config } };
      const entry = {
        path: 'notes/alice.md', slug: 'notes/alice', pageId: snapshot!.page.id, revision: snapshot!.revision,
        state: { mode: 'working', level: 'working-level', present: true, dirty: null, diskOid: null, levelSha256: sha256(Buffer.from(page)), page: { live: true, revision: snapshot!.revision, originMatches: true } },
        result: { cls: 'legacy_unverified', settled: false, action: 'import', classAction: 'owner' },
      } as unknown as ShadowPath;
      const level = { sourceId: 'default', incarnation: source!.incarnation, root: sourceRoot, gitRoot: sourceRoot, mode: 'working', scope: '', slugMode: 'git-root',
        baselineCommit: null, head: 'working', kind: 'full', kindBlockers: [], full: true, paths: [entry] } as unknown as ShadowLevel;
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', ['sync-import-provenance', `default:${source!.incarnation}:${snapshot!.page.id}`]);
      let flipped = false;
      const flip = async () => {
        if (flipped) return;
        flipped = true;
        writeFileSync(join(root, '..', 'private', '_excluded-people.md'), rules('notes/alice'));
        await engine.executeRaw('UPDATE sources SET config=jsonb_set(config,\'{private_routing,excluded_people_markdown}\',$2::jsonb) WHERE id=$1', ['lg-private', JSON.stringify(rules('notes/alice'))]);
      };
      const screen = readOnlySameContentScreen(engine, context, { noEmbed: true, noExtract: true, noSchemaPack: true });
      const unchanged = await withRegisteredLocalWriter(engine, 'cli', () => screen(level, [entry]));
      expect(unchanged.get(entry.path)).toBe('same');

      const flipAfterScreen = async (screenLevel: ShadowLevel, paths: ShadowPath[]) => {
        const verdicts = await withRegisteredLocalWriter(engine, 'cli', () => screen(screenLevel, paths));
        await flip();
        return verdicts;
      };
      const state = newPassApplyState();
      let refusal: unknown = null;
      await withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null } }, async () => {
        try {
          await sweepLegacy(engine, level, { passId: 'test-private-source-fence', observedAt: new Date().toISOString(), remote: false,
            admission: 'normal', fullRound: true, obligations: {}, context, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true },
            screen: flipAfterScreen }, state);
        } catch (error) {
          refusal = error;
        }
        return {} as never;
      });
      expect(flipped).toBe(true);
      expect(await readSyncImportProvenance(engine, 'default', source!.incarnation, snapshot!.page.id)).toBeNull();
      if (refusal) expect(refusal).toMatchObject({ message: 'private source inventory changed since screen; refusing publication' });
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
