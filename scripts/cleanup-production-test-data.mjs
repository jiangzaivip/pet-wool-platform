// Removes the known seeded test dataset after a backup has been created.
import { readFile, rename, writeFile } from 'node:fs/promises'

const rootDir = process.env.PROJECT_ROOT_DIR || process.cwd()
const dataFile = `${rootDir}/api-node/data/store.json`
const store = JSON.parse(await readFile(dataFile, 'utf8'))
const testProductSlug = 'paypal-small-test-010-usd'
const testProduct = (store.products || []).find((product) => product.slug === testProductSlug)
const isTestOrder = (order) => /@example\.com$/i.test(String(order.email || ''))
  || order.product_id === testProduct?.id
  || String(order.product_title || '') === 'PayPal 小额测试商品 0.10 USD'
const isTestUser = (user) => /@example\.com$/i.test(String(user.email || ''))
  || String(user.email || '').toLowerCase() === '454@qq.com'

const testOrders = (store.orders || []).filter(isTestOrder)
const orderIds = new Set(testOrders.map((order) => order.id))
const paypalIds = new Set(testOrders.map((order) => order.paypal_order_id).filter(Boolean))
const before = {
  products: store.products?.length || 0,
  orders: store.orders?.length || 0,
  users: store.users?.length || 0,
  payments: store.payments?.length || 0,
}

store.products = (store.products || []).filter((product) => product.slug !== testProductSlug)
store.orders = (store.orders || []).filter((order) => !isTestOrder(order))
store.users = (store.users || []).filter((user) => !isTestUser(user))
store.payments = (store.payments || []).filter((payment) => !orderIds.has(payment.order_id) && !paypalIds.has(payment.paypal_order_id))

const tmpFile = `${dataFile}.production-cleanup.tmp`
await writeFile(tmpFile, JSON.stringify(store, null, 2))
await rename(tmpFile, dataFile)

console.log(JSON.stringify({
  before,
  removed: {
    products: before.products - store.products.length,
    orders: before.orders - store.orders.length,
    users: before.users - store.users.length,
    payments: before.payments - store.payments.length,
  },
  after: {
    products: store.products.length,
    orders: store.orders.length,
    users: store.users.length,
    payments: store.payments.length,
  },
}, null, 2))
