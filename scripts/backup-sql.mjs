// Creates a PostgreSQL-compatible snapshot from the current JSON store.
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const generatedFile = path.join(rootDir, 'workspace', 'generated', 'store-postgres-seed.sql')
const backupDir = path.join(rootDir, 'api-node', 'sql-backups')
const keep = Math.max(1, Number(process.env.SQL_BACKUP_KEEP || 14))

await mkdir(backupDir, { recursive: true })

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const target = path.join(backupDir, `store-${stamp}.sql`)

async function runPgDump() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim()
  if (!databaseUrl) return false
  const parsed = new URL(databaseUrl)
  const output = createWriteStream(target, { mode: 0o600 })
  const child = spawn('pg_dump', [
    '--no-owner',
    '--no-privileges',
    '--host', parsed.hostname,
    '--port', parsed.port || '5432',
    '--username', decodeURIComponent(parsed.username),
    '--dbname', decodeURIComponent(parsed.pathname.slice(1)),
  ], {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.stdout.pipe(output)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(true)
      else reject(new Error(`pg_dump exited with code ${code}`))
    })
  })
}

const dumped = await runPgDump()
if (!dumped) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'export-store-postgres.mjs')], {
      cwd: rootDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`SQL export exited with code ${code}`)))
  })
  await cp(generatedFile, target)
}

const entries = await readdir(backupDir, { withFileTypes: true })
const files = []
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.sql')) continue
  const file = path.join(backupDir, entry.name)
  const info = await stat(file)
  files.push({ file, mtime: info.mtimeMs })
}
files.sort((a, b) => b.mtime - a.mtime)
for (const item of files.slice(keep)) await rm(item.file, { force: true })

console.log(JSON.stringify({ backup_file: target, keep, sql_backups: Math.min(files.length, keep) }, null, 2))
