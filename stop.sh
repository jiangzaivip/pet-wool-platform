#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/pet-wool.pid"

if [ ! -f "${PID_FILE}" ]; then
  echo "Pet Wool Platform is not running: PID file not found."
  exit 0
fi

PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
if [ -z "${PID}" ] || ! kill -0 "${PID}" 2>/dev/null; then
  rm -f "${PID_FILE}"
  echo "Pet Wool Platform is not running."
  exit 0
fi

kill "${PID}"
for _ in $(seq 1 20); do
  if ! kill -0 "${PID}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    echo "Pet Wool Platform stopped."
    exit 0
  fi
  sleep 0.5
done

echo "Service did not stop in time. Sending SIGKILL."
kill -9 "${PID}" 2>/dev/null || true
rm -f "${PID_FILE}"
echo "Pet Wool Platform stopped."
