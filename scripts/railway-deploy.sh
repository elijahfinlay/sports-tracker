#!/usr/bin/env bash
# Run from the project root AFTER `railway login`.
# Idempotent — safe to re-run.

set -euo pipefail

if ! railway whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: railway login"; exit 1
fi

if [[ ! -f .railway-secrets.local ]]; then
  echo "Missing .railway-secrets.local — generate with:"
  echo '  node -e "const c=require(`crypto`); console.log(`SESSION_SECRET=`+c.randomBytes(32).toString(`hex`)); console.log(`ENCRYPTION_KEY=`+c.randomBytes(32).toString(`hex`));" > .railway-secrets.local'
  exit 1
fi

# Source the generated secrets
set -a; source .railway-secrets.local; set +a

# 1. Initialise (or relink) the project. Skips if already linked.
if ! railway status >/dev/null 2>&1; then
  echo "==> railway init"
  railway init --name sports-tracker
fi

echo "==> Adding persistent volume at /data"
railway volume add --mount-path /data || echo "(volume already exists, continuing)"

echo "==> Setting environment variables"
railway variables \
  --set "NODE_ENV=production" \
  --set "DATABASE_PATH=/data/sports.db" \
  --set "UPLOAD_DIR=/data/uploads" \
  --set "OSAA_API_BASE_URL=https://www.osaa.org/api" \
  --set "SESSION_SECRET=${SESSION_SECRET}" \
  --set "ENCRYPTION_KEY=${ENCRYPTION_KEY}" \
  --skip-deploys

echo "==> Deploying"
railway up --detach

echo ""
echo "Deploy started. Stream logs with:  railway logs"
echo "Open the dashboard with:           railway open"
echo ""
echo "After the first deploy succeeds, create the admin user:"
echo "  railway run npm run create-admin <username> <password>"
