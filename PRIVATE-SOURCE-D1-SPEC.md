# Private source routing and D1 guarantee spec

Baseline: fork `f6c7868a1`, audited family `private-source routing and D1 guards` (38 commits, STILL_NEEDED) plus `per-source facts visibility` (1 commit). The private source is `lg-private`. The default source is world federated only when its source config says `federated: true` and `facts_visibility: world`.

## Guarantees pinned by fork tests

1. Family deny-list matches normalized slug, path, author suffix, type, title, and content identity. Matching person, author, contact, and harvest writes route to `lg-private`; ordinary shared business contacts remain in the requested source. Pinned by `test/private-source-routing.test.ts`: `routes matching person author pages to private source`, `keeps known shared business contacts in requested source`, `never downgrades an existing private same-slug page`, and `routes an existing bare private slug after stripping leading path segments`.

2. Unresolved identities are private policy, not enrichment candidates. Missing, unreadable, renamed, empty, or mismatched policy documents fail closed before an import or write can use default. Pinned by `test/private-source-routing.test.ts`: `THROWS when no source carries the policy files`, `THROWS when the deny-list heading is renamed`, and `refuses to arm when database and on-disk policy documents differ`; also `test/private-routing-armed-writepath.test.ts`: `refuses identity-unresolved entries at page restore and fact write seams`.

3. A person page or fact must never remain in default when policy resolves it to `lg-private`. Existing private pages are collisions and are refused at the default write seam. The exact collision allowlist can permit an approved public stub, but never overrides a deny-list match or a deny-listed title. Pinned by `test/private-routing-armed-writepath.test.ts`: `refuses a person-shaped engine write to default even when ARMED`, `a slug live in lg-private is refused`, `defect 1 fix`, `defect 2`, and `regression: a brand new ordinary business-contact page is ALLOWED`.

4. D1 matching is namespace agnostic. Bare, `wiki/`, person, contact, harvest, and `/_author` forms match the same normalized identity; prefix entries match only at a key prefix, never mid-string. Pinned by `test/d1-prefix-match-regression.test.ts`: `prefix-routes bare, wiki, person, and author-normalized shapes`, `keeps every existing wildcard entry working as before`, and `does not catch ordinary-word, surname-prefix, or mid-string controls`; write behavior is pinned by `test/d1-prefix-match-writepath.test.ts`: `records the four prefix probes` and `keeps every wildcard entry refused`.

5. Private page and fact text must not cross the default or an MCP client that is not granted the private source. Fork facts remain source scoped and the visibility backstop prevents a world fact in a non-federated source. Pinned by `test/facts-visibility.test.ts`: `source private policy beats a world brain default`, `world policy is clamped on a non-federated source`, and `remote=true -> only world facts in payload`; write-path durability is pinned by `test/persistence-facts-backstop.test.ts`: `confined writers and disabled extraction never receive a queued claim`.

## v0.60.174 equivalence matrix

| Guarantee or mechanism | Status | Evidence in v0.60.174 |
|---|---|---|
| `lg-private` policy routing and D1 deny list | MISSING before this port | The shared page upsert at `src/core/engine-sql/pages.ts:88-185` has source identity but no private policy decision. |
| Remote private page and provenance hiding | COVERED | `src/core/search/private-visibility.ts:1-20,46-50,175-177,249-267`. It is read protection, not write routing. |
| Source grants for MCP clients | COVERED | `src/core/schema-migrations/v195-f3-access-token-grants.ts:7-16`, `v202-legacy-token-grant-conversion.ts:8-28`, `src/schema.sql:731-762`. |
| OAuth no-source axis | COVERED | `src/core/schema-migrations/v203-oauth-client-grant-axes.ts:7-16`, `src/core/ops/context.ts:527-540`. |
| Cross-source link policy #4680 | COVERED | `CHANGELOG.md:363-364`; approved links are written by every writer and read endpoints remain grant scoped. |
| Recall `source_id` #4830 | COVERED | `CHANGELOG.md:370-370`, `src/core/ops/facts.ts:597-597`; source identity is retained or omitted when a federated row cannot name one. |
| Per-source fact visibility | PARTIAL before this port | `src/core/facts/visibility.ts:1-19,35-43,54-62` had only a brain default and explicit caller override, with no source federation clamp. |

## Minimum port implemented

`src/core/private-source-routing.ts` reads `sources.config.private_routing` first and falls back to the two policy files under the source path. It arms only when `lg-private` has both documents and a non-empty Family deny-list, normalizes D1 candidates, checks unresolved identity and existing private collisions, and fails closed at the shared page write and restore seams in both engines. Verbatim engine migration copies use the explicit `migrationWrite` option and are not treated as new exposure. `src/core/facts/visibility.ts` adds a source policy resolver. Both engine fact wrappers normalize world requests to private unless the source explicitly permits world facts, and invoke the private fact guard. Upstream grant, link, recall, and MCP mechanisms remain unchanged.
