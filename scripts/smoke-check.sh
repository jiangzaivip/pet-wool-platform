#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8888}"
API_URL="${API_URL:-${BASE_URL}}"

echo "Checking public site: ${BASE_URL}"
curl -fsSI "${BASE_URL}/" >/dev/null
curl -fsSI "${BASE_URL}/blog" >/dev/null
curl -fsSI "${BASE_URL}/support" >/dev/null
ROBOTS_HEADERS="$(curl -fsSI "${BASE_URL}/robots.txt")"
SITEMAP_HEADERS="$(curl -fsSI "${BASE_URL}/sitemap.xml")"
curl -fsS "${BASE_URL}/robots.txt" | grep -F "Sitemap: " >/dev/null
curl -fsS "${BASE_URL}/sitemap.xml" | grep -F "<urlset" >/dev/null
node -e '
const [robots, sitemap] = process.argv.slice(1)
if (!robots.includes("text/plain")) throw new Error("robots.txt content type is invalid")
if (!/application\/xml|text\/xml/.test(sitemap)) throw new Error("sitemap.xml content type is invalid")
' "${ROBOTS_HEADERS}" "${SITEMAP_HEADERS}"
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
# Unknown frontend paths must 404. On the test topology nginx only proxies
# /api,/uploads,/health to the API and forwards everything else to Vite (which
# serves the SPA with 200), so probe the API origin directly. In production the
# API serves the frontend itself, where API_URL is the same origin.
API_ORIGIN="${API_ORIGIN:-${API_URL}}"
NOT_FOUND_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "${API_ORIGIN}/abc-test-404-987654321")"
if [ "${NOT_FOUND_STATUS}" != "404" ]; then
  echo "Expected an unknown frontend URL to return HTTP 404, got ${NOT_FOUND_STATUS}." >&2
  exit 1
fi
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

# --- 图标资源 ---
# The site shipped with no favicon and no manifest, so every page load and every
# crawler hit logged a 404 for both. A missing icon is invisible to an API
# contract gate, so pin the exact files and their content types here.
echo "Checking icons and manifest"
node -e '
const expected = {
  "/favicon.ico": "image/x-icon",
  "/favicon.svg": "image/svg+xml",
  "/apple-touch-icon.png": "image/png",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png",
  "/manifest.json": "application/json",
}
for (const [path, type] of Object.entries(expected)) {
  const res = await fetch(process.argv[1] + path, { signal: AbortSignal.timeout(10000) })
  const got = (res.headers.get("content-type") || "").split(";")[0].trim()
  if (res.status !== 200) throw new Error(`${path} returned ${res.status}, expected 200`)
  if (got !== type) throw new Error(`${path} content-type is ${got || "(none)"}, expected ${type}`)
}
' "${BASE_URL}"

# The SPA shell must advertise them, or a saved bookmark / crawler sees a bare page.
INDEX_HTML="$(curl -fsS "${BASE_URL}/")"
for needle in 'rel="icon"' 'rel="apple-touch-icon"' 'rel="manifest"' 'theme-color'; do
  case "${INDEX_HTML}" in
    *"${needle}"*) ;;
    *) echo "index.html is missing ${needle}" >&2; exit 1 ;;
  esac
done

# The manifest must be valid JSON with the icons it promises.
node -e '
const manifest = JSON.parse(process.argv[1])
if (!Array.isArray(manifest.icons) || !manifest.icons.length) throw new Error("manifest has no icons")
if (!manifest.name || !manifest.start_url) throw new Error("manifest is missing name/start_url")
for (const icon of manifest.icons) {
  if (!icon.src || !icon.sizes || !icon.type) throw new Error(`manifest icon is incomplete: ${JSON.stringify(icon)}`)
}
if (!manifest.icons.some((i) => i.purpose === "maskable")) throw new Error("manifest has no maskable icon")
' "$(curl -fsS "${BASE_URL}/manifest.json")"
curl -fsS -X POST "${API_URL}/api/bot/answer" \
  -H 'Content-Type: application/json' \
  --data '{"question":"价格是多少","lang":"zh"}' >/dev/null

echo "Smoke check passed."
