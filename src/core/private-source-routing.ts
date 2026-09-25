import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gbrainPath } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { loadAllSources, parseSourceConfig, type SourceRow } from './sources-load.ts';
import { isPersonSlug } from './slug-namespace.ts';
import { warnOncePerProcess } from './utils.ts';

export interface PrivateWriteRouteInput {
  requestedSourceId?: string;
  slug: string;
  content?: string;
  entityName?: string;
  entityType?: string;
}

export interface PrivateWriteRoute {
  sourceId: string;
  routed: boolean;
  reason?: 'existing_private_page' | 'excluded_people_policy';
  privateSourceId?: string;
}

interface ExcludedPerson { slugPattern: string; name: string; }

const DEFAULT_SOURCE_ID = 'default';
const EXCLUDED_PEOPLE_FILE = '_excluded-people.md';
const FILING_RULES_FILE = '_brain-filing-rules.md';
const PRIVATE_ROUTING_CONFIG_KEY = 'private_routing';
const EXCLUDED_PEOPLE_CONFIG_KEY = 'excluded_people_markdown';
const FILING_RULES_CONFIG_KEY = 'filing_rules_markdown';
const COLLISION_ALLOWLIST_PATH_ENV = 'GBRAIN_PRIVACY_ALLOWLIST_PATH';

/**
 * T-LEAK-7 collision allowlist: exact slugs that may legitimately be live in
 * BOTH the private source and `default` at once (a public stub plus a
 * private profile of the same identity). Exempts ONLY rule (b), the
 * existing-live-page-in-private-source check in `resolvePrivateWriteSource`.
 * It never touches rule (a), the Family deny-list match in
 * `matchesExcludedPeople`: `resolvePrivateWriteSource` evaluates rule (a)
 * BEFORE rule (b) for personish writes, so a deny-listed person who matches
 * rule (a) always gets reason: 'excluded_people_policy', a reason this
 * allowlist's callers never exempt, and stays refused even if a
 * `collision|` row names them. The two rules are independent gates and this
 * file only ever widens the narrower of the two.
 *
 * Format: one `collision|<exact slug>` row per line. Lines starting with `#`
 * (after trimming leading whitespace) are comments. No globs, no patterns,
 * the slug is matched verbatim against the write's own requested slug.
 * Padding on the row, a space after the pipe, CRLF line endings, and a
 * leading UTF-8 BOM on the file's first row are all tolerated (trimmed away
 * before matching). This is deliberately MORE permissive than the deploy
 * gate's `grep -qxF` exact-line check on the same file: that asymmetry is
 * safe-direction only (a row this parser exempts but the gate's exact-line
 * grep does not recognize makes the gate conservative -- it flags a
 * collision as unexpected and fails loudly, never the reverse), but the two
 * readers disagreeing is worth knowing if the gate and this code ever seem
 * to disagree about a slug. See
 * test/private-source-routing-allowlist-parser.test.ts for the exact matrix.
 *
 * Path is overridable via GBRAIN_PRIVACY_ALLOWLIST_PATH (tests use this),
 * defaulting to `${configDir()}/privacy-allowlist.tsv` (honors GBRAIN_HOME).
 * A missing file means zero exemptions, not a failure: fail-closed belongs
 * to the deny-list (a missing
 * DENY-list should refuse writes); a missing ALLOWlist should not, because
 * failing closed on an allowlist would refuse writes an allowlist exists to
 * permit, the opposite of its purpose.
 */
function collisionAllowlistPath(): string {
  const override = process.env[COLLISION_ALLOWLIST_PATH_ENV]?.trim();
  if (override) return override;
  // Defect 3 fix: must honor GBRAIN_HOME (via configDir()/gbrainPath()),
  // like every other gbrain-home-relative path, so a unit test run with
  // GBRAIN_HOME pointed at a temp dir never resolves to the operator's real
  // ~/.gbrain/privacy-allowlist.tsv. bunfig.toml preloads
  // test/helpers/gbrain-home-preload.ts precisely so tests never see the
  // real file; this function must respect that.
  return gbrainPath('privacy-allowlist.tsv');
}

function loadCollisionAllowlist(): Set<string> {
  const path = collisionAllowlistPath();
  const slugs = new Set<string>();
  if (!existsSync(path)) return slugs;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return slugs;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^collision\|(.+)$/);
    if (match?.[1]) {
      const slug = match[1].trim();
      if (slug) slugs.add(slug);
    }
  }
  return slugs;
}

