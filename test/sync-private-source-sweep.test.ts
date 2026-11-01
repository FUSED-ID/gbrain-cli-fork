import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { withRegisteredLocalWriter } from '../src/core/persistence/identity.ts';
import { readOnlySameContentScreen } from '../src/core/persistence/sync-convergence.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { sweepLegacy, newPassApplyState } from '../src/core/persistence/sync-pass-apply.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { readSyncImportProvenance } from '../src/core/persistence/sync-holds.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { screenWaiver, waiveNoopEntry, waiveNoopRun, type WaiverCursor, type WaiverEntry, type WaiverRunEntry } from '../src/core/persistence/sync-waivers.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { ManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import type { ShadowLevel, ShadowPath } from '../src/core/persistence/sync-pass.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rules = (slug: string) => `# people\n\n## Family deny-list\n\n| slug | name |\n| --- | --- |\n| \`${slug}\` | Alice Example |\n`;
const filing = '# filing rules\n';
const page = '---\ntype: concept\ntitle: notes/alice\n---\n\nThe same body.\n';

async function setupPrivateWaiver(engine: BrainEngine, root: string, opts: { localPath?: boolean } = {}) {
  const privateRoot = join(root, '..', 'private');
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(privateRoot, '_excluded-people.md'), rules('people/bob'));
  writeFileSync(join(privateRoot, '_brain-filing-rules.md'), filing);
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes/alice.md'), page);
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'alice');
  await engine.executeRaw(`UPDATE sources SET config=jsonb_set(jsonb_set(COALESCE(config,'{}'::jsonb),'{federated}','true'::jsonb),'{facts_visibility}','"world"'::jsonb) WHERE id='default'`);
  if (opts.localPath) await engine.setConfig('sync.write_through', 'false');
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES('lg-private','LG private',$3::text,jsonb_build_object('private_routing',jsonb_build_object('excluded_people_markdown',$1::text,'filing_rules_markdown',$2::text)))`, [rules('people/bob'), filing, opts.localPath ? privateRoot : null]);
}

async function waiverFixture(engine: BrainEngine, root: string) {
  await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
  const snapshot = await engine.readPageSnapshot('notes/alice', { sourceId: 'default' });
  const binding = await getWorktreeBinding(engine, 'default');
  const sourceRoot = binding!.local_path ?? root;
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', ['default']);
  const [request] = await engine.executeRaw<{ request_id: string; intent: Record<string, unknown> }>(
    `SELECT request_id,intent FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY created_at DESC LIMIT 1`, ['default']);
  if (!snapshot || !binding || !source || !request) throw new Error('waiver fixture did not publish its page');
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', ['sync-import-provenance', `default:${source.incarnation}:${snapshot.page.id}`]);
  const authority = await withRegisteredLocalWriter(engine, 'cli', () => managedSyncAuthority(engine, 'default', source.incarnation, sourceRoot));
  const cursor: WaiverCursor = { sourceId: 'default', incarnation: source.incarnation, root: sourceRoot, gitRoot: sourceRoot, slugMode: 'git-root', binding,
    authority, runId: 'waiver-run', index: 0 };
  const pending: WaiverEntry = { requestId: request.request_id, slug: 'notes/alice', pageId: snapshot.page.id,
    intent: { ...request.intent, expected_revision: snapshot.revision, working: true } as never };
  const config = { engine: engine.kind, embedding_disabled: true } as GBrainConfig;
  const flip = async () => {
    writeFileSync(join(root, '..', 'private', '_excluded-people.md'), rules('notes/alice'));
    await engine.executeRaw('UPDATE sources SET config=jsonb_set(config,\'{private_routing,excluded_people_markdown}\',$2::jsonb) WHERE id=$1', ['lg-private', JSON.stringify(rules('notes/alice'))]);
  };
  const head = async (key: string, requestId: string | null) => {
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::jsonb)`,
      [key, JSON.stringify([{ runId: cursor.runId, index: cursor.index, pending: requestId ? { requestId } : null }])]);
  };
  const provenance = () => readSyncImportProvenance(engine, 'default', source.incarnation, snapshot.page.id);
  return { cursor, pending, config, flip, head, provenance };
}

