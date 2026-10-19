# pet-wool-platform (WoolBuddy) — Agent Instructions

Pet wool-felt customization e-commerce site (宠物羊毛毡定制平台). Monorepo: `frontend/` is a Vue 3 + Vite + TypeScript storefront and `/admin` console; `api-node/` is the live API — one Node.js native-HTTP server (`server.mjs`, ~5.5k lines) over a JSON file store. `backend/` (Rust) and `docker-compose.yml` are early drafts, not used in current production. Docs and commit messages are mostly Chinese.

## Commands (verified in root `package.json`)

- Install: `npm install` then `npm --prefix frontend install`
- Build frontend: `npm run build` (runs `vite build` via `--prefix frontend`; does NOT type-check — run `npm --prefix frontend run typecheck` separately; no linter configured)
- Quick gate (pre-deploy, ~3s): `npm run verify:core` (= `node scripts/verify-core.mjs`) — API contracts + page render smoke, no fragile text assertions, no data writes. Non-zero exit on any failure.
- Quick gate without browser: `SKIP_BROWSER=1 npm run verify:core`
- Smoke check: `npm run smoke` (`scripts/smoke-check.sh`; override target with `BASE_URL=`/`API_URL=`/`API_ORIGIN=` env vars — `API_ORIGIN` defaults to `API_URL`, set it to `http://127.0.0.1:8082` when the site is served on a different origin)
- Currency/payment invariants: `npm run test:currency` (three verify scripts; needs `node --experimental-strip-types` because they import `frontend/src/currency.ts` directly)
- Admin console verify: `npm run test:admin`
- Translation key parity: `npm run test:i18n` (needs `node --experimental-strip-types`; fails if en/ko miss a customer-facing zh key)
- API module imports: `npm run test:imports` — `node --check` only parses one file and never resolves import targets, so a module that exports a name it forgot to mark with `export` passes it and then kills the process on boot. This script parses `server.mjs`'s local imports and verifies each imported symbol actually exists.
- Checkout display check: `node --experimental-strip-types scripts/verify-checkout-display.mjs` (not wired into any npm script; also imports `frontend/src/currency.ts`, so it needs the same flag)
- Full E2E: `npm run test:e2e` (`node test-results/e2e-check.mjs`, Playwright)
- Pre-deploy checks: `npm run production:check` and `npm run production:paypal-check`
- Production-start gate: `npm run test:prod-start` (proves `scripts/verify-production-start.mjs` really refuses a bad config; deploy.sh runs the checker itself before touching the live service)
- Release archive: `npm run release:package` (`scripts/package-release.sh` → `releases/pet-wool-platform-release-<stamp>.tar.gz` + `.sha256`; needs a built `frontend/dist/`)

## Running services (this host is the deploy box)

- systemd units: `pet-wool-frontend-dev` (Vite on 127.0.0.1:5173), `pet-wool-api` (Node API on 127.0.0.1:8082); nginx listens on 8888 and proxies `/` → Vite, `/api`, `/uploads`, `/health` → API
- nginx proxies the Vite **dev server**, so edits to `frontend/src` go live on 8888 without a build; `frontend/dist/` only matters for deploy
- After `api-node/` or data-structure changes: `systemctl restart pet-wool-api`
- Health: `curl -s http://127.0.0.1:8082/health`

## Data — treat as production

- The live database is `api-node/data/store.json` (gitignored). Never hand-edit it while `pet-wool-api` is running; change data via the admin console or scripts.
- Back up before bulk changes or release: `node scripts/backup-data.mjs` → `api-node/backups/<timestamp>/` (store.json + uploads; keep last 10, `BACKUP_KEEP` to change). A daily `pet-wool-backup.timer` does this automatically. Restore: `node scripts/restore-data.mjs --dry-run <dir>` then `--apply <dir>` — if the live store is already corrupt the pre-restore backup fails, and the damaged file is kept as `store.json.<ts>.corrupt` instead of aborting.
- E2E and cleanup scripts auto-clean test data with prefixes `commercial-`, `unpaid-`, `blocked-`, `hidden-`, `commercial-check-*`; manual cleanup: `node scripts/cleanup-e2e-data.mjs --apply --confirm-e2e-cleanup` (preview without flags).
- Postgres is optional (`STORE_BACKEND=postgres` + `DATABASE_URL` in `.env`); default is JSON. Migration export: `npm run export:postgres`.

## Conventions

