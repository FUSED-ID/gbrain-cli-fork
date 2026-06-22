#!/usr/bin/env bash
set -euo pipefail

DB="${GBRAIN_DATABASE_URL:-postgres://lg@localhost:5432/gbrain}"
GBRAIN_BIN="${GBRAIN_BIN:-gbrain}"
GBRAIN_CMD="${GBRAIN_CMD:-}"
PRIVATE_SOURCE="${GBRAIN_PRIVATE_SOURCE_ID:-lg-private}"
PRIVATE_DIR="${GBRAIN_PRIVATE_POLICY_DIR:-$HOME/gbrain-private}"
EXCLUDED="$PRIVATE_DIR/_excluded-people.md"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

command -v psql >/dev/null || fail "psql not found"
if [[ -n "$GBRAIN_CMD" ]]; then
  # shellcheck disable=SC2206
  GBRAIN_RUN=($GBRAIN_CMD)
else
  command -v "$GBRAIN_BIN" >/dev/null || fail "gbrain binary not found: $GBRAIN_BIN"
  GBRAIN_RUN=("$GBRAIN_BIN")
fi
[[ -f "$EXCLUDED" ]] || fail "missing private policy file: $EXCLUDED"

PRIVATE_PATTERN="${GBRAIN_PRIVATE_TEST_PATTERN:-}"
if [[ -z "$PRIVATE_PATTERN" ]]; then
  PRIVATE_PATTERN="$(
    awk -F'|' '
      /^## / { in_deny = ($0 ~ /^## Family deny-list/); next }
      in_deny && $2 ~ /`[^`]*\*/ {
        gsub(/^[[:space:]]*`|`[[:space:]]*$/, "", $2);
        print $2;
        exit;
      }
    ' "$EXCLUDED"
  )"
fi
[[ -n "$PRIVATE_PATTERN" ]] || fail "no wildcard private slug pattern found; set GBRAIN_PRIVATE_TEST_PATTERN"

PRIVATE_BASE="${PRIVATE_PATTERN%\*}"
PRIVATE_SLUG="${GBRAIN_PRIVATE_TEST_SLUG:-${PRIVATE_BASE}routing-canary/_author}"
SHARED_SLUG="${GBRAIN_SHARED_TEST_SLUG:-shared-business-routing-canary/_author}"

cleanup() {
  psql "$DB" -v private_slug="$PRIVATE_SLUG" -v shared_slug="$SHARED_SLUG" -v private_source="$PRIVATE_SOURCE" -qAt <<'SQL' >/dev/null 2>&1 || true
DELETE FROM pages
 WHERE slug IN (:'private_slug', :'shared_slug')
   AND source_id IN ('default', :'private_source');
SQL
}
trap cleanup EXIT
cleanup

make_page() {
  local name="$1"
  local out="$2"
  cat > "$out" <<EOF
---
type: person
full_name: $name
source: redgreen-reimport-source-routing
---

# $name

Routing canary for source isolation.
EOF
}

source_for_slug() {
  local slug="$1"
  psql "$DB" -v slug="$slug" -qAt <<'SQL'
SELECT source_id
  FROM pages
 WHERE slug = :'slug'
 ORDER BY updated_at DESC
 LIMIT 1;
SQL
}

count_in_source() {
  local slug="$1"
  local source="$2"
  psql "$DB" -v slug="$slug" -v source="$source" -qAt <<'SQL'
SELECT count(*)::int
  FROM pages
 WHERE slug = :'slug'
   AND source_id = :'source';
SQL
}

tmp_private="$(mktemp -t gbrain-private-routing.XXXXXX.md)"
tmp_shared="$(mktemp -t gbrain-shared-routing.XXXXXX.md)"
make_page "Private Routing Canary" "$tmp_private"
make_page "Shared Business Routing Canary" "$tmp_shared"

printf 'gate: contacts/reimport source routing\n'

GBRAIN_SOURCE=default "${GBRAIN_RUN[@]}" capture --file "$tmp_private" --slug "$PRIVATE_SLUG" --quiet >/dev/null
private_source_seen="$(source_for_slug "$PRIVATE_SLUG")"
[[ "$private_source_seen" == "$PRIVATE_SOURCE" ]] \
  || fail "private person/_author canary routed to '${private_source_seen:-missing}', expected '$PRIVATE_SOURCE' (pre-fix RED routes to default)"
[[ "$(count_in_source "$PRIVATE_SLUG" default)" == "0" ]] \
  || fail "private person/_author canary also exists in default"
pass "private person/_author canary routes to $PRIVATE_SOURCE"

GBRAIN_SOURCE=default "${GBRAIN_RUN[@]}" capture --file "$tmp_private" --slug "$PRIVATE_SLUG" --quiet >/dev/null
[[ "$(count_in_source "$PRIVATE_SLUG" "$PRIVATE_SOURCE")" == "1" ]] \
  || fail "private person/_author rewrite did not stay idempotent in $PRIVATE_SOURCE"
[[ "$(count_in_source "$PRIVATE_SLUG" default)" == "0" ]] \
  || fail "private person/_author rewrite created a default-source row"
pass "private person/_author rewrite is non-downgrading"

GBRAIN_SOURCE=default "${GBRAIN_RUN[@]}" capture --file "$tmp_shared" --slug "$SHARED_SLUG" --quiet >/dev/null
shared_source_seen="$(source_for_slug "$SHARED_SLUG")"
[[ "$shared_source_seen" == "default" ]] \
  || fail "shared business canary routed to '${shared_source_seen:-missing}', expected default"
pass "shared business canary stays in default"

rm -f "$tmp_private" "$tmp_shared"
pass "redgreen-reimport-source-routing gate GREEN"
