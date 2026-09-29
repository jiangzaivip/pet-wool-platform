// Verifies that every api-node module can be imported, and that every symbol
// server.mjs imports from a local module actually exists there.
//
// Two separate failure modes, both of which passed `node --check` while the
// service refused to boot:
//
//   1. A module exports a name it forgot to mark with `export`. Loading the
//      module still succeeds, so a plain import check reports nothing wrong.
//      server.mjs is what crashes, on the import line, with "The requested
//      module does not provide an export named ...".
//   2. A module fails to load at all (bad path, unresolved cycle).
//
// Checking only the module's own exports is what made the first version of this
// script useless: removing `export` from a function still let it import fine.
// So the source of truth is what server.mjs actually asks for.

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const apiDir = join(projectRoot, 'api-node')
const serverPath = join(apiDir, 'server.mjs')

// Matches a local (relative) import in server.mjs and captures the named
// bindings: import { a, b as c } from './x.mjs'
const LOCAL_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g

function parseLocalImports(source) {
  const found = []
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    const [, names, specifier] = match
    const wanted = names
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    found.push({ specifier, wanted })
  }
  return found
}

const failures = []
let checked = 0

// server.mjs is read but never imported: importing it would bind a port.
const serverSource = await readFile(serverPath, 'utf8')
const localImports = parseLocalImports(serverSource)

if (!localImports.length) {
  process.stdout.write('FAIL: no local imports found in server.mjs — the parser is broken\n')
  process.exit(1)
}

for (const { specifier, wanted } of localImports) {
  const name = specifier.replace(/^\.\//, '')
  const path = join(apiDir, name)
  let module
  try {
    module = await import(pathToFileURL(path).href)
  } catch (error) {
    failures.push(`${name}: cannot be imported — ${error?.message || error}`)
    process.stdout.write(`  FAIL ${name}: ${error?.message || error}\n`)
    continue
  }
  const available = new Set(Object.keys(module))
  const missing = wanted.filter((symbol) => !available.has(symbol))
  if (missing.length) {
    failures.push(
      `${name}: server.mjs imports ${missing.join(', ')} but the module does not export ${missing.length === 1 ? 'it' : 'them'}`,
    )
    process.stdout.write(`  FAIL ${name}: missing export(s) ${missing.join(', ')}\n`)
  } else {
    process.stdout.write(`  ok   ${name}: ${wanted.length} import(s) resolved\n`)
  }
  checked += 1
}

// Also confirm every sibling module loads, so a file that nothing imports yet
// does not rot unnoticed.
const siblings = (await readdir(apiDir)).filter((entry) => entry.endsWith('.mjs') && entry !== 'server.mjs')
for (const entry of siblings) {
  try {
    await import(pathToFileURL(join(apiDir, entry)).href)
  } catch (error) {
    failures.push(`${entry}: cannot be imported — ${error?.message || error}`)
    process.stdout.write(`  FAIL ${entry}: ${error?.message || error}\n`)
  }
}

process.stdout.write(`\n${checked} local import(s) verified, ${siblings.length} module(s) loaded, ${failures.length} failed\n`)

if (failures.length) {
  process.stdout.write('\nThe API will not start until these are fixed.\n')
  for (const failure of failures) process.stdout.write(`  ${failure}\n`)
  process.exit(1)
}
