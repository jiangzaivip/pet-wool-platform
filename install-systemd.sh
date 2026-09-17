#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash install-systemd.sh"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  echo "Node.js is required. Install Node.js 18 or newer first."
  exit 1
fi
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "Node.js 18 or newer is required. Current version: $(node -v)"
  exit 1
fi

SERVICE_NAME="${SERVICE_NAME:-pet-wool-platform}"
SERVICE_HOST="${SERVICE_HOST:-${HOST:-0.0.0.0}}"
SERVICE_PORT="${SERVICE_PORT:-${PORT:-8888}}"
SERVICE_SERVE_FRONTEND="${SERVICE_SERVE_FRONTEND:-${SERVE_FRONTEND:-true}}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Pet Wool Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=-${ROOT_DIR}/.env
Environment=NODE_ENV=production
Environment=HOST=${SERVICE_HOST}
Environment=PORT=${SERVICE_PORT}
Environment=SERVE_FRONTEND=${SERVICE_SERVE_FRONTEND}
Environment=API_ROOT_DIR=${ROOT_DIR}/api-node
Environment=DATA_DIR=${ROOT_DIR}/api-node/data
Environment=UPLOAD_DIR=${ROOT_DIR}/api-node/uploads
Environment=FRONTEND_DIST_DIR=${ROOT_DIR}/frontend/dist
ExecStart=${NODE_BIN} ${ROOT_DIR}/api-node/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
systemctl status "${SERVICE_NAME}" --no-pager