- Money is integer minor units in `*_cents` fields; the currency base is KRW with fixed rates (`fixed-krw-v1`).
- The currency table is deliberately duplicated: `frontend/src/currency.ts` and `api-node/currency.mjs` must export identical `CURRENCY_RATE_VERSION`, `CURRENCY_BASE`, `CURRENCY_RATES`, `CURRENCY_DECIMALS`, `LANG_CURRENCY` — `npm run test:currency` fails on drift. Server payment snapshots are authoritative; client display conversion is an estimate.
- All browser-side API calls, token handling, and error normalization go through `frontend/src/api.ts` — views must not bypass it.
- In `api-node/server.mjs`, keep env/filesystem path derivation in the config block at the top; the server auto-loads `.env` from the project root.
- `store.json` is a process-wide singleton cached in memory; read-modify-write goes through `saveStore`/`withStore` and must not be reordered. Loading the file per request silently lost concurrent orders.
- `X-Forwarded-For` is trusted only when `TRUST_PROXY_ADDRESSES` lists the proxy address (empty by default) — otherwise anyone can mint a fresh rate-limit bucket per request.
- i18n keys: `npm run test:i18n` enforces that en/ko cover every customer-facing zh key; `admin.*` is intentionally Chinese-only.
- PayPal credentials (Client ID/Secret/Webhook ID, mode, currency) are configured in the admin dashboard site config, never in `.env` — only technical switches like `PAYPAL_MOCK`, `PAYPAL_TIMEOUT_MS` live there.
- Commit messages: short one-line summaries, typically Chinese.

## Deploy

`bash deploy.sh` is the only release path (see `DEPLOY.md`); the target must be explicit via `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_DIR`, `DEPLOY_KEY`, `DEPLOY_ENV_FILE`. Never set `DEPLOY_BOOTSTRAP_DATA=true` on an existing server; `DEPLOY_SKIP_BUILD=true` only when `frontend/dist/` is already built from verified source. Old docs describing manual copy-to-`/var/www` are obsolete.

## Pitfalls

- No unit-test framework or linter — verification means the verify scripts plus smoke/E2E against running services; E2E restarts systemd units, so it must run as root on the deploy host.
- `test-results/e2e-check.mjs` hardcodes absolute `/root/pet-wool-platform/...` paths — it only works from this deployment location.
- E2E mutates the real `store.json` (it snapshots/restores around payment tests) — don't run it against a server you can't afford to disturb, and clean up test data afterwards.
- `api-node/backups/` may contain PayPal Secret/Webhook ID — treat as sensitive; never commit (already gitignored) and use the admin "脱敏备份" export for third parties.
- `npm run smoke` now hard-requires `frontend/public/robots.txt` (must contain a `Sitemap: ` line), `frontend/public/sitemap.xml`, and nginx's `/doc/` (served from `site-doc/`) — a missing file there fails the smoke check, not the build.
- `.env` files are gitignored except `*.example` templates; admin default login in dev is `admin@example.com` / `admin123456` and must be replaced before production.
- With `NODE_ENV=production` the API refuses to start unless PayPal is live with a webhook ID, `PUBLIC_BASE_URL` is HTTPS, `GOOGLE_DEMO_LOGIN` is off, the admin password is not the published default, and `USER_TOKEN_SECRET` is set. PayPal is currently sandbox, so a production start fails by design.
- New `api-node/*.mjs` must export every symbol `server.mjs` imports, and must not read module-scope values declared further down (TDZ crash at boot). `npm run test:imports` covers both.
- Guest checkout has no user token: the buyer's proof of ownership is `x-payment-secret` (from `/paypal/create-order`) or, for the first payment, `x-order-secret` (the order's `client_request_id`). These proofs are OR-ed — combining them with `||` or `find(Boolean)` short-circuits on the first rejection string and wrongly denies callers holding the other valid proof.
- `api-node/backups/` holds customer PII and the PayPal Secret; files are chmod 0600 and the directory 0700. A daily `pet-wool-backup.timer` writes them. Its unit must not set `ProtectHome=true` (the project lives under `/root`, and the service dies with 200/CHDIR).
- Systemd drop-in dirs under `/etc/systemd/system/<unit>.service.d/` are ignored on this host; edit the unit file itself.
- `deploy.sh` rolls back via `trap rollback EXIT`, not `ERR`: the health check ends in `exit 1`, which never fires an ERR trap. Do not "simplify" it back.
- `assertProductionRuntime` only runs under `NODE_ENV=production`, so no local gate exercises it. Run `scripts/verify-production-start.mjs` on the deploy host; it is wired into deploy.sh for exactly this reason.
- The release file list in `deploy.sh` is explicit — a new script is not deployed until it is added to `RELEASE_FILES`. `verify:core` now asserts every `api-node/*.mjs` appears there, because a missing module makes the remote API fail to boot, not degrade.
- Verify scripts can pass a broken assertion and still exit 0 (a throw in `finally`). Never trust the exit code alone — read the output.
- The deploy host runs Node 18 while the dev box runs Node 22: `node -e` there is CommonJS, so any top-level `await` (or ESM-only syntax) in a smoke probe dies with a SyntaxError and takes the whole deploy down with it (rollback fires). Keep deploy-time probes to CommonJS `node -e` or plain curl/bash.
- `.env` values already present in the process environment win over the file. Anything testing `.env` precedence must clear inherited vars first (`VERIFY_START_CLEAN_ENV=1`).
