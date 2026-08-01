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

SERVICE_NAME="${SERVICE_NAME:-pet-wool-platform}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Pet Wool Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=-${ROOT_DIR}/.env
Environment=HOST=0.0.0.0
Environment=PORT=8888
Environment=SERVE_FRONTEND=true
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
systemctl enable --now "${SERVICE_NAME}"
systemctl status "${SERVICE_NAME}" --no-pager