/**
 * Rule (b) in resolvePrivateWriteSource consults this exact-slug allowlist
 * after the private page lookup. It is never used for rule (a), the family
 * deny-list, or by a caller after resolution.
 */
export function isAllowlistedCollision(requestedSourceId: string, slug: string): boolean {
  if (requestedSourceId !== DEFAULT_SOURCE_ID) return false;
  return loadCollisionAllowlist().has(slug);
}

interface PrivatePolicyDocuments {
  excludedPeople: string;
  filingRules: string;
}

function normalizeSlugish(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['"]/g, '').replace(/[^a-z0-9/*]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeName(value: string): string { return normalizeSlugish(value).replace(/\*/g, ''); }
function stripAuthorSuffix(slug: string): string { return slug.replace(/\/_author$/, ''); }

function candidateKeys(input: PrivateWriteRouteInput): Set<string> {
  const keys = new Set<string>();
  const add = (value?: string) => { if (value) { const n = normalizeSlugish(value); if (n) keys.add(n); } };
  const addPathCandidates = (value: string) => {
    let rest = value;
    while (rest) {
      add(rest);
      // D1 policy fix: pages stored under a `wiki/` prefix and pages stored
      // bare are the same identity (see _excluded-people.md's note on
      // william-vandenberg existing in both forms). Every de-prefixed
      // candidate along this walk also gets a wiki/-prefixed sibling, so a
      // deny-list match or an existing-private-page lookup catches whichever
      // form the other side used, in either direction.
      if (rest.startsWith('wiki/')) add(rest.slice('wiki/'.length));
      else add(`wiki/${rest}`);
      const slash = rest.indexOf('/');
      if (slash < 0) break;
      rest = rest.slice(slash + 1);
    }
  };
  const slug = input.slug;
  addPathCandidates(slug);
  addPathCandidates(stripAuthorSuffix(slug));
  // The page row is authoritative for routing.  A slug-only caller can be
  // misleading (for example, a concept-shaped row under a person slug), so
  // include the loaded/about-to-be-written type and title as independent
  // deny-list keys.  This is deliberately before content parsing: parsed
  // frontmatter is not a substitute for the stored row identity.
  add(input.entityType);
  add(input.entityName);
  if (input.content) {
    const title = input.content.match(/^title:\s*(.+)$/m)?.[1]
      ?? input.content.match(/^full_name:\s*(.+)$/m)?.[1]
      ?? input.content.match(/^#\s+(.+)$/m)?.[1];
    add(title?.replace(/^["']|["']$/g, '').trim());
  }
  return keys;
}

function isPersonishWrite(input: PrivateWriteRouteInput): boolean {
  return input.entityType === 'person' || input.slug.endsWith('/_author')
    || isPersonSlug(input.slug)
    || input.slug.startsWith('contacts/') || input.slug.startsWith('harvest/')
    || /^type:\s*person\s*$/mi.test(input.content ?? '');
}

function globMatches(pattern: string, keys: Set<string>): boolean {
  const normalized = normalizeSlugish(pattern);
  if (!normalized) return false;
  const escape = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // A policy entry without `*` is a prefix by default. This makes a newly
  // named page safe without requiring every policy author to remember a
  // trailing wildcard. Entries with `*` retain their existing anchored glob
  // semantics.
  if (!normalized.includes('*')) return [...keys].some((key) => key.startsWith(normalized));
  const re = new RegExp(`^${normalized.split('*').map(escape).join('.*')}$`);
  return [...keys].some((key) => re.test(key));
}

export function parseExcludedPeople(doc: string): ExcludedPerson[] {
  const start = doc.search(/^##\s+Family deny-list\b/im);
  if (start < 0) return [];
  const rest = doc.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  const section = next >= 0 ? rest.slice(0, next + 1) : rest;
  const rows: ExcludedPerson[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
    if (match?.[1] && match[2] && !/^name$/i.test(match[2].trim())) {
      rows.push({ slugPattern: match[1].trim(), name: match[2].replace(/\([^)]*\)/g, '').trim() });
    }
  }
  return rows;
}

async function getConfiguredPrivateSourceId(engine: BrainEngine): Promise<string | null> {
  if (process.env.GBRAIN_PRIVATE_SOURCE_ID) return process.env.GBRAIN_PRIVATE_SOURCE_ID;
  for (const key of ['privacy.private_source_id', 'routing.private_source_id']) {
    try { const value = await engine.getConfig(key); if (value?.trim()) return value.trim(); } catch { /* legacy/test engine */ }
  }
  return null;
}

function databasePolicyDocuments(source: SourceRow): PrivatePolicyDocuments | null {
  const config = parseSourceConfig(source.config);
  const routing = config[PRIVATE_ROUTING_CONFIG_KEY];
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return null;
  const policy = routing as Record<string, unknown>;
  const excludedPeople = policy[EXCLUDED_PEOPLE_CONFIG_KEY];
  const filingRules = policy[FILING_RULES_CONFIG_KEY];
  if (typeof excludedPeople !== 'string' || typeof filingRules !== 'string') return null;
  return { excludedPeople, filingRules };
}

function sourceHasPolicy(source: SourceRow): boolean {
  if (databasePolicyDocuments(source)) return true;
  if (!source.local_path) return false;
  return existsSync(join(source.local_path, EXCLUDED_PEOPLE_FILE))
    && existsSync(join(source.local_path, FILING_RULES_FILE));
}

function readPolicyDocuments(source: SourceRow): PrivatePolicyDocuments | null {
  const stored = databasePolicyDocuments(source);
  if (stored) return stored;
  if (!source.local_path) return null;
  return {
    excludedPeople: readFileSync(join(source.local_path, EXCLUDED_PEOPLE_FILE), 'utf8'),
    filingRules: readFileSync(join(source.local_path, FILING_RULES_FILE), 'utf8'),
  };
}

function diskPolicyDocuments(source: SourceRow): PrivatePolicyDocuments | null {
  if (!source.local_path) return null;
  const excludedPath = join(source.local_path, EXCLUDED_PEOPLE_FILE);
  const filingPath = join(source.local_path, FILING_RULES_FILE);
  if (!existsSync(excludedPath) || !existsSync(filingPath)) return null;
  try {
    return {
      excludedPeople: readFileSync(excludedPath, 'utf8'),
      filingRules: readFileSync(filingPath, 'utf8'),
    };
  } catch {
    return null;
  }
}

function policyContentMismatch(source: SourceRow): boolean {
  const stored = databasePolicyDocuments(source);
  const onDisk = diskPolicyDocuments(source);
  return !!stored && !!onDisk
    && (stored.excludedPeople !== onDisk.excludedPeople || stored.filingRules !== onDisk.filingRules);
}

async function findPrivateSource(engine: BrainEngine): Promise<SourceRow | null> {
  let sources: SourceRow[];
  try { sources = await loadAllSources(engine); } catch { return null; }
  const configured = await getConfiguredPrivateSourceId(engine);
  const preferred = [
    ...(configured ? sources.filter((source) => source.id === configured) : []),
    ...sources.filter((source) => source.id === 'lg-private'),
    ...sources,
  ];
  return preferred.find(sourceHasPolicy) ?? null;
}

function matchesExcludedPeople(source: SourceRow, input: PrivateWriteRouteInput): boolean {
  let entries: ExcludedPerson[];
  try {
    const documents = readPolicyDocuments(source);
    if (!documents) return false;
    entries = parseExcludedPeople(documents.excludedPeople);
  } catch { return false; }
  const keys = candidateKeys(input);
  return entries.some((entry) => globMatches(entry.slugPattern, keys) || keys.has(normalizeName(entry.name)));
}

export async function resolvePrivateWriteSource(
  engine: BrainEngine,
  input: PrivateWriteRouteInput,
): Promise<PrivateWriteRoute> {
  const requested = input.requestedSourceId || DEFAULT_SOURCE_ID;
  const privateSource = await findPrivateSource(engine);
  if (!privateSource) return { sourceId: requested, routed: false };
  if (requested === privateSource.id) return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
  if (policyContentMismatch(privateSource)) {
    warnOncePerProcess(
      `private-routing.policy_mismatch.${privateSource.id}`,
      `[private-routing] policy content mismatch for private source '${privateSource.id}'; ` +
      'refusing to route this write until the database-held and on-disk policy documents match.',
    );
    return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
  }
  // Rule (a), the Family deny-list match, is evaluated before rule (b), the
  // existing-private-page lookup. An allowlist row can therefore only exempt
  // rule (b), never a deny-list refusal.
  if (matchesExcludedPeople(privateSource, input)) {
    return { sourceId: privateSource.id, routed: true, reason: 'excluded_people_policy', privateSourceId: privateSource.id };
  }
  const collisionExempt = isAllowlistedCollision(requested, input.slug);
  try {
    for (const key of candidateKeys(input)) {
      if (await engine.getPage(key, { sourceId: privateSource.id })) {
        if (collisionExempt) {
          // Keep routed=true so remote fences still reject this write. The
          // exemption changes the resolved target, not the policy match:
          // consumers write the requested source and skip mirror tombstoning
          // because sourceId equals requested.
          return {
            sourceId: requested,
            routed: true,
            reason: 'existing_private_page',
            privateSourceId: privateSource.id,
          };
        }
        return { sourceId: privateSource.id, routed: true, reason: 'existing_private_page', privateSourceId: privateSource.id };
      }
    }
  } catch { /* policy-file matching remains authoritative */ }
  return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
}

/**
 * Return whether a live page with this exact slug exists in one source.
 * The default getPage contract excludes soft-deleted rows, so a tombstone
 * does not count as existing and cannot re-admit a purged leak.
 */
export async function hasLivePageInSource(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<boolean> {
  try {
    return (await engine.getPage(slug, { sourceId })) !== null;
  } catch {
    return false;
  }
}

/**
 * Write pre-flight: assert that private-write routing is ARMED.
 *
 * Why this exists. `resolvePrivateWriteSource` degrades to "no routing" in
 * three places, all silent: no private source resolves, `_excluded-people.md`
 * cannot be read, or the `## Family deny-list` heading is missing or renamed.
 * In every case the write proceeds to the requested source, which defaults to
 * `default`, which is the one source configured `federated: true` with
 * `facts_visibility: world`.
 *
 * That is fail-OPEN on a privacy control, and the routing decision is taken at
 * IMPORT time. A corpus rebuild with the policy files absent would route every
 * family and person page to the federated, world-visible source, raise no
 * error, and leave nothing in the logs to find afterwards.
 *
 * So every person-shaped write must assert rather than assume. This throws; it
 * does not warn. The result is cached per engine while the policy source
 * metadata is unchanged, so a bulk import does not parse the policy per page.
 */
export interface PrivateRoutingArmedReport {
  privateSourceId: string;
  localPath: string;
  excludedEntryCount: number;
}

interface CachedArmedRouting {
  report: PrivateRoutingArmedReport;
  policyFingerprint: string;
}

const armedRoutingCache = new WeakMap<object, CachedArmedRouting>();

export async function isPersonishPageWrite(
  engine: BrainEngine,
  slug: string,
  page: { type?: string; title?: string },
): Promise<boolean> {
  if (page.type === 'person' || slug.endsWith('/_author') || isPersonSlug(slug)
    || slug.startsWith('contacts/') || slug.startsWith('harvest/')) return true;
  const source = await findPrivateSource(engine);
  if (!source) return false;
  try {
    const input = { slug, entityType: page.type, entityName: page.title, content: undefined };
    // A loaded title/type can be the only signal for a deny-list entry when a
    // legacy or user-renamed slug is not person-shaped.
    if (matchesExcludedPeople(source, input)) return true;
    for (const key of candidateKeys(input)) {
      if (await engine.getPage(key, { sourceId: source.id })) return true;
    }
  } catch { /* existing-page detection is best effort */ }
  return false;
}

function cacheOwner(engine: BrainEngine): object {
  let owner = engine as unknown as object;
  while (true) {
    const prototype = Object.getPrototypeOf(owner);
    if (!prototype || typeof prototype !== 'object' || !('kind' in prototype)) return owner;
    owner = prototype;
  }
}

async function worldFederatedSourceIds(engine: BrainEngine): Promise<Set<string>> {
  let sources: SourceRow[];
  try {
    sources = await loadAllSources(engine);
  } catch {
    return new Set(['default']);
  }
  const ids = new Set(
    sources
      .filter((source) => {
        const config = parseSourceConfig(source.config);
        return config.federated === true && config.facts_visibility === 'world';
      })
      .map((source) => source.id),
  );
  return ids;
}

export async function shouldAssertPrivateRouting(
  engine: BrainEngine,
  sourceId: string,
): Promise<boolean> {
  return (await worldFederatedSourceIds(engine)).has(sourceId);
}

function policyFingerprint(source: SourceRow): string | null {
  const stored = databasePolicyDocuments(source);
  if (stored) {
    return `db:${source.id}:${source.local_path ?? ''}:${stored.excludedPeople}:${stored.filingRules}`;
  }
  if (!source.local_path) return null;
  try {
    return [`source:${source.id}`, `path:${source.local_path}`, EXCLUDED_PEOPLE_FILE, FILING_RULES_FILE].map((part) => {
      if (part !== EXCLUDED_PEOPLE_FILE && part !== FILING_RULES_FILE) return part;
      const stat = statSync(join(source.local_path!, part));
      return `${part}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }).join('|');
  } catch {
    return null;
  }
}

export async function assertPrivateRoutingArmed(
  engine: BrainEngine,
): Promise<PrivateRoutingArmedReport> {
  const owner = cacheOwner(engine);
  const cached = armedRoutingCache.get(owner);
  const source = await findPrivateSource(engine);
  if (source && policyContentMismatch(source)) {
    warnOncePerProcess(
      `private-routing.unarmed-mismatch.${source.id}`,
      `[private-routing] could not use ${EXCLUDED_PEOPLE_FILE} for source '${source.id}': database-held and on-disk policy content differs.`,
    );
    throw new Error(
      `private-write routing is NOT ARMED: ${source.id} has database-held policy content ` +
      `that mismatches the on-disk ${EXCLUDED_PEOPLE_FILE} or ${FILING_RULES_FILE}; refusing to arm. ` +
      'Update the database-held policy with the provisioning command or make both copies identical.',
    );
  }
  if (cached && source && source.id === cached.report.privateSourceId
    && policyFingerprint(source) === cached.policyFingerprint) {
    return cached.report;
  }

  if (!source) {
    warnOncePerProcess(
      'private-routing.unarmed-no-source',
      `[private-routing] could not resolve ${EXCLUDED_PEOPLE_FILE} and ${FILING_RULES_FILE}; no private source carries both files.`,
    );
    throw new Error(
      'private-write routing is NOT ARMED: no source has both ' +
      `${EXCLUDED_PEOPLE_FILE} and ${FILING_RULES_FILE} present under its local_path. ` +
      'Person-shaped writes would route to the default source, which is federated and world-visible. ' +
      'Refusing to import. Fix the private source local_path or restore the policy files.',
    );
  }

  let raw: string;
  const stored = databasePolicyDocuments(source);
  if (stored) {
    raw = stored.excludedPeople;
  } else {
    if (!source.local_path) {
      warnOncePerProcess(
        `private-routing.unarmed-no-path.${source.id}`,
        `[private-routing] could not parse ${EXCLUDED_PEOPLE_FILE}: private source '${source.id}' has no local_path or database-held policy.`,
      );
      throw new Error(
        'private-write routing is NOT ARMED: the private source has no local_path ' +
          'and no database-held policy documents. Refusing to import.',
      );
    }
    try {
      raw = readFileSync(join(source.local_path, EXCLUDED_PEOPLE_FILE), 'utf8');
    } catch (err) {
      warnOncePerProcess(
        `private-routing.unarmed-read.${source.id}.${source.local_path}`,
        `[private-routing] could not parse/read ${join(source.local_path, EXCLUDED_PEOPLE_FILE)}: ${(err as Error).message}.`,
      );
      throw new Error(
        `private-write routing is NOT ARMED: ${EXCLUDED_PEOPLE_FILE} under ` +
        `'${source.local_path}' could not be read (${(err as Error).message}). Refusing to import.`,
      );
    }
  }

  const entries = parseExcludedPeople(raw);
  if (entries.length === 0) {
    const policyLocation = source.local_path ?? `database:${source.id}`;
    warnOncePerProcess(
      `private-routing.unarmed-empty.${source.id}.${policyLocation}`,
      `[private-routing] could not parse ${policyLocation}/${EXCLUDED_PEOPLE_FILE}: zero deny-list entries.`,
    );
    throw new Error(
      `private-write routing is NOT ARMED: ${EXCLUDED_PEOPLE_FILE} under ` +
      `'${policyLocation}' parsed to ZERO deny-list entries. The parser keys on a ` +
      "'## Family deny-list' heading followed by a markdown table; a renamed heading " +
      'or reformatted table yields an empty list and silently disables routing. Refusing to import.',
    );
  }

  const report = {
    privateSourceId: source.id,
    localPath: source.local_path ?? `database:${source.id}`,
    excludedEntryCount: entries.length,
  };
  const fingerprint = policyFingerprint(source);
  if (fingerprint) armedRoutingCache.set(owner, { report, policyFingerprint: fingerprint });
  return report;
}

export interface PrivatePageWriteTarget {
  requestedSourceId: string;
  slug: string;
  /** Type/title from the loaded row, or from the row about to be inserted. */
  entityType?: string;
  entityName?: string;
}

/**
 * The single page-write policy chokepoint used by both engines and by direct
 * page JSONB writers.  It intentionally loads the existing row when the
 * caller does not provide identity fields; callers must not derive routing
 * solely from newly parsed frontmatter.
 */
export async function enforcePrivatePageWrite(
  engine: BrainEngine,
  target: PrivatePageWriteTarget,
): Promise<PrivateWriteRoute> {
  if (!(await shouldAssertPrivateRouting(engine, target.requestedSourceId))) {
    return { sourceId: target.requestedSourceId, routed: false };
  }

  let entityType = target.entityType;
  let entityName = target.entityName;
  if (entityType === undefined || entityName === undefined) {
    const loaded = await engine.getPage(target.slug, {
      sourceId: target.requestedSourceId,
      includeDeleted: true,
    });
    if (loaded) {
      entityType ??= loaded.type;
      entityName ??= loaded.title;
    }
  }

  // The armed assertion is a source-wide invariant. It must run before the
  // identity-shape heuristic because a renamed heading or a family/title-only
  // deny-list match must not fail open as "not person-shaped".
  await assertPrivateRoutingArmed(engine);
  const personish = await isPersonishPageWrite(engine, target.slug, {
    type: entityType,
    title: entityName,
  });
  if (!personish) return { sourceId: target.requestedSourceId, routed: false };

  const route = await resolvePrivateWriteSource(engine, {
    requestedSourceId: target.requestedSourceId,
    slug: target.slug,
    entityType,
    entityName,
  });
  if (route.routed && route.sourceId !== target.requestedSourceId) {
    throw new Error(
      `private-write routing is ARMED but a page write received a person-shaped write for ` +
      `world-federated source '${target.requestedSourceId}' that the privacy policy routes to ` +
      `private source '${route.sourceId}' (${route.reason}). Slug '${target.slug}'. ` +
      'Route it through the private source or refuse the write.',
    );
  }
  return route;
}

/**
 * Fact-write companion to enforcePrivatePageWrite.  Facts carry no type or
 * title, so resolve the owning page from the loaded database row using the
 * fence slug first and the entity slug as the legacy fallback.  A fact that
 * would route away from default is refused at this low-level seam; callers
 * that can route must do so before invoking the engine.
 */
export async function enforcePrivateFactWrite(
  engine: BrainEngine,
  target: {
    sourceId: string;
    pageSlug?: string | null;
    entitySlug?: string | null;
    visibility?: string | null;
  },
): Promise<void> {
  if (!(await shouldAssertPrivateRouting(engine, target.sourceId))) return;
  const slug = target.pageSlug?.trim() || target.entitySlug?.trim();
  if (!slug) return;
  const page = await engine.getPage(slug, {
    sourceId: target.sourceId,
    includeDeleted: true,
  });
  const route = await enforcePrivatePageWrite(engine, {
    requestedSourceId: target.sourceId,
    slug,
    entityType: page?.type,
    entityName: page?.title,
  });
  if (route.routed && route.sourceId !== target.sourceId && target.sourceId === DEFAULT_SOURCE_ID) {
    throw new Error(
      `private-write routing refused fact write for '${slug}' in world-federated source ` +
      `'${target.sourceId}'; route the fact to '${route.sourceId}'.`,
    );
  }
  // Explicitly retain the world-on-default denial. The allowlist never
  // exempts rule (a), and never permits a world fact to remain in default.
  if (target.visibility === 'world' && target.sourceId === DEFAULT_SOURCE_ID && route.routed && route.sourceId !== target.sourceId) {
    throw new Error(`world-visible fact denied for private-routed page '${slug}'`);
  }
}

export const __privateSourceRoutingTest = {
  parseExcludedPeople, normalizeSlugish, candidateKeys, findPrivateSource,
  isAllowlistedCollision, collisionAllowlistPath, matchesExcludedPeople,
};
