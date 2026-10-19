#!/usr/bin/env bash
# Emails the operator when a systemd unit fails. Wired via
# `OnFailure=pet-wool-alert@%n.service`; the instance name is the failed unit.
#
# Uses curl's SMTP support so the notifier has no dependencies of its own: the
# whole point is to run when the application (and its node_modules) may be the
# thing that is broken. Credentials come from the project .env, never the unit
# file, so they stay in one place.
set -uo pipefail

FAILED_UNIT="${1:-unknown}"
ROOT_DIR="${PROJECT_ROOT_DIR:-/opt/pet-wool-platform}"

if [ -f "${ROOT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ROOT_DIR}/.env"
  set +a
fi

TO="${NOTIFY_ADMIN_EMAIL:-${SMTP_USER:-}}"
FROM="${SMTP_FROM:-${SMTP_USER:-}}"

# .env stores SMTP_FROM as a display-name address ("WoolBuddy <a@b.c>") and may
# carry the surrounding quotes. curl's --mail-from/--mail-rcpt take a bare
# address and answer 555 to anything else, so normalize both.
addr() {
  local value="$1"
  value="${value%\"}"
  value="${value#\"}"
  if [[ "${value}" =~ \<([^>]+)\> ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "${value}"
  fi
}
TO_ADDR="$(addr "${TO}")"
FROM_ADDR="$(addr "${FROM}")"

if [ -z "${TO_ADDR}" ] || [ -z "${SMTP_HOST:-}" ] || [ -z "${SMTP_PASS:-}" ]; then
  echo "notify-failure: SMTP_NOT_CONFIGURED (unit ${FAILED_UNIT} on $(hostname))" >&2
  exit 0
fi

SUBJECT="[WoolBuddy] unit failed: ${FAILED_UNIT} on $(hostname)"
MESSAGE="$(mktemp)"
trap 'rm -f "${MESSAGE}"' EXIT

{
  printf 'To: %s\r\n' "${TO}"
  printf 'From: %s\r\n' "${FROM}"
  printf 'Subject: %s\r\n' "${SUBJECT}"
  printf 'MIME-Version: 1.0\r\n'
  printf 'Content-Type: text/plain; charset=UTF-8\r\n'
  printf '\r\n'
  printf 'Failed unit: %s\r\n' "${FAILED_UNIT}"
  printf 'Host: %s\r\n' "$(hostname)"
  printf 'Time: %s\r\n' "$(date -Is)"
  printf '\r\n'
  systemctl status "${FAILED_UNIT}" --no-pager -l 2>&1 | head -40
  printf '\r\n--- journal (last 80 lines) ---\r\n'
  journalctl -u "${FAILED_UNIT}" -n 80 --no-pager 2>&1
} > "${MESSAGE}"

SMTP_URL="smtps://${SMTP_HOST}:${SMTP_PORT:-465}"
if [ "${SMTP_SECURE:-true}" = "false" ]; then
  SMTP_URL="smtp://${SMTP_HOST}:${SMTP_PORT:-587}"
fi

curl --silent --show-error --max-time 30 \
  --url "${SMTP_URL}" \
  --user "${SMTP_USER}:${SMTP_PASS}" \
  --mail-from "${FROM_ADDR}" \
  --mail-rcpt "${TO_ADDR}" \
  --upload-file "${MESSAGE}" || {
    echo "notify-failure: SEND_FAILED for ${FAILED_UNIT}" >&2
    exit 0
  }
echo "notify-failure: sent for ${FAILED_UNIT}"
