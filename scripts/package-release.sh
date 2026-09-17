#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

STAMP="${RELEASE_STAMP:-$(date +%Y%m%d-%H%M%S)}"
RELEASE_DIR="${ROOT_DIR}/releases"
ARCHIVE="${RELEASE_DIR}/pet-wool-platform-release-${STAMP}.tar.gz"
CHECKSUM="${ARCHIVE}.sha256"

RELEASE_FILES=(
  package.json
  package-lock.json
  frontend/package.json
  frontend/package-lock.json
  frontend/dist
  frontend/src/currency.ts
  api-node/server.mjs
  api-node/currency.mjs
  api-node/payment-amounts.mjs
  scripts/backup-data.mjs
  scripts/backup-sql.mjs
  scripts/cleanup-e2e-data.mjs
  scripts/cleanup-orphan-uploads.mjs
  scripts/export-store-postgres.mjs
  scripts/migrate-json-to-postgres.mjs
  scripts/migrate-currency-krw.mjs
  scripts/verify-multicurrency.mjs
  scripts/paypal-live-check.mjs
  scripts/production-check.mjs
  scripts/restore-data.mjs
  scripts/smoke-check.sh
  start.sh
  stop.sh
  restart.sh
  install-systemd.sh
  deploy
  .env.deploy.example
  RELEASE_PACKAGE.md
  DEPLOY.md
)

echo "Building frontend..."
npm run build

for file in "${RELEASE_FILES[@]}"; do
  if [ ! -e "${ROOT_DIR}/${file}" ]; then
    echo "Missing release file: ${file}" >&2
    exit 1
  fi
done

mkdir -p "${RELEASE_DIR}"
rm -f "${ARCHIVE}" "${CHECKSUM}"

echo "Creating ${ARCHIVE}..."
tar -czf "${ARCHIVE}" "${RELEASE_FILES[@]}"
sha256sum "${ARCHIVE}" > "${CHECKSUM}"

echo "Release package: ${ARCHIVE}"
echo "SHA256 file:     ${CHECKSUM}"
du -h "${ARCHIVE}" | awk '{print "Package size:    " $1}'
