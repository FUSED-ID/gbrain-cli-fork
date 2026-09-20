# gf-p6 result

Baseline: deployed checkout `/Users/lg/gbrain-upstream` was measured at branch
`codex/r4-destructive-guard-20260917`, commit
`d53ce2bcbcb58fa8169bd6f9c5eb2475988c3639`, clean (`status --porcelain -uall`
count `0`). All implementation and tests run in the detached worktree
`/Users/lg/lane-work/gf-p6-work`. The `gbrain` binary was not invoked.

## Design, written before implementation

### Part (a): one claim rule with a deliberate local path

The submit gate and the claim gate will share the existing pure
`isProtectedJobName()` rule from `src/core/minions/protected-names.ts`; there
will be no second protected-name list. `MinionQueue.add()` will retain the
existing `allowProtectedSubmit` capability and, for a protected submission that
has that capability, stamp a reserved queue-owned grant into the persisted job
payload. A protected row without that grant is not claimable.

The claim SQL will apply one predicate to the existing worker name narrowing:
the row must be in the requested queue, waiting, and have a name in the
worker's `registeredNames`; additionally, a protected name must carry the
queue-owned grant. Thus a row inserted directly into `minion_jobs`, a legacy
protected row already waiting, and a protected row re-queued by an untrusted
retry cannot run. The grant is consumed from the in-memory claimed job before
the handler sees it, but remains durable in the row so a failed, deliberately
submitted job does not lose its explicit claim entitlement.

`GBRAIN_WORKER_ONLY_NAMES` continues to work because it still reduces
`registeredNames` before `claim()`; the protected predicate is an additional
condition, never a replacement for that narrowing. A deliberate CLI or
operation-local submit still passes `allowProtectedSubmit: true`, which is the
existing trusted path and now travels with that job to claim time.

`retryJob()` will exclude protected names. Retrying is an admin operation and
does not itself constitute a new deliberate local submission; a failed
protected operation must be submitted again through the existing trusted path.
This closes the highlighted `retry_job` re-arm path without weakening the
claim gate.

Rejected alternatives:

* Only adding `isProtectedJobName()` to the `claim()` SQL was rejected because
  it would make even an explicit local CLI/operation-local submission
  permanently unclaimable.
* Passing a worker-wide `allowProtectedNames` flag to `claim()` was rejected
  because every protected row visible to that worker would then be claimable,
  including old or remote rows; the entitlement must travel with the row.
* A new database column or DDL migration was rejected because the deployed
  schema must remain compatible and this control can use the existing JSONB
  payload without a migration.
* A second protected-name constant in `queue.ts` was rejected because it would
  recreate the drift the change is intended to remove.

### Part (b): no automatic self-consent

I choose shape 2: a QUEUED `autopilot-cycle` or
`autopilot-global-maintenance` job will exclude `purge` from its effective
phase list, even if a stale or forged payload asks for it. Those handlers will
not pass `purgeConsent` to `runCycle`. The existing `purge` job remains the
queue-side hard-delete class and keeps its deployed explicit cutoff plus
`confirm: 'yes-i-mean-it'` gate. The direct human `dream --yes-i-mean-it`
interface continues to own its explicit consent path; automatic inline
autopilot execution will also no longer self-consent.

Shape 1—threading submitter consent through an autopilot-cycle payload—was
rejected for this control surface because it would make a destructive phase a
property of a broad multi-phase job and would require every producer, retry,
and replay path to preserve and validate the same destructive entitlement.
Shape 1 would retain automatic purge as a feature, but its entitlement would
be easier to replay or accidentally broaden. Shape 2 makes the authority
boundary structural: only the already-gated purge job or a direct human CLI
consent can reach the hard-delete arm.

`src/core/destructive-guard.ts` remains the implementation of the destructive
operation and its direct consent model. It is not reused for the queue claim
predicate because it answers a different question—whether a human CLI request
has the required flags—not whether a queued row was deliberately admitted by
the trusted submitter path. The queue grant is admission metadata, not a
second hard-delete consent mechanism.

## Receipts

Implementation commit for the source line references below:
`4f02b308f88c46b81c09122cdccd7d30db29512d`.

### Part (a)

RED command, run before the implementation:

```text
env -u GBRAIN_DATABASE_URL -u DATABASE_URL /opt/homebrew/bin/bun test test/gf-p6-control-surface.test.ts
```

Verbatim decisive failing output from that command (the full raw tool capture is
at `/Users/lg/lane-work/gf-p6/codex.err:7339-7497`):

```text
error: expect(received).toBeNull()
Received: { name: "purge", queue: "default", status: "active", lock_token: "gf-p6-direct" }
(fail) gf-p6 part (a): protected names are gated at claim > a protected row inserted directly into the queue is not claimed
error: expect(received).toBeNull()
Received: { name: "purge", queue: "default", status: "waiting" }
(fail) gf-p6 part (a): protected names are gated at claim > retry does not re-arm a protected job
1 pass
4 fail
10 expect() calls
Ran 5 tests across 1 file.
```

