/**
 * Private-source routing policy for the world-federated write boundary.
 *
 * Upstream already owns source identity, grants, visibility reads, and the
 * page SQL writer. This module only resolves the fork's two policy documents
 * and gives those upstream seams one fail-closed decision.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { gbrainPath } from './config.ts';
import { parseSourceConfig } from './sources-load.ts';
import { isPersonSlug } from './slug-namespace.ts';
import { digest, sha256 } from './persistence/digest.ts';

const DEFAULT_SOURCE_ID = 'default';
const PRIVATE_SOURCE_ID = 'lg-private';
const POLICY_KEY = 'private_routing';
const EXCLUDED_FILE = '_excluded-people.md';
const FILING_FILE = '_brain-filing-rules.md';
const ALLOWLIST_ENV = 'GBRAIN_PRIVACY_ALLOWLIST_PATH';

export interface PrivateWriteRouteInput {
  requestedSourceId?: string;
  slug: string;
  content?: string;
  entityName?: string;
  entityType?: string;
}

export interface PrivateSourceRow { id: string; config: unknown; local_path: string | null }
export interface PrivateSourceSnapshot { sources: PrivateSourceRow[]; stamp: string }

export interface PrivateWriteRoute {
  sourceId: string;
  routed: boolean;
  reason?: 'existing_private_page' | 'excluded_people_policy' | 'unresolved_identity_policy';
  privateSourceId?: string;
}

interface PolicyEntry { slugPattern: string; name: string }
interface PolicyDocuments { excludedPeople: string; filingRules: string }
const mismatchWarnings = new Set<string>();

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/["']/g, '').replace(/[^a-z0-9/*]+/g, '-').replace(/^-+|-+$/g, '');
}

function candidates(input: PrivateWriteRouteInput): Set<string> {
  const out = new Set<string>();
  const add = (value?: string) => { if (value) { const n = normalize(value); if (n) out.add(n); } };
  const addPath = (value: string) => {
    let rest = value;
    while (rest) {
      add(rest);
      if (rest.startsWith('wiki/')) add(rest.slice(5));
      else add(`wiki/${rest}`);
      const slash = rest.indexOf('/');
      if (slash < 0) break;
      rest = rest.slice(slash + 1);
    }
  };
  addPath(input.slug);
  addPath(input.slug.replace(/\/_author$/, ''));
  add(input.entityType);
  add(input.entityName);
  if (input.content) {
    const title = input.content.match(/^title:\s*(.+)$/m)?.[1]
      ?? input.content.match(/^full_name:\s*(.+)$/m)?.[1]
      ?? input.content.match(/^#\s+(.+)$/m)?.[1];
    add(title?.replace(/^['"]|['"]$/g, '').trim());
  }
  return out;
}

function parseSection(markdown: string, heading: string): PolicyEntry[] {
  const start = markdown.search(new RegExp(`^##\\s+${heading}\\b`, 'im'));
  if (start < 0) return [];
  const rest = markdown.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  const section = next < 0 ? rest : rest.slice(0, next + 1);
  const rows: PolicyEntry[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
    if (match?.[1] && match[2] && !/^slug$/i.test(match[1].trim())) {
      rows.push({ slugPattern: match[1].trim(), name: match[2].replace(/\([^)]*\)/g, '').trim() });
    }
  }
  return rows;
}

export function parseExcludedPeople(markdown: string): PolicyEntry[] {
  return parseSection(markdown, 'Family deny-list');
}

export function parseUnresolvedIdentity(markdown: string): PolicyEntry[] {
  return parseSection(markdown, 'Do not enrich, identity unresolved');
}

export function hasUnresolvedIdentityPolicySection(markdown: string): boolean {
  return /^##\s+Do not enrich, identity unresolved\b/im.test(markdown);
}

function matchesPattern(pattern: string, keys: Set<string>): boolean {
  const normalized = normalize(pattern);
  if (!normalized) return false;
  if (!normalized.includes('*')) return [...keys].some(key => key.startsWith(normalized));
  const escaped = normalized.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const re = new RegExp(`^${escaped}$`);
  return [...keys].some(key => re.test(key));
}

function matchesEntries(entries: PolicyEntry[], input: PrivateWriteRouteInput): boolean {
  const keys = candidates(input);
  return entries.some(entry => matchesPattern(entry.slugPattern, keys) || keys.has(normalize(entry.name)));
}

function collisionAllowlistPath(): string {
  return process.env[ALLOWLIST_ENV]?.trim()
    || gbrainPath('privacy-allowlist.tsv');
}

export function isAllowlistedCollision(requestedSourceId: string, slug: string): boolean {
  if (requestedSourceId !== DEFAULT_SOURCE_ID) return false;
  try {
    if (!existsSync(collisionAllowlistPath())) return false;
    return readFileSync(collisionAllowlistPath(), 'utf8').split(/\r?\n/).some(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('collision|') && trimmed.slice('collision|'.length).trim() !== ''
        && trimmed.slice('collision|'.length).trim() === slug;
    });
  } catch { return false; }
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

function databasePolicyFromSource(source: { config: unknown }): PolicyDocuments | null {
  const config = parseSourceConfig(source.config);
  const value = config[POLICY_KEY];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (typeof row.excluded_people_markdown === 'string' && typeof row.filing_rules_markdown === 'string') {
      return { excludedPeople: row.excluded_people_markdown, filingRules: row.filing_rules_markdown };
    }
  }
  return null;
}

function diskPolicyFromSource(source: { local_path: string | null }): PolicyDocuments | null {
  if (!source.local_path) return null;
  const excluded = join(source.local_path, EXCLUDED_FILE);
  const filing = join(source.local_path, FILING_FILE);
  if (!existsSync(excluded) || !existsSync(filing)) return null;
  try { return { excludedPeople: readFileSync(excluded, 'utf8'), filingRules: readFileSync(filing, 'utf8') }; } catch { return null; }
}

function policyFromSource(
  source: { id?: string; config: unknown; local_path: string | null },
  opts: { onMismatch?: 'warn' | 'throw' } = {},
): PolicyDocuments | null {
  const database = databasePolicyFromSource(source);
  const disk = diskPolicyFromSource(source);
  if (database && source.local_path) {
    const mismatch = !disk
      || database.excludedPeople !== disk.excludedPeople
      || database.filingRules !== disk.filingRules;
    if (mismatch) {
      const message = `[private-routing] policy content mismatch for private source '${source.id ?? PRIVATE_SOURCE_ID}'; `
        + 'database-held and on-disk policy documents differ, so private routing is disabled.';
      if (opts.onMismatch === 'throw') {
        throw new Error(`${message} Database-held and on-disk policy documents mismatches detected. Refusing to arm until both copies are identical.`);
      }
      const key = `${source.id ?? PRIVATE_SOURCE_ID}:${source.local_path}`;
      if (!mismatchWarnings.has(key)) {
        mismatchWarnings.add(key);
        console.warn(message);
      }
      return null;
    }
    return database;
  }
  return database ?? disk;
}

async function configuredPrivateSource(engine: BrainEngine): Promise<string | null> {
  if (process.env.GBRAIN_PRIVATE_SOURCE_ID?.trim()) return process.env.GBRAIN_PRIVATE_SOURCE_ID.trim();
  for (const key of ['privacy.private_source_id', 'routing.private_source_id']) {
    try { const value = await engine.getConfig(key); if (value?.trim()) return value.trim(); } catch { /* legacy engine */ }
  }
  return null;
}

