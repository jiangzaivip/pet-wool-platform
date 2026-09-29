// Fails when a translation key used by the storefront is missing from a
// non-Chinese locale. Missing keys render as literal "status.unpaid" text on
// customer-facing pages, which no unit test would otherwise catch.
import { createRequire } from 'node:module'
import { messages } from '../frontend/src/i18n.ts'

const LOCALES = ['zh', 'en', 'ko']

function flatten(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    out.set(prefix, 'array')
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out)
    return out
  }
  out.set(prefix, typeof value)
  return out
}

// Keys the storefront renders for customers. Admin-only namespaces are exempt:
// the admin console is intentionally forced to Chinese.
const ADMIN_ONLY = /^(admin|feedbackMessages)\./
const tables = Object.fromEntries(LOCALES.map((locale) => [locale, flatten(messages[locale])]))

let failed = false
for (const locale of LOCALES.filter((l) => l !== 'zh')) {
  const missing = [...tables.zh.keys()].filter((key) => !ADMIN_ONLY.test(key) && !tables[locale].has(key))
  if (!missing.length) {
    console.log(`PASS ${locale} covers every customer-facing zh key (${tables.zh.size} keys)`)
    continue
  }
  failed = true
  console.log(`FAIL ${locale} is missing ${missing.length} customer-facing keys`)
  for (const key of missing.slice(0, 40)) console.log(`     ${key}`)
  if (missing.length > 40) console.log(`     ... and ${missing.length - 40} more`)
}
process.exit(failed ? 1 : 0)
