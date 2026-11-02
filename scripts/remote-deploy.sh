#!/usr/bin/env bash
# Runs on the VPS after the deploy workflow rsynced the sources into the app directory.
# Started by the deploy key's forced command (see docs/deploy-sapo.md), never by hand with a different cwd.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

env_value() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(grep -E "^${name}=" .env | tail -n 1 | cut -d '=' -f 2- | tr -d '\r "' || true)"
  fi
  printf '%s' "$value"
}

PORT_VALUE="$(env_value PORT)"
PORT_VALUE="${PORT_VALUE:-3000}"
READINESS_VALUE="$(env_value READINESS_TOKEN)"
if [ -z "$READINESS_VALUE" ]; then
  echo "READINESS_TOKEN is not set in the environment or in .env; /readyz cannot be probed" >&2
  exit 1
fi

# /readyz answers 200 with a status body once the token matches; only
# status "down" (Redis or database unreachable) fails the deploy. A
# "degraded" status reflects failures recorded before this deploy.
probe_ready() {
  PROBE_URL="http://127.0.0.1:${PORT_VALUE}/readyz" PROBE_TOKEN="$READINESS_VALUE" node -e '
    const http = require("http");
    const req = http.get(
      process.env.PROBE_URL,
      { headers: { authorization: "Bearer " + process.env.PROBE_TOKEN } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) process.exit(1);
          try {
            const status = JSON.parse(body).status;
            process.exit(status === "ok" || status === "degraded" ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      },
    );
    req.on("error", () => process.exit(1));
    req.setTimeout(5000, () => {
      req.destroy();
      process.exit(1);
    });
  ' >/dev/null 2>&1
}

trap 'rm -rf dist.next' EXIT

echo "Deploying commit $(cat DEPLOY_COMMIT)"
npm ci
npx prisma generate

# Snapshot the running build before anything else changes, so a
# failed start can be reverted to code that actually worked. The snapshot
# stays after a healthy deploy: it is the manual rollback target until the
# next deploy replaces it.
rm -rf dist.prev
if [ -d dist ]; then
  cp -a dist dist.prev
fi

npm run db:migrate

# Build beside the live dist: a failed build leaves dist untouched.
rm -rf dist.next
npm run build -- --outDir dist.next

if [ -d dist ]; then
  mv dist dist.old
fi
mv dist.next dist
rm -rf dist.old

BUILD_SHA="$(cat DEPLOY_COMMIT)" pm2 startOrReload ecosystem.config.cjs --update-env

api_ready=""
for _ in $(seq 1 20); do
  if probe_ready; then
    api_ready="yes"
    break
  fi
  sleep 3
done

if [ -z "$api_ready" ]; then
  echo "Post-reload /readyz probe failed; reverting to dist.prev" >&2
  if [ -d dist.prev ]; then
    rm -rf dist
    cp -a dist.prev dist
    BUILD_SHA="reverted-from-$(cat DEPLOY_COMMIT)" pm2 startOrReload ecosystem.config.cjs --update-env
  else
    echo "No previous build was available to restore" >&2
  fi
  exit 1
fi

pm2 save
echo "Deploy healthy: f1genz-sapo-api is online"
