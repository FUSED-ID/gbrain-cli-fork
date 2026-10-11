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
import { parseSourceConfig } from './sources-load.ts';

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

export interface PrivateWriteRoute {
  sourceId: string;
  routed: boolean;
  reason?: 'existing_private_page' | 'excluded_people_policy' | 'unresolved_identity_policy';
  privateSourceId?: string;
}

interface PolicyEntry { slugPattern: string; name: string }
interface PolicyDocuments { excludedPeople: string; filingRules: string }

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
    || join(process.env.GBRAIN_HOME?.trim() || join(process.env.HOME || '', '.gbrain'), 'privacy-allowlist.tsv');
}

function isAllowlistedCollision(requestedSourceId: string, slug: string): boolean {
  if (requestedSourceId !== DEFAULT_SOURCE_ID) return false;
  try {
    if (!existsSync(collisionAllowlistPath())) return false;
    return readFileSync(collisionAllowlistPath(), 'utf8').split(/\r?\n/).some(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('collision|') && trimmed.slice('collision|'.length).trim() === slug;
    });
  } catch { return false; }
}

function policyFromSource(source: { config: unknown; local_path: string | null }): PolicyDocuments | null {
  const config = parseSourceConfig(source.config);
  const value = config[POLICY_KEY];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (typeof row.excluded_people_markdown === 'string' && typeof row.filing_rules_markdown === 'string') {
      return { excludedPeople: row.excluded_people_markdown, filingRules: row.filing_rules_markdown };
    }
  }
  if (!source.local_path) return null;
  const excluded = join(source.local_path, EXCLUDED_FILE);
  const filing = join(source.local_path, FILING_FILE);
  if (!existsSync(excluded) || !existsSync(filing)) return null;
  try { return { excludedPeople: readFileSync(excluded, 'utf8'), filingRules: readFileSync(filing, 'utf8') }; } catch { return null; }
}

async function configuredPrivateSource(engine: BrainEngine): Promise<string | null> {
  if (process.env.GBRAIN_PRIVATE_SOURCE_ID?.trim()) return process.env.GBRAIN_PRIVATE_SOURCE_ID.trim();
  for (const key of ['privacy.private_source_id', 'routing.private_source_id']) {
    try { const value = await engine.getConfig(key); if (value?.trim()) return value.trim(); } catch { /* legacy engine */ }
  }
  return null;
}

async function findPrivateSource(engine: BrainEngine): Promise<{ id: string; config: unknown; local_path: string | null } | null> {
  const sources = await engine.listAllSources({ includeArchived: true });
  const configured = await configuredPrivateSource(engine);
  const ordered = [
    ...(configured ? sources.filter(s => s.id === configured) : []),
    ...sources.filter(s => s.id === PRIVATE_SOURCE_ID),
    ...sources,
  ];
  return ordered.find(source => policyFromSource(source)) ?? null;
}

function isWorldFederated(source: { config: unknown }): boolean {
  const config = parseSourceConfig(source.config);
  return config.federated === true && config.facts_visibility === 'world';
}

export async function shouldAssertPrivateRouting(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const source = (await engine.listAllSources({ includeArchived: true })).find(s => s.id === sourceId);
  return !!source && isWorldFederated(source);
}

export async function assertPrivateRoutingArmed(engine: BrainEngine): Promise<{ privateSourceId: string; excludedEntryCount: number }> {
  const source = await findPrivateSource(engine);
  const policy = source && policyFromSource(source);
  const excluded = policy ? parseExcludedPeople(policy.excludedPeople) : [];
  if (!source || !policy || excluded.length === 0) {
    throw new Error(`private-write routing is NOT ARMED: ${PRIVATE_SOURCE_ID} must carry ${EXCLUDED_FILE} with a non-empty Family deny-list and ${FILING_FILE}.`);
  }
  return { privateSourceId: source.id, excludedEntryCount: excluded.length };
}

export async function resolvePrivateWriteSource(engine: BrainEngine, input: PrivateWriteRouteInput): Promise<PrivateWriteRoute> {
  const requested = input.requestedSourceId || DEFAULT_SOURCE_ID;
  const source = await findPrivateSource(engine);
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

export async function enforcePrivatePageWrite(
  engine: BrainEngine,
  target: { requestedSourceId: string; slug: string; entityType?: string; entityName?: string; content?: string },
): Promise<PrivateWriteRoute> {
  if (!(await shouldAssertPrivateRouting(engine, target.requestedSourceId))) return { sourceId: target.requestedSourceId, routed: false };
  await assertPrivateRoutingArmed(engine);
  const personish = target.entityType === 'person' || target.slug.endsWith('/_author')
    || /^(people|person|contacts|harvest)\//.test(target.slug)
    || /^type:\s*person\s*$/mi.test(target.content ?? '');
  const route = await resolvePrivateWriteSource(engine, target);
  if (!personish && !route.routed) return route;
  if (route.routed && route.sourceId !== target.requestedSourceId) {
    throw new Error(`private-write routing is ARMED but a page write for '${target.slug}' must land in private source '${route.sourceId}' (${route.reason}).`);
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

export const __privateSourceRoutingTest = { candidates, policyFromSource, findPrivateSource, matchesEntries, isAllowlistedCollision };
