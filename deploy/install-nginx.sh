#!/usr/bin/env bash
# Installs the repo-managed woolbuddy.shop vhost onto a production host.
#
# Usage (on the production host, as root):
#   sudo bash deploy/install-nginx.sh
#
# Idempotent: re-running replaces the vhost with the repo copy and reloads
# nginx only if `nginx -t` passes. It refuses to reload if the config is invalid,
# so a bad edit can never take the site down.
#
# Certbot also writes a vhost; this script owns the file, so re-run Certbot
# renewal only (never `certbot --nginx` for a new cert) or it will overwrite the
# hardened version with its own template.
set -euo pipefail

TARGET_SITE="${TARGET_SITE:-/etc/nginx/sites-enabled/woolbuddy.shop}"
CERTBOT_VHOST="/etc/nginx/sites-available/woolbuddy.shop"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nginx/woolbuddy.shop.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must run as root (it writes ${TARGET_SITE})." >&2
  exit 1
fi
if [ ! -f "${SOURCE}" ]; then
  echo "Missing source config: ${SOURCE}" >&2
  exit 1
fi

CERT_DIR="/etc/letsencrypt/live/woolbuddy.shop"
if [ ! -f "${CERT_DIR}/fullchain.pem" ]; then
  echo "TLS certificate not found at ${CERT_DIR}. Run Certbot before installing this vhost." >&2
  exit 1
fi

echo "Installing vhost from ${SOURCE} -> ${TARGET_SITE}"
install -m 0644 "${SOURCE}" "${TARGET_SITE}"

if [ -f "${CERTBOT_VHOST}" ] && ! cmp -s "${SOURCE}" "${CERTBOT_VHOST}"; then
  echo "Note: ${CERTBOT_VHOST} (Certbot's copy) now differs; this script owns ${TARGET_SITE}."
fi

echo "Validating nginx configuration..."
if ! nginx -t; then
  echo "nginx -t failed; the previous configuration is still live. Fix ${SOURCE} and re-run." >&2
  exit 1
fi

systemctl reload nginx
echo "nginx reloaded. Verify with: curl -sSI https://woolbuddy.shop/ | tr -d '\\r'"