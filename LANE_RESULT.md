# LANE_RESULT

## Outcome

All five named fixes are implemented on branch `codex/r4-destructive-guard-20260917`.
Implementation commit: `4d74afea7969a1e8192311181bc5887d824a674a`.

## C1 red receipt

On the untouched starting commit `877b6ea7c4362f3ba591a28a4974a1e073cde149`, the exact
remote-shaped `submit_job` call was refused by the operation handler:

```text
{"name":"OperationError","code":"permission_denied","message":"'autopilot-cycle' jobs cannot be submitted over MCP (CLI-only for security)"}
exit_code=1
```

I chose shape (a): `remote-autopilot-cycle` is a separate unprotected job name. Its
handler ignores all caller-supplied data and runs the fixed phase list
`sync`, `extract`, `embed`; it has no purge consent path. The post-fix test drives the
real `submit_job` operation with the exact remote ping payload, then drives the real
registered handler with a forged purge phase and asserts that only the fixed phases are
passed to `runCycle`.

## Green receipts

- C1 and C4 targeted tests: `12 pass 0 fail`, 36 expect calls, 2 files.
- C2/C3/C4 source and related tests: `79 pass 14 skip 0 fail`, 165 expect calls, 3 files. The skips are the expected no-`DATABASE_URL` remote E2E skips.
- Requested focused gate: `466 pass 0 fail`, 1432 expect calls, 13 files.
- Minion/queue retry after the aggregate hook contention: `261 pass 0 fail`, 875 expect calls, 2 files.
- `env -u GBRAIN_DATABASE_URL -u DATABASE_URL bun run typecheck`: exit 0 (`$ tsc --noEmit`).
- `env -u GBRAIN_DATABASE_URL -u DATABASE_URL bun run build`: exit 0 (`bundle 2173 modules`; `compile bin/gbrain`).
- `env -u GBRAIN_DATABASE_URL -u DATABASE_URL bun run scripts/generate-flag-registry.ts`: `wrote .../src/core/cli-flag-registry.generated.ts (108 commands, 5045 flag entries)`.
- `git diff --check`: clean.

The broad related-test aggregate was also attempted. Bun's default concurrent run hit
unrelated fixture hook timeouts; the affected minion, queue, and files tests passed when
rerun with serialized/individual execution. No code failure remained in the named fixes.

## Changed sites and verified line numbers

### C1

- `src/commands/remote.ts:117` submits `remote-autopilot-cycle`.
- `src/commands/jobs.ts:149-154` defines the separate fixed remote trigger; `src/commands/jobs.ts:2767-2785` registers its fixed non-purge handler.
- `src/core/minions/handler-timeouts.ts:62` gives the remote trigger the cycle timeout.
- `test/destructive-guard-r4.test.ts:1-59` exercises the real operation decision and real handler.

### C2

- `src/core/ops/sources.ts:197` updates the cascading-delete description; `src/core/ops/sources.ts:206` documents the pages/facts/chunks confirmation contract; `src/core/ops/sources.ts:216-217` records why remote scope remains.
- `src/core/sources-ops.ts:926-942` counts pages, facts, and chunks; `src/core/sources-ops.ts:956` gates removal on any data.
- `test/sources-ops.test.ts:305-319` covers a facts-only source.
- A remote caller was found at `test/e2e/sources-remote-mcp.test.ts:373` and `:385` (and the operation contract remains pinned at `test/sources-mcp.test.ts:116`). Per the brief, `localOnly` was not changed; only the confirmation half was fixed.

### C3

- `src/commands/sources.ts:1144-1154` queries `archived` and gives a typed exit-2 refusal naming `gbrain sources archive`.
- `test/sources-ops.test.ts:470-489` proves a live source remains present after refusal.

### C4

- `src/core/cycle.ts:1725-1733` takes the dry-run arm before consent validation.
- `src/commands/sources.ts:1101-1113` normalizes `--scope` in any position, including equals form; `:1134-1141` validates the value; `:1181-1188` uses a typed refusal for missing scope.
- `test/destructive-guard-fable-fixes.test.ts:92-106` proves dry-run does not touch deletion.
- `test/sources-ops.test.ts:492-506` covers flag ordering, equals form, and invalid scope.

### C5

- Revoke-client hints: `src/core/destructive-guard.ts:306,311,313,671,709`; `src/commands/agent-register.ts:383,542,932`; `src/commands/doctor/checks/routing-federation.ts:182`; `src/core/mcp-registration.ts:177`; `docs/guides/multi-source-brains.md:139`.
- Additional executable/help sites found and corrected: `src/commands/auth.ts:761,1162`; `docs/integrations/qm-harness-snippets/provision-scopes.sh:249`; `docs/tutorials/company-brain.md:292,573`; `docs/architecture/KEY_FILES.md:385`; cleanup commands in `test/e2e/serve-http-ingest-webhook.test.ts:186`, `test/e2e/serve-http-multi-agent.test.ts:186`, `test/e2e/serve-http-oauth.test.ts:119,951,973`, and `test/e2e/sources-remote-mcp.test.ts:228`.
- Migration hints: `src/commands/doctor.ts:2223` now points to `--dry-run`; `src/commands/ze-switch.ts:197` emits separate `--dry-run` and `--yes` commands.
- Jobs prune help: `src/commands/jobs.ts:393,597,600`; top-level help `src/cli.ts:3951` now requires `--older-than Nd`.
- Regenerated registry: `src/core/cli-flag-registry.generated.ts:18,43`.
- Updated pinned expectations: `test/auth-register-client-output-pin.test.ts:55`, `test/destructive-guard.test.ts:536,620,623`, and `test/mcp-registration-blocks.test.ts:58`.

## Pre-existing failures

The brief’s known pre-existing failures remain out of scope: the 7 tests in
`test/forget-reconcile-durability.test.ts` and `test/privacy-strip-and-forget.test.ts`
(forget-fence defect). They were not fixed or chased.

## Brief discrepancies

The supplied line numbers were review hints and drifted from this tree; all lines above
were verified post-change. The C2 instruction has an explicit conditional conflict:
the brief requests `localOnly: true` but also says to leave scope intact if a remote
caller exists. The remote caller exists, so the confirmation-only resolution was used.
No other named requirement was found to be incorrect.