async function legacySweepFixture(engine: BrainEngine, root: string) {
  await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
  const snapshot = await engine.readPageSnapshot('notes/alice', { sourceId: 'default' });
  if (!snapshot) throw new Error('legacy sweep fixture did not publish its page');
  const binding = await getWorktreeBinding(engine, 'default');
  const sourceRoot = binding!.local_path ?? root;
  const [source] = await engine.executeRaw<{ incarnation: string; last_commit: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,last_commit,config FROM sources WHERE id=$1', ['default']);
  const context: ManagedSyncContext = { binding: binding!, root: sourceRoot, gitRoot: sourceRoot, sourceId: 'default', incarnation: source!.incarnation,
    source: { last_commit: source!.last_commit, config: source!.config } };
  const entry = {
    path: 'notes/alice.md', slug: 'notes/alice', pageId: snapshot.page.id, revision: snapshot.revision,
    state: { mode: 'working', level: 'working-level', present: true, dirty: null, diskOid: null, levelSha256: sha256(Buffer.from(page)), page: { live: true, revision: snapshot.revision, originMatches: true } },
    result: { cls: 'legacy_unverified', settled: false, action: 'import', classAction: 'owner' },
  } as unknown as ShadowPath;
  const level = { sourceId: 'default', incarnation: source!.incarnation, root: sourceRoot, gitRoot: sourceRoot, mode: 'working', scope: '', slugMode: 'git-root',
    baselineCommit: null, head: 'working', kind: 'full', kindBlockers: [], full: true, paths: [entry] } as unknown as ShadowLevel;
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', ['sync-import-provenance', `default:${source!.incarnation}:${snapshot.page.id}`]);
  const flip = async () => {
    writeFileSync(join(root, '..', 'private', '_excluded-people.md'), rules('notes/alice'));
    await engine.executeRaw('UPDATE sources SET config=jsonb_set(config,\'{private_routing,excluded_people_markdown}\',$2::jsonb) WHERE id=$1', ['lg-private', JSON.stringify(rules('notes/alice'))]);
  };
  return { context, entry, level, incarnation: source!.incarnation, pageId: snapshot.page.id, flip };
}

describe('private-source inventory during a legacy sweep slice', () => {
  test('unchanged policy records provenance', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await legacySweepFixture(engine, root);
      const state = newPassApplyState();
      await withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null } }, async () => {
        await sweepLegacy(engine, f.level, { passId: 'test-private-source-fence-control', observedAt: new Date().toISOString(), remote: false,
          admission: 'normal', fullRound: true, obligations: {}, context: f.context, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true },
          screen: readOnlySameContentScreen(engine, f.context, { noEmbed: true, noExtract: true, noSchemaPack: true }) }, state);
        return {} as never;
      });
      expect(await readSyncImportProvenance(engine, 'default', f.incarnation, f.pageId)).not.toBeNull();
    }, { setup: async ({ engine, root }) => setupPrivateWaiver(engine, root) });
  }, 180_000);

  test('policy flip before record publication refuses without advancing sweep progress', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await legacySweepFixture(engine, root);
      const state = newPassApplyState();
      const obligations = {};
      let sweptProgress = 0;
      const flipAfterScreen = async (screenLevel: ShadowLevel, paths: ShadowPath[]) => {
        const verdicts = await withRegisteredLocalWriter(engine, 'cli', () => readOnlySameContentScreen(engine, f.context, { noEmbed: true, noExtract: true, noSchemaPack: true })(screenLevel, paths));
        await f.flip();
        return verdicts;
      };
      await withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null } }, async () => {
        await expect(sweepLegacy(engine, f.level, { passId: 'test-private-source-fence-refusal', observedAt: new Date().toISOString(), remote: false,
          admission: 'normal', fullRound: true, obligations, context: f.context, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true },
          screen: flipAfterScreen, onSwept: async () => { sweptProgress++; } }, state))
          .rejects.toThrow('private source inventory changed since screen; refusing publication');
        return {} as never;
      });
      expect(await readSyncImportProvenance(engine, 'default', f.incarnation, f.pageId)).toBeNull();
      expect(sweptProgress).toBe(0);
      expect(obligations).toEqual({});
      expect(state.swept.recorded).toBe(0);
    }, { setup: async ({ engine, root }) => setupPrivateWaiver(engine, root) });
  }, 180_000);
});

