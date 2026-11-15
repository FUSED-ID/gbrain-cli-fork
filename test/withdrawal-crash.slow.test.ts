import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { registerLocalWriter, localHostId } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

/** Same seed as helpers/withdrawal-effect-process.ts, with a federated source so the world fact stays world. The helper file is shared and stays unchanged. */
async function seedFederatedWithdrawal(backend: string, files: string, database: string): Promise<void> {
  const engine: BrainEngine = backend === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
  await engine.connect(backend === 'pglite' ? { database_path: database } : { database_url: database });
  const hostId = localHostId();
  const sourceId = 'synthetic-withdrawal-crash';
  try {
    await engine.initSchema();
    await registerLocalWriter(engine, 'cli');
    await engine.executeRaw(
      `INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{"federated":true,"facts_visibility":"world"}')`,
      [sourceId, files],
    );
    const binding = await claimWorktree(engine, sourceId, files, hostId);
    for (const slug of ['affected', 'untouched']) {
      const body = slug === 'affected' ? renderFactsTable([{ rowNum: 1, claim: 'synthetic crash claim', kind: 'fact', confidence: 1,
        visibility: 'world', notability: 'medium', active: true }]) : 'Exact untouched bytes';
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }], { sourceId });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      writeFileSync(join(files, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
    }
    const fact = await engine.insertFact({ fact: 'synthetic crash claim', source: 'synthetic', visibility: 'world' }, { source_id: sourceId });
    const context: OperationContext = { engine, remote: false, sourceId, config: { engine: engine.kind }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    const authority = await submissionAuthority(context, 'forget', sourceId, binding.source_incarnation, 'affected');
    const request = await admitWrite(engine, { authority, principal: authority.principal, operation: 'forget', sourceId,
      sourceIncarnation: binding.source_incarnation, slug: 'affected', pageId: null, requestId: randomUUID(),
      intent: { id: fact.id }, callerIntent: { id: fact.id }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const untouched = await engine.executeRaw(`SELECT row_to_json(p) AS page,(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
      FROM content_chunks c WHERE c.page_id=p.id) AS chunks FROM pages p WHERE source_id=$1 AND slug='untouched'`, [sourceId]);
    await engine.transaction(async tx => {
      await recordFactWithdrawal(tx, fact.id, sourceId, false, { requestId: request.id });
      await completeWrite(tx, request, 'committed', { status: 'forgotten' });
    });
    const revision = (await engine.readPageSnapshot('affected', { sourceId }))!.revision;
    writeFileSync(join(files, 'state.json'), JSON.stringify({ untouched, revision, requestId: request.id, bytes: readFileSync(join(files, 'untouched.md'), 'base64') }));
  } finally {
    await engine.disconnect();
  }
}

for (const backend of testBackends()) for (const boundary of ['after_mirror_file', 'before_mirror_commit']) {
  test(`${backend}: SIGKILL at ${boundary} recovers forward with exact unrelated state`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-crash-'));
    const files = join(root, 'files'); mkdirSync(files);
    const pg = backend === 'postgres' ? await isolatedPersistencePostgres(process.env.DATABASE_URL!) : null;
    const database = pg?.databaseUrl ?? join(root, 'pglite');
    if (pg) await pg.engine.disconnect();
    const home = join(root, 'home');
    mkdirSync(home);
    const launch = (mode: string) => Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/withdrawal-effect-process.ts'), mode, backend, files, database, boundary], {
      env: { ...process.env, GBRAIN_HOME: home, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const previousHome = process.env.GBRAIN_HOME;
      process.env.GBRAIN_HOME = home;
      try { await seedFederatedWithdrawal(backend, files, database); }
      finally { if (previousHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = previousHome; }
      const child = launch('crash'), reader = child.stdout.getReader();
      const errors = new Response(child.stderr).text();
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          output += new TextDecoder().decode(next.value);
          if (output.includes('AT_MIRROR_BOUNDARY')) break;
        }
        child.kill('SIGKILL');
        expect(await child.exited).toBe(137); expect(child.signalCode).toBe('SIGKILL');
        expect(output, await errors).toContain('AT_MIRROR_BOUNDARY');
      } finally { clearTimeout(timer); child.kill(); }
      const recovery = launch('recover');
      const recovered = await new Response(recovery.stdout).text(), stderr = await new Response(recovery.stderr).text();
      expect(await recovery.exited, stderr).toBe(0); expect(recovered).toContain('RECOVERED_EXACTLY');
    } finally { await pg?.close(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
}
