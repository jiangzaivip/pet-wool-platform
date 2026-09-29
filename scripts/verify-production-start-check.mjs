// Confirms verify-production-start.mjs actually fails on a bad configuration,
// so a green run in CI or on the deploy host means something.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(rootDir, 'scripts', 'verify-production-start.mjs')

// Run the real checker against the real project tree, overriding only .env and
// pointing DATA_DIR at a copy. Rebuilding a miniature api-node/ by hand was the
// first attempt and it silently produced ERR_MODULE_NOT_FOUND for 'pg': the
// server died before reaching any assertion, so every case "failed" for the
// wrong reason and the harness looked like it was proving something.
const realEnv = join(rootDir, '.env')
const envBackup = existsSync(realEnv) ? readFileSync(realEnv, 'utf8') : null

const makeCase = (name, envOverrides) => {
  const base = mkdtempSync(join(tmpdir(), `vps-${name}-`))
  cpSync(join(rootDir, 'api-node', 'data'), join(base, 'data'), { recursive: true })
  if (existsSync(join(rootDir, 'api-node', 'uploads'))) {
    cpSync(join(rootDir, 'api-node', 'uploads'), join(base, 'uploads'), { recursive: true })
  }
  // assertProductionRuntime checks PayPal first, so every other guard is
  // unreachable until the copied store is switched to live mode. Without this the
  // harness only ever proves the PayPal guard works.
  const storePath = join(base, 'data', 'store.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  store.site = store.site || {}
  store.site.paypal = {
    ...(store.site.paypal || {}), enabled: true, mode: 'live',
    client_id: 'test-client-id', secret: 'test-secret', webhook_id: 'test-webhook-id',
  }
  writeFileSync(storePath, JSON.stringify(store))
  const envLines = [
    'NODE_ENV=production',
    'PUBLIC_BASE_URL=https://woolbuddy.shop',
    'PAYPAL_MOCK=false',
    'GOOGLE_DEMO_LOGIN=false',
    'USER_TOKEN_SECRET=' + 'x'.repeat(48),
    'ADMIN_PASSWORD_HASH=' + 'a'.repeat(64),
    'GOOGLE_CLIENT_IDS=real-id.apps.googleusercontent.com',
    '',
  ]
  for (const [key, value] of Object.entries(envOverrides)) {
    const index = envLines.findIndex((line) => line.startsWith(`${key}=`))
    const line = `${key}=${value}`
    if (index >= 0) envLines[index] = line
    else envLines.splice(envLines.length - 1, 0, line)
  }
  writeFileSync(join(base, '.env'), envLines.join('\n'))
  return { base, envFile: join(base, '.env') }
}

const run = ({ base, envFile }) => {
  // The checker reads PROJECT_ROOT_DIR/.env, so the case .env is installed there
  // for the duration of the run and removed afterwards.
  const restore = () => {
    if (envBackup === null) rmSync(realEnv, { force: true })
    else writeFileSync(realEnv, envBackup)
  }
  try {
    if (envBackup !== null) rmSync(realEnv, { force: true })
    cpSync(envFile, realEnv)
    const out = execFileSync(process.execPath, [script], {
      env: {
        // Drop inherited config so each case's .env is the only source of truth.
        VERIFY_START_CLEAN_ENV: '1',
        PROJECT_ROOT_DIR: rootDir,
        VERIFY_START_DATA_DIR: join(base, 'data'),
        VERIFY_START_UPLOAD_DIR: join(base, 'uploads'),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` }
  } finally {
    restore()
  }
}

let failed = 0
const cases = [
  ['Google demo login enabled', { GOOGLE_DEMO_LOGIN: 'true' }],
  ['No real Google client id', { GOOGLE_CLIENT_IDS: 'demo-google-client-id' }],
  ['USER_TOKEN_SECRET too short', { USER_TOKEN_SECRET: 'short' }],
  ['PUBLIC_BASE_URL not HTTPS', { PUBLIC_BASE_URL: 'http://insecure.example' }],
  ['PAYPAL_MOCK on', { PAYPAL_MOCK: 'true' }],
]

// A timeout means the server neither started nor reported a refusal, which is
// not evidence that the guard works. Require the specific refusal message so a
// broken harness (missing module, wrong cwd) cannot masquerade as a passing case.
const EXPECTED_REASON = {
  'Google demo login enabled': 'GOOGLE_DEMO_LOGIN',
  'No real Google client id': 'Google client ID',
  'USER_TOKEN_SECRET too short': 'USER_TOKEN_SECRET',
  'PUBLIC_BASE_URL not HTTPS': 'PUBLIC_BASE_URL',
  'PAYPAL_MOCK on': 'PAYPAL_MOCK',
}

for (const [label, overrides] of cases) {
  const base = makeCase(label.replace(/\W+/g, '-').toLowerCase(), overrides)
  const result = run(base)
  const reason = (result.out.match(/^  - (.+)$/m) || [])[1] || ''
  const timedOut = /Timed out/.test(result.out)
  const ok = result.code === 1 && !timedOut && reason.includes(EXPECTED_REASON[label])
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label} -> exit ${result.code}`
    + `${timedOut ? ' [TIMED OUT - guard not exercised]' : ''}`
    + ` ${reason.slice(0, 70) || '(no refusal message)'}`
  )

}

if (failed) {
  console.error(`\n${failed} case(s) did not fail as expected; the production-start check may be inert.`)
  process.exit(1)
}
console.log('\nAll production-start refusal cases fail as expected.')
