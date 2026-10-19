// Validates a backup before replacing live JSON data. Dry-run is the default;
// --apply is required for the replacement step.
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiDir = path.join(rootDir, 'api-node')
const dataDir = path.join(apiDir, 'data')
const dataFile = path.join(dataDir, 'store.json')
const uploadDir = path.join(apiDir, 'uploads')
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const dryRun = !apply || args.includes('--dry-run')
const backupArg = args.find((arg) => !['--dry-run', '--apply'].includes(arg))
const backupDir = path.resolve(backupArg || '')
const paypalSupportedCurrencies = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF',
  'ILS', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD',
  'THB', 'TWD', 'USD',
])

function usage() {
  console.error('Usage: node scripts/restore-data.mjs [--dry-run|--apply] api-node/backups/<timestamp>')
  process.exit(1)
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function validateUploadReference({ owner, value, uploadsBase }) {
  const match = String(value || '').match(/^\/uploads\/([^/]+)$/)
  if (!match) return
  const filename = decodeURIComponent(match[1])
  if (!/^\d{13}-[0-9a-f-]{36}\.[a-z0-9]+$/i.test(filename)) {
    throw new Error(`${owner} references invalid upload filename ${filename}`)
  }
  if (!await exists(path.join(uploadsBase, filename))) {
    throw new Error(`${owner} references missing upload ${filename}`)
  }
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

function isValidSiteImageReference(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (isValidHttpUrl(text)) return true
  if (text.startsWith('/assets/') && !text.includes('..') && !text.includes('\\')) return true
  return /^\/uploads\/[^/]+$/.test(text)
}

function hasValidLength(value, min = 1, max = 1000) {
  const text = String(value || '').trim()
  return text.length >= min && text.length <= max
}

function isValidSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || '').trim())
}