async function listSources(engine: BrainEngine): Promise<PrivateSourceRow[]> {
  if (typeof engine.listAllSources === 'function') {
    const listed = await engine.listAllSources({ includeArchived: true });
    if (Array.isArray(listed)) return listed;
  }
  if (typeof engine.executeRaw !== 'function') {
    throw new Error('private-write routing refused: source list is unavailable');
  }
  const fallback = await engine.executeRaw<{ id: string; config: unknown; local_path: string | null }>(
    'SELECT id, config, local_path FROM sources ORDER BY (id = \'default\') DESC, id',
  );
  if (!Array.isArray(fallback)) throw new Error('private-write routing refused: source list could not be read');
  return fallback;
}

function orderSources(sources: PrivateSourceRow[], configured: string | null): PrivateSourceRow[] {
  return [
    ...(configured ? sources.filter(s => s.id === configured) : []),
    ...sources.filter(s => s.id === PRIVATE_SOURCE_ID),
    ...sources,
  ];
}

function sourceRoutingStampInput(source: PrivateSourceRow): Record<string, unknown> {
  const config = parseSourceConfig(source.config);
  const privateRouting = config[POLICY_KEY];
  const routing = privateRouting && typeof privateRouting === 'object' && !Array.isArray(privateRouting)
    ? privateRouting as Record<string, unknown> : null;
  const disk = diskPolicyFromSource(source);
  return {
    id: source.id,
    local_path: source.local_path,
    // databasePolicyFromSource reads exactly these two keys; unrelated source
    // config writes must not invalidate a private-routing screen.
    private_routing: {
      excluded_people_markdown: typeof routing?.excluded_people_markdown === 'string' ? routing.excluded_people_markdown : null,
      filing_rules_markdown: typeof routing?.filing_rules_markdown === 'string' ? routing.filing_rules_markdown : null,
    },
    // diskPolicyFromSource reads both files whenever local_path is present.
    disk_policy: disk ? {
      excluded_people_sha256: sha256(disk.excludedPeople),
      filing_rules_sha256: sha256(disk.filingRules),
    } : null,
  };
}

