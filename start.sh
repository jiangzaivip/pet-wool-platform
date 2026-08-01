#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 18 or newer first."
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "Node.js 18 or newer is required. Current version: $(node -v)"
  exit 1
fi

if [ -f "${ROOT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${ROOT_DIR}/.env"
  set +a
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8888}"
export SERVE_FRONTEND="${SERVE_FRONTEND:-true}"
export API_ROOT_DIR="${API_ROOT_DIR:-${ROOT_DIR}/api-node}"
export DATA_DIR="${DATA_DIR:-${ROOT_DIR}/api-node/data}"
export UPLOAD_DIR="${UPLOAD_DIR:-${ROOT_DIR}/api-node/uploads}"
export FRONTEND_DIST_DIR="${FRONTEND_DIST_DIR:-${ROOT_DIR}/frontend/dist}"

mkdir -p "${DATA_DIR}" "${UPLOAD_DIR}" "${ROOT_DIR}/logs"

if [ ! -f "${DATA_DIR}/store.json" ]; then
  echo "Missing data file: ${DATA_DIR}/store.json"
  exit 1
fi

if [ ! -f "${FRONTEND_DIST_DIR}/index.html" ]; then
  echo "Missing frontend build: ${FRONTEND_DIST_DIR}/index.html"
  exit 1
fi

PID_FILE="${ROOT_DIR}/pet-wool.pid"
if [ -f "${PID_FILE}" ]; then
  OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "Pet Wool Platform is already running. PID: ${OLD_PID}"
    echo "URL: http://127.0.0.1:${PORT}/"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

nohup node "${ROOT_DIR}/api-node/server.mjs" > "${ROOT_DIR}/logs/pet-wool.log" 2>&1 &
PID="$!"
echo "${PID}" > "${PID_FILE}"

sleep 1
if ! kill -0 "${PID}" 2>/dev/null; then
  echo "Service failed to start. Recent log:"
  tail -80 "${ROOT_DIR}/logs/pet-wool.log" || true
  rm -f "${PID_FILE}"
  exit 1
fi

echo "Pet Wool Platform started."
echo "PID: ${PID}"
echo "URL: http://127.0.0.1:${PORT}/"
echo "Admin: http://127.0.0.1:${PORT}/admin"
echo "Log: ${ROOT_DIR}/logs/pet-wool.log"
