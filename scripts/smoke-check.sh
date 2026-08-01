#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8888}"
API_URL="${API_URL:-${BASE_URL}}"

echo "Checking public site: ${BASE_URL}"
curl -fsSI "${BASE_URL}/" >/dev/null
curl -fsSI "${BASE_URL}/blog" >/dev/null
curl -fsSI "${BASE_URL}/support" >/dev/null
PUBLIC_HEADERS="$(curl -fsSI "${BASE_URL}/")"
DOC_HEADERS="$(curl -fsSI "${BASE_URL}/doc/")"
node -e '
const headers = process.argv[1].toLowerCase()
for (const required of [
  "x-content-type-options: nosniff",
  "x-frame-options: deny",
  "referrer-policy: strict-origin-when-cross-origin"
]) {
  if (!headers.includes(required)) throw new Error(`public site header missing: ${required}`)
}
' "${PUBLIC_HEADERS}"
node -e '
const headers = process.argv[1].toLowerCase()
for (const required of [
  "x-content-type-options: nosniff",
  "x-frame-options: deny",
  "referrer-policy: strict-origin-when-cross-origin"
]) {
  if (!headers.includes(required)) throw new Error(`doc site header missing: ${required}`)
}
' "${DOC_HEADERS}"

echo "Checking API: ${API_URL}"
HEALTH_JSON="$(curl -fsS "${API_URL}/health")"
node -e '
const health = JSON.parse(process.argv[1])
const counts = health.counts || {}
const required = ["categories", "products", "orders", "users", "payments"]
if (!health.ok || health.service !== "pet-wool-api") throw new Error("API health status is invalid")
if ("data_file" in health || "upload_dir" in health || JSON.stringify(health).includes("/root/")) {
  throw new Error("API health leaks server paths")
}
for (const key of required) {
  if (!Number.isFinite(Number(counts[key]))) throw new Error(`API health count ${key} is missing`)
}
' "${HEALTH_JSON}"
curl -fsS "${API_URL}/api/site" >/dev/null
curl -fsS "${API_URL}/api/categories" >/dev/null
curl -fsS "${API_URL}/api/blog" >/dev/null
curl -fsS -X POST "${API_URL}/api/bot/answer" \
  -H 'Content-Type: application/json' \
  --data '{"question":"价格是多少","lang":"zh"}' >/dev/null

echo "Smoke check passed."
