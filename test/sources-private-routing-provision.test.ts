import { afterAll, beforeAll, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';

const SOURCE_ID = 'provision-private-fixture';
const FAMILY_ROW = '| `family-person` | Family Person |\n';
const UNRESOLVED_ROW = '| `unresolved-person` | unresolved@example.test |\n';

let engine: PGLiteEngine;

function policyMarkdown(opts: { unresolvedHeading?: boolean; unresolvedRows?: string } = {}): string {
  const unresolved = opts.unresolvedHeading === false
    ? ''
    : `\n## Do not enrich, identity unresolved\n| Slug pattern | Contact |\n|---|---|\n${opts.unresolvedRows ?? UNRESOLVED_ROW}`;
  return `## Family deny-list\n| Slug pattern | Name |\n|---|---|\n${FAMILY_ROW}${unresolved}`;
}

async function seedSource(localPath: string, config: Record<string, unknown> = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources(id, name, local_path, config)
     VALUES($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [SOURCE_ID, 'Provision private fixture', localPath, JSON.stringify(config)],
  );
}

async function runProvision(json = true): Promise<string[]> {
  const lines: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await runSources(engine, ['provision-private-routing', SOURCE_ID, ...(json ? ['--json'] : [])]);
  } finally {
    logSpy.mockRestore();
  }
  return lines;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE_ID]);
});

describe('sources provision-private-routing policy section guards', () => {
  test('reports both parsed section counts and stores both sections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-provision-private-fixture-'));
    try {
      writeFileSync(join(dir, '_excluded-people.md'), policyMarkdown({ unresolvedRows: UNRESOLVED_ROW + UNRESOLVED_ROW }));
      writeFileSync(join(dir, '_brain-filing-rules.md'), '# filing rules\n');
      await seedSource(dir);

      const lines = await runProvision();
      expect(JSON.parse(lines[0]!)).toEqual({
        source_id: SOURCE_ID,
        excluded_entry_count: 1,
        unresolved_identity_entry_count: 2,
      });
      const rows = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [SOURCE_ID]);
      const stored = typeof rows[0]?.config === 'string' ? JSON.parse(rows[0].config) : rows[0]?.config;
      expect(stored).toMatchObject({
        private_routing: {
          excluded_people_markdown: policyMarkdown({ unresolvedRows: UNRESOLVED_ROW + UNRESOLVED_ROW }),
          filing_rules_markdown: '# filing rules\n',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a present unresolved heading with zero parsed entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-provision-private-empty-unresolved-'));
    try {
      writeFileSync(join(dir, '_excluded-people.md'), policyMarkdown({ unresolvedRows: '' }));
      writeFileSync(join(dir, '_brain-filing-rules.md'), '# filing rules\n');
      await seedSource(dir);

      await expect(runProvision(false)).rejects.toThrow(/identity unresolved.*present.*zero entries/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses removal when the stored markdown had the unresolved heading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-provision-private-removed-unresolved-'));
    const storedMarkdown = policyMarkdown();
    try {
      writeFileSync(join(dir, '_excluded-people.md'), policyMarkdown({ unresolvedHeading: false }));
      writeFileSync(join(dir, '_brain-filing-rules.md'), '# filing rules\n');
      await seedSource(dir, {
        private_routing: {
          excluded_people_markdown: storedMarkdown,
          filing_rules_markdown: '# filing rules\n',
        },
      });

      await expect(runProvision()).rejects.toThrow(/previously stored.*identity unresolved.*missing/i);
      const rows = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [SOURCE_ID]);
      expect(JSON.stringify(rows[0]?.config)).toContain('Do not enrich, identity unresolved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
