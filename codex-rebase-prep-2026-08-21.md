# Codex-L1 rebase preparation report — 2026-08-21

## Scope and execution status

- Repository inspected: `/Users/lg/gbrain-upstream` only.
- `/Users/lg/gbrain` was not touched.
- No Postgres connection or database command was run.
- No build was needed, so no worktree or branch was created.
- The checkout was left unchanged; its pre-existing untracked files remain untouched.

Requested `git fetch origin` was attempted, but the sandbox denied opening
`.git/FETCH_HEAD` (`Operation not permitted`). A read-only `git ls-remote`
fallback was also attempted, but DNS could not resolve `github.com`. Therefore
the upstream comparison below uses the locally cached `origin/master` and tags;
remote freshness as of 2026-08-21 is unverified.

Heartbeat appends were attempted before the fetch and read-only fallback, but
the sandbox denied writes to the requested external state directory. No
heartbeat line was written.

## Version comparison

Current checkout:

- Branch: `rebase-to-0.42.52`
- HEAD: `e161e23fb298d819d1072c440e647a085b55056b`
- Package version: `0.42.76.0-fused-id.1`
- HEAD is 20 commits after upstream tag `v0.42.76.0`, on the FUSED-ID fork line.

Latest locally available upstream tag:

- Tag: `v0.45.12.0`
- Commit: `7fdcd8bd2ee0b3546b167da14cddd27eb2507212`
- Cached `origin/master` and `origin/HEAD` point to this same commit.
- Tag date: 2026-08-13.

The two lines diverge at `130d321d234726c8ea364823c93c9c65b40ee167`
(`v0.42.76.0`). Upstream has 90 commits from that base through `v0.45.12.0`;
the checkout has 20 fork commits. A direct tree comparison is large
(981 files, 94,822 insertions, 5,693 deletions), so this report narrows the
review to import, git-backed sync ingestion, CLI contracts, and migrations.

## Changelog delta from v0.42.76.0 to v0.45.12.0

Release sequence in the cached upstream history: `v0.43.0.0`, `v0.44.0.0`,
`v0.44.1.0`, `v0.45.0.0`, `v0.45.1.0`, `v0.45.2.0`, `v0.45.3.0`,
`v0.45.5.0`, `v0.45.6.0`, `v0.45.7.0`, `v0.45.8.0`, `v0.45.9.0`,
`v0.45.10.0`, `v0.45.11.0`, and `v0.45.12.0`.

High-level delta:

- `v0.43`: stable five-verb memory protocol and intent-aware search routing.
- `v0.44`: BrainBench conformance/evaluation surface and benchmark schemas.
- `v0.45.0`–`v0.45.3`: opt-in personal-agent bootstrap, hooks, workspace/repo
  persistence, and harness-specific scope behavior.
- `v0.45.5`: honest autopilot health/staleness, migration quiescing, safer sync
  daemon behavior, and keyless scheduler-chain behavior.
- `v0.45.6`: 17 bundled production skills and skill-pack currency/preconditions.
- `v0.45.7`: ambient recall (`context_pack` and `delta`) plus one additive
  per-session cursor migration.
- `v0.45.8`–`v0.45.10`: sync/import correctness and write-through fixes, plus
  search/doctor improvements.
- `v0.45.11`–`v0.45.12`: bootstrap hand-off polish and a tested Hermes install
  harness; no additional import/sync schema change was found.

## Import and git_sync changes affecting the rebase

These are the post-`v0.42.76.0` upstream changes confirmed in commit history
and source diffs:

### Behavior changes to account for

1. **Global anchor ownership is now enforced** (`636628fd`, v0.45.8 wave).
   `import` and legacy/global sync paths no longer repoint `sync.repo_path` or
   advance `sync.last_commit` when invoked on a foreign Git directory. The
   command warns and leaves the existing brain-repo anchor unchanged. Scripts
   that depended on importing any Git directory to establish the global brain
   repo must explicitly configure `sync.repo_path` or register/use a source.

