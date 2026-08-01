import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataFile = path.join(rootDir, 'api-node', 'data', 'store.json')
const uploadDir = path.join(rootDir, 'api-node', 'uploads')
const apply = process.argv.includes('--apply')
const confirmed = process.argv.includes('--confirm-e2e-cleanup')

if (apply && !confirmed) {
  console.error('Refusing to modify data without --confirm-e2e-cleanup. Run without --apply for a dry-run preview.')
  process.exit(1)
}

function isE2eEmail(value = '') {
  return /^(commercial(?:-[a-z0-9-]+)?|unpaid|blocked(?:-[a-z0-9-]+)?|hidden|payable|balance(?:-[a-z0-9-]+)?|missing-photo|invalid(?:-[a-z0-9-]+)?|too-many-photos|other-user|non-default(?:-[a-z0-9-]+)?|normalized|manual(?:-[a-z0-9-]+)?|multi-currency|stale-created|tracking-ui|csv-formula|no-photo|very-long-commercial-customer-email-[a-z0-9-]+-with-many-segments|commercial-paypal(?:-[a-z0-9-]+)?)-(\d+|debug)@example\.com$/i.test(String(value))
}

function translatedTitle(item = {}) {
  return String(item.title || item.translations?.zh?.title || '')
}

function isE2eProduct(product = {}) {
  const slug = String(product.slug || '')
  const title = translatedTitle(product)
  return slug.startsWith('commercial-check-')
    || slug.startsWith('commercial-paypal-usd-')
    || slug.startsWith('commercial-readiness-')
    || slug.startsWith('hidden-category-product-')
    || title.startsWith('商业化测试商品 ')
    || title.startsWith('PayPal 美元测试商品 ')
    || title.startsWith('配置待完善商品 ')
    || title.startsWith('隐藏分类商品 ')
}

function isE2eCategory(category = {}) {
  const slug = String(category.slug || '')
  const title = translatedTitle(category)
  return slug.startsWith('commercial-category-')
    || slug.startsWith('hidden-category-')
    || title.startsWith('商业化测试分类 ')
    || title.startsWith('隐藏分类 ')
}

function isE2eContent(item = {}) {
  const id = String(item.id || '')
  const slug = String(item.slug || '')
  return id.startsWith('commercial-') || slug.startsWith('commercial-')
}

const store = JSON.parse(await readFile(dataFile, 'utf8'))
const e2eCategories = (store.categories || []).filter(isE2eCategory)
const e2eCategoryIds = new Set(e2eCategories.map((category) => category.id))
const e2eProducts = (store.products || []).filter((product) => isE2eProduct(product) || e2eCategoryIds.has(product.category_id))
const e2eProductIds = new Set(e2eProducts.map((product) => product.id))
function isE2eOrder(order = {}) {
  const productTitle = String(order.product_title || '')
  return isE2eEmail(order.email)
    || e2eProductIds.has(order.product_id)
    || productTitle.startsWith('商业化测试商品 ')
    || productTitle.startsWith('PayPal 美元测试商品 ')
}
const e2eOrders = (store.orders || []).filter(isE2eOrder)
const e2eUsers = (store.users || []).filter((user) => isE2eEmail(user.email))
const orderIds = new Set(e2eOrders.map((order) => order.id))
const paypalIds = new Set(e2eOrders.map((order) => order.paypal_order_id).filter(Boolean))
const uploadFiles = new Set(e2eOrders
  .flatMap((order) => Array.isArray(order.photo_urls) ? order.photo_urls : [])
  .map((url) => path.basename(String(url || '')))
  .filter((name) => /^[0-9]+-[a-f0-9-]+\.(png|jpe?g|webp)$/i.test(name)))

const before = {
  orders: store.orders?.length || 0,
  users: store.users?.length || 0,
  products: store.products?.length || 0,
  categories: store.categories?.length || 0,
  payments: store.payments?.length || 0,
  faq: store.site?.faq?.length || 0,
  reviews: store.site?.reviews?.length || 0,
  blog: store.site?.blog?.length || 0,
  paypal_client_id: store.site?.paypal?.client_id || '',
}

store.orders = (store.orders || []).filter((order) => !isE2eOrder(order))
store.users = (store.users || []).filter((user) => !isE2eEmail(user.email))
store.products = (store.products || []).filter((product) => !e2eProductIds.has(product.id))
store.categories = (store.categories || []).filter((category) => !isE2eCategory(category))
store.payments = (store.payments || []).filter((payment) => !orderIds.has(payment.order_id) && !paypalIds.has(payment.paypal_order_id))
if (store.site) {
  store.site.faq = (store.site.faq || []).filter((item) => !isE2eContent(item))
  store.site.reviews = (store.site.reviews || []).filter((item) => !isE2eContent(item))
  store.site.blog = (store.site.blog || []).filter((item) => !isE2eContent(item))
}
const paypal = store.site?.paypal || {}
const hasE2ePaypalConfig = /^client-\d+$/.test(String(paypal.client_id || ''))
  || /^secret-\d+$/.test(String(paypal.secret || ''))
  || /^webhook-\d+$/.test(String(paypal.webhook_id || ''))
if (hasE2ePaypalConfig) {
  store.site = {
    ...(store.site || {}),
    paypal: {
      ...(store.site?.paypal || {}),
      enabled: true,
      mode: 'sandbox',
      client_id: 'sandbox-demo-client-id',
      secret: '',
      webhook_id: '',
      currency: 'USD',
    },
  }
}

const after = {
  orders: store.orders.length,
  users: store.users.length,
  products: store.products.length,
  categories: store.categories.length,
  payments: store.payments.length,
  faq: store.site?.faq?.length || 0,
  reviews: store.site?.reviews?.length || 0,
  blog: store.site?.blog?.length || 0,
  paypal_client_id: store.site?.paypal?.client_id || '',
}

if (apply) {
  const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(tmpFile, JSON.stringify(store, null, 2))
  await rename(tmpFile, dataFile)
}

let removedUploads = 0
if (apply) {
  for (const filename of uploadFiles) {
    await rm(path.join(uploadDir, filename), { force: true })
      .then(() => { removedUploads += 1 })
      .catch(() => {})
  }
}

console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', before, after, removed: {
  orders: before.orders - after.orders,
  users: before.users - after.users,
  products: before.products - after.products,
  categories: before.categories - after.categories,
  payments: before.payments - after.payments,
  faq: before.faq - after.faq,
  reviews: before.reviews - after.reviews,
  blog: before.blog - after.blog,
  uploads: apply ? removedUploads : uploadFiles.size,
  paypal_config: hasE2ePaypalConfig ? 1 : 0,
}, matched: {
  orders: e2eOrders.length,
  users: e2eUsers.length,
  products: e2eProducts.length,
  categories: e2eCategories.length,
  product_ids: e2eProductIds.size,
}}, null, 2))