describe('private-source routing stamp scope', () => {
  test('an unrelated source config write does not refuse sweep or waiver publication', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await legacySweepFixture(engine, root);
      const state = newPassApplyState();
      const screen = async (screenLevel: ShadowLevel, paths: ShadowPath[]) => {
        const verdicts = await withRegisteredLocalWriter(engine, 'cli', () => readOnlySameContentScreen(engine, f.context, { noEmbed: true, noExtract: true, noSchemaPack: true })(screenLevel, paths));
        await engine.updateSourceConfig('default', { last_extract_atoms_at: new Date().toISOString() });
        return verdicts;
      };
      await withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null } }, async () => {
        await sweepLegacy(engine, f.level, { passId: 'test-private-source-fence-unrelated-config', observedAt: new Date().toISOString(), remote: false,
          admission: 'normal', fullRound: true, obligations: {}, context: f.context, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true },
          screen, onSwept: async () => {} }, state);
        return {} as never;
      });
      expect(await readSyncImportProvenance(engine, 'default', f.incarnation, f.pageId)).not.toBeNull();
    }, { setup: async ({ engine, root }) => setupPrivateWaiver(engine, root) });

    await managedBrain(async ({ engine, root }) => {
      const f = await waiverFixture(engine, root);
      await f.head('waiver-entry-unrelated-config', f.pending.requestId);
      installFaultHook(async point => {
        if (point === 'sync:before_waiver_entry') await engine.updateSourceConfig('default', { last_extract_atoms_at: new Date().toISOString() });
      });
      try {
        const waived = await waiveNoopEntry(engine, f.cursor, f.pending, f.config, 'waiver-entry-unrelated-config', async (_tx) => f.cursor, async () => f.cursor);
        expect(waived).not.toBeNull();
      } finally { installFaultHook(undefined); }
      expect(await f.provenance()).not.toBeNull();
    }, { setup: ({ engine, root }) => setupPrivateWaiver(engine, root) });
  }, 180_000);

  test('a configured private source id change between screen and commit refuses publication', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await waiverFixture(engine, root);
      await f.head('waiver-entry-configured-source-flip', f.pending.requestId);
      installFaultHook(async point => {
        if (point === 'sync:before_waiver_entry') await engine.setConfig('privacy.private_source_id', 'lg-private');
      });
      try {
        await expect(waiveNoopEntry(engine, f.cursor, f.pending, f.config, 'waiver-entry-configured-source-flip', async (_tx) => f.cursor, async () => f.cursor))
          .rejects.toThrow('private source inventory changed since screen; refusing publication');
      } finally { installFaultHook(undefined); }
      expect(await f.provenance()).toBeNull();
    }, { setup: ({ engine, root }) => setupPrivateWaiver(engine, root) });
  }, 180_000);

  test('editing a local private policy file between screen and commit refuses publication', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await waiverFixture(engine, root);
      await f.head('waiver-entry-disk-policy-flip', f.pending.requestId);
      installFaultHook(async point => {
        if (point === 'sync:before_waiver_entry') writeFileSync(join(root, '..', 'private', '_excluded-people.md'), rules('notes/alice'));
      });
      try {
        await expect(waiveNoopEntry(engine, f.cursor, f.pending, f.config, 'waiver-entry-disk-policy-flip', async (_tx) => f.cursor, async () => f.cursor))
          .rejects.toThrow('private source inventory changed since screen; refusing publication');
      } finally { installFaultHook(undefined); }
      expect(await f.provenance()).toBeNull();
    }, { setup: ({ engine, root }) => setupPrivateWaiver(engine, root, { localPath: true }) });
  }, 180_000);
});

describe('private-source inventory during waiver publication', () => {
  test('waiveNoopEntry records provenance when policy is unchanged', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await waiverFixture(engine, root);
      await f.head('waiver-entry-control', f.pending.requestId);
      const waived = await waiveNoopEntry(engine, f.cursor, f.pending, f.config, 'waiver-entry-control', async (_tx) => f.cursor, async () => f.cursor);
      expect(waived).not.toBeNull();
      expect(await f.provenance()).not.toBeNull();
    }, { setup: ({ engine, root }) => setupPrivateWaiver(engine, root) });
  }, 180_000);

  test('waiveNoopEntry refuses publication after a policy flip', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await waiverFixture(engine, root);
      await f.head('waiver-entry-flip', f.pending.requestId);
      installFaultHook(async point => { if (point === 'sync:before_waiver_entry') await f.flip(); });
      try {
        await expect(waiveNoopEntry(engine, f.cursor, f.pending, f.config, 'waiver-entry-flip', async (_tx) => f.cursor, async () => f.cursor))
          .rejects.toThrow('private source inventory changed since screen; refusing publication');
      } finally { installFaultHook(undefined); }
      expect(await f.provenance()).toBeNull();
    }, { setup: ({ engine, root }) => setupPrivateWaiver(engine, root) });
  }, 180_000);

  test('waiveNoopRun records provenance without a policy flip and refuses after one', async () => {
    await managedBrain(async ({ engine, root }) => {
      const f = await waiverFixture(engine, root);
      const screened = await screenWaiver(engine, f.cursor, f.pending, f.config);
      expect(screened?.privateSourceStamp).toBeString();
      const run: WaiverRunEntry[] = [{ pending: f.pending, waived: screened! }];
      await f.head('waiver-run-control', null);
      const control = await waiveNoopRun(engine, f.cursor, run, 'waiver-run-control', async (_tx) => f.cursor, async () => f.cursor);
      expect(control).toMatchObject({ waived: 1 });
      expect(await f.provenance()).not.toBeNull();

      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', ['sync-import-provenance', `default:${f.cursor.incarnation}:${f.pending.pageId}`]);
      const flippedScreen = await screenWaiver(engine, f.cursor, f.pending, f.config);
      expect(flippedScreen?.privateSourceStamp).toBeString();
      await f.flip();
      await f.head('waiver-run-flip', null);
      await expect(waiveNoopRun(engine, f.cursor, [{ pending: f.pending, waived: flippedScreen! }], 'waiver-run-flip', async (_tx) => f.cursor, async () => f.cursor))
        .rejects.toThrow('private source inventory changed since screen; refusing publication');
      expect(await f.provenance()).toBeNull();
    }, { setup: ({ engine, root }) => setupPrivateWaiver(engine, root) });
  }, 180_000);
});
