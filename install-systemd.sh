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
# A crashed or restart-looping service used to be invisible: nothing was
# watching, and the structured log just stopped. OnFailure mails the operator.
OnFailure=pet-wool-alert@%n.service

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
# nginx overwrites X-Forwarded-For, so the API may trust it to derive the real
# client IP for rate limiting. Left empty, a client hitting the API port
# directly can spoof the header and escape throttling.
Environment=TRUST_PROXY_ADDRESSES=${TRUST_PROXY_ADDRESSES:-127.0.0.1}
ExecStart=${NODE_BIN} ${ROOT_DIR}/api-node/server.mjs
Restart=always
RestartSec=3

# Hardening. The API only ever writes to its own data/upload/log paths, so the
# rest of the filesystem can be read-only and the process cannot gain
# privileges or see other users' files.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=${ROOT_DIR}/api-node/data ${ROOT_DIR}/api-node/uploads ${ROOT_DIR}/logs
# Uploads are streamed with a hard size cap, but keep headroom for concurrency.
LimitNOFILE=8192
TasksMax=256

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
systemctl status "${SERVICE_NAME}" --no-pager