function isValidIsoDate(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const parsed = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

function assertUniqueIds(label, items = []) {
  const seen = new Set()
  for (const item of items) {
    const key = String(item?.id || '').trim()
    if (!key) throw new Error(`${label} contains item without id`)
    if (seen.has(key)) throw new Error(`${label} contains duplicate id ${key}`)
    seen.add(key)
  }
}

async function validateStore(store, uploadsBase = uploadDir) {
  const requiredArrays = ['categories', 'products', 'orders', 'payments']
  for (const key of requiredArrays) {
    if (!Array.isArray(store[key])) throw new Error(`store.json ${key} must be an array`)
  }
  if (!store.site || typeof store.site !== 'object') throw new Error('store.json site must be an object')
  if (!store.site.brand || typeof store.site.brand !== 'object') throw new Error('store.json site.brand is required')
  if (!store.site.paypal || typeof store.site.paypal !== 'object') throw new Error('store.json site.paypal is required')
  if (store.site.paypal.currency && !paypalSupportedCurrencies.has(String(store.site.paypal.currency || '').trim().toUpperCase())) throw new Error('site paypal contains unsupported currency')
  if (Array.isArray(store.site.faq)) {
    for (const item of store.site.faq) {
      if (!item || typeof item !== 'object'
        || !hasValidLength(item.question || item.translations?.zh?.question, 1, 300)
        || !hasValidLength(item.answer || item.translations?.zh?.answer, 1, 2000)) {
        throw new Error('site faq contains invalid item')
      }
    }
  }
  if (Array.isArray(store.site.reviews)) {
    for (const item of store.site.reviews) {
      const rating = Number(item?.rating)
      const images = Array.isArray(item?.images) ? item.images : [item?.pet_image, item?.work_image].filter(Boolean)
      if (!item || typeof item !== 'object'
        || !hasValidLength(item.name, 1, 120)
        || !hasValidLength(item.country, 1, 80)
        || !Number.isInteger(rating) || rating < 1 || rating > 5
        || (item.status && !['published', 'hidden'].includes(String(item.status)))
        || !hasValidLength(item.title || item.translations?.zh?.title, 1, 200)
        || !hasValidLength(item.content || item.translations?.zh?.content, 1, 2000)
        || images.length > 24
        || images.some((image) => !isValidSiteImageReference(image))
        || (item.avatar_url && !isValidSiteImageReference(item.avatar_url))
        || (item.product_slug && !isValidSlug(item.product_slug))) {
        throw new Error('site reviews contains invalid item')
      }
      for (const image of [...images, item.avatar_url].filter(Boolean)) {
        await validateUploadReference({ owner: `review ${item.name || item.id}`, value: image, uploadsBase })
      }
    }
  }
  assertUniqueIds('categories', store.categories)
  assertUniqueIds('products', store.products)
  assertUniqueIds('orders', store.orders)
  assertUniqueIds('payments', store.payments)
  if (Array.isArray(store.users)) assertUniqueIds('users', store.users)
  const categoryIds = new Set(store.categories.map((category) => category.id))
  const missingCategoryProduct = store.products.find((product) => product.category_id && !categoryIds.has(product.category_id))
  if (missingCategoryProduct) throw new Error(`product ${missingCategoryProduct.slug || missingCategoryProduct.id} references missing category ${missingCategoryProduct.category_id}`)
  const hiddenCategoryIds = new Set(store.categories.filter((category) => category.status === 'hidden').map((category) => category.id))
  const publishedHiddenCategoryProduct = store.products.find((product) => (product.status || 'published') === 'published' && hiddenCategoryIds.has(product.category_id))
  if (publishedHiddenCategoryProduct) throw new Error(`published product ${publishedHiddenCategoryProduct.slug || publishedHiddenCategoryProduct.id} references hidden category ${publishedHiddenCategoryProduct.category_id}`)
  const productIds = new Set(store.products.map((product) => product.id))
  const missingProductOrder = store.orders.find((order) => order.product_id && !productIds.has(order.product_id))
  if (missingProductOrder) throw new Error(`order ${missingProductOrder.order_no || missingProductOrder.id} references missing product ${missingProductOrder.product_id}`)
  const orderIds = new Set(store.orders.map((order) => order.id))
  const missingOrderPayment = store.payments.find((payment) => payment.order_id && !orderIds.has(payment.order_id))
  if (missingOrderPayment) throw new Error(`payment ${missingOrderPayment.id} references missing order ${missingOrderPayment.order_id}`)
  for (const product of store.products) {
    const published = (product.status || 'published') === 'published'
    if (published && !hasValidLength(product.seo_title || product.translations?.zh?.seo_title, 1, 120)) throw new Error(`published product ${product.slug || product.id} requires seo title`)
    if (published && !hasValidLength(product.seo_description || product.translations?.zh?.seo_description, 1, 300)) throw new Error(`published product ${product.slug || product.id} requires seo description`)
    if (!Array.isArray(product.options) || product.options.length === 0) throw new Error(`product ${product.slug || product.id} requires options`)
    if (product.options.some((option) => {
      const price = Number(option?.price_cents)
      return !hasValidLength(option?.name || option?.translations?.zh?.name, 1, 120) || !Number.isSafeInteger(price) || price <= 0
    })) throw new Error(`product ${product.slug || product.id} contains invalid options`)
    const images = [product.image_url, ...(Array.isArray(product.images) ? product.images : [])]
    if (published && images.filter(Boolean).length === 0) throw new Error(`published product ${product.slug || product.id} requires image`)
    for (const image of images) {
      await validateUploadReference({ owner: `product ${product.slug || product.id}`, value: image, uploadsBase })
    }
  }
  for (const order of store.orders) {
    for (const photo of Array.isArray(order.photo_urls) ? order.photo_urls : []) {
      await validateUploadReference({ owner: `order ${order.order_no || order.id}`, value: photo, uploadsBase })
    }
  }
  for (const post of Array.isArray(store.site.blog) ? store.site.blog : []) {
    if (!isValidSlug(post.slug)
      || !isValidIsoDate(post.date)
      || !hasValidLength(post.title || post.translations?.zh?.title, 1, 200)
      || !hasValidLength(post.excerpt || post.translations?.zh?.excerpt, 1, 500)
      || !hasValidLength(post.content || post.translations?.zh?.content, 1, 6000)) {
      throw new Error(`blog ${post.slug || post.id} contains invalid content`)
    }
    if (!isValidSiteImageReference(post.image_url)) {
      throw new Error(`blog ${post.slug || post.id} requires a valid image reference`)
    }
    await validateUploadReference({ owner: `blog ${post.slug || post.id}`, value: post.image_url, uploadsBase })
  }
  return {
    categories: store.categories.length,
    products: store.products.length,
    orders: store.orders.length,
    users: Array.isArray(store.users) ? store.users.length : 0,
    payments: store.payments.length,
  }
}

if (!backupArg) usage()

const backupStore = path.join(backupDir, 'store.json')
const backupUploads = path.join(backupDir, 'uploads')

if (!await exists(backupStore)) {
  console.error(`Backup store.json not found: ${backupStore}`)
  process.exit(1)
}

let parsed
let counts
try {
  parsed = JSON.parse(await readFile(backupStore, 'utf8'))
  counts = await validateStore(parsed, backupUploads)
} catch (error) {
  console.error(`Backup validation failed: ${error.message}`)
  process.exit(1)
}

if (dryRun) {
  console.log(JSON.stringify({
    dry_run: true,
    apply_required: true,
    restore_candidate: backupDir,
    store: backupStore,
    uploads_present: await exists(backupUploads),
    counts,
  }, null, 2))
  process.exit(0)
}

// A validated pre-restore backup is the safety net, but it is exactly the step
// that fails when the live store is already corrupt (missing site block, dangling
// payment references). Aborting there means the operator can never recover from
// the one situation they need recovery for. In that case preserve the damaged
// file verbatim and continue: the incoming backup has already passed validation.
//
// Two configurations make this script a no-op at best and a data-loss event at
// worst, so they are refused up front:
//   * a live service holds the store in memory and rewrites the whole file on
//     the next order/review/report, silently undoing the restore;
//   * with STORE_BACKEND=postgres the deployment reads the database, not this
//     file, so "restored" would mean nothing.
function serviceRunning() {
  for (const name of ['pet-wool-platform', 'pet-wool-api']) {
    const result = spawnSync('systemctl', ['is-active', name], { encoding: 'utf8' })
    if (String(result.stdout || '').trim() === 'active') return name
  }
  return ''
}

function configuredBackend() {
  const fromEnv = String(process.env.STORE_BACKEND || '').trim().toLowerCase()
  if (fromEnv) return fromEnv
  try {
    const text = readFileSync(path.join(rootDir, '.env'), 'utf8')
    const match = text.match(/^\s*STORE_BACKEND\s*=\s*['"]?([a-z]+)['"]?\s*$/m)
    return match ? match[1].toLowerCase() : 'json'
  } catch {
    return 'json'
  }
}

if (apply) {
  const backend = configuredBackend()
  if (backend === 'postgres') {
    console.error('STORE_BACKEND=postgres: this script only restores the JSON file. Restore the database with pg_restore (or switch STORE_BACKEND back first).')
    process.exit(1)
  }
  const active = serviceRunning()
  if (active && !args.includes('--force')) {
    console.error(`${active} is running and will overwrite the restored file from memory. Stop it first (systemctl stop ${active}) or pass --force to override.`)
    process.exit(1)
  }
}

const backupResult = spawnSync(process.execPath, [path.join(rootDir, 'scripts', 'backup-data.mjs')], {
  cwd: rootDir,
  stdio: 'inherit',
})
if (backupResult.status !== 0) {
  const quarantine = `${dataFile}.${Date.now()}.corrupt`
  try {
    if (await exists(dataFile)) {
      await copyFile(dataFile, quarantine)
      console.error(`Live store failed validation; preserved a copy at ${quarantine} and continuing with the validated backup.`)
    } else {
      console.error('Live store is missing and could not be backed up; continuing with the validated backup.')
    }
  } catch (error) {
    console.error(`Could not preserve the live store (${error.message}). Aborting so nothing is overwritten.`)
    process.exit(1)
  }
}

await mkdir(dataDir, { recursive: true })
const tmpStore = `${dataFile}.${process.pid}.${Date.now()}.${randomUUID()}.restore.tmp`
await writeFile(tmpStore, JSON.stringify(parsed, null, 2))
await rename(tmpStore, dataFile)

await rm(uploadDir, { recursive: true, force: true })
if (await exists(backupUploads)) await cp(backupUploads, uploadDir, { recursive: true })
else await mkdir(uploadDir, { recursive: true })

console.log(JSON.stringify({
  restored_from: backupDir,
  store: dataFile,
  uploads: uploadDir,
  counts,
  restart_required: 'systemctl restart pet-wool-api',
}, null, 2))