Change: the trusted `allowProtectedSubmit` path now stamps the reserved claim
grant at `src/core/minions/queue.ts:228-234`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`); the single claim predicate
combines `registeredNames` with the protected-name set and grant at
`src/core/minions/queue.ts:1472-1493`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`); the returned handler payload
strips the reserved key at `src/core/minions/queue.ts:1495-1500`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`); retry refuses protected names
at `src/core/minions/queue.ts:1223-1234`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`) and the admin operation reports
that boundary at `src/core/ops/jobs.ts:666-686`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`).

GREEN command and verbatim output (same command):

```text
bun test v1.3.14 (0d9b296a)
(pass) gf-p6 part (a): protected names are gated at claim > a protected row inserted directly into the queue is not claimed
(pass) gf-p6 part (a): protected names are gated at claim > an explicit protected submit remains claimable and worker narrowing remains exact
(pass) gf-p6 part (a): protected names are gated at claim > retry does not re-arm a protected job
5 pass
0 fail
17 expect() calls
Ran 5 tests across 1 file.
```

The actual green invocation included the required database-variable removal:
`env -u GBRAIN_DATABASE_URL -u DATABASE_URL /opt/homebrew/bin/bun test test/gf-p6-control-surface.test.ts`.

### Part (b)

RED command, run before the implementation:

```text
env -u GBRAIN_DATABASE_URL -u DATABASE_URL /opt/homebrew/bin/bun test test/gf-p6-control-surface.test.ts
```

Verbatim decisive failing output from that command (the same raw capture is at
`/Users/lg/lane-work/gf-p6/codex.err:7339-7497`):

```text
[cycle.purge] start
[cycle.purge] done
error: expect(received).toBe(expected)
Expected: "skipped"
Received: "clean"
(fail) gf-p6 part (b): queued autopilot cycles cannot reach purge > autopilot-cycle excludes purge even when a queued payload requests only purge
[cycle.purge] start
[cycle.purge] done
error: expect(received).not.toContain(expected)
Expected to not contain: "purge"
Received: [ "purge" ]
(fail) gf-p6 part (b): queued autopilot cycles cannot reach purge > global maintenance excludes purge from its queued phase list
1 pass
4 fail
10 expect() calls
Ran 5 tests across 1 file.
```

Change: the shared queue phase sets exclude purge at
`src/core/cycle.ts:220-223`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`); queued autopilot and global
maintenance handlers refuse a purge-only payload and omit `purgeConsent` at
`src/commands/jobs.ts:2698-2773` and `:2800-2863`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`); the scheduler payload and
automatic inline fallback use the same non-purge sets at
`src/commands/autopilot-fanout.ts:651-653` and
`src/commands/autopilot.ts:1480-1490`
(`4f02b308f88c46b81c09122cdccd7d30db29512d`). The existing explicitly
consented purge job remains unchanged.

GREEN command and verbatim output (same command):

```text
bun test v1.3.14 (0d9b296a)
(pass) gf-p6 part (b): queued autopilot cycles cannot reach purge > autopilot-cycle excludes purge even when a queued payload requests only purge
(pass) gf-p6 part (b): queued autopilot cycles cannot reach purge > global maintenance excludes purge from its queued phase list
5 pass
0 fail
17 expect() calls
Ran 5 tests across 1 file.
```

The actual green invocation included the required database-variable removal:
`env -u GBRAIN_DATABASE_URL -u DATABASE_URL /opt/homebrew/bin/bun test test/gf-p6-control-surface.test.ts`.

## Verification

Measured verification before final cleanup:

* `env -u GBRAIN_DATABASE_URL -u DATABASE_URL /opt/homebrew/bin/bun run typecheck`
  passed with `tsc --noEmit`.
* `env -u GBRAIN_DATABASE_URL -u DATABASE_URL /opt/homebrew/bin/bun test test/gf-p6-control-surface.test.ts test/minions.test.ts test/autopilot-cycle-handler.test.ts test/autopilot-global-maintenance.test.ts test/autopilot-fanout.test.ts test/destructive-guard-r4.test.ts`
  passed: `292 pass`, `0 fail`, `1056 expect() calls`, `Ran 292 tests across 6 files.`
* `git diff --check` passed; forbidden artifact search was
  `find /Users/lg/lane-work/gf-p6-work -type f -path '*/bin/gbrain' -print`
  with count `0` on the same line.
* Source line evidence is tied to implementation commit
  `4f02b308f88c46b81c09122cdccd7d30db29512d`; no generated flag registry, DDL,
  database write, merge, push, or deployed-checkout edit was performed.

Final deployed-checkout and worktree-removal receipts are appended after the
worktree is removed.

Measured immediately before removal:

```text
git -C /Users/lg/gbrain-upstream rev-parse --abbrev-ref HEAD
codex/r4-destructive-guard-20260917
git -C /Users/lg/gbrain-upstream rev-parse HEAD
d53ce2bcbcb58fa8169bd6f9c5eb2475988c3639
git -C /Users/lg/gbrain-upstream status --porcelain -uall | wc -l
0
git -C /Users/lg/gbrain-upstream worktree list
/Users/lg/gbrain-upstream      d53ce2bcb [codex/r4-destructive-guard-20260917]
/Users/lg/lane-work/gf-p6-work 20a5ccc67 (detached HEAD)
```

The deployed checkout remained unchanged; the disposable implementation
worktree was clean at `20a5ccc6745f9a64fc4cd364cb732e9aea5ecb40` with status
count `0`.

Unfinished task ids: none
