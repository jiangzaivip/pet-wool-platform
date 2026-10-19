// Archives and removes legacy orders whose stored currency is not the KRW base.
//
// Context: the KRW migration rewrote product prices but left order rows alone, so
// pre-migration USD/CNY orders carry a KRW amount in amount_cents. They are test
// rows from that period; keeping them means an operator can read a $3,014 total
// on a piece quoted at ~$220. They are archived (full JSON, 0600) before removal
// so the history is recoverable.
//
// Usage:
//   node scripts/archive-non-krw-orders.mjs            # dry run
//   node scripts/archive-non-krw-orders.mjs --apply
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apply = process.argv.includes('--apply')
const backend = String(process.env.STORE_BACKEND || 'json').trim().toLowerCase()

async function readStore() {
  if (backend === 'postgres') {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    const { rows } = await pool.query('SELECT data FROM platform_runtime_store WHERE id = 1')
    return { pool, store: rows[0].data }
  }
  const file = path.join(rootDir, 'api-node', 'data', 'store.json')
  return { pool: null, store: JSON.parse(await readFile(file, 'utf8')), file }
}

async function writeStore(connection, store) {
  if (connection.pool) {
    await connection.pool.query(
      'UPDATE platform_runtime_store SET data = $1::jsonb, updated_at = now() WHERE id = 1',
      [JSON.stringify(store)],
    )
    await connection.pool.end()
    return
  }
  await writeFile(connection.file, `${JSON.stringify(store, null, 2)}\n`)
}

const connection = await readStore()
const store = connection.store
const orders = Array.isArray(store.orders) ? store.orders : []
const payments = Array.isArray(store.payments) ? store.payments : []
const doomed = orders.filter((order) => (order.currency || 'KRW') !== 'KRW')
const doomedIds = new Set(doomed.map((order) => order.id))
const doomedPayments = payments.filter((payment) => doomedIds.has(payment.order_id))

console.log(JSON.stringify({
  backend,
  orders_total: orders.length,
  non_krw_orders: doomed.length,
  non_krw_payments: doomedPayments.length,
  by_currency: doomed.reduce((acc, order) => {
    const key = order.currency || '?'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {}),
  applied: apply,
}, null, 2))

if (!apply || !doomed.length) {
  if (connection.pool) await connection.pool.end()
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const archiveDir = path.join(rootDir, 'api-node', 'backups')
await mkdir(archiveDir, { recursive: true, mode: 0o700 })
const archiveFile = path.join(archiveDir, `legacy-non-krw-orders-${stamp}.json`)
await writeFile(archiveFile, JSON.stringify({
  archived_at: new Date().toISOString(),
  reason: 'legacy non-KRW test orders with KRW amount_cents',
  orders: doomed,
  payments: doomedPayments,
}, null, 2), { mode: 0o600 })
await chmod(archiveFile, 0o600)
console.log(`archived ${doomed.length} order(s) + ${doomedPayments.length} payment(s) -> ${archiveFile}`)

store.orders = orders.filter((order) => !doomedIds.has(order.id))
store.payments = payments.filter((payment) => !doomedIds.has(payment.order_id))
await writeStore(connection, store)
console.log(`store now: ${store.orders.length} order(s), ${store.payments.length} payment(s)`)
