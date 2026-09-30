#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

: "${DEPLOY_HOST:?Set DEPLOY_HOST to the intended production host before deploying}"
REMOTE_HOST="${DEPLOY_HOST}"
REMOTE_USER="${DEPLOY_USER:-ubuntu}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/pet-wool-platform}"
SERVICE_NAME="${DEPLOY_SERVICE_NAME:-pet-wool-platform}"
SERVICE_HOST="${DEPLOY_SERVICE_HOST:-0.0.0.0}"
SERVICE_PORT="${DEPLOY_PORT:-8888}"
SERVICE_SERVE_FRONTEND="${DEPLOY_SERVE_FRONTEND:-true}"
KEY_FILE="${DEPLOY_KEY:-${ROOT_DIR}/.deploy/production_ed25519}"
ENV_FILE="${DEPLOY_ENV_FILE:-${ROOT_DIR}/.env}"
BOOTSTRAP_DATA="${DEPLOY_BOOTSTRAP_DATA:-false}"
UPDATE_ENV="${DEPLOY_UPDATE_ENV:-false}"
SKIP_BUILD="${DEPLOY_SKIP_BUILD:-false}"
SSH_OPTS=(-i "${KEY_FILE}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

if [ ! -f "${KEY_FILE}" ]; then
  echo "Missing deployment key: ${KEY_FILE}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required locally to build the frontend." >&2
  exit 1
fi

if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)"; then
  echo "Node.js 22.18 or newer is required locally for the locked frontend toolchain." >&2
  echo "The production runtime itself may use Node.js 18 or newer." >&2
  exit 1
fi

case "${SERVICE_PORT}" in
  ''|*[!0-9]*) echo "DEPLOY_PORT must be numeric." >&2; exit 1 ;;
esac
case "${SKIP_BUILD}" in
  true|false) ;;
  *) echo "DEPLOY_SKIP_BUILD must be true or false." >&2; exit 1 ;;
esac

if [ "${SKIP_BUILD}" = "true" ]; then
  if [ ! -f "${ROOT_DIR}/frontend/dist/index.html" ]; then
    echo "DEPLOY_SKIP_BUILD=true requires an existing frontend/dist/index.html." >&2
    exit 1
  fi
  echo "Skipping frontend build; using existing frontend/dist."
else
  echo "Installing locked frontend dependencies..."
  npm ci --prefix frontend --ignore-scripts
  echo "Building frontend..."
  npm run build
fi

RELEASE_TAR="$(mktemp /tmp/pet-wool-release.XXXXXX.tar.gz)"
REMOTE_TMP="/tmp/pet-wool-release-${USER:-deploy}-$$.tar.gz"
REMOTE_ENV_TMP="/tmp/pet-wool-env-${USER:-deploy}-$$"
REMOTE_BACKUP="/tmp/pet-wool-backup-${USER:-deploy}-$$.tar.gz"
trap 'rm -f "${RELEASE_TAR}"' EXIT

RELEASE_FILES=(
  package.json package-lock.json
  frontend/package.json frontend/package-lock.json frontend/dist
  api-node/server.mjs
  api-node/currency.mjs
  api-node/payment-amounts.mjs
  api-node/shipping.mjs
  api-node/client-reports.mjs
  frontend/src/currency.ts
  scripts/backup-data.mjs
  scripts/backup-sql.mjs
  scripts/cleanup-e2e-data.mjs
  scripts/cleanup-orphan-uploads.mjs
  scripts/export-store-postgres.mjs
  scripts/migrate-currency-krw.mjs
  scripts/migrate-json-to-postgres.mjs
  scripts/verify-multicurrency.mjs
  scripts/paypal-live-check.mjs
  scripts/production-check.mjs
  scripts/restore-data.mjs
  scripts/smoke-check.sh
  scripts/verify-core.mjs
  scripts/verify-i18n.mjs
  scripts/verify-admin-console.mjs
  # server.mjs statically imports shipping.mjs and client-reports.mjs; leaving
  # either out of the release makes the API fail to boot on the target host.
  scripts/verify-module-imports.mjs
  # Self-contained: spins up its own API against a temp store, so it can run on
  # the target host to prove the release actually boots and settles payments.
  scripts/verify-payment-amounts.mjs
  scripts/verify-webhook-idempotency.mjs
  # verify-production-start-check.mjs is intentionally NOT published: it rewrites
  # the project .env while probing refusal cases, which has no place on a host
  # that holds live credentials. It runs from the development machine instead.
  scripts/verify-production-start.mjs
  scripts/cleanup-production-test-data.mjs
  scripts/remove-test-fixtures.mjs
  scripts/generate-icons.py
  deploy/nginx/woolbuddy.shop.conf
  deploy/install-nginx.sh
  start.sh stop.sh restart.sh install-systemd.sh
  deploy
  deploy.sh
  .env.deploy.example
)
if [ "${BOOTSTRAP_DATA}" = "true" ]; then
  RELEASE_FILES+=(api-node/data/store.json api-node/uploads)
