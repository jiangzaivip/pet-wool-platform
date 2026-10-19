#!/usr/bin/env bash
# Pulls the production backups into an off-host directory.
#
# Every backup used to live on the same disk as the database it protects: a lost
# VM meant a lost database and lost photos together. This runs on a second host
# and copies the dumps, the uploads tarball and the data archives over SSH, then
# prunes by age locally.
#
# Run from the secondary host, e.g.:
#   DEPLOY_KEY=/root/pet-wool-platform/.deploy/production_ed25519 \
#   PROD_HOST=ubuntu@43.155.164.232 \
#   OFFSITE_DIR=/root/pet-wool-offsite \
#   bash scripts/offsite-backup-pull.sh
set -euo pipefail

DEPLOY_KEY="${DEPLOY_KEY:?set DEPLOY_KEY to the ssh key for the production host}"
PROD_HOST="${PROD_HOST:?set PROD_HOST, e.g. ubuntu@203.0.113.10}"
PROD_DIR="${PROD_DIR:-/opt/pet-wool-platform}"
OFFSITE_DIR="${OFFSITE_DIR:-/root/pet-wool-offsite}"
KEEP_DAYS="${KEEP_DAYS:-21}"

STAGE="${OFFSITE_DIR}/incoming"
mkdir -p "${STAGE}" "${OFFSITE_DIR}/snapshots"
chmod 0700 "${OFFSITE_DIR}" "${STAGE}" "${OFFSITE_DIR}/snapshots"

# Stream a tar of the backup directories straight out of the production host.
# sudo is needed because the dumps are 0600 root-owned on purpose.
ssh -i "${DEPLOY_KEY}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "${PROD_HOST}" \
  "sudo -n tar -C '${PROD_DIR}/api-node' -czf - sql-backups backups 2>/dev/null" \
  | tar -C "${STAGE}" -xzf -

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
SNAPSHOT="${OFFSITE_DIR}/snapshots/${STAMP}"
mkdir -p "${SNAPSHOT}"
for part in sql-backups backups; do
  [ -d "${STAGE}/${part}" ] && mv "${STAGE}/${part}" "${SNAPSHOT}/"
done
chmod -R 0700 "${SNAPSHOT}"

LATEST_SQL="$(find "${SNAPSHOT}/sql-backups" -name 'store-*.sql' -printf '%s %p\n' | sort -rn | head -1)"
if [ -z "${LATEST_SQL}" ]; then
  echo "offsite-backup: no store-*.sql in the snapshot — treating as failure" >&2
  exit 1
fi
echo "offsite-backup: ${STAMP} ok ($(du -sh "${SNAPSHOT}" | cut -f1), newest dump $(echo "${LATEST_SQL}" | cut -d' ' -f1) bytes)"

# Prune old snapshots, always keeping the newest three.
mapfile -t OLD < <(find "${OFFSITE_DIR}/snapshots" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" | sort | head -n -3)
for dir in "${OLD[@]:-}"; do
  if [ -n "${dir}" ]; then
    rm -rf "${dir}"
  fi
done
exit 0
