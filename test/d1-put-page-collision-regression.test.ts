import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGLiteEngine } from "../src/core/pglite-engine.ts";
import { operationsByName } from "../src/core/operations.ts";
import { resetGateway } from "../src/core/ai/gateway.ts";

const putPage = operationsByName.put_page;
if (!putPage) throw new Error("put_page operation missing");

const ALLOWLIST_ENV = "GBRAIN_PRIVACY_ALLOWLIST_PATH";
const DENYLIST = "## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated-family-entry` | Unrelated Family Entry |\n";
const CASES = [
  { slug: "person/lgv", privateSlug: "lgv" },
  { slug: "chris-hooper/_author", privateSlug: "chris-hooper" },
  { slug: "wiki/chris-hooper/_author", privateSlug: "chris-hooper" },
] as const;

let engine: PGLiteEngine;
let policyDir: string;
let allowlistPath: string;
let previousAllowlistPath: string | undefined;

function context() {
  return {
    engine,
    config: { engine: "pglite" as const },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: "default",
  };
}

function contentFor(slug: string): string {
  return `---\ntype: person\ntitle: ${slug}\n---\n\nPUBLIC ${slug} op v1\n`;
}

async function seedScenario(slug: string, privateSlug: string): Promise<void> {
  await engine.putPage(privateSlug, {
    type: "person",
    title: `Private ${slug}`,
    compiled_truth: `PRIVATE ${slug}`,
    timeline: "",
    frontmatter: {},
  }, { sourceId: "lg-private" });
  await engine.putPage(slug, {
    type: "person",
    title: slug,
    compiled_truth: `PUBLIC ${slug} op v1`,
    timeline: "",
    frontmatter: {},
  }, { sourceId: "default", migrationWrite: true });
}

beforeAll(async () => {
  policyDir = mkdtempSync(join(tmpdir(), "gbrain-d1-put-page-policy-"));
  allowlistPath = join(policyDir, "privacy-allowlist.tsv");
  previousAllowlistPath = process.env[ALLOWLIST_ENV];
  process.env[ALLOWLIST_ENV] = allowlistPath;
  writeFileSync(join(policyDir, "_excluded-people.md"), DENYLIST);
  writeFileSync(join(policyDir, "_brain-filing-rules.md"), "# filing rules\n");
  writeFileSync(allowlistPath, CASES.map(({ slug }) => `collision|${slug}`).join("\n") + "\n");

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources
     SET config = jsonb_set(
       jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb),
       '{facts_visibility}', '"world"'::jsonb
     )
     WHERE id = 'default'`,
  );
  resetGateway();
}, 120_000);

beforeEach(async () => {
  await engine.executeRaw(
    `DELETE FROM pages
     WHERE slug IN ('person/lgv', 'lgv', 'chris-hooper/_author', 'wiki/chris-hooper/_author', 'chris-hooper')`,
  );
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)`,
    [policyDir],
  );
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  if (existsSync(policyDir)) rmSync(policyDir, { recursive: true, force: true });
  if (previousAllowlistPath === undefined) delete process.env[ALLOWLIST_ENV];
  else process.env[ALLOWLIST_ENV] = previousAllowlistPath;
});

describe("put_page collision allowlist routing", () => {
  for (const { slug, privateSlug } of CASES) {
    test(`${slug} preserves both the private body and the default row across two puts`, async () => {
      await seedScenario(slug, privateSlug);

      await putPage.handler(context(), { slug, content: contentFor(slug) });
      await putPage.handler(context(), { slug, content: contentFor(slug) });

      const privateRows = await engine.executeRaw<{ compiled_truth: string }>(
        `SELECT compiled_truth FROM pages WHERE source_id = 'lg-private' AND slug = $1`,
        [privateSlug],
      );
      const defaultRows = await engine.executeRaw<{ compiled_truth: string; deleted_at: string | null }>(
        `SELECT compiled_truth, deleted_at FROM pages WHERE source_id = 'default' AND slug = $1`,
        [slug],
      );

      expect(privateRows[0]?.compiled_truth).toBe(`PRIVATE ${slug}`);
      expect(defaultRows).toHaveLength(1);
      expect(defaultRows[0]?.deleted_at).toBeNull();
    });
  }
});
