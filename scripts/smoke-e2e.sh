#!/usr/bin/env bash
# =============================================================================
# smoke-e2e.sh — end-to-end publish→install smoke against a live registry.
# =============================================================================
#
# What it proves:
#   1. The deployed registry is responding (homepage + /api/v1/health).
#   2. A pre-seeded test publisher can mint a publish token.
#   3. `workgraph publish examples/pr-quality` round-trips through:
#        - POST /api/publish/init   → presigned R2 PUTs
#        - PUT  each presigned URL  → R2 receives bytes
#        - POST /api/publish/<id>/finalize → registry HEADs R2, records version
#   4. `workgraph install workgraph-smoke/pr-quality@<v> --registry $REGISTRY_URL`
#      from a temporary clean projectRoot exits 0, writes files, writes lockfile.
#   5. `workgraph verify` against the install reports `clean: true`.
#   6. Cleanup: yank the test version so the seed publisher stays tidy.
#
# Required env (all caller-supplied):
#   REGISTRY_URL          e.g. https://agentpack.dev or https://agentpack-xyz.vercel.app
#   SMOKE_PUBLISH_TOKEN   a Bearer token with scope 'publish:packs:workgraph-smoke'
#                         (mint via the production /tokens UI as a test user)
#
# Exit codes:
#   0  smoke green
#   1  usage / setup error
#   2  registry not reachable
#   3  publish failed
#   4  install failed
#   5  lockfile checksum mismatch
#   6  verify drift
#
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${REGISTRY_URL:?REGISTRY_URL is required (e.g. https://agentpack.dev)}"
: "${SMOKE_PUBLISH_TOKEN:?SMOKE_PUBLISH_TOKEN is required (mint via the /tokens UI)}"

REGISTRY_URL="${REGISTRY_URL%/}"
TMP_DIR=$(mktemp -d -t agentpack-smoke-XXXXXXXX)
SMOKE_VERSION="0.0.0-smoke.$(date -u +%Y%m%d%H%M%S)"
RESULTS_FILE="$REPO_ROOT/smoke-results.json"

trap 'rm -rf "$TMP_DIR"' EXIT

red()   { printf '\033[1;31m%s\033[0m\n' "$1"; }
green() { printf '\033[1;32m%s\033[0m\n' "$1"; }
note()  { printf '\033[1;36m%s\033[0m\n' "$1"; }

note "▸ Step 1/6: probe registry"
HEALTH_CODE=$(curl -s -o /tmp/health.json -w '%{http_code}' "$REGISTRY_URL/api/v1/health" || echo "000")
if [[ "$HEALTH_CODE" != "200" ]]; then
  red "Registry health probe failed: HTTP $HEALTH_CODE"
  cat /tmp/health.json 2>/dev/null || true
  exit 2
fi
HEALTH=$(cat /tmp/health.json)
echo "  $HEALTH"
DB_STATUS=$(jq -r '.db // "missing"' <<<"$HEALTH")
R2_STATUS=$(jq -r '.r2 // "missing"' <<<"$HEALTH")
if [[ "$DB_STATUS" != "up" || "$R2_STATUS" != "up" ]]; then
  red "Registry reports degraded: db=$DB_STATUS r2=$R2_STATUS"
  exit 2
fi
green "  ✓ registry up (db=$DB_STATUS, r2=$R2_STATUS)"

note "▸ Step 2/6: build CLI"
pnpm --filter @agentpack/core build >/dev/null
pnpm --filter @agentpack/cli build >/dev/null
WORKGRAPH="$REPO_ROOT/packages/cli/bin/workgraph.mjs"
test -x "$WORKGRAPH" || { red "CLI binary not found at $WORKGRAPH"; exit 1; }
green "  ✓ CLI built"

note "▸ Step 3/6: publish examples/pr-quality@$SMOKE_VERSION"
# Override the manifest version to a smoke-unique value so we can re-run.
SMOKE_MANIFEST="$TMP_DIR/AGENTPACK.yaml"
sed -E "s/^(version:\s*).*/\1\"$SMOKE_VERSION\"/" examples/pr-quality/AGENTPACK.yaml > "$SMOKE_MANIFEST"
PUBLISH_OUT=$(WORKGRAPH_TOKEN="$SMOKE_PUBLISH_TOKEN" \
  "$WORKGRAPH" publish "$SMOKE_MANIFEST" \
  --registry "$REGISTRY_URL" \
  --publisher workgraph-smoke \
  --json 2>&1) || { red "publish failed"; echo "$PUBLISH_OUT"; exit 3; }
echo "$PUBLISH_OUT" | tail -1
PUBLISHED_VERSION=$(echo "$PUBLISH_OUT" | jq -r '.version // empty' 2>/dev/null || true)
if [[ -z "$PUBLISHED_VERSION" ]]; then
  red "Could not extract published version from CLI output"
  exit 3
fi
green "  ✓ published workgraph-smoke/pr-quality@$PUBLISHED_VERSION"

note "▸ Step 4/6: install into clean projectRoot"
INSTALL_ROOT="$TMP_DIR/install-target"
mkdir -p "$INSTALL_ROOT"
"$WORKGRAPH" install "workgraph-smoke/pr-quality@$PUBLISHED_VERSION" \
  --registry "$REGISTRY_URL" \
  --target claude-code \
  --profile safe \
  --project "$INSTALL_ROOT" \
  --yes || { red "install failed"; exit 4; }
test -f "$INSTALL_ROOT/AGENTPACK.lock" || { red "no lockfile written"; exit 4; }
test -f "$INSTALL_ROOT/CLAUDE.md" || { red "expected CLAUDE.md not written"; exit 4; }
green "  ✓ install wrote files + lockfile"

note "▸ Step 5/6: verify lockfile checksums against registry"
LOCKFILE_CHECKSUM=$(jq -r '.manifestChecksum' "$INSTALL_ROOT/AGENTPACK.lock")
REGISTRY_CHECKSUM=$(curl -s "$REGISTRY_URL/api/v1/packs/workgraph-smoke/pr-quality/versions/$PUBLISHED_VERSION" | \
  jq -r '.manifestChecksum // empty')
if [[ "$LOCKFILE_CHECKSUM" != "$REGISTRY_CHECKSUM" || -z "$LOCKFILE_CHECKSUM" ]]; then
  red "manifestChecksum mismatch: lockfile=$LOCKFILE_CHECKSUM registry=$REGISTRY_CHECKSUM"
  exit 5
fi
green "  ✓ checksums match ($LOCKFILE_CHECKSUM)"

note "▸ Step 6/6: workgraph verify (drift check)"
cd "$INSTALL_ROOT"
"$WORKGRAPH" verify workgraph-smoke.pr-quality || { red "verify reported drift"; exit 6; }
cd "$REPO_ROOT"
green "  ✓ verify clean"

# Record results for regression tracking.
ARTIFACT_BYTES=$(find "$INSTALL_ROOT" -type f -not -path '*/\.workgraph/*' -not -name 'AGENTPACK.lock' \
  -exec stat -c '%s' {} + 2>/dev/null | awk '{s+=$1} END{print s+0}')
jq -n \
  --arg version "$PUBLISHED_VERSION" \
  --arg checksum "$LOCKFILE_CHECKSUM" \
  --arg url "$REGISTRY_URL" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson bytes "$ARTIFACT_BYTES" \
  '{
    timestamp: $ts,
    registry_url: $url,
    smoke_version: $version,
    manifest_checksum: $checksum,
    artifact_bytes: $bytes,
    status: "green"
  }' > "$RESULTS_FILE"

green ""
green "════════════════════════════════════════════════════════"
green "  ✓ End-to-end smoke green"
green "    registry: $REGISTRY_URL"
green "    version : workgraph-smoke/pr-quality@$PUBLISHED_VERSION"
green "    results : $RESULTS_FILE"
green "════════════════════════════════════════════════════════"
