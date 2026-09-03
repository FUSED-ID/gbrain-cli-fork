# FUSED-ID 0.48.2 carry list

- P1 - worker `--only` / `GBRAIN_WORKER_ONLY_NAMES`; retire when upstream exposes a bounded worker allow-list with equivalent validation.
- P2 - SuperGrok mesh recipe via Hermes OAuth shim; retire when upstream provides a subscription-backed xAI OAuth recipe or the shim is decommissioned.
- P3 - private-write source routing for entity enrichment and `put_page`, plus `assertPrivateRoutingArmed` as an import pre-flight; retire when upstream provides policy-driven private source routing with remote-write denial.
- P4 - per-source `facts_visibility` layered above ENG-8 brain defaults; retire when upstream carries an equivalent source-policy resolver and backstop wiring.
- P5 - renumber fork permissions to v146+ and heal missing upstream v127 surface/index artifacts; retire when the fork migration is native and old v127 stamps have aged out.
- P6 - regenerate the flag registry, fix special eval flag discovery, disable automatic releases, and stamp `0.48.2.0-fused-id.1`; retire when release policy and registry generation are native upstream.
- P7 - make the P4 override loud and add the P3 import pre-flight; retire with P3 and P4.

## P4 narrows an upstream contract. Read this before trusting the ladder.

Upstream's ENG-8 module contract, stated at the top of
`src/core/facts/visibility.ts`, is that an **explicit caller value always
wins**. Under P4 it does not.

`resolveSourceVisibility` overrides an explicit `visibility: 'world'` to
`'private'` when the target source is not federated, and overrides any explicit
value when the source cannot be resolved or the lookup throws. `config.federated
=== true` is a strict check, so a source with `federated: false` or no
`federated` key at all is treated as non-federated. In the live brain that is
**nine of ten sources**; only `default` is federated.

This was undocumented, untested, and contradicted by the function's own
docstring until the G2 gate (2026-09-03). All three are now fixed.

### Why the override is kept rather than removed

`src/core/facts/meta-hook.ts` filters facts for remote callers on the
visibility label **alone**, with no independent `source.federated` check at that
layer. Honouring an explicit `'world'` would therefore write a remote-visible
label onto a source the operator never federated. The override is a
fail-closed backstop for a gate that sits in the wrong layer.

### The durable fix, still owed

Validate the requested visibility at the CLI and MCP boundary, where a human
sees the error; leave `resolveSourceVisibility` as the pure ladder its docstring
originally described; and have the export path check both the fact's visibility
and `source.federated`. Retire the override at that point.

## P3 fails open, so the import must assert

`resolvePrivateWriteSource` degrades to "no routing" in three places, all
silent: no private source resolves, `_excluded-people.md` cannot be read, or
the `## Family deny-list` heading is missing or renamed. In each case the write
proceeds to the requested source, which defaults to `default`, which is the one
source configured `federated: true` with `facts_visibility: world`.

The routing decision is taken at **import** time. A corpus rebuild with the
policy files absent would route every family and person page to the federated,
world-visible source, raise no error, and leave nothing in the logs.

`assertPrivateRoutingArmed(engine)` must therefore be called immediately before
any bulk import and a throw treated as a hard stop. It throws rather than warns,
by design.