function sourceInventoryStamp(sources: PrivateSourceRow[], configured: string | null): string {
  return digest({ configured_private_source_id: configured,
    sources: [...sources].sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id))
      .map(sourceRoutingStampInput) });
}

export async function readPrivateSourceSnapshot(engine: BrainEngine): Promise<PrivateSourceSnapshot> {
  const sources = await listSources(engine);
  const configured = await configuredPrivateSource(engine);
  return { sources: orderSources(sources, configured), stamp: sourceInventoryStamp(sources, configured) };
}

async function orderedSources(engine: BrainEngine): Promise<PrivateSourceRow[]> {
  return (await readPrivateSourceSnapshot(engine)).sources;
}

async function findPrivateSource(engine: BrainEngine, snapshot?: PrivateSourceSnapshot): Promise<PrivateSourceRow | null> {
  const sources = snapshot?.sources ?? await orderedSources(engine);
  return sources.find(source => policyFromSource(source)) ?? null;
}

function isWorldFederated(source: { config: unknown }): boolean {
  const config = parseSourceConfig(source.config);
  return config.federated === true && config.facts_visibility === 'world';
}

export async function shouldAssertPrivateRouting(engine: BrainEngine, sourceId: string): Promise<boolean> {
  // The D1 seam protects the public/default publication boundary. Federated
  // secondary sources may have their own visibility floor without carrying
  // the brain's private policy documents, so they are not implicitly routed
  // through lg-private.
  if (sourceId !== DEFAULT_SOURCE_ID) return false;
  const source = (await listSources(engine)).find(s => s.id === sourceId);
  return !!source && isWorldFederated(source);
}

export async function assertPrivateRoutingArmed(engine: BrainEngine): Promise<{ privateSourceId: string; localPath: string; excludedEntryCount: number }> {
  const sources = await orderedSources(engine);
  let source: { id: string; config: unknown; local_path: string | null } | null = null;
  let policy: PolicyDocuments | null = null;
  for (const candidate of sources) {
    const candidatePolicy = policyFromSource(candidate, { onMismatch: 'throw' });
    if (candidatePolicy) {
      source = candidate;
      policy = candidatePolicy;
      break;
    }
  }
  const excluded = policy ? parseExcludedPeople(policy.excludedPeople) : [];
  if (!source || !policy || excluded.length === 0) {
    if (source && policy && excluded.length === 0) {
      throw new Error(`private-write routing is NOT ARMED: ZERO deny-list entries in ${EXCLUDED_FILE}; Refusing to import until the Family deny-list is restored.`);
    }
    throw new Error(`private-write routing is NOT ARMED: ${PRIVATE_SOURCE_ID} must carry ${EXCLUDED_FILE} with a non-empty Family deny-list and ${FILING_FILE}. Refusing to import.`);
  }
  return {
    privateSourceId: source.id,
    localPath: source.local_path ?? `database:${source.id}`,
    excludedEntryCount: excluded.length,
  };
}

export async function resolvePrivateWriteSource(engine: BrainEngine, input: PrivateWriteRouteInput, opts: { sourceSnapshot?: PrivateSourceSnapshot } = {}): Promise<PrivateWriteRoute> {
  const requested = input.requestedSourceId || DEFAULT_SOURCE_ID;
  const source = await findPrivateSource(engine, opts.sourceSnapshot);
  if (!source || requested === source.id) return { sourceId: requested, routed: false, privateSourceId: source?.id };
  const policy = policyFromSource(source);
  if (!policy) return { sourceId: requested, routed: false, privateSourceId: source.id };
  const excluded = parseExcludedPeople(policy.excludedPeople);
  const unresolved = parseUnresolvedIdentity(policy.excludedPeople);
  if (matchesEntries(excluded, input)) return { sourceId: source.id, routed: true, reason: 'excluded_people_policy', privateSourceId: source.id };
  if (matchesEntries(unresolved, input)) return { sourceId: source.id, routed: true, reason: 'unresolved_identity_policy', privateSourceId: source.id };
  for (const key of candidates(input)) {
    if (await engine.getPage(key, { sourceId: source.id })) {
      if (isAllowlistedCollision(requested, input.slug)) {
        return { sourceId: requested, routed: true, reason: 'existing_private_page', privateSourceId: source.id };
      }
      return { sourceId: source.id, routed: true, reason: 'existing_private_page', privateSourceId: source.id };
    }
  }
  return { sourceId: requested, routed: false, privateSourceId: source.id };
}

