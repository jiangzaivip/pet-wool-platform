// Removes leaked payment/email test fixtures from the live store.
//
// Why this exists instead of scripts/cleanup-production-test-data.mjs:
// that script hard-coded a single slug ('paypal-small-test-010-usd') that never
// matched what actually shipped ('paypal-small-test-001-usd'), and it only
// rewrote api-node/data/store.json — which is NOT the data source in
// STORE_BACKEND=postgres, so the fixture stayed reachable in production.
//
//   node scripts/remove-test-fixtures.mjs                      # dry-run
//   node scripts/remove-test-fixtures.mjs --apply --confirm-fixture-cleanup
//
// Dry-run is the default, matching cleanup-e2e-data.mjs. Never run this without
// a current backup: it deletes rows from the live store.
//
// SCOPE — deliberately narrow. It removes products whose slug looks synthetic,
// and only the orders/payments that reference those products. It does NOT treat
// an @example.com order email as a fixture: real customers do use example.com,
// and a broad rule silently deleted 246 orders / 752 users when this script was
// first written against a test store. Users and audit logs are never deleted.
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataFile = path.join(rootDir, 'api-node', 'data', 'store.json')
const databaseUrl = String(process.env.DATABASE_URL || '').trim()

const apply = process.argv.includes('--apply')
const confirmed = process.argv.includes('--confirm-fixture-cleanup')

if (apply && !confirmed) {
  console.error('Refusing to modify the live store without --confirm-fixture-cleanup. Run without --apply for a dry-run preview.')
  process.exit(1)
}

// Anchored on tokens that only appear in synthetic payment/email probes. A real
// product slug never contains them.
const FIXTURE_SLUG = /(^|[-_])(test|testing|fixture|demo|probe|qa)([-_]|$)|-usd$|usd-test/i

const isFixtureProduct = (product = {}) => FIXTURE_SLUG.test(String(product.slug || ''))

function plan(store) {
  const products = store.products || []
  const fixtureProducts = products.filter(isFixtureProduct)
  const fixtureProductIds = new Set(fixtureProducts.map((product) => product.id))
  const fixtureProductSlugs = new Set(fixtureProducts.map((product) => String(product.slug || '')))

  // Only rows that point AT a fixture product. No email heuristic.
  const orders = store.orders || []
  const fixtureOrders = orders.filter((order) => fixtureProductIds.has(order.product_id)
    || fixtureProductSlugs.has(String(order.product_slug || '')))
  const fixtureOrderIds = new Set(fixtureOrders.map((order) => order.id))
  const fixturePaypalIds = new Set(fixtureOrders.map((order) => order.paypal_order_id).filter(Boolean))

  const payments = (store.payments || []).filter((payment) => !fixtureOrderIds.has(payment.order_id)
    && !fixturePaypalIds.has(payment.paypal_order_id))

  return {
    fixture_slugs: fixtureProducts.map((product) => product.slug),
    fixture_orders: fixtureOrders.length,
    fixture_payments: (store.payments || []).length - payments.length,
    before: {
      products: products.length,
      orders: orders.length,
      users: (store.users || []).length,
      payments: (store.payments || []).length,
    },
    apply() {
      store.products = products.filter((product) => !fixtureProductIds.has(product.id))
      store.orders = orders.filter((order) => !fixtureOrderIds.has(order.id))
      store.payments = payments
    },
  }
}

async function writeJsonStore(store) {
  const tmpFile = `${dataFile}.fixture-cleanup.tmp`
  await writeFile(tmpFile, JSON.stringify(store, null, 2))
  await rename(tmpFile, dataFile)
}

async function main() {
  let pool = null
  if (databaseUrl) {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
  }

  let store
  if (pool) {
    const result = await pool.query('SELECT data FROM platform_runtime_store WHERE id = 1')
    if (!result.rows.length) throw new Error('platform_runtime_store has no row with id = 1')
    store = typeof result.rows[0].data === 'string' ? JSON.parse(result.rows[0].data) : result.rows[0].data
  } else {
    store = JSON.parse(await readFile(dataFile, 'utf8'))
  }

  const report = plan(store)
  const dirty = report.fixture_slugs.length > 0

  if (apply && dirty) {
    report.apply()
    if (pool) {
      await pool.query(`
        INSERT INTO platform_runtime_store (id, data, updated_at)
        VALUES (1, $1::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `, [JSON.stringify(store)])
    }
    // Keep the JSON shadow copy in step regardless of backend.
    await writeJsonStore(store)
  }
  if (pool) await pool.end()

  console.log(JSON.stringify({
    backend: pool ? 'postgres' : 'json',
    mode: apply ? 'apply' : 'dry-run',
    action: !dirty ? 'noop (no fixture products found)' : apply ? 'removed' : 'would remove',
    fixture_slugs: report.fixture_slugs,
    would_remove: {
      products: report.fixture_slugs.length,
      orders: report.fixture_orders,
      payments: report.fixture_payments,
      users: 0,
    },
    before: report.before,
  }, null, 2))
}

await main()