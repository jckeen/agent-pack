#!/usr/bin/env bash
# =============================================================================
# bring-up-prod.sh — wire the Workgraph Registry against live infrastructure.
# =============================================================================
#
# This script is a guided runbook. It DOES NOT run unattended — every step
# either prints what to do or prompts you to paste a credential it can't get.
# Run it once when first promoting to production; subsequent deploys use
# `vercel --prod` directly.
#
# Prerequisites already in place:
#   - vercel CLI installed and logged in (`vercel whoami` returns your user)
#   - Cloudflare account with R2 enabled
#   - Neon account (https://neon.tech) with one project ready to create
#   - GitHub OAuth App registered (https://github.com/settings/applications/new)
#
# Steps:
#   1. Create the Vercel project from this repo
#   2. Create a Neon project + database
#   3. Create a Cloudflare R2 bucket + API token
#   4. Wire all environment variables into Vercel
#   5. Run migrations against the live Neon DB
#   6. Deploy production
#   7. Run end-to-end smoke
#
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

color()  { printf '\033[1;36m%s\033[0m\n' "$1"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$1"; }
red()    { printf '\033[1;31m%s\033[0m\n' "$1"; }
green()  { printf '\033[1;32m%s\033[0m\n' "$1"; }

pause_with_prompt() {
  local message="$1"
  echo
  yellow "▸ $message"
  read -r -p "Press Enter when done, or Ctrl-C to abort: " _
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    red "Missing required command: $1"
    exit 1
  fi
}

require_cmd vercel
require_cmd jq
require_cmd curl

# -----------------------------------------------------------------------------
color "=== Step 1: Vercel project ==="
# -----------------------------------------------------------------------------
echo "Linking this repo to a Vercel project under your Vercel team (set VERCEL_TEAM)."
echo "If the project doesn't exist, Vercel CLI will offer to create it."
echo "Project name suggestion: 'agentpack'"
echo
echo "Root directory: apps/registry"
echo "Build & install commands are read from apps/registry/vercel.json — do NOT"
echo "let the CLI override them with auto-detected values."
echo
pause_with_prompt "Run: cd apps/registry && vercel link --scope \"${VERCEL_TEAM:-<your-vercel-team>}\""

# -----------------------------------------------------------------------------
color "=== Step 2: Neon project ==="
# -----------------------------------------------------------------------------
cat <<'EOF'
Open https://console.neon.tech and create a new project:
  - Project name:       agentpack-registry
  - Postgres version:   16
  - Region:             AWS us-east-2 (closest to Vercel iad1)
  - Branch:             main

After creation, click the project → "Connection string" → "Pooled connection".
Copy that URL. It will look like:
  postgres://...@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require

That URL goes into DATABASE_URL in Vercel.
EOF
echo
read -r -p "Paste DATABASE_URL here (will be sent to Vercel env, NOT logged): " -s DATABASE_URL
echo
if [[ -z "${DATABASE_URL:-}" ]]; then
  red "DATABASE_URL is empty — aborting."
  exit 1
fi

# -----------------------------------------------------------------------------
color "=== Step 3: Cloudflare R2 bucket + token ==="
# -----------------------------------------------------------------------------
cat <<'EOF'
Open the Cloudflare dashboard → R2 → Buckets → "Create bucket":
  - Bucket name:   agentpack-artifacts
  - Location:      Automatic
  - Storage class: Standard

Then R2 → Manage R2 API Tokens → "Create API token":
  - Permissions:   Object Read & Write
  - Specify buckets: agentpack-artifacts (single-bucket scope)
  - TTL:           leave unset (the bucket lives as long as the registry)

Copy the four values it shows AFTER creating the token:
  - Access Key ID
  - Secret Access Key
  - Endpoint (looks like https://<account-id>.r2.cloudflarestorage.com)
  - Bucket name (you set it to "agentpack-artifacts")
EOF
echo
read -r -p "R2_ENDPOINT (https://<account-id>.r2.cloudflarestorage.com): " R2_ENDPOINT
read -r -p "R2_BUCKET [agentpack-artifacts]: " R2_BUCKET
R2_BUCKET="${R2_BUCKET:-agentpack-artifacts}"
read -r -p "R2_ACCESS_KEY_ID: " R2_ACCESS_KEY_ID
read -r -p "R2_SECRET_ACCESS_KEY (input hidden): " -s R2_SECRET_ACCESS_KEY
echo
if [[ -z "$R2_ENDPOINT" || -z "$R2_ACCESS_KEY_ID" || -z "$R2_SECRET_ACCESS_KEY" || -z "$R2_BUCKET" ]]; then
  red "One or more R2 fields are empty — aborting."
  exit 1
fi

# -----------------------------------------------------------------------------
color "=== Step 4: GitHub OAuth App ==="
# -----------------------------------------------------------------------------
cat <<EOF
Open https://github.com/settings/applications/new and create a new OAuth App:
  - Application name:           AgentPack
  - Homepage URL:               https://agentpack.dev  (or your Vercel URL)
  - Authorization callback URL: https://agentpack.dev/api/auth/callback/github
                                (use your real production URL here)

After clicking "Register application", you'll get a Client ID and a
"Generate a new client secret" button. Generate the secret and paste both:
EOF
echo
read -r -p "NEXT_PUBLIC_REGISTRY_URL (e.g. https://agentpack.dev): " REGISTRY_URL
read -r -p "AUTH_GITHUB_ID: " AUTH_GITHUB_ID
read -r -p "AUTH_GITHUB_SECRET (input hidden): " -s AUTH_GITHUB_SECRET
echo
AUTH_SECRET=$(openssl rand -hex 32)
green "Generated AUTH_SECRET: ${AUTH_SECRET:0:8}... (full value will be set in Vercel)"

# -----------------------------------------------------------------------------
color "=== Step 5: Wire all env into Vercel ==="
# -----------------------------------------------------------------------------
echo "Setting env vars in Vercel for production environment."
echo "You will be prompted for each — accept the auto-filled value."
echo
cd "$REPO_ROOT/apps/registry"

set_env() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | vercel env add "$name" production --force >/dev/null 2>&1 || \
    printf '%s' "$value" | vercel env add "$name" production
  green "  set $name"
}

set_env DATABASE_URL "$DATABASE_URL"
set_env AUTH_SECRET "$AUTH_SECRET"
set_env NEXT_PUBLIC_REGISTRY_URL "$REGISTRY_URL"
set_env AUTH_GITHUB_ID "$AUTH_GITHUB_ID"
set_env AUTH_GITHUB_SECRET "$AUTH_GITHUB_SECRET"
set_env R2_ENDPOINT "$R2_ENDPOINT"
set_env R2_BUCKET "$R2_BUCKET"
set_env R2_ACCESS_KEY_ID "$R2_ACCESS_KEY_ID"
set_env R2_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY"

cd "$REPO_ROOT"

# -----------------------------------------------------------------------------
color "=== Step 6: Run migrations against Neon ==="
# -----------------------------------------------------------------------------
echo "Pushing schema via Drizzle:"
echo
DATABASE_URL="$DATABASE_URL" pnpm --filter @agentpack/db db:push
green "✓ Migrations applied"

# -----------------------------------------------------------------------------
color "=== Step 7: Seed initial publishers ==="
# -----------------------------------------------------------------------------
echo "Importing the seed-packs.json into the live DB (so /packs renders)."
echo
DATABASE_URL="$DATABASE_URL" pnpm seed:import
green "✓ Seed imported"

# -----------------------------------------------------------------------------
color "=== Step 8: Production deploy ==="
# -----------------------------------------------------------------------------
echo
read -r -p "Ready to ship production? [y/N]: " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  yellow "Skipping production deploy. When ready: cd apps/registry && vercel --prod"
  exit 0
fi

cd "$REPO_ROOT/apps/registry"
PROD_URL=$(vercel --prod 2>&1 | tee /tmp/vercel-deploy.log | tail -n 1)
cd "$REPO_ROOT"
green "✓ Deployed: $PROD_URL"

# -----------------------------------------------------------------------------
color "=== Step 9: End-to-end smoke ==="
# -----------------------------------------------------------------------------
echo
echo "Run: REGISTRY_URL=\"$REGISTRY_URL\" ./scripts/smoke-e2e.sh"
echo
echo "If smoke is green, promote the package versions to 0.3.0:"
echo "  pnpm -r exec npm version 0.3.0 --no-git-tag-version --allow-same-version"
echo "  git add -A && git commit -m 'release: v0.3.0' && git tag v0.3.0 && git push --tags"
echo
green "Bring-up complete."
