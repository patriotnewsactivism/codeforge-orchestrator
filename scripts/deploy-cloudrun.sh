#!/usr/bin/env bash
#
# Deploy the CodeForge orchestrator to Google Cloud Run.
#
# Run this in Google Cloud Shell (https://shell.cloud.google.com) — gcloud is
# already authenticated there, so there is nothing to install.
#
#   curl -sL https://raw.githubusercontent.com/patriotnewsactivism/codeforge-orchestrator/main/scripts/deploy-cloudrun.sh | bash
#
# What it does:
#   1. enables the APIs Cloud Run needs
#   2. builds the repo's Dockerfile with Cloud Build
#   3. deploys as an always-on service (min-instances=1, CPU always allocated)
#      — required because the orchestrator is a background poller, not a
#        request handler. A scale-to-zero service would stop polling.
#   4. prints the health endpoint so you can confirm the model routing table
#
# Cost note: one always-on instance at 1 vCPU / 512Mi. That is a real, ongoing
# charge (roughly the price of a coffee or two per month at idle). Scale-to-zero
# is not an option for a poller. Delete with:
#   gcloud run services delete codeforge-orchestrator --region "$REGION"

set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-codeforge-orchestrator}"
REPO_URL="https://github.com/patriotnewsactivism/codeforge-orchestrator.git"

# ── Config: points at the PRODUCTION Convex deployment ───────────────────────
CONVEX_URL="${CONVEX_URL:-https://useful-capybara-447.convex.site}"
ORCH_SECRET="${ORCH_SECRET:-5UTdB0_1xs4T-2cs6H4NQxDAOfwcK7gXyl5T-D4uD7s}"
VIKTOR_API_URL="${VIKTOR_API_URL:-https://api.viktor.com}"
VIKTOR_PROJECT_NAME="${VIKTOR_PROJECT_NAME:-codeforge-v2}"
VIKTOR_PROJECT_SECRET="${VIKTOR_PROJECT_SECRET:-FBURyo5KzqZZR474R4orHcWJ3pY00TANJnPXjeRwgdg}"

# Optional — set these to turn on multi-model routing / git features:
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "ERROR: no gcloud project set. Run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

echo "==> Project: $PROJECT_ID   Region: $REGION   Service: $SERVICE"

echo "==> Enabling required APIs (safe to re-run)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com --quiet

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
echo "==> Cloning orchestrator"
git clone --depth 1 "$REPO_URL" "$WORKDIR/src" --quiet
cd "$WORKDIR/src"
echo "    HEAD: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# Build the env var list, skipping empties so we never set a blank key.
ENV_VARS="CONVEX_URL=${CONVEX_URL}"
ENV_VARS="${ENV_VARS},RAILWAY_ORCHESTRATOR_SECRET=${ORCH_SECRET}"
ENV_VARS="${ENV_VARS},VIKTOR_SPACES_API_URL=${VIKTOR_API_URL}"
ENV_VARS="${ENV_VARS},VIKTOR_SPACES_PROJECT_NAME=${VIKTOR_PROJECT_NAME}"
ENV_VARS="${ENV_VARS},VIKTOR_SPACES_PROJECT_SECRET=${VIKTOR_PROJECT_SECRET}"
ENV_VARS="${ENV_VARS},POLL_INTERVAL=3000"
ENV_VARS="${ENV_VARS},MAX_AGENT_DEPTH=4"
ENV_VARS="${ENV_VARS},MAX_CONCURRENT_AGENTS=8"
ENV_VARS="${ENV_VARS},MAX_RETRY_LOOPS=5"
[[ -n "$OPENROUTER_API_KEY" ]] && ENV_VARS="${ENV_VARS},OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
[[ -n "$GITHUB_REPO"        ]] && ENV_VARS="${ENV_VARS},GITHUB_REPO=${GITHUB_REPO}"
[[ -n "$GITHUB_TOKEN"       ]] && ENV_VARS="${ENV_VARS},GITHUB_TOKEN=${GITHUB_TOKEN}"

echo "==> Building + deploying to Cloud Run (this takes a few minutes)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --no-cpu-throttling \
  --cpu 1 \
  --memory 512Mi \
  --timeout 3600 \
  --set-env-vars "$ENV_VARS" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
echo
echo "==> Deployed: $URL"

echo "==> Waiting for the health endpoint to report its model routing table"
for i in $(seq 1 20); do
  BODY="$(curl -fsS -m 10 "$URL" 2>/dev/null || true)"
  if echo "$BODY" | grep -q modelRouting; then
    echo "    healthy after ${i} attempt(s):"
    echo "$BODY" | head -c 1200
    echo
    echo "==> SUCCESS. Paste the block above back to Viktor in #codeforge."
    exit 0
  fi
  sleep 6
done

echo "!! Service deployed but /health never reported modelRouting." >&2
echo "   Grab logs with:" >&2
echo "   gcloud run services logs read $SERVICE --region $REGION --limit 80" >&2
exit 1
