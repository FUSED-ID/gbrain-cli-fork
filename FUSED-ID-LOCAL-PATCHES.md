# FUSED-ID local patches — carry-forward across garrytan rebases

This fork (`FUSED-ID/gbrain-cli-fork`) tracks upstream `garrytan/gbrain` and
carries a small set of **additive** local patches. They are designed so a
version-bump rebase replays them with (near) zero conflict.

## Remotes
- `origin`   → `garrytan/gbrain` (UPSTREAM — pull/rebase only, never push here)
- `fused-id` → `FUSED-ID/gbrain-cli-fork` (our fork — push here)

## Local patches carried

### 1. SuperGrok mesh recipe (dream enrichment on the SuperGrok subscription)
Lets any mesh node run chat/enrichment via the Hermes `supergrok-shim`
(`hermes chat --provider xai-oauth`) — no API tokens.
- **Additive (never conflicts):** `src/core/ai/recipes/supergrok.ts`, `src/core/ai/recipes/supergrok.test.ts`
- **Conflict surface = 2 lines only:** `src/core/ai/recipes/index.ts` — the
  `import { supergrok } ...` line and the `supergrok,` entry in `ALL`.
- Service source of truth (NOT in this repo): `FUSED-ID/m4-macbook-pro-setup`
  `bin/supergrok-shim.py`; deploy on Hermes via `FUSED-ID/hermes-vps-setup`.
- Client usage: `gbrain enrich --source default --model supergrok:grok-4.3 --max-usd off`
  (base URL comes from the recipe's `base_url_default` = Hermes tailscale shim;
  override with `base_urls.supergrok` config or `SUPERGROK_BASE_URL` if it moves).

> If you add more local deltas, prefer NEW files + a single registry line.
> Never hand-edit a core upstream file if an additive file will do — that is
> what keeps rebases clean.

## Rebase procedure (on a garrytan version bump)
```bash
cd ~/gbrain-upstream
git fetch origin
git rebase origin/master            # or the new upstream tag/branch
# New files (supergrok.ts / supergrok.test.ts) replay with NO conflict.
# If index.ts conflicts because Garry added a recipe: keep BOTH sides —
#   re-add `import { supergrok } from './supergrok.ts';` and the `supergrok,`
#   entry in the ALL[] array, then `git add` + `git rebase --continue`.

# VERIFY the patch survived (must be green):
bun test src/core/ai/recipes/supergrok.test.ts
# Smoke (optional, needs the shim up):
gbrain enrich --source default --limit 1 --model supergrok:grok-4.3 --max-usd off --dry-run

git push fused-id HEAD --force-with-lease
```

## Known upstream-unification opportunities (would shrink these patches)
- gbrain chat budget pricing reads the ANTHROPIC table only; recipe `cost_per_1m_*`
  isn't consulted for chat, so we pass `--max-usd off`. If upstream adds
  recipe-cost-driven chat pricing (the TODO noted in `budget-tracker.ts`), the
  `--max-usd off` workaround can drop.
