#!/usr/bin/env node
// Migrate product prices to the KRW store base.
//
// The storefront now shows prices per site language (ko=KRW, en=USD, zh=CNY)
// using the fixed rate table in api-node/currency.mjs, and PayPal charges the
// converted amount in the configured charge currency. For the KRW price to be
// the authoritative number, products stored in another currency (legacy data
// was USD) are converted once, value-preservingly, to whole won.
//
// - Idempotent: products already in KRW are never touched, so re-running (or
//   running after the server's own migration) is safe.
// - Orders are NOT rewritten: historical orders keep the currency they were
//   created with, and the server converts their PayPal charge amounts.
// - A timestamped backup of store.json is written next to the original.
//
// Usage: node scripts/migrate-currency-krw.mjs [--dry-run]
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { convertMinorAmount, CURRENCY_BASE, normalizeSupportedCurrency } from '../api-node/currency.mjs'

const rootDir = path.resolve(new URL('..', import.meta.url).pathname)
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'api-node', 'data')
const storeFile = path.join(dataDir, 'store.json')
const dryRun = process.argv.includes('--dry-run')

const raw = await readFile(storeFile, 'utf8')
const store = JSON.parse(raw)
const products = Array.isArray(store.products) ? store.products : []

let converted = 0
const changes = []
for (const product of products) {
  const from = normalizeSupportedCurrency(product.currency)
  if (!from || from === CURRENCY_BASE) continue
  const before = {
    base_price_cents: Number(product.base_price_cents || 0),
    options: (product.options || []).map((option) => Number(option.price_cents || 0)),
  }
  const convert = (minor) => convertMinorAmount(minor, from, CURRENCY_BASE)
  const after = {
    base_price_cents: convert(before.base_price_cents),
    options: before.options.map(convert),
  }
  if (!dryRun) {
    product.base_price_cents = after.base_price_cents
    for (const [index, option] of (product.options || []).entries()) {
      option.price_cents = after.options[index]
    }
    product.currency = CURRENCY_BASE
  }
  converted += 1
  changes.push({ slug: product.slug, from, before, after })
}

console.log(`store: ${storeFile}`)
console.log(`products: ${products.length}, converted to ${CURRENCY_BASE}: ${converted}`)
for (const change of changes) {
  console.log(`  ${change.slug}: ${change.from} -> ${CURRENCY_BASE}`)
  console.log(`    base ${change.before.base_price_cents} -> ${change.after.base_price_cents}`)
  if (change.before.options.length) {
    console.log(`    options ${change.before.options.join('/')} -> ${change.after.options.join('/')}`)
  }
}

const orders = Array.isArray(store.orders) ? store.orders : []
const orderCurrencies = {}
for (const order of orders) {
  const currency = String(order.currency || 'unknown').trim().toUpperCase()
  orderCurrencies[currency] = (orderCurrencies[currency] || 0) + 1
}
console.log(`orders left untouched (historical currency): ${JSON.stringify(orderCurrencies)}`)

if (dryRun) {
  console.log('dry run: store.json not modified')
} else if (converted > 0) {
  const backupFile = `${storeFile}.bak-currency-krw-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await writeFile(path.join(dataDir, `.migrate-currency-krw.tmp`), JSON.stringify(store, null, 2))
  await rename(storeFile, backupFile)
  await rename(path.join(dataDir, `.migrate-currency-krw.tmp`), storeFile)
  console.log(`backup written: ${backupFile}`)
  console.log('store.json updated')
} else {
  console.log('nothing to convert; store.json not modified')
}
