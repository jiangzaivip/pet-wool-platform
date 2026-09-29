// Boots the API exactly the way systemd does (NODE_ENV=production, the release
// .env loaded) and fails when the process refuses to start. It never listens on
// the real port and never mutates data.
//
// This exists because assertProductionRuntime only runs under
// NODE_ENV=production: the whole test machine runs without it, so every gate
// there passes while a production start can still fail. That is how a bad
// production assertion took the site down for 20 minutes before this existed.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? process.env.PROJECT_ROOT_DIR
  : new URL('..', import.meta.url).pathname.replace(/\/$/, '')
if (!rootDir) {
  console.error('PROJECT_ROOT_DIR is not set and could not be derived')
  process.exit(1)
}

const envFile = join(rootDir, '.env')
if (!existsSync(envFile)) {
  console.error(`No .env at ${envFile}; cannot verify a production start.`)
  process.exit(1)
}

// Load .env the same way the server does: a key already present in the real
// environment wins. That precedence is correct in production but makes the
// self-check meaningless when the test host exports its own NODE_ENV,
// GOOGLE_DEMO_LOGIN or PAYPAL_MOCK, because the case's .env is then ignored
// wholesale. VERIFY_START_CLEAN_ENV=1 drops inherited values first.
const env = process.env.VERIFY_START_CLEAN_ENV === '1' ? {} : { ...process.env }
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) continue
  const [, key, rawValue] = match
  if (Object.prototype.hasOwnProperty.call(env, key)) continue
  let value = rawValue.trim()
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1)
  }
  env[key] = value
}
env.NODE_ENV = 'production'
env.PROJECT_ROOT_DIR = rootDir

// The real store must be used: the point is to validate the live configuration.
// A throwaway copy keeps a failed boot from touching production data. The copy is
// prepared before any env override so callers (and the self-check) can point
// DATA_DIR at a store they have already adjusted.
const scratch = mkdtempSync(join(tmpdir(), 'prod-start-check-'))
cpSync(join(rootDir, 'api-node', 'data'), join(scratch, 'data'), { recursive: true })
cpSync(join(rootDir, 'api-node', 'uploads'), join(scratch, 'uploads'), { recursive: true })
env.DATA_DIR = process.env.VERIFY_START_DATA_DIR || join(scratch, 'data')
env.UPLOAD_DIR = process.env.VERIFY_START_UPLOAD_DIR || join(scratch, 'uploads')
env.PORT = '0'
env.SERVE_FRONTEND = 'false'

const failures = []
const child = spawn(process.execPath, [join(rootDir, 'api-node', 'server.mjs')], {
  cwd: join(rootDir, 'api-node'),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

// The server writes structured logs to stderr, so both streams carry the events
// this check depends on. Waiting only on stdout silently reported "exited before
// reporting a start" for a server that had in fact started.
let started = false
let resolveDone
const done = new Promise((resolve) => { resolveDone = resolve })

function inspect(chunk) {
  const text = chunk.toString()
  for (const line of text.split(/\r?\n/)) {
    const message = line.match(/"message":"([^"]+)"/)
    if (message) failures.push(message[1])
    if (line.includes('"event":"service.started"')) {
      started = true
      child.kill('SIGKILL')
      resolveDone(null)
    }
  }
}
child.stdout.on('data', inspect)
child.stderr.on('data', inspect)

const timer = setTimeout(() => {
  child.kill('SIGKILL')
  resolveDone('timeout')
}, 20000)
const code = await done
clearTimeout(timer)

if (failures.length) {
  console.error('Production start is refused by the current configuration:')
  for (const failure of [...new Set(failures)]) console.error(`  - ${failure}`)
  process.exit(1)
}
if (!started) {
  if (code === 'timeout') console.error('Timed out waiting for the server to report a start.')
  else console.error(`Server exited (code ${code}) before reporting a start.`)
  process.exit(1)
}
console.log('PASS production start is accepted (NODE_ENV=production, live .env)')
process.exit(0)