fi
tar -czf "${RELEASE_TAR}" "${RELEASE_FILES[@]}"

if [ "${UPDATE_ENV}" = "true" ] && [ ! -f "${ENV_FILE}" ]; then
  echo "DEPLOY_UPDATE_ENV=true requires DEPLOY_ENV_FILE: ${ENV_FILE}" >&2
  exit 1
fi
if [ "${BOOTSTRAP_DATA}" = "true" ] && [ ! -f "${ROOT_DIR}/api-node/data/store.json" ]; then
  echo "DEPLOY_BOOTSTRAP_DATA=true requires local api-node/data/store.json" >&2
  exit 1
fi

echo "Checking remote runtime and target..."
REMOTE_ENV_EXISTS="$(ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "sudo test -f '${REMOTE_DIR}/.env' && echo true || echo false")"
ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" \
  "REMOTE_DIR='${REMOTE_DIR}' SERVICE_NAME='${SERVICE_NAME}' SERVICE_PORT='${SERVICE_PORT}' BOOTSTRAP_DATA='${BOOTSTRAP_DATA}' REMOTE_ENV_EXISTS='${REMOTE_ENV_EXISTS}' CAN_UPLOAD_ENV='$([ -f "${ENV_FILE}" ] && echo true || echo false)' bash -s" <<'REMOTE_PREFLIGHT'
set -euo pipefail

sudo -n true 2>/dev/null || {
  echo "Passwordless sudo is required for the remote deployment user." >&2
  exit 1
}

command -v node >/dev/null 2>&1 || {
  echo "Node.js is missing on the remote host." >&2
  exit 1
}
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"; then
  echo "Node.js 18 or newer is required on the remote host." >&2
  exit 1
fi

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  :
elif ss -ltn 2>/dev/null | grep -Eq "[.:]${SERVICE_PORT}[[:space:]]"; then
  echo "Target port ${SERVICE_PORT} is already used by another process." >&2
  echo "Set DEPLOY_SERVICE_NAME/DEPLOY_PORT deliberately or stop the conflicting service." >&2
  exit 1
fi

if sudo test -d "${REMOTE_DIR}" && [ "${REMOTE_ENV_EXISTS}" != "true" ] && [ "${CAN_UPLOAD_ENV}" != "true" ]; then
  echo "Remote .env is missing: ${REMOTE_DIR}/.env" >&2
  echo "Provide DEPLOY_ENV_FILE for the first deployment." >&2
  exit 1
fi

if sudo test -d "${REMOTE_DIR}" && ! sudo test -f "${REMOTE_DIR}/api-node/data/store.json" && [ "${BOOTSTRAP_DATA}" != "true" ]; then
  echo "Remote production data is missing: ${REMOTE_DIR}/api-node/data/store.json" >&2
  echo "Use DEPLOY_BOOTSTRAP_DATA=true only for an intentional first data install." >&2
  exit 1
fi
if ! sudo test -d "${REMOTE_DIR}" && [ "${BOOTSTRAP_DATA}" != "true" ]; then
  echo "Remote target does not exist and no bootstrap data was requested." >&2
  echo "Use DEPLOY_BOOTSTRAP_DATA=true only for an intentional first data install." >&2
  exit 1
fi
REMOTE_PREFLIGHT

echo "Uploading release..."
scp "${SSH_OPTS[@]}" "${RELEASE_TAR}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_TMP}"
ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "chmod 600 '${REMOTE_TMP}'"
if [ "${UPDATE_ENV}" = "true" ] || [ "${REMOTE_ENV_EXISTS}" != "true" ]; then
  if [ ! -f "${ENV_FILE}" ]; then
    echo "Local deployment env is missing: ${ENV_FILE}" >&2
    exit 1
  fi
  scp "${SSH_OPTS[@]}" "${ENV_FILE}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_ENV_TMP}"
  ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "chmod 600 '${REMOTE_ENV_TMP}'"
fi

echo "Installing release..."
ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" \
  "REMOTE_DIR='${REMOTE_DIR}' REMOTE_TMP='${REMOTE_TMP}' REMOTE_ENV_TMP='${REMOTE_ENV_TMP}' REMOTE_BACKUP='${REMOTE_BACKUP}' SERVICE_NAME='${SERVICE_NAME}' SERVICE_HOST='${SERVICE_HOST}' SERVICE_PORT='${SERVICE_PORT}' SERVICE_SERVE_FRONTEND='${SERVICE_SERVE_FRONTEND}' UPDATE_ENV='${UPDATE_ENV}' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail
umask 077