/** Recheck a screen's source inventory inside the publication transaction. */
export async function assertPrivateSourceStamp(engine: BrainEngine, expected: string): Promise<void> {
  await engine.executeRaw("SELECT set_config('lock_timeout','2s',true),set_config('statement_timeout','10s',true)");
  await engine.executeRaw('LOCK TABLE sources IN SHARE MODE');
  const sources = await listSources(engine);
  const configured = await configuredPrivateSource(engine);
  const actual = sourceInventoryStamp(sources, configured);
  if (actual !== expected) throw new Error('private source inventory changed since screen; refusing publication');
}

export async function isPersonishPageWrite(
  engine: BrainEngine,
  slug: string,
  page: { type?: string; title?: string; frontmatter?: unknown } = {},
): Promise<boolean> {
  if (page.type === 'person' || isPersonSlug(slug) || slug.endsWith('/_author')
    || /^(contacts|harvest)\//.test(slug)) return true;
  const source = await findPrivateSource(engine);
  const policy = source && policyFromSource(source);
  if (!policy) return false;
  const input = { slug, entityType: page.type, entityName: page.title };
  return matchesEntries(parseExcludedPeople(policy.excludedPeople), input)
    || matchesEntries(parseUnresolvedIdentity(policy.excludedPeople), input);
}

export async function enforcePrivatePageWrite(
  engine: BrainEngine,
  target: { requestedSourceId: string; slug: string; entityType?: string; entityName?: string; content?: string },
): Promise<PrivateWriteRoute> {
  if (!(await shouldAssertPrivateRouting(engine, target.requestedSourceId))) return { sourceId: target.requestedSourceId, routed: false };
  let entityType = target.entityType;
  let entityName = target.entityName;
  if (entityType === undefined || entityName === undefined) {
    const page = await engine.getPage(target.slug, { sourceId: target.requestedSourceId, includeDeleted: true });
    entityType ??= page?.type;
    entityName ??= page?.title;
  }
  await assertPrivateRoutingArmed(engine);
  const personish = entityType === 'person' || target.slug.endsWith('/_author')
    || /^(people|person|contacts|harvest)\//.test(target.slug)
    || /^type:\s*person\s*$/mi.test(target.content ?? '');
  const route = await resolvePrivateWriteSource(engine, { ...target, entityType, entityName });
  if (!personish && !route.routed) return route;
  if (route.routed && route.sourceId !== target.requestedSourceId) {
    throw new Error(`private-write routing is ARMED: routed page write for '${target.slug}' must land in private source '${route.sourceId}' (${route.reason}).`);
  }
  return route;
}

export async function enforcePrivateFactWrite(
  engine: BrainEngine,
  target: { sourceId: string; pageSlug?: string | null; entitySlug?: string | null; visibility?: string | null },
): Promise<void> {
  if (!(await shouldAssertPrivateRouting(engine, target.sourceId))) return;
  const slug = target.pageSlug?.trim() || target.entitySlug?.trim();
  if (!slug) return;
  const page = await engine.getPage(slug, { sourceId: target.sourceId, includeDeleted: true });
  const route = await enforcePrivatePageWrite(engine, {
    requestedSourceId: target.sourceId, slug, entityType: page?.type, entityName: page?.title,
  });
  if (route.routed && route.sourceId !== target.sourceId) {
    throw new Error(`private-write routing refused fact write for '${slug}' in source '${target.sourceId}'; route it to '${route.sourceId}'.`);
  }
  if (target.visibility === 'world' && route.routed && route.sourceId !== target.sourceId) {
    throw new Error(`world-visible fact denied for private-routed page '${slug}'.`);
  }
}

function matchesExcludedPeople(source: { config?: unknown; local_path: string | null }, input: PrivateWriteRouteInput): boolean {
  const policy = policyFromSource({ id: 'lg-private', config: source.config ?? {}, local_path: source.local_path });
  return !!policy && matchesEntries(parseExcludedPeople(policy.excludedPeople), input);
}

export const __privateSourceRoutingTest = {
  candidates, policyFromSource, findPrivateSource, matchesEntries, matchesExcludedPeople, isAllowlistedCollision,
  parseExcludedPeople, collisionAllowlistPath,
};
