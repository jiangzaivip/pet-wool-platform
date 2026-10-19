// Hides (never deletes) products that look like payment/e-mail test fixtures.
//
// A fixture product on a live PayPal account is reachable, linkable,
// chargeable and indexed — the exact combination that produced
// /products/paypal-small-test-001-usd in the production sitemap. Deleting the
// row would orphan the orders that reference it, so the product is flipped to
// status=hidden, which drops it from /api/products, the sitemap and the
// storefront while keeping old orders readable.
//
// Usage (the service caches the store in memory, so stop it first):
//   node scripts/hide-fixture-products.mjs            # dry run
//   node scripts/hide-fixture-products.mjs --apply
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apply = process.argv.includes('--apply')
const FIXTURE = /(^|[-_])(test|testing|fixture|demo|probe|qa)([-_]|$)|-usd$/i

function isFixture(product) {
  return FIXTURE.test(String(product?.slug || ''))
}

function plan(store) {
  const products = Array.isArray(store.products) ? store.products : []
  const targets = products.filter((product) => isFixture(product) && product.status !== 'hidden')
  const hiddenIds = new Set(products.filter(isFixture).map((product) => product.id))
  const referenced = (store.orders || []).filter((order) => hiddenIds.has(order.product_id)).length
  return { targets, referenced }
}

async function loadPostgres() {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const { rows } = await pool.query('SELECT data FROM platform_runtime_store WHERE id = 1')
  if (!rows.length) throw new Error('platform_runtime_store has no row id=1')
  return { pool, store: rows[0].data }
}

async function main() {
  const backend = String(process.env.STORE_BACKEND || 'json').trim().toLowerCase()
  let store
  let postgresPool = null
  let dataFile = ''

  if (backend === 'postgres') {
    if (!String(process.env.DATABASE_URL || '').trim()) throw new Error('STORE_BACKEND=postgres requires DATABASE_URL')
    const loaded = await loadPostgres()
    postgresPool = loaded.pool
    store = loaded.store
  } else {
    dataFile = path.join(rootDir, 'api-node', 'data', 'store.json')
    store = JSON.parse(await readFile(dataFile, 'utf8'))
  }

  const { targets, referenced } = plan(store)
  console.log(JSON.stringify({
    backend,
    fixture_products: (store.products || []).filter(isFixture).map((p) => ({ slug: p.slug, status: p.status })),
    to_hide: targets.map((p) => p.slug),
    orders_referencing_fixtures: referenced,
    applied: apply && targets.length > 0,
  }, null, 2))

  if (!apply || !targets.length) {
    if (postgresPool) await postgresPool.end()
    return
  }

  for (const product of targets) {
    product.status = 'hidden'
    product.updated_at = new Date().toISOString()
  }
  if (postgresPool) {
    await postgresPool.query('UPDATE platform_runtime_store SET data = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(store)])
    await postgresPool.end()
  } else {
    await writeFile(dataFile, `${JSON.stringify(store, null, 2)}\n`)
  }
  console.log(`hidden ${targets.length} fixture product(s)`)
}

main().catch((error) => {
  console.error(`hide-fixture-products failed: ${error.message}`)
  process.exit(1)
})
