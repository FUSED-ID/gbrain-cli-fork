# FUSED-ID 0.48 cutover report

## Result and pin

- Worktree: `/Users/lg/gbrain-0.48`
- Branch: `fused-id/rebuild-0.48`
- Base: `v0.48.1.0` (`e9a14c952870f4a8b3f32529ce8ed05e9dad698b`)
- Patch commits: six, P1 through P6, in order
- Push target: `fused-id` only
- The requested pin was retained. Upstream has since reached `v0.48.2.0`
  (`8c70f6255` at `origin/master`); I found no .2.0 change that is materially
  better for this scoped series, so I did not move the pin.

## Patch commits

1. P1 `16b24c66` — worker `--only` / `GBRAIN_WORKER_ONLY_NAMES`
2. P2 `ab789442` — SuperGrok mesh recipe
3. P3 `173b7191` — private-write source routing
4. P4 `59b6b7a8` — per-source facts visibility above ENG-8
5. P5 `8eb6326e` — v127 collision repair and v146 migration
6. P6 — flag-registry/generator repair, release policy, and fused version (final SHA is reported at handoff)

## 26 fork-only commit classification

The comparison set is the 26 commits after merge-base `7fdcd8bd2` on the fork.

| # | Commit | Disposition | Reason |
|---:|---|---|---|
| 1 | `3e1296d6e` | DROP-obsolete | Historical 0.42 rebase bookkeeping; superseded by the scoped six-patch series. |
| 2 | `79f664615` | PORT P3 | Private-person reimports are the requested private-source routing, adapted to .48 `ops/pages.ts`. |
| 3 | `2a73d44a9` | DROP-obsolete | Checkpoint/freshness sync-extract work is outside this engine-tree cutover. |
| 4 | `cb6f4415d` | DROP-native | Chronicle/schema-pack foundation is already present in pinned v0.48.1.0. |
| 5 | `d970cfbfc` | DROP-obsolete | TD-2 engine-health/doctor rescoping is not part of the six requested patches. |
| 6 | `e0fb62576` | PORT P2 | SuperGrok is absent from pinned upstream and was ported as a registered recipe. |
| 7 | `8dd6424a5` | DROP-obsolete | Old carry-forward/rebase documentation is replaced by this report and carry list. |
| 8 | `935756628` | DROP-obsolete | Old chat `user_provided_models` typing does not apply to the .48 dynamic-model touchpoint. |
| 9 | `abe75957d` | DROP-obsolete | Eval answer-generation gateway changes are outside the pinned six-patch scope. |
| 10 | `ef26effbc` | DROP-obsolete | LongMemEval chat-receipt auditing is outside scope. |
| 11 | `e0a1703b0` | DROP-obsolete | LongMemEval session-ID canonicalization is outside scope. |
| 12 | `d64eff7eb` | PORT P6 | Release automation disablement is explicitly required by P6. |
| 13 | `2bbb5e64b` | DROP-native | Pinned upstream already carries the world-only legacy access-token permission default. |
| 14 | `7bee899c3` | PORT P1 | Worker explicit allow-list behavior is explicitly required by P1. |
| 15 | `309601082` | DROP-obsolete | Older schema-pack pipeline/type reconciliation is a corpus/schema lane, not this engine tree. |
| 16 | `396c40f69` | DROP-obsolete | Live-corpus type inventory is deployment-specific and not needed in the scratch engine. |
| 17 | `16475633d` | DROP-obsolete | Superseded 0.42 version stamp. |
| 18 | `0ce53a0ae` | PORT P6 | Flag-registry regeneration is required; the generator was fixed for the special eval command. |
| 19 | `2b2de799e` | PORT P4 | Per-source facts visibility was reconciled above upstream ENG-8 rather than blind-ported. |
| 20 | `e161e23fb` | DROP-obsolete | Extraction refusal-reason telemetry is outside this patch scope. |
| 21 | `5d1ae9ca9` | PORT P5 | Migration collision is repaired by renumbering fork work to v146+ with coverage. |
| 22 | `e92091835` | DROP-obsolete | Merge bookkeeping with no independent tree change. |
| 23 | `bda9adadb` | PORT P5 | Session-context self-heal pattern was adapted and combined with the oauth v127 artifact self-heal. |
| 24 | `f1e4619aa` | DROP-obsolete | Merge bookkeeping with no independent tree change. |
| 25 | `bb304df96` | DROP-obsolete | 0.45.12 merge/deploy bookkeeping, not an independent requested feature. |
| 26 | `0b73f5177` | DROP-obsolete | Deployment bookkeeping with no standalone patch to port. |

Exact-alias pinning was separately verified as native in the target: the target
has the exact-alias resolution path across five files, while the fork feature
has no fork-only files. It is therefore DROP-native and is not a seventh patch.

## Red then green evidence

Each red run was performed on the clean pinned tree before applying that patch;
each green run was performed after applying it.

| Patch | Red evidence | Green evidence |
|---|---|---|
| P1 | Worker-only test failed at import: `parseWorkerOnlyNames` was not exported; `0 pass, 1 fail`. | `test/jobs-worker-only.test.ts`: `5 pass, 0 fail`. |
| P2 | Recipe test found no registered SuperGrok recipe; `0 pass, 2 fail`. | `test/supergrok-recipe.test.ts`: `2 pass, 0 fail`. |
| P3 | Private-routing tests failed on missing `private-source-routing.ts`; `0 pass, 2 fail`. | Private-routing plus enrichment tests: `31 pass, 0 fail`. |
| P4 | Visibility test failed because `resolveSourceVisibility` was absent; `0 pass, 1 fail`. | `test/facts-visibility.test.ts`: `26 pass, 0 fail`. |
| P5 | Migration coverage failed on missing oauth v127 self-heal; `0 pass, 1 fail`. | `test/migrations-v146-schema-coverage.test.ts`: `3 pass, 0 fail`. |
| P6 | Eval pre-dispatch rejected `--by-type` as an unknown flag. | Generator/regenerated registry acceptance passed; the subprocess `gbrain eval longmemeval --by-type --help` exited 0 and listed all five flags. |

The final focused regression run passed `116` tests across five files, followed
by TypeScript typecheck and the 54-check verification gate (`54/54` green).
The final targeted doctor/update run passed `87` tests across four files before
the final contract-preserving suffix adjustment; the final combined targeted
run passed `116/116`.

## Full suite comparison

Both runs used `bun run test:full` with `GBRAIN_MODEL`,
`GBRAIN_DATABASE_URL`, and `DATABASE_URL` unset, and neither connected to the
live database.

- Clean pinned baseline: unit `23,612 pass / 32 skip / 13 fail`; serial phase
  added four failures, for `17` total failures.
- Final six-commit tree: unit `23,633 pass / 32 skip / 13 fail`; serial phase
  added four failures, for `17` total failures.

The pass-count increase is the added patch coverage. The unchanged failures
are environment/fixture failures: git-tag fixture setup without an editor,
worker-health expectations, DB-config-plane fixture setup, PGLite live-serve
fixture setup, workspace-push/template-door fixtures, loop reopen setup, and
worker-registry liveness. No patch-specific failure remains.

## Findings and retirement

All non-ported work is listed above with a disposition and reason. The six
retirement conditions are recorded one line per patch in
`FUSED-ID-LOCAL-PATCHES.md`; in short, each patch retires when the corresponding
worker control, recipe, private routing, visibility ladder, migration repair,
or release/registry policy becomes native upstream.

No model-heavy command, paid operation, live corpus, deployed tree, or live
Postgres database was used.