backup_exists=false
deploy_ok=false
rollback() {
  # Runs on every exit path, including the explicit `exit 1` below. A plain
  # `exit` does NOT fire the ERR trap, so the previous release used to stay
  # broken on disk while the script reported failure: the site was left down
  # until someone restored it by hand. An EXIT trap keyed on deploy_ok covers
  # both error exits and explicit exits.
  if [ "${deploy_ok}" = "true" ] || [ "${backup_exists}" != "true" ]; then
    return
  fi
  echo "Deployment verification failed; restoring previous release..." >&2
  sudo systemctl stop "${SERVICE_NAME}" || true
  sudo rm -rf "${REMOTE_DIR}"
  sudo mkdir -p "${REMOTE_DIR}"
  sudo tar -xzf "${REMOTE_BACKUP}" -C "${REMOTE_DIR}"
  sudo env SERVICE_NAME="${SERVICE_NAME}" SERVICE_HOST="${SERVICE_HOST}" SERVICE_PORT="${SERVICE_PORT}" SERVICE_SERVE_FRONTEND="${SERVICE_SERVE_FRONTEND}" bash "${REMOTE_DIR}/install-systemd.sh" >/tmp/pet-wool-rollback.log 2>&1 || true
  echo "Previous release restored. Details: /tmp/pet-wool-rollback.log" >&2
}
trap rollback EXIT

if [ -d "${REMOTE_DIR}" ]; then
  sudo tar -czf "${REMOTE_BACKUP}" -C "${REMOTE_DIR}" .
  backup_exists=true
  echo "Previous release backed up at ${REMOTE_BACKUP}"
fi

sudo mkdir -p "${REMOTE_DIR}"
sudo tar -xzf "${REMOTE_TMP}" -C "${REMOTE_DIR}"
rm -f "${REMOTE_TMP}"

if [ "${UPDATE_ENV}" = "true" ] || ! sudo test -f "${REMOTE_DIR}/.env"; then
  if [ ! -f "${REMOTE_ENV_TMP}" ]; then
    echo "No deployment env was uploaded for ${REMOTE_DIR}/.env" >&2
    exit 1
  fi
  sudo install -m 0600 "${REMOTE_ENV_TMP}" "${REMOTE_DIR}/.env"
  rm -f "${REMOTE_ENV_TMP}"
fi

if ! sudo test -f "${REMOTE_DIR}/.env"; then
  echo "Production .env is required; refusing to create insecure defaults." >&2
  exit 1
fi
if ! sudo test -f "${REMOTE_DIR}/api-node/data/store.json"; then
  echo "Production store.json is required; refusing to start an empty store." >&2
  exit 1
fi

sudo npm ci --prefix "${REMOTE_DIR}" --omit=dev --ignore-scripts

# Boot the API once with the real production environment before touching the
# live service. assertProductionRuntime only runs under NODE_ENV=production, so
# every other gate can pass while production still refuses to start.
sudo bash -c 'set -a; . "$1"; set +a; export PROJECT_ROOT_DIR="$2"; node "$3"' \
  _ "${REMOTE_DIR}/.env" "${REMOTE_DIR}" "${REMOTE_DIR}/scripts/verify-production-start.mjs"

sudo bash -c 'set -a; . "$1"; set +a; export NODE_ENV=production PROJECT_ROOT_DIR="$2"; node "$3"' \
  _ "${REMOTE_DIR}/.env" "${REMOTE_DIR}" "${REMOTE_DIR}/scripts/production-check.mjs"
sudo bash -c 'set -a; . "$1"; set +a; export NODE_ENV=production PROJECT_ROOT_DIR="$2"; node "$3"' \
  _ "${REMOTE_DIR}/.env" "${REMOTE_DIR}" "${REMOTE_DIR}/scripts/paypal-live-check.mjs"

sudo env \
  SERVICE_NAME="${SERVICE_NAME}" \
  SERVICE_HOST="${SERVICE_HOST}" \
  SERVICE_PORT="${SERVICE_PORT}" \
  SERVICE_SERVE_FRONTEND="${SERVICE_SERVE_FRONTEND}" \
  bash "${REMOTE_DIR}/install-systemd.sh"

for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error "http://127.0.0.1:${SERVICE_PORT}/health" >/dev/null; then
    break
  fi
  if [ "${attempt}" -eq 20 ]; then
    echo "Health check failed after service start." >&2
    exit 1
  fi
  sleep 1
done

BASE_URL="http://127.0.0.1:${SERVICE_PORT}" API_URL="http://127.0.0.1:${SERVICE_PORT}" bash "${REMOTE_DIR}/scripts/smoke-check.sh"
deploy_ok=true
echo "Deployment verified: ${SERVICE_NAME} on port ${SERVICE_PORT}"
REMOTE_SCRIPT
