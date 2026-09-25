import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { assertPrivateRoutingArmed, resolvePrivateWriteSource } from '../src/core/private-source-routing.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

const putPage = operationsByName.put_page;
const PERSON_CONTENT = '---\ntype: person\ntitle: Private Test Person\n---\n\nPerson body.\n';

let engine: PGLiteEngine;
let policyDir: string;

// This file writes real person-shaped content through the put_page
// operation handler (`executePutPage`), which loads ../ai/gateway.ts and
// checks isAvailable('embedding') BEFORE the engine's privacy guard ever
// runs. On a shell where OPENAI_API_KEY / VOYAGE_API_KEY / OPENROUTER_API_KEY
// are exported (this developer's normal shell), that makes every put_page
// call in this file attempt a REAL embedding call, which previously burned
// live quota, hit HTTP 429, and made this file take 319s.
//
// Unsetting process.env here is NOT enough on its own: isAvailable checks
// the gateway's module-global config snapshot (src/core/ai/gateway.ts,
// configureGateway's `_config`), not process.env directly. If an earlier
// test file in the same worker left the gateway configured with a key
// already folded into that snapshot (test/extract-facts-embed-warn.serial
// .test.ts mock.modules the gateway, for one), deleting the env vars here
// changes nothing the gateway reads and this file still embeds for real.
// So beforeAll unsets the keys AND calls resetGateway() (clears _config,
// then re-applies the registered test baseline if any, capturing the now
// key-less process.env), and afterAll restores the keys AND calls
// resetGateway() again so the next test file in this worker does not
// inherit a keyless gateway. See
// test/helpers/private-routing-armed-writepath-preload.ts for a standalone
// reproduction that proves this at the gateway layer directly, run with
// `bun test --preload`.
const EMBEDDING_PROVIDER_KEYS = ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'OPENROUTER_API_KEY'] as const;
const savedProviderKeys: Partial<Record<typeof EMBEDDING_PROVIDER_KEYS[number], string>> = {};

// This file's 'lgv' scenarios exercise a slug ('person/lgv') that the real
// operator's live ~/.gbrain/privacy-allowlist.tsv (the T-LEAK-7 collision
// allowlist) legitimately exempts, on a machine where that file exists.
// Point GBRAIN_PRIVACY_ALLOWLIST_PATH at a path that never exists for the
// duration of this file, so these tests assert the guard's behavior in
// isolation and do not depend on, or get broken by, whatever the operator's
// real dotfile happens to contain.
const ALLOWLIST_PATH_ENV = 'GBRAIN_PRIVACY_ALLOWLIST_PATH';
let savedAllowlistPath: string | undefined;

function writePolicy(excluded: string): void {
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(join(policyDir, '_excluded-people.md'), excluded);
}

async function pointPrivateSource(localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [localPath],
  );
}

async function pointDatabasePrivateSource(): Promise<void> {
  const policy = JSON.stringify({
    private_routing: {
      excluded_people_markdown: '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `peer-person` | Peer Person |\n',
      filing_rules_markdown: '# filing rules\n',
    },
  });
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [null, policy],
  );
}

