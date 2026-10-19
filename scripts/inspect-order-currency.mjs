// Read-only: prints order/payment distribution for the configured store.
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadStore() {
  if (String(process.env.STORE_BACKEND || '').trim().toLowerCase() === 'postgres') {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    const { rows } = await pool.query('SELECT data FROM platform_runtime_store WHERE id = 1')
    await pool.end()
    return rows[0].data
  }
  return JSON.parse(await readFile(path.join(rootDir, 'api-node', 'data', 'store.json'), 'utf8'))
}

const store = await loadStore()
const orders = store.orders || []
const payments = store.payments || []
const byCurrency = {}
for (const order of orders) {
  const key = order.currency || 'KRW'
  byCurrency[key] = (byCurrency[key] || 0) + 1
}
const nonKrw = orders.filter((order) => (order.currency || 'KRW') !== 'KRW')
const paymentIds = new Set(payments.filter((p) => nonKrw.some((o) => o.id === p.order_id)).map((p) => p.id))

console.log(JSON.stringify({
  backend: String(process.env.STORE_BACKEND || 'json'),
  orders: orders.length,
  payments: payments.length,
  users: (store.users || []).length,
  by_currency: byCurrency,
  non_krw_orders: nonKrw.length,
  non_krw_payments: paymentIds.size,
  sample: nonKrw.slice(0, 10).map((o) => ({
    order_no: o.order_no, currency: o.currency, amount_cents: o.amount_cents,
    paid: o.paid_amount_cents, at: o.created_at, email: String(o.email || '').replace(/(.{2}).*(@.*)/, '$1***$2'),
    user_id: o.user_id || '',
  })),
}, null, 2))