2. **Malformed YAML frontmatter is rejected** (`23c7b0eb`). The importer now
   validates frontmatter and returns an import error/skip with a remediation
   message instead of accepting parser fallout and importing potentially wrong
   content. Existing malformed files need fixing or explicit failure handling.

3. **Auto-skipped failures are now acknowledgeable** (`fd0e371d`).
   `gbrain sync --skip-failed` clears both `open` and `auto_skipped` file
   failures. This is a semantic expansion of the existing flag, not a new
   flag spelling.

4. **Large syncs queue deferred extraction** (`bd4c976a`). When a sync exceeds
   the extraction size gate, it now submits an idempotent source-scoped stale
   extraction job where possible, rather than only printing a hint. This is
   best-effort and does not change the import bookmark contract; a worker is
   needed to consume the queued job.

### Correctness fixes with operational impact

- Git C-style-quoted paths are decoded before entering the sync manifest
  (`ce156eb8`), so filenames containing quotes, backslashes, control escapes,
  or octal-escaped UTF-8 are no longer silently dropped.
- A sync baseline commit is created only after a clean positive unborn-HEAD
  probe (`0a1890bb`); ambiguous probe failures refuse to auto-init/commit rather
  than risk stacking a baseline commit over an existing repository.
- Imports clear prior failure-ledger rows when a path imports successfully or
  is confirmed unchanged (`2dc33fb8`), preventing stale failures from blocking
  later convergence.
- Import error summaries retain an unredacted sample, preserving table and
  constraint names while still grouping structurally similar failures
  (`ed6e4e32`).

### Changes that are already in the current baseline

The following are not new post-`0.42.76` rebase deltas and should not be
reimplemented as fork work:

- strict unknown-flag rejection (introduced in `v0.42.76.0`),
- clean stdout JSON for `gbrain import --json`,
- resumable/pinned-target sync checkpoints and sync hard-deadline controls,
- existing `--source-id` import routing and source-scoped sync behavior.

No removal of an existing `import` or `sync` flag was found in the cached
upstream delta. The main CLI compatibility risk is strict validation: any
fork-local wrapper that passes an undocumented/stale flag will now fail before
import/sync work begins.

## Schema and migration compatibility warning

Upstream `v0.42.76.0` ends at migration v125. Upstream `v0.45.12.0` adds
migration v126, `session_context_state`, for ambient recall. It is additive and
empty on creation; upstream describes it as no existing-data rewrite.

The FUSED-ID checkout also reports `LATEST_VERSION = 126`, but its migration
126 is a different fork-local migration: `oauth_and_access_token_permissions`
adds permissions JSONB columns to `oauth_clients` and `access_tokens`. This is
a migration-number collision, not a harmless additive merge. A rebase that
lands upstream migration v126 without renumbering/merging will treat
`session_context_state` as already applied on a schema stamped 126, leaving the
ambient-recall table absent while the binary assumes it exists. Resolve the
numbering/body collision before any database upgrade or release; this report
did not open or modify any database.

The upstream v0.45.7 release also expands the frozen memory-verb surface from
five to seven (`context_pack` and `delta`), but its wire version remains 1 and
the change is additive. It is not an import/git_sync break by itself.

## Recommended rebase-prep actions

1. Re-run `git fetch origin` in an environment permitted to write the checkout's
   `.git` metadata, then confirm whether a tag newer than cached `v0.45.12.0`
   exists.
2. Resolve migration slot 126 explicitly before applying or testing the rebase;
   choose a new fork migration number or a deliberate merged migration with a
   verified schema-coverage test.
3. Audit fork wrappers/scripts for undocumented flags and for reliance on
   foreign-directory `import` changing global `sync.*` anchors.
4. Add/retain regression coverage for quoted Git paths, malformed frontmatter,
   foreign-repo anchor refusal, baseline-commit refusal, and migration-slot
   compatibility. No build was run in this scoped read-only pass.