function putContext() {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function executePutPage(slug: string): Promise<void> {
  await putPage.handler(putContext(), { slug, content: PERSON_CONTENT });
}

beforeAll(async () => {
  for (const key of EMBEDDING_PROVIDER_KEYS) {
    if (process.env[key] !== undefined) savedProviderKeys[key] = process.env[key];
    delete process.env[key];
  }
  savedAllowlistPath = process.env[ALLOWLIST_PATH_ENV];
  process.env[ALLOWLIST_PATH_ENV] = join(tmpdir(), 'gbrain-arm-writepath-no-such-allowlist.tsv');
  // Clear whatever the gateway's module-global config snapshot holds from an
  // earlier test file in this worker, and reconfigure from the now key-less
  // process.env (via the registered test baseline, if any), so
  // isAvailable('embedding') reflects the keys just deleted above rather
  // than a stale snapshot.
  resetGateway();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources
     SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{facts_visibility}', '"world"'::jsonb)
     WHERE id = 'default'`,
  );
}, 120_000);

beforeEach(async () => {
  policyDir = mkdtempSync(join(tmpdir(), 'gbrain-arm-writepath-'));
  await engine.executeRaw(
    `DELETE FROM pages WHERE slug LIKE 'people/arm-writepath-%' OR slug LIKE 'person/arm-writepath-%'`,
  );
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
  // v0.57: a routed write publishes through the persistence pipeline, which
  // binds the private source. This fixture recreates that source row with raw
  // SQL per test, so drop the previous test's binding with it.
  await engine.executeRaw(`DELETE FROM persistence_source_bindings WHERE source_id = 'lg-private'`);
});

afterAll(async () => {
  await engine.disconnect();
  if (policyDir && existsSync(policyDir)) rmSync(policyDir, { recursive: true, force: true });
  for (const key of EMBEDDING_PROVIDER_KEYS) {
    if (key in savedProviderKeys) process.env[key] = savedProviderKeys[key];
    else delete process.env[key];
  }
  if (savedAllowlistPath === undefined) delete process.env[ALLOWLIST_PATH_ENV];
  else process.env[ALLOWLIST_PATH_ENV] = savedAllowlistPath;
  // Reconfigure the gateway from the restored env so the next test file in
  // this worker does not inherit the keyless snapshot this file needed.
  resetGateway();
});

describe('private routing armed guard at the put_page write path', () => {
  test('throws when no private source resolves', async () => {
    await expect(executePutPage('people/arm-writepath-no-source')).rejects.toThrow(/NOT ARMED/);
  });

  test('throws when _excluded-people.md is unreadable', async () => {
    await pointPrivateSource(policyDir);
    mkdirSync(join(policyDir, '_excluded-people.md'));
    writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');

    await expect(executePutPage('people/arm-writepath-unreadable')).rejects.toThrow(/could not be read/);
  });

  test('throws when the Family deny-list heading is missing', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Renamed family section\n| Slug pattern | Name |\n|---|---|\n| `private-test*` | Private Test Person |\n');

    await expect(executePutPage('people/arm-writepath-renamed')).rejects.toThrow(/ZERO deny-list entries/);
  });

  test('rechecks the cached arm when a policy file changes', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `cache-person` | Cache Person |\n');

    await assertPrivateRoutingArmed(engine);

    writeFileSync(join(policyDir, '_excluded-people.md'), '## Renamed family section\n');
    await expect(engine.putPage('people/arm-writepath-cache', {
      type: 'person',
      title: 'Cache Person',
      compiled_truth: 'Changed write.',
      timeline: '',
      frontmatter: {},
    })).rejects.toThrow(/ZERO deny-list entries/);
  });

  test('throws for the leaked singular person slug even when its type is concept', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('person/lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus/i);
  });

  test('refuses a person-shaped engine write to default even when ARMED', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('person/lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus/i);
  });

  // D1 policy fix (this lane): refusal is decided by the deny-list and by
  // live private-source collisions, never by "is this exact slug new to
  // `default`". The pairs below each vary exactly one input, RED then GREEN,
  // so a gate that never went RED is not silently trusted.

  test('RED/GREEN: a slug matching the deny list is refused; the same shape off the list is allowed', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `denylisted-person*` | Denylisted Person |\n');
    const page = {
      type: 'concept',
      title: 'Some Contact',
      compiled_truth: 'Contact body.',
      timeline: '',
      frontmatter: {},
    } as const;

    const red = await engine.putPage('people/denylisted-person', page, { sourceId: 'default' })
      .then(() => ({ allowed: true, message: '' }))
      .catch((error: unknown) => ({ allowed: false, message: String(error) }));
    expect(red.allowed).toBe(false);
    expect(red.message).toMatch(/excluded_people_policy/);
    console.log(`RED deny-listed slug write to default: refused: ${red.message}`);

    const green = await engine.putPage('people/off-the-list-person', page, { sourceId: 'default' });
    const roundTrip = await engine.getPage('people/off-the-list-person', { sourceId: 'default' });
    expect(green.slug).toBe('people/off-the-list-person');
    expect(roundTrip?.compiled_truth).toBe(page.compiled_truth);
    console.log(`GREEN non-denylisted slug write to default: allowed, round-tripped slug=${roundTrip?.slug}`);
  });

  test('RED/GREEN: a slug live in lg-private is refused; the same shape not live there is allowed', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('privately-held-person', {
      type: 'concept',
      title: 'Privately Held Person',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    const page = {
      type: 'concept',
      title: 'Privately Held Person',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    } as const;

    const red = await engine.putPage('people/privately-held-person', page, { sourceId: 'default' })
      .then(() => ({ allowed: true, message: '' }))
      .catch((error: unknown) => ({ allowed: false, message: String(error) }));
    expect(red.allowed).toBe(false);
    expect(red.message).toMatch(/existing_private_page/);
    console.log(`RED slug live in lg-private write to default: refused: ${red.message}`);

    const green = await engine.putPage('people/not-privately-held-person', {
      ...page,
      title: 'Not Privately Held Person',
    }, { sourceId: 'default' });
    expect(green.slug).toBe('people/not-privately-held-person');
    console.log(`GREEN slug not live in lg-private write to default: allowed, slug=${green.slug}`);
  });

  // Defect 1 fix, round 2 (binding NO-GO, second pass): rule (a), the
  // Family deny-list match, was unreachable behind rule (b) for anyone both
  // deny-listed AND live in lg-private, because resolvePrivateWriteSource
  // checked rule (b) first and returned as soon as any candidate key had a
  // live private page. Both engines gate the T-LEAK-7 collision-allowlist
  // exemption on route.reason === 'existing_private_page' specifically so
  // it can never suppress a rule (a) refusal -- but with rule (a)
  // unreachable, route.reason was NEVER 'excluded_people_policy' for these
  // people, so a collision row for a denied person admitted them anyway.
  // These two tests cover the case the pre-fix suite missed: they seed a
  // live private page for the denied slug BEFORE writing the collision row,
  // so a regression back to "rule (b) first" would silently pass again.
  test('defect 1 fix: a deny-listed slug that ALSO has a live private page is refused even with a collision row for it', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `arm-writepath-denylisted-and-private*` | Denylisted And Private |\n');
    const bareSlug = 'arm-writepath-denylisted-and-private';
    const requestedSlug = 'people/arm-writepath-denylisted-and-private';
    await engine.putPage(bareSlug, {
      type: 'concept', title: 'Denylisted And Private', compiled_truth: 'Private copy.', timeline: '', frontmatter: {},
    }, { sourceId: 'lg-private' });

    const allowlistPath = join(policyDir, 'privacy-allowlist.tsv');
    const priorAllowlistPath = process.env[ALLOWLIST_PATH_ENV];
    process.env[ALLOWLIST_PATH_ENV] = allowlistPath;
    try {
      // The collision row names the EXACT requested slug: before the order
      // fix this made resolvePrivateWriteSource return reason:
      // 'existing_private_page' (rule (b) found the live private copy
      // first), which the engine's collisionExempt check then waved through.
      writeFileSync(allowlistPath, 'collision|' + requestedSlug + '\n');
      const page = {
        type: 'concept', title: 'Denylisted And Private', compiled_truth: 'Leaked shape.', timeline: '', frontmatter: {},
      } as const;
      const outcome = await engine.putPage(requestedSlug, page, { sourceId: 'default' })
        .then(() => ({ allowed: true, message: '' }))
        .catch((error: unknown) => ({ allowed: false, message: String(error) }));
      expect(outcome.allowed).toBe(false);
      expect(outcome.message).toMatch(/excluded_people_policy/);
      await expect(engine.getPage(requestedSlug, { sourceId: 'default' })).resolves.toBeNull();
    } finally {
      if (priorAllowlistPath === undefined) delete process.env[ALLOWLIST_PATH_ENV];
      else process.env[ALLOWLIST_PATH_ENV] = priorAllowlistPath;
    }
  });

  // Decision (defect 2): a collision-allowlisted slug whose write TITLE
  // matches a deny-listed NAME must be REFUSED, not admitted. The
  // allowlist's only legitimate purpose is exempting rule (b) for an exact,
  // pre-approved slug collision (a public stub coexisting with a private
  // profile under the identical slug); it says nothing about the identity
  // of the content being written under that slug. matchesExcludedPeople
  // matches on the write's title/entityName as well as its slug (see
  // candidateKeys), precisely so a denied person cannot be published by
  // reusing an unrelated, allowlisted slug and simply naming them in the
  // title. Exempting that would turn the collision allowlist into a
  // deny-list bypass, which is not what it is for.
  test('defect 2: a collision-allowlisted slug is still refused when its TITLE matches a deny-listed name', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `no-slug-match-here` | Named Not By Slug |\n');
    const slug = 'people/arm-writepath-allowlisted-title-collision';

    const allowlistPath = join(policyDir, 'privacy-allowlist.tsv');
    const priorAllowlistPath = process.env[ALLOWLIST_PATH_ENV];
    process.env[ALLOWLIST_PATH_ENV] = allowlistPath;
    try {
      writeFileSync(allowlistPath, 'collision|' + slug + '\n');
      const page = {
        type: 'concept', title: 'Named Not By Slug', compiled_truth: 'body', timeline: '', frontmatter: {},
      } as const;
      const outcome = await engine.putPage(slug, page, { sourceId: 'default' })
        .then(() => ({ allowed: true, message: '' }))
        .catch((error: unknown) => ({ allowed: false, message: String(error) }));
      expect(outcome.allowed).toBe(false);
      expect(outcome.message).toMatch(/excluded_people_policy/);
      await expect(engine.getPage(slug, { sourceId: 'default' })).resolves.toBeNull();
    } finally {
      if (priorAllowlistPath === undefined) delete process.env[ALLOWLIST_PATH_ENV];
      else process.env[ALLOWLIST_PATH_ENV] = priorAllowlistPath;
    }
  });

  test('regression: a brand new ordinary business-contact page is ALLOWED', async () => {
    // This is exactly the shape com.lgv.capture-contact creates every night
    // (bryan-y/_author, mirko/_author, ...): a person-shaped write to
    // `default` for a slug that is new to `default`, not on the deny list,
    // and not live in lg-private. The pre-fix guard refused every one of
    // these; that was the defect.
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    const slug = 'wiki/some-new-contact/_author';
    const page = {
      type: 'note',
      title: 'Some New Contact',
      compiled_truth: 'Ordinary business contact, never seen before.',
      timeline: '',
      frontmatter: {},
    } as const;

    await expect(engine.getPage(slug, { sourceId: 'default' })).resolves.toBeNull();
    const written = await engine.putPage(slug, page, { sourceId: 'default' });
    expect(written.slug).toBe(slug);
    const roundTrip = await engine.getPage(slug, { sourceId: 'default' });
    expect(roundTrip?.compiled_truth).toBe(page.compiled_truth);
  });

  test('a page soft-deleted in lg-private does not count as existing there', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    const page = {
      type: 'concept',
      title: 'Formerly Private Person',
      compiled_truth: 'Was private, now purged.',
      timeline: '',
      frontmatter: {},
    } as const;

    await engine.putPage('formerly-private-person', page, { sourceId: 'lg-private' });
    await engine.softDeletePage('formerly-private-person', { sourceId: 'lg-private' });
    await expect(engine.getPage('formerly-private-person', { sourceId: 'lg-private' })).resolves.toBeNull();

    // Not live in lg-private (it is soft-deleted, i.e. not "existing"), not
    // on the deny list: the write to default must be allowed, not routed.
    const written = await engine.putPage('people/formerly-private-person', {
      ...page,
      compiled_truth: 'Now a shared business page.',
    }, { sourceId: 'default' });
    expect(written.slug).toBe('people/formerly-private-person');
  });

  test('a target row deleted concurrently with the write is NOT resurrected', async () => {
    // This proves the tombstone-race fix, not merely the guard: seed a live
    // row in `default`, then force its deleted_at to a timestamp AFTER the
    // write we are about to issue will have captured writeStartedAt. That
    // simulates a purge that lands in the gap between this call's checks and
    // its INSERT ... ON CONFLICT. The ON CONFLICT WHERE must see deleted_at
    // >= writeStartedAt and refuse to clear it back to NULL.
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    const slug = 'concurrently-purged-page';
    const page = {
      type: 'concept',
      title: 'Concurrently Purged Page',
      compiled_truth: 'Original body.',
      timeline: '',
      frontmatter: {},
    } as const;

    await engine.putPage(slug, page, { sourceId: 'default' });
    // Force the tombstone into the future relative to any writeStartedAt the
    // next putPage call captures, standing in for "the purge committed after
    // this call's checks ran".
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() + interval '1 hour' WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );

    await expect(engine.putPage(slug, {
      ...page,
      compiled_truth: 'Attempted resurrection via routine sync write.',
    }, { sourceId: 'default' })).rejects.toThrow(/deleted concurrently|produced no row/);

    const raw = await engine.executeRaw<{ deleted_at: string | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(raw[0]?.deleted_at).not.toBeNull();
    expect(raw[0]?.compiled_truth).toBe('Original body.');
    console.log(`Tombstone race: purged row stayed deleted, compiled_truth unchanged: ${JSON.stringify(raw[0])}`);
  });

  test('put_page routes a person prefix to an existing bare private slug', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('bare-existing-person', {
      type: 'concept',
      title: 'Bare Existing Person',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(putPage.handler(putContext(), {
      slug: 'person/bare-existing-person',
      content: '---\ntype: concept\ntitle: Bare Existing Person\n---\n\nRouted update.\n',
    })).resolves.toBeDefined();
    await expect(engine.getPage('bare-existing-person', { sourceId: 'lg-private' })).resolves.toBeDefined();
    await expect(engine.getPage('person/bare-existing-person', { sourceId: 'default' })).resolves.toBeNull();
  });

  test('catches a bare private copy behind the contacts prefix', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('contact-person', {
      type: 'concept',
      title: 'Contact Person',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('contacts/contact-person', {
      type: 'concept',
      title: 'Contact Person',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus|NOT ARMED/i);
  });

  test('catches a bare private copy behind the harvest prefix', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('harvest-person', {
      type: 'concept',
      title: 'Harvest Person',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('harvest/harvest-person', {
      type: 'concept',
      title: 'Harvest Person',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus|NOT ARMED/i);
  });

  test('rechecks the private source row after a successful arm', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `arm-writepath-after-delete` | After Delete |\n');
    await executePutPage('people/arm-writepath-after-delete');

    await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
    await expect(executePutPage('people/arm-writepath-after-delete')).rejects.toThrow(/NOT ARMED/);
  });

  test('arms and routes from database-held policy without local policy files', async () => {
    await pointDatabasePrivateSource();
    const route = await resolvePrivateWriteSource(engine, {
      requestedSourceId: 'default',
      slug: 'people/peer-person',
      entityName: 'Peer Person',
      entityType: 'person',
    });
    expect(route.sourceId).toBe('lg-private');
    expect((await assertPrivateRoutingArmed(engine)).localPath).toBe('database:lg-private');

    await expect(putPage.handler(putContext(), {
      slug: 'people/peer-person',
      content: PERSON_CONTENT,
    })).rejects.toThrow(/storage_error|repo_not_found|preflight/i);
    await expect(engine.getPage('people/peer-person', { sourceId: 'lg-private' })).resolves.toBeNull();
  });
});
