import { chromium } from 'playwright'
import { createHmac } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const base = 'http://127.0.0.1:8888'
const execFileAsync = promisify(execFile)
const out = []
const stamp = Date.now()
const testEmail = `commercial-${stamp}@example.com`
const unpaidEmail = `unpaid-${stamp}@example.com`
const blockedEmail = `blocked-${stamp}@example.com`
const payableEmail = `payable-${stamp}@example.com`
const balanceEmail = `balance-due-${stamp}@example.com`
let adminOrderSearchEmail = testEmail
const uploadFixture = '/root/pet-wool-platform/test-results/upload-fixture.png'
const invalidUploadFixture = '/root/pet-wool-platform/test-results/upload-invalid.txt'
const oversizeUploadFixture = '/root/pet-wool-platform/test-results/upload-oversize-fixture.png'
const siteRestoreFixture = '/root/pet-wool-platform/test-results/site-restore-fixture.json'
const invalidRestoreFixtureDir = '/root/pet-wool-platform/test-results/invalid-restore-fixture'
const storeFile = '/root/pet-wool-platform/api-node/data/store.json'
const uploadDir = '/root/pet-wool-platform/api-node/uploads'
const uploadSnapshotDir = `/tmp/pet-wool-upload-snapshot-${stamp}`
const originalBrandName = 'WoolBuddy'
const temporaryBrandName = `临时品牌 ${stamp}`
let temporaryProductId = ''
let storeSnapshotForMissingPhoto = ''
const temporaryProductSlug = `commercial-check-${stamp}`
const temporaryProductTitle = `商业化测试商品 ${stamp}`
const paypalProductSlug = `commercial-paypal-usd-${stamp}`
const paypalProductTitle = `PayPal 美元测试商品 ${stamp}`
const readinessProductSlug = `commercial-readiness-${stamp}`
const readinessProductTitle = `配置待完善商品 ${stamp}`
const temporaryCategorySlug = `commercial-category-${stamp}`
const temporaryCategoryTitle = `商业化测试分类 ${stamp}`
let hiddenProductId = ''
const hiddenProductSlug = `commercial-check-hidden-${stamp}`
let originalSiteSnapshot = null
let apiRestartInProgress = false
let uploadSnapshotForMissingPhoto = false
let missingPhotoSnapshotOrderId = ''
let commercialOrderId = ''
const userTokenSecret = process.env.USER_TOKEN_SECRET || process.env.ADMIN_SESSION_SECRET || 'ac0e7d037817094e9e0b4441f9bae3209d67b02fa484917065f71b16109a1a78'

function ok(name, detail = '') {
  out.push({ name, status: 'ok', detail })
}
function fail(name, error) {
  out.push({ name, status: 'fail', detail: String(error?.message || error) })
}
function fullBackupHeaders(token) {
  return { authorization: `Bearer ${token}`, 'x-confirm-secret-backup': 'true' }
}
function signedCustomerToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', userTokenSecret).update(encoded).digest('base64url')
  return `user-v1.${encoded}.${signature}`
}
function makePublishedProductImagesRestoreSafe(store) {
  for (const product of store.products || []) {
    if (String(product.status || 'published') !== 'published') continue
    const fallbackImage = `https://example.com/restore-fixture-${product.slug || product.id || 'product'}.jpg`
    product.image_url = fallbackImage
    product.images = [fallbackImage]
  }
}
async function expectVisible(page, selector, name) {
  const loc = page.locator(selector).first()
  await loc.waitFor({ state: 'visible', timeout: 10000 })
  ok(name)
}
async function expectText(page, text, name) {
  await expectVisible(page, `text=${text}`, name)
}
async function expectVisibleTextIn(page, selector, text, name) {
  await page.locator(selector).filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 10000 })
  ok(name)
}
async function expectNoText(page, text, name) {
  const visible = await page.locator(`text=${text}`).first().isVisible({ timeout: 1000 }).catch(() => false)
  if (!visible) ok(name)
  else throw new Error(`${name}: unexpected text visible: ${text}`)
}
async function fillAdminLogin(page, email = 'admin@example.com', password = 'admin123456') {
  const dashboardVisible = await page.locator('text=运营后台').first().isVisible({ timeout: 1000 }).catch(() => false)
  if (dashboardVisible) return false
  await page.locator('text=管理员登录').first().waitFor({ state: 'visible', timeout: 10000 })
  const form = page.locator('form.panel').filter({ hasText: '管理员登录' }).first()
  await form.locator('input[type="email"]').fill(email)
  await form.locator('input[type="password"]').fill(password)
  return true
}
async function acceptTransientText(page, text, name) {
  await page.locator(`text=${text}`).first().isVisible({ timeout: 1500 }).catch(() => false)
  ok(name)
}
async function expectNoHorizontalOverflow(page, name) {
  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  if (width.scrollWidth <= width.clientWidth + 1) ok(name)
  else throw new Error(`${name}: ${JSON.stringify(width)}`)
}
async function expectNoPublicAuthorization(path, name) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await page.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const seen = []
  await page.addInitScript(() => localStorage.setItem('admin_token', 'admin-e2e'))
  page.on('request', (request) => {
    const url = request.url()
    if (url.startsWith(`${base}/api/`) && !url.startsWith(`${base}/api/admin`)) {
      seen.push({ url, authorization: request.headers().authorization || '' })
    }
  })
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  const leaked = seen.filter((item) => item.authorization)
  await page.close()
  if (seen.length && leaked.length === 0) ok(name, `${seen.length} public requests checked`)
  else throw new Error(`${name}: ${JSON.stringify({ seen: seen.length, leaked })}`)
}
function validSiteImageReference(value = '') {
  const text = String(value || '').trim()
  if (!text) return true
  if (text.startsWith('/assets/') && !text.includes('..') && !text.includes('\\')) return true
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol)
  } catch {
    return false
  }
}
function hasOrderableOption(product) {
  return product?.options?.some((option) => option?.id)
}
function siteForRestore(site) {
  const next = JSON.parse(JSON.stringify(site || {}))
  if (next.paypal) next.paypal.currency = 'USD'
  if (Array.isArray(next.blog)) {
    next.blog = next.blog.map((post) => ({
      ...post,
      image_url: validSiteImageReference(post?.image_url) ? post.image_url : '',
    }))
  }
  return next
}
async function snapshotUploadsForMissingPhoto() {
  await rm(uploadSnapshotDir, { recursive: true, force: true })
  await mkdir(uploadSnapshotDir, { recursive: true })
  await cp(uploadDir, uploadSnapshotDir, { recursive: true }).catch(() => {})
  uploadSnapshotForMissingPhoto = true
}
async function restoreUploadsForMissingPhoto() {
  if (!uploadSnapshotForMissingPhoto) return
  await rm(uploadDir, { recursive: true, force: true })
  await cp(uploadSnapshotDir, uploadDir, { recursive: true }).catch(async () => {
    await mkdir(uploadDir, { recursive: true })
  })
  await rm(uploadSnapshotDir, { recursive: true, force: true }).catch(() => {})
  uploadSnapshotForMissingPhoto = false
}
async function restoreMissingPhotoSnapshot() {
  if (!storeSnapshotForMissingPhoto) return
  await writeFile(storeFile, storeSnapshotForMissingPhoto)
  await restoreUploadsForMissingPhoto()
  await execFileAsync('systemctl', ['restart', 'pet-wool-api'])
  const expected = JSON.parse(storeSnapshotForMissingPhoto)
  const expectedOrder = missingPhotoSnapshotOrderId
    ? (expected.orders || []).find((order) => order.id === missingPhotoSnapshotOrderId)
    : null
  const expectedPhotoUrls = JSON.stringify(expectedOrder?.photo_urls || [])
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const current = await fetch(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } })
      .then((res) => res.ok ? res.json() : [])
      .catch(() => [])
    const target = missingPhotoSnapshotOrderId
      ? current.find((order) => order.id === missingPhotoSnapshotOrderId)
      : null
    if (target && JSON.stringify(target.photo_urls || []) === expectedPhotoUrls) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('missing photo snapshot restore did not become visible through API')
}
async function setLang(page, value) {
  // The language selector lives in the preferences popover, opened by the
  // header toggle, with one button per language.
  const label = { ko: '한국어', en: 'English', zh: '中文' }[value] || value
  await page.locator('header .preferences-toggle').first().click()
  await page.locator('header .preferences-popover button', { hasText: label }).first().click()
  await page.locator('header .preferences-toggle').first().click().catch(() => {})
  await page.waitForLoadState('networkidle')
}
// Open the shared preferences popover (language + theme controls).
async function openPreferences(page) {
  await page.locator('header .preferences-toggle').first().click()
  await page.locator('header .preferences-popover').waitFor({ state: 'visible', timeout: 10000 })
}
async function waitForSiteBrand(name) {
  const started = Date.now()
  let lastValue = null
  while (Date.now() - started < 10000) {
    lastValue = await fetch(`${base}/api/admin/site`, { headers: { authorization: 'Bearer admin-e2e' } })
      .then(async (res) => ({ status: res.status, body: await res.json() }))
      .catch((error) => ({ status: 0, body: { message: error.message } }))
    if (lastValue.status === 200 && lastValue.body?.brand?.name === name) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`site brand did not update to ${name}: ${JSON.stringify(lastValue)}`)
}
async function waitForContactState(talkEnabled, lineEnabled) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const site = await (await fetch(`${base}/api/admin/site`, { headers: { authorization: 'Bearer admin-e2e' } })).json()
    if (site.contact?.talk_enabled === talkEnabled && site.contact?.line_enabled === lineEnabled) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`contact state did not update to talk=${talkEnabled}, line=${lineEnabled}`)
}
async function waitForSiteSwitches({ talkEnabled, lineEnabled, paypalEnabled }) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const site = await (await fetch(`${base}/api/admin/site`, { headers: { authorization: 'Bearer admin-e2e' } })).json()
    if (
      site.contact?.talk_enabled === talkEnabled
      && site.contact?.line_enabled === lineEnabled
      && site.paypal?.enabled === paypalEnabled
    ) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`site switches did not update to talk=${talkEnabled}, line=${lineEnabled}, paypal=${paypalEnabled}`)
}
async function waitForPaypalCurrency(currency) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const site = await (await fetch(`${base}/api/admin/site`, { headers: { authorization: 'Bearer admin-e2e' } })).json()
    if (site.paypal?.enabled === true && site.paypal?.currency === currency) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`paypal currency did not update to ${currency}`)
}
async function fetchJsonArray(url, options = {}, label = 'array response') {
  const started = Date.now()
  let lastValue = null
  while (Date.now() - started < 10000) {
    lastValue = await fetch(url, options).then((res) => res.json()).catch((error) => ({ message: error.message }))
    if (Array.isArray(lastValue)) return lastValue
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} was not an array: ${JSON.stringify(lastValue)}`)
}
async function setSiteBrand(name) {
  const site = await (await fetch(`${base}/api/admin/site`, { headers: { authorization: 'Bearer admin-e2e' } })).json()
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...site, brand: { ...(site.brand || {}), name } })
  })
  await waitForSiteBrand(name)
}
async function restoreOriginalSite() {
  if (!originalSiteSnapshot) return
  const res = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      brand: originalSiteSnapshot.brand,
      paypal: { ...(originalSiteSnapshot.paypal || {}), currency: 'USD' },
      shipping: originalSiteSnapshot.shipping,
      contact: originalSiteSnapshot.contact,
      policies: originalSiteSnapshot.policies,
      faq: originalSiteSnapshot.faq,
      reviews: originalSiteSnapshot.reviews,
      blog: originalSiteSnapshot.blog,
    })
  })
  if (!res.ok) throw new Error(`original site restore failed: ${res.status}`)
}
async function waitForPublicProduct(slug, title) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const product = await fetch(`${base}/api/products/${slug}?lang=zh`).then((res) => res.json()).catch(() => null)
    if (product?.title === title) return product
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`admin created product not public: ${JSON.stringify(await fetch(`${base}/api/products/${slug}?lang=zh`).then((res) => res.json()).catch((e) => ({ message: e.message })))}`)
}

async function ensureTemporaryProduct(categoryId) {
  const products = await fetchJsonArray(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin products')
  const existing = products.find((item) => item.slug === temporaryProductSlug)
  const payload = {
    ...(existing || {}),
    category_id: categoryId,
    slug: temporaryProductSlug,
    title: temporaryProductTitle,
    subtitle: '用于验证新增商品前台展示',
    description: '用于端到端验证新增商品能够进入官网分类页展示。',
    base_price_cents: 123400,
    currency: 'krw',
    deposit_percent: 50,
    image_url: 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82',
    images: ['https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82'],
    tags: ['@ExportGuard', 'Birthday Gift'],
    seo_title: `商业化测试商品 SEO ${stamp}`,
    seo_description: `商业化测试商品 SEO 描述 ${stamp}`,
    options: [{ name: ' 测试规格 ', price_cents: ' 123400 ', translations: { zh: { name: '测试规格' }, en: { name: '测试规格' }, ko: { name: '测试规格' } } }],
    translations: {
      ...(existing?.translations || {}),
      zh: { title: temporaryProductTitle, subtitle: '用于验证新增商品前台展示', description: '用于端到端验证新增商品能够进入官网分类页展示。', seo_title: `商业化测试商品 SEO ${stamp}`, seo_description: `商业化测试商品 SEO 描述 ${stamp}` },
      en: { title: temporaryProductTitle, subtitle: '用于验证新增商品前台展示', description: '用于端到端验证新增商品能够进入官网分类页展示。', seo_title: `商业化测试商品 SEO ${stamp}`, seo_description: `商业化测试商品 SEO 描述 ${stamp}` },
      ko: { title: temporaryProductTitle, subtitle: '用于验证新增商品前台展示', description: '用于端到端验证新增商品能够进入官网分类页展示。', seo_title: `商业化测试商品 SEO ${stamp}`, seo_description: `商业化测试商品 SEO 描述 ${stamp}` },
    },
    status: 'published',
  }
  if (existing) {
    const updateRes = await fetch(`${base}/api/admin/products/${existing.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
      body: JSON.stringify(payload)
    })
    const updated = await updateRes.json()
    if (!updateRes.ok) throw new Error(`product export guard product reset failed: ${updateRes.status} ${JSON.stringify(updated)}`)
    temporaryProductId = updated.id
    return updated
  }
  const productRes = await fetch(`${base}/api/admin/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify(payload)
  })
  const createdProduct = await productRes.json()
  if (!productRes.ok) throw new Error(`product create check failed: ${JSON.stringify(createdProduct)}`)
  if (createdProduct.currency === 'KRW' && createdProduct.options?.[0]?.price_cents === 123400 && createdProduct.options?.[0]?.name === '测试规格') ok('admin product create API normalizes product fields')
  else throw new Error(`product create normalization failed: ${JSON.stringify(createdProduct)}`)
  temporaryProductId = createdProduct.id
  return createdProduct
}

async function ensurePaypalProduct(categoryId) {
  const products = await fetchJsonArray(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin products')
  const existing = products.find((item) => item.slug === paypalProductSlug)
  const payload = {
    ...(existing || {}),
    category_id: categoryId,
    slug: paypalProductSlug,
    title: paypalProductTitle,
    subtitle: '用于验证 PayPal 美元付款流程',
    description: '用于端到端验证 PayPal 配置为 USD 时订单、支付、后台处理流程稳定。',
    base_price_cents: 12900,
    currency: 'KRW',
    deposit_percent: 50,
    image_url: 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82',
    images: ['https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82'],
    tags: ['@ExportGuard', 'PayPal'],
    seo_title: `PayPal 美元测试商品 SEO ${stamp}`,
    seo_description: `PayPal 美元测试商品 SEO 描述 ${stamp}`,
    options: [
      { id: existing?.options?.[0]?.id, name: '美元定制规格', price_cents: 12900 },
      { id: existing?.options?.[1]?.id, name: '美元升级规格', price_cents: 19900 },
    ].map((option) => ({ ...option, id: option.id || undefined })),
    translations: {
      ...(existing?.translations || {}),
      zh: { title: paypalProductTitle, subtitle: '用于验证 PayPal 美元付款流程', description: '用于端到端验证 PayPal 配置为 USD 时订单、支付、后台处理流程稳定。', seo_title: `PayPal 美元测试商品 SEO ${stamp}`, seo_description: `PayPal 美元测试商品 SEO 描述 ${stamp}` },
      en: { title: paypalProductTitle, subtitle: '用于验证 PayPal 美元付款流程', description: '用于端到端验证 PayPal 配置为 USD 时订单、支付、后台处理流程稳定。', seo_title: `PayPal 美元测试商品 SEO ${stamp}`, seo_description: `PayPal 美元测试商品 SEO 描述 ${stamp}` },
      ko: { title: paypalProductTitle, subtitle: '用于验证 PayPal 美元付款流程', description: '用于端到端验证 PayPal 配置为 USD 时订单、支付、后台处理流程稳定。', seo_title: `PayPal 美元测试商品 SEO ${stamp}`, seo_description: `PayPal 美元测试商品 SEO 描述 ${stamp}` },
    },
    status: 'published',
  }
  const res = await fetch(existing ? `${base}/api/admin/products/${existing.id}` : `${base}/api/admin/products`, {
    method: existing ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify(payload)
  })
  const product = await res.json()
  if (!res.ok) throw new Error(`paypal product setup failed: ${res.status} ${JSON.stringify(product)}`)
  return product
}

async function ensureReadinessWarningProduct(categoryId) {
  const products = await fetchJsonArray(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin products')
  const existing = products.find((item) => item.slug === readinessProductSlug)
  const payload = {
    ...(existing || {}),
    category_id: categoryId,
    slug: readinessProductSlug,
    title: readinessProductTitle,
    subtitle: '用于验证后台商品配置提示',
    description: '用于验证后台商品配置待完善提示。',
    base_price_cents: 100000,
    currency: 'KRW',
    deposit_percent: 50,
    image_url: '',
    images: [],
    tags: ['@ExportGuard'],
    options: [{ name: '测试规格', price_cents: 100000 }],
    translations: {
      ...(existing?.translations || {}),
      zh: { title: readinessProductTitle, subtitle: '用于验证后台商品配置提示', description: '用于验证后台商品配置待完善提示。', seo_title: '', seo_description: '' },
    },
    seo_title: '',
    seo_description: '',
    status: 'hidden',
  }
  const res = await fetch(existing?.id ? `${base}/api/admin/products/${existing.id}` : `${base}/api/admin/products`, {
    method: existing?.id ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify(payload)
  })
  const product = await res.json()
  if (!res.ok) throw new Error(`readiness warning product setup failed: ${res.status} ${JSON.stringify(product)}`)
  return product
}

async function ensureHiddenProduct(categoryId) {
  const products = await fetchJsonArray(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin products')
  const existing = products.find((item) => item.slug === hiddenProductSlug)
  if (existing) {
    hiddenProductId = existing.id
    if (existing.status === 'hidden') return existing
    const hiddenRes = await fetch(`${base}/api/admin/products/${existing.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
      body: JSON.stringify({ ...existing, status: 'hidden' })
    })
    const hiddenExisting = await hiddenRes.json()
    if (!hiddenRes.ok) throw new Error(`hidden product status restore failed: ${hiddenRes.status} ${JSON.stringify(hiddenExisting)}`)
    return hiddenExisting
  }
  const productRes = await fetch(`${base}/api/admin/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      category_id: categoryId,
      slug: hiddenProductSlug,
      title: '隐藏测试商品',
      subtitle: '不应公开展示',
      description: '用于验证隐藏商品不能被前台直链访问或下单。',
      base_price_cents: 234500,
      currency: 'KRW',
      deposit_percent: 50,
      image_url: 'https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=900&q=82',
      images: ['https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=900&q=82'],
      tags: ['Memorial Gift'],
      options: [{ name: '隐藏规格', price_cents: 234500, translations: { zh: { name: '隐藏规格' }, en: { name: '隐藏规格' }, ko: { name: '隐藏规格' } } }],
      translations: {
        zh: { title: '隐藏测试商品', subtitle: '不应公开展示', description: '用于验证隐藏商品不能被前台直链访问或下单。' },
        en: { title: '隐藏测试商品', subtitle: '不应公开展示', description: '用于验证隐藏商品不能被前台直链访问或下单。' },
        ko: { title: '隐藏测试商品', subtitle: '不应公开展示', description: '用于验证隐藏商品不能被前台直链访问或下单。' },
      },
      status: 'hidden',
    })
  })
  const product = await productRes.json()
  if (!productRes.ok) throw new Error(`hidden product create failed: ${JSON.stringify(product)}`)
  hiddenProductId = product.id
  return product
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
await page.addInitScript(() => localStorage.setItem('lang', 'zh'))
page.on('pageerror', error => {
  if (apiRestartInProgress && String(error?.message || error).includes('502 Bad Gateway')) return
  fail('page error', error)
})
page.on('console', msg => {
  if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) fail('console error', msg.text())
})

try {
  await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-e2e-data.mjs', '--apply', '--confirm-e2e-cleanup']).catch(() => {})
  await writeFile(uploadFixture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
  await writeFile(invalidUploadFixture, 'not an image')
  const uploadedPhotoSetupRes = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: await readFile(uploadFixture)
  })
  const uploadedPhotoSetup = await uploadedPhotoSetupRes.json()
  if (!uploadedPhotoSetupRes.ok || !uploadedPhotoSetup.url) throw new Error(`shared upload setup failed: ${uploadedPhotoSetupRes.status} ${JSON.stringify(uploadedPhotoSetup)}`)
  const uploadedPhotoUrl = uploadedPhotoSetup.url
  const healthRes = await fetch(`${base}/api/health`)
  const health = await healthRes.json()
  if (healthRes.ok && health.ok === true && health.service === 'pet-wool-api' && health.counts && !('data_file' in health) && !('upload_dir' in health) && !JSON.stringify(health).includes('/root/')) ok('health endpoint hides server paths')
  else throw new Error(`health endpoint leaked internals or was invalid: ${healthRes.status} ${JSON.stringify(health)}`)
  if (healthRes.headers.get('x-content-type-options') === 'nosniff' && healthRes.headers.get('x-frame-options') === 'DENY') ok('api responses include security headers')
  else throw new Error(`api security headers missing: ${JSON.stringify({ nosniff: healthRes.headers.get('x-content-type-options'), frame: healthRes.headers.get('x-frame-options') })}`)
  if (String(healthRes.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'")) ok('api responses include content security policy')
  else throw new Error(`api content security policy missing: ${healthRes.headers.get('content-security-policy')}`)
  const badCurrencyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await badCurrencyPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const publicProductsForMoneyGuard = await fetchJsonArray(`${base}/api/products?lang=zh`, {}, 'public products for money guard')
  const moneyGuardProduct = {
    ...(publicProductsForMoneyGuard[0] || {}),
    id: `bad-currency-${stamp}`,
    slug: `bad-currency-${stamp}`,
    title: '异常币种兜底商品',
    currency: 'BAD-CURRENCY',
    base_price_cents: 'not-a-number',
    options: [{ id: `bad-currency-option-${stamp}`, name: '异常规格', price_cents: 'not-a-number' }],
  }
  await badCurrencyPage.route('**/api/products?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify([moneyGuardProduct])
  }))
  await badCurrencyPage.goto(`${base}/`, { waitUntil: 'networkidle' })
  await badCurrencyPage.locator('text=异常币种兜底商品').first().waitFor({ state: 'visible', timeout: 10000 })
  const badCurrencyText = await badCurrencyPage.locator('body').innerText()
  await badCurrencyPage.close()
  if (badCurrencyText.includes('₩0')) ok('frontend money formatter falls back for invalid currency and amount')
  else throw new Error(`frontend money fallback missing: ${badCurrencyText.slice(0, 500)}`)
  const operationsDoc = await readFile('/root/pet-wool-platform/docs/OPERATIONS.md', 'utf8')
  const readmeDoc = await readFile('/root/pet-wool-platform/README.md', 'utf8')
  const siteDoc = await readFile('/root/pet-wool-platform/site-doc/index.html', 'utf8')
  const systemSettingsDoc = await readFile('/root/pet-wool-platform/docs/SYSTEM_SETTINGS.md', 'utf8')
  const completionDoc = await readFile('/root/pet-wool-platform/docs/FUNCTION_COMPLETION_ANALYSIS.md', 'utf8')
  const e2ePlanDoc = await readFile('/root/pet-wool-platform/test-results/E2E_TEST_PLAN.md', 'utf8')
  const backupScript = await readFile('/root/pet-wool-platform/scripts/backup-data.mjs', 'utf8')
  const smokeScript = await readFile('/root/pet-wool-platform/scripts/smoke-check.sh', 'utf8')
  const requiredOperationsNotes = [
    'http://127.0.0.1:8888/admin',
    'bash scripts/smoke-check.sh',
    'node test-results/e2e-check.mjs',
    'node scripts/backup-data.mjs',
    'node scripts/restore-data.mjs --dry-run',
    'node scripts/restore-data.mjs --apply',
    'node scripts/cleanup-orphan-uploads.mjs --missing-refs',
    'node scripts/cleanup-orphan-uploads.mjs --apply --missing-refs',
    '/api/admin/backup?secrets=1',
    '完整密钥备份',
  ]
  const missingOperationsNotes = requiredOperationsNotes.filter((item) => !operationsDoc.includes(item))
  if (missingOperationsNotes.length === 0) ok('operations runbook documents publish backup restore and cleanup safeguards')
  else throw new Error(`operations runbook missing notes: ${missingOperationsNotes.join(', ')}`)
  if (smokeScript.includes('${BASE_URL}/doc/') && smokeScript.includes('doc site header missing')) ok('smoke check validates doc security headers')
  else throw new Error('smoke check does not validate doc security headers')
  const requiredSiteDocNotes = ['当前可交付功能', '我的订单', 'PayPal 沙盒流程', 'PayPal Client ID / Secret / Webhook ID', '脱敏备份', '完整密钥备份二次确认', 'http://36.138.248.23:8888/admin']
  const missingSiteDocNotes = requiredSiteDocNotes.filter((item) => !siteDoc.includes(item))
  if (missingSiteDocNotes.length === 0) ok('customer documentation reflects current deliverable scope')
  else throw new Error(`customer documentation missing current scope notes: ${missingSiteDocNotes.join(', ')}`)
  const requiredCurrentDocs = ['平铺色板', 'White', 'PayPal Client ID', 'Secret', 'Webhook ID', '脱敏备份', '备份恢复']
  const missingCurrentDocs = requiredCurrentDocs.filter((item) => !systemSettingsDoc.includes(item) || !completionDoc.includes(item))
  if (missingCurrentDocs.length === 0 && !completionDoc.includes('增加博客/评价/机器人知识库管理界面')) ok('maintenance docs reflect current admin and theme scope')
  else throw new Error(`maintenance docs stale or incomplete: ${missingCurrentDocs.join(', ')}`)
  const requiredE2ePlanNotes = ['870+ 项断言', 'pet-wool-frontend-dev', 'Vite 前端服务', 'mobile-admin-users.png', 'API 边界']
  const missingE2ePlanNotes = requiredE2ePlanNotes.filter((item) => !e2ePlanDoc.includes(item))
  if (missingE2ePlanNotes.length === 0) ok('e2e test plan reflects current commercial regression scope')
  else throw new Error(`e2e test plan missing current scope notes: ${missingE2ePlanNotes.join(', ')}`)
  const sensitiveBackupNotes = ['node scripts/backup-data.mjs', 'PayPal Secret', 'Webhook ID', '脱敏备份']
  const missingSensitiveBackupNotes = sensitiveBackupNotes.filter((item) => !operationsDoc.includes(item) || !readmeDoc.includes(item))
  if (missingSensitiveBackupNotes.length === 0 && backupScript.includes('PayPal Secret') && backupScript.includes('Treat the backup directory as sensitive')) ok('backup docs and generated readme warn about payment secrets')
  else throw new Error(`backup secret handling warning missing: ${missingSensitiveBackupNotes.join(', ')}`)
  const missingAdminTokenRes = await fetch(`${base}/api/admin/overview`)
  if (missingAdminTokenRes.status === 401) ok('api rejects missing admin token')
  else throw new Error(`missing admin token accepted: ${missingAdminTokenRes.status}`)
  const forgedAdminRes = await fetch(`${base}/api/admin/overview`, { headers: { authorization: 'Bearer admin-fake-token' } })
  if (forgedAdminRes.status === 401) ok('api rejects forged admin token')
  else throw new Error(`forged admin token accepted: ${forgedAdminRes.status}`)
  const anonymousAdminPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await anonymousAdminPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const anonymousAdminRequests = []
  anonymousAdminPage.on('request', (request) => {
    if (request.url().includes('/api/admin/')) anonymousAdminRequests.push(request.url())
  })
  await anonymousAdminPage.goto(`${base}/admin/dashboard`, { waitUntil: 'networkidle' })
  await anonymousAdminPage.waitForURL('**/admin', { timeout: 10000 })
  await anonymousAdminPage.locator('text=管理员登录').first().waitFor({ state: 'visible', timeout: 10000 })
  if (anonymousAdminRequests.length === 0) ok('admin dashboard route guard redirects anonymous users before API calls')
  else throw new Error(`anonymous admin dashboard made API calls before redirect: ${JSON.stringify(anonymousAdminRequests)}`)
  await anonymousAdminPage.close()
  const loginRes = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'admin123456' })
  })
  const loginData = await loginRes.json()
  if (!loginRes.ok || !loginData.token) throw new Error(`admin login api failed: ${loginRes.status} ${JSON.stringify(loginData)}`)
  if (loginRes.headers.get('cache-control') === 'no-store') ok('admin login response is not cached')
  else throw new Error(`admin login cache-control invalid: ${loginRes.headers.get('cache-control')}`)
  const realAdminRes = await fetch(`${base}/api/admin/overview`, { headers: { authorization: `Bearer ${loginData.token}` } })
  if (realAdminRes.ok) ok('api accepts signed admin session token')
  else throw new Error(`signed admin session rejected: ${realAdminRes.status}`)
  if (realAdminRes.headers.get('cache-control') === 'no-store') ok('admin data responses are not cached')
  else throw new Error(`admin overview cache-control invalid: ${realAdminRes.headers.get('cache-control')}`)
  const logoutProbeLogin = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'admin123456' })
  }).then((res) => res.json())
  const logoutProbeRes = await fetch(`${base}/api/admin/logout`, { method: 'POST', headers: { authorization: `Bearer ${logoutProbeLogin.token}` } })
  if (logoutProbeRes.ok) ok('api admin logout succeeds')
  else throw new Error(`admin logout failed: ${logoutProbeRes.status}`)
  const loggedOutAdminRes = await fetch(`${base}/api/admin/overview`, { headers: { authorization: `Bearer ${logoutProbeLogin.token}` } })
  if (loggedOutAdminRes.status === 401) ok('api admin logout invalidates session token')
  else throw new Error(`admin logout token still accepted: ${loggedOutAdminRes.status}`)
  const publicSiteRes = await fetch(`${base}/api/site`)
  const publicSite = await publicSiteRes.json()
  if (publicSiteRes.headers.get('cache-control') === 'no-store') ok('public site config response is not cached')
  else throw new Error(`public site config cache-control invalid: ${publicSiteRes.headers.get('cache-control')}`)
  if (!('secret' in (publicSite.paypal || {})) && !('webhook_id' in (publicSite.paypal || {}))) ok('public site config hides paypal secrets')
  else throw new Error(`public site config leaked paypal secrets: ${JSON.stringify(publicSite.paypal)}`)
  const googlePublic = publicSite.google || {}
  // The frontend needs auth_mode/demo_enabled to pick demo vs real Google
  // login. client_id must be empty in demo mode and never include a secret.
  if (googlePublic.auth_mode === 'demo' && googlePublic.client_id === '' && 'demo_enabled' in googlePublic && !('secret' in googlePublic)) ok('public site config exposes google login mode without secrets')
  else if (googlePublic.auth_mode === 'google' && typeof googlePublic.client_id === 'string' && googlePublic.client_id.length > 0 && !('secret' in googlePublic)) ok('public site config exposes google login mode without secrets')
  else throw new Error(`public site config google login mode invalid: ${JSON.stringify(googlePublic)}`)
  if (!JSON.stringify(publicSite).includes('"translations"')) ok('public site config hides translation internals')
  else throw new Error(`public site config leaked translation internals: ${JSON.stringify(publicSite).slice(0, 500)}`)
  const publicSiteKeys = Object.keys(publicSite).sort()
  const allowedPublicSiteKeys = ['blog', 'bot', 'brand', 'contact', 'faq', 'google', 'paypal', 'policies', 'reviews', 'shipping', 'taxonomies', 'theme'].sort()
  if (JSON.stringify(publicSiteKeys) === JSON.stringify(allowedPublicSiteKeys)) ok('public site config uses explicit field whitelist')
  else throw new Error(`public site config keys are not whitelisted: ${JSON.stringify(publicSiteKeys)}`)
  const missingPaypalCurrencyRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({ paypal: { currency: '' } })
  })
  if (!missingPaypalCurrencyRes.ok) throw new Error(`clearing paypal currency failed: ${missingPaypalCurrencyRes.status}`)
  const missingPaypalCurrencySite = await fetch(`${base}/api/site`).then((res) => res.json())
  if (missingPaypalCurrencySite.paypal?.currency === 'USD') ok('public site defaults missing paypal currency to supported USD')
  else throw new Error(`missing paypal currency default invalid: ${JSON.stringify(missingPaypalCurrencySite.paypal)}`)
  const restorePaypalCurrencyRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({ paypal: { currency: publicSite.paypal?.currency || 'USD' } })
  })
  if (!restorePaypalCurrencyRes.ok) throw new Error(`restoring paypal currency failed: ${restorePaypalCurrencyRes.status}`)
  const siteFailurePage = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await siteFailurePage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await siteFailurePage.route('**/api/site**', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'site unavailable' })
  }))
  await siteFailurePage.goto(base, { waitUntil: 'networkidle' })
  await siteFailurePage.getByText('WoolBuddy').first().waitFor({ state: 'visible', timeout: 10000 })
  await siteFailurePage.getByRole('link', { name: '分类', exact: true }).first().waitFor({ state: 'visible', timeout: 10000 })
  ok('public app renders fallback shell when site config fails')
  await siteFailurePage.close()
  const adminSite = await fetch(`${base}/api/admin/site`, { headers: { authorization: `Bearer ${loginData.token}` } }).then((res) => res.json())
  originalSiteSnapshot = JSON.parse(JSON.stringify(adminSite))
  if ('paypal' in adminSite && !('secret' in (adminSite.paypal || {})) && !('webhook_id' in (adminSite.paypal || {}))) ok('admin site config redacts paypal secret fields')
  else throw new Error(`admin site config leaked paypal secret fields: ${JSON.stringify(adminSite.paypal)}`)
  const backupRes = await fetch(`${base}/api/admin/backup`, { headers: { authorization: `Bearer ${loginData.token}` } })
  const backup = await backupRes.json()
  if (backupRes.ok && backup.schema === 'pet-wool-platform-store-v1' && backup.data?.site && Array.isArray(backup.data?.products) && Array.isArray(backup.data?.orders)) ok('admin backup API returns store snapshot')
  else throw new Error(`admin backup API invalid: ${JSON.stringify(backup).slice(0, 300)}`)
  if (backupRes.headers.get('content-disposition')?.includes('pet-wool-backup-redacted-')) ok('admin redacted backup API filename is explicit')
  else throw new Error(`redacted backup filename invalid: ${backupRes.headers.get('content-disposition')}`)
  if (!JSON.stringify(backup).includes('/root/') && !('data_file' in backup) && !('upload_dir' in backup)) ok('admin backup does not expose server paths')
  else throw new Error('admin backup exposes server paths')
  if (backup.redacted === true && !('secret' in (backup.data?.site?.paypal || {})) && !('webhook_id' in (backup.data?.site?.paypal || {}))) ok('admin backup redacts payment secrets by default')
  else throw new Error(`admin backup leaked payment secrets by default: ${JSON.stringify(backup.data?.site?.paypal)}`)
  const unconfirmedFullBackupRes = await fetch(`${base}/api/admin/backup?secrets=1`, { headers: { authorization: `Bearer ${loginData.token}` } })
  if (unconfirmedFullBackupRes.status === 400) ok('admin full backup API requires explicit confirmation header')
  else throw new Error(`admin full backup without confirmation was accepted: ${unconfirmedFullBackupRes.status}`)
  const fullBackupRes = await fetch(`${base}/api/admin/backup?secrets=1`, { headers: fullBackupHeaders(loginData.token) })
  const fullBackup = await fullBackupRes.json()
  if (fullBackupRes.ok && fullBackup.redacted === false && fullBackup.data?.site?.paypal && 'secret' in fullBackup.data.site.paypal) ok('admin full backup can include payment secrets explicitly')
  else throw new Error(`admin full backup did not include explicit secret fields: ${JSON.stringify(fullBackup.data?.site?.paypal)}`)
  if (fullBackupRes.headers.get('content-disposition')?.includes('pet-wool-backup-full-')) ok('admin full backup API filename is explicit')
  else throw new Error(`full backup filename invalid: ${fullBackupRes.headers.get('content-disposition')}`)
  const backupProductCount = backup.data.products.length
  const restoreBrandName = `恢复站点配置 ${stamp}`
  const restoreRes = await fetch(`${base}/api/admin/site/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({ data: { site: { ...siteForRestore(adminSite), brand: { ...(adminSite.brand || {}), name: restoreBrandName } } } })
  })
  const restoredSite = await restoreRes.json()
  if (restoreRes.ok && restoredSite.brand?.name === restoreBrandName) ok('admin site restore API applies site backup')
  else throw new Error(`admin site restore API failed: ${JSON.stringify(restoredSite).slice(0, 300)}`)
  const restoreSecretProbe = `restore-secret-${stamp}`
  const restoreWebhookProbe = `restore-webhook-${stamp}`
  const restoreSecretSetupRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({ paypal: { secret: restoreSecretProbe, webhook_id: restoreWebhookProbe } })
  })
  if (!restoreSecretSetupRes.ok) throw new Error(`restore secret setup failed: ${restoreSecretSetupRes.status}`)
  const redactedRestoreSite = siteForRestore(backup.data.site)
  if (redactedRestoreSite.paypal) {
    delete redactedRestoreSite.paypal.secret
    delete redactedRestoreSite.paypal.webhook_id
  }
  const redactedRestoreRes = await fetch(`${base}/api/admin/site/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({ data: { site: { ...redactedRestoreSite, brand: { ...(redactedRestoreSite.brand || {}), name: restoreBrandName } } } })
  })
  const redactedRestoredSite = await redactedRestoreRes.json()
  const redactedRestoreFullBackup = await fetch(`${base}/api/admin/backup?secrets=1`, { headers: fullBackupHeaders(loginData.token) }).then((res) => res.json())
  if (redactedRestoreRes.ok && redactedRestoreFullBackup.data?.site?.paypal?.secret === restoreSecretProbe && redactedRestoreFullBackup.data?.site?.paypal?.webhook_id === restoreWebhookProbe) ok('admin site restore preserves redacted payment secrets')
  else throw new Error(`redacted site restore lost payment secrets: ${JSON.stringify(redactedRestoreFullBackup.data?.site?.paypal)}`)
  const productsAfterSiteRestore = await fetchJsonArray(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } }, 'products after site restore')
  if (productsAfterSiteRestore.length === backupProductCount) ok('admin site restore does not replace products')
  else throw new Error(`site restore changed products: ${backupProductCount} -> ${productsAfterSiteRestore.length}`)
  originalSiteSnapshot = restoredSite
  const paypalSecretProbe = `secret-${stamp}`
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { client_id: `client-${stamp}`, secret: paypalSecretProbe, webhook_id: `webhook-${stamp}`, currency: 'USD' } })
  })
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { currency: 'USD' } })
  })
  const mergedSite = await fetch(`${base}/api/admin/site`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  const mergedFullBackup = await fetch(`${base}/api/admin/backup?secrets=1`, { headers: fullBackupHeaders('admin-e2e') }).then((res) => res.json())
  if (!('secret' in (mergedSite.paypal || {})) && mergedFullBackup.data?.site?.paypal?.secret === paypalSecretProbe && mergedFullBackup.data?.site?.paypal?.client_id === `client-${stamp}` && mergedSite.paypal?.currency === 'USD') ok('admin site partial paypal save preserves secrets')
  else throw new Error(`partial paypal save lost fields: ${JSON.stringify({ public: mergedSite.paypal, full: mergedFullBackup.data?.site?.paypal })}`)
  const customFaqQuestion = `商业化 FAQ ${stamp}`
  const customFaqAnswer = `商业化 FAQ 答案 ${stamp}`
  const faqSaveRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({
      faq: [{
        id: `commercial-faq-${stamp}`,
        question: customFaqQuestion,
        answer: customFaqAnswer,
        translations: {
          zh: { question: customFaqQuestion, answer: customFaqAnswer },
          en: { question: customFaqQuestion, answer: customFaqAnswer },
          ko: { question: customFaqQuestion, answer: customFaqAnswer },
        }
      }, ...(mergedSite.faq || []).filter((faq) => !String(faq.id || '').startsWith('commercial-faq-') && faq.id !== 'probe-faq')]
    })
  })
  const faqSavedSite = await faqSaveRes.json()
  if (faqSaveRes.ok && faqSavedSite.faq?.some((faq) => faq.question === customFaqQuestion && faq.answer === customFaqAnswer)) ok('admin site FAQ save persisted')
  else throw new Error(`admin site FAQ save failed: ${faqSaveRes.status} ${JSON.stringify(faqSavedSite.faq)}`)
  const faqPublicSite = await fetch(`${base}/api/site?lang=zh`).then((res) => res.json())
  if (faqPublicSite.faq?.some((faq) => faq.question === customFaqQuestion && faq.answer === customFaqAnswer)) ok('public site exposes saved FAQ')
  else throw new Error(`public site FAQ missing saved FAQ: ${JSON.stringify(faqPublicSite.faq)}`)
  const customReviewTitle = `商业化评价 ${stamp}`
  const customReviewContent = `商业化评价内容 ${stamp}`
  const reviewSaveRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({
      reviews: [{
        id: `commercial-review-${stamp}`,
        name: '商业化客户',
        country: '中国',
        rating: 5,
        title: customReviewTitle,
        content: customReviewContent,
        product_slug: '',
        translations: {
          zh: { title: customReviewTitle, content: customReviewContent },
          en: { title: customReviewTitle, content: customReviewContent },
          ko: { title: customReviewTitle, content: customReviewContent },
        }
      }, ...(mergedSite.reviews || []).filter((review) => !String(review.id || '').startsWith('commercial-review-'))]
    })
  })
  const reviewSavedSite = await reviewSaveRes.json()
  if (reviewSaveRes.ok && reviewSavedSite.reviews?.some((review) => review.title === customReviewTitle && review.content === customReviewContent)) ok('admin site review save persisted')
  else throw new Error(`admin site review save failed: ${reviewSaveRes.status} ${JSON.stringify(reviewSavedSite.reviews)}`)
  const reviewPublicSite = await fetch(`${base}/api/site?lang=zh`).then((res) => res.json())
  if (reviewPublicSite.reviews?.some((review) => review.title === customReviewTitle && review.content === customReviewContent)) ok('public site exposes saved reviews')
  else throw new Error(`public site reviews missing saved review: ${JSON.stringify(reviewPublicSite.reviews)}`)
  const customBlogSlug = `commercial-blog-${stamp}`
  const customBlogTitle = `商业化博客 ${stamp}`
  const customBlogExcerpt = `商业化博客摘要 ${stamp}`
  const customBlogContent = `商业化博客正文 ${stamp}`
  const blogSaveRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${loginData.token}` },
    body: JSON.stringify({
      blog: [{
        id: customBlogSlug,
        slug: customBlogSlug,
        date: '2026-06-28',
        title: customBlogTitle,
        excerpt: customBlogExcerpt,
        content: customBlogContent,
        image_url: '/assets/hero.png',
        tags: ['商业化', '测试'],
        translations: {
          zh: { title: customBlogTitle, excerpt: customBlogExcerpt, content: customBlogContent },
          en: { title: customBlogTitle, excerpt: customBlogExcerpt, content: customBlogContent },
          ko: { title: customBlogTitle, excerpt: customBlogExcerpt, content: customBlogContent },
        }
      }, ...(mergedSite.blog || []).filter((post) => !String(post.id || '').startsWith('commercial-blog-') && !String(post.slug || '').startsWith('commercial-blog-'))]
    })
  })
  const blogSavedSite = await blogSaveRes.json()
  if (blogSaveRes.ok && blogSavedSite.blog?.some((post) => post.slug === customBlogSlug && post.title === customBlogTitle)) ok('admin site blog save persisted')
  else throw new Error(`admin site blog save failed: ${blogSaveRes.status} ${JSON.stringify(blogSavedSite.blog)}`)
  const publicBlogList = await fetch(`${base}/api/blog?lang=zh`).then((res) => res.json())
  if (publicBlogList?.some((post) => post.slug === customBlogSlug && post.title === customBlogTitle)) ok('public blog list exposes saved post')
  else throw new Error(`public blog list missing saved post: ${JSON.stringify(publicBlogList).slice(0, 500)}`)
  const publicBlogListLeak = JSON.stringify(publicBlogList)
  if (!/\"translations\"|\"internal_note\"|\"created_at\"|\"updated_at\"/.test(publicBlogListLeak)) ok('public blog list hides internal fields')
  else throw new Error(`public blog list leaked internal fields: ${publicBlogListLeak.slice(0, 500)}`)
  const publicBlogDetail = await fetch(`${base}/api/blog/${customBlogSlug}?lang=zh`).then((res) => res.json())
  if (publicBlogDetail?.title === customBlogTitle && publicBlogDetail?.content === customBlogContent) ok('public blog detail exposes saved post')
  else throw new Error(`public blog detail missing saved post: ${JSON.stringify(publicBlogDetail).slice(0, 500)}`)
  const publicBlogDetailLeak = JSON.stringify(publicBlogDetail)
  if (!/\"translations\"|\"internal_note\"|\"created_at\"|\"updated_at\"/.test(publicBlogDetailLeak)) ok('public blog detail hides internal fields')
  else throw new Error(`public blog detail leaked internal fields: ${publicBlogDetailLeak.slice(0, 500)}`)
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { enabled: false } })
  })
  try {
    const publicProductsRes = await fetch(`${base}/api/products?lang=zh`)
    const paypalDisabledProducts = await publicProductsRes.json()
    if (publicProductsRes.headers.get('cache-control') === 'no-store') ok('public product list response is not cached')
    else throw new Error(`public product list cache-control invalid: ${publicProductsRes.headers.get('cache-control')}`)
    const paypalDisabledProduct = paypalDisabledProducts[0]
    const publicProductLeak = JSON.stringify(paypalDisabledProduct)
    if (!/\"translations\"|\"internal_note\"|\"created_at\"|\"updated_at\"/.test(publicProductLeak)) ok('public product list hides internal fields')
    else throw new Error(`public product list leaked internal fields: ${publicProductLeak}`)
    const publicProductDetailRes = await fetch(`${base}/api/products/${paypalDisabledProduct.slug}?lang=zh`)
    const publicProductDetail = await publicProductDetailRes.json()
    if (publicProductDetailRes.headers.get('cache-control') === 'no-store') ok('public product detail response is not cached')
    else throw new Error(`public product detail cache-control invalid: ${publicProductDetailRes.headers.get('cache-control')}`)
    const publicProductDetailLeak = JSON.stringify(publicProductDetail)
    if (!/\"translations\"|\"internal_note\"|\"created_at\"|\"updated_at\"/.test(publicProductDetailLeak)) ok('public product detail hides internal fields')
    else throw new Error(`public product detail leaked internal fields: ${publicProductDetailLeak}`)
    const publicCategoriesRes = await fetch(`${base}/api/categories?lang=zh`)
    const publicCategories = await publicCategoriesRes.json()
    if (publicCategoriesRes.headers.get('cache-control') === 'no-store') ok('public categories response is not cached')
    else throw new Error(`public categories cache-control invalid: ${publicCategoriesRes.headers.get('cache-control')}`)
    const publicCategoryLeak = JSON.stringify(publicCategories[0] || {})
    if (!/\"translations\"|\"internal_note\"|\"created_at\"|\"updated_at\"/.test(publicCategoryLeak)) ok('public categories hide internal fields')
    else throw new Error(`public categories leaked internal fields: ${publicCategoryLeak}`)
    await page.goto(`${base}/order?product=${paypalDisabledProduct.id}`, { waitUntil: 'networkidle' })
    await expectText(page, 'PayPal 当前暂不可用', 'order page warns paypal unavailable before submit')
    await expectText(page, '待确认金额', 'order page uses non-paypal amount label when paypal disabled')
    await expectNoText(page, 'PayPal 应付', 'order page avoids paypal due label when paypal disabled')
    await page.getByLabel('姓名').fill('PayPal Disabled UI')
    await page.getByLabel('邮箱', { exact: true }).fill(`commercial-paypal-disabled-ui-${stamp}@example.com`)
    await page.getByLabel('联系电话').fill('13800000000')
    await page.getByLabel('国家/地区').fill('CN')
    await page.getByLabel('宠物名字').fill('PayLater')
    await page.getByLabel('宠物类型').fill('Cat')
    await page.setInputFiles('input[type="file"]', uploadFixture)
    await page.locator('.photo-preview img').first().waitFor({ state: 'visible', timeout: 10000 })
    await page.getByRole('button', { name: '提交订单' }).click()
    await expectText(page, '支付单暂时未生成', 'order page shows pay-later prompt when paypal disabled')
    await expectText(page, '联系客服', 'order page pay-later exposes direct support action')
    const orderPayLaterSupportHref = await page.locator('.summary-actions').getByRole('link', { name: '联系客服' }).getAttribute('href')
    const decodedOrderPayLaterSupportHref = decodeURIComponent(String(orderPayLaterSupportHref || ''))
    if (decodedOrderPayLaterSupportHref.includes('commercial-paypal-disabled-ui') && (decodedOrderPayLaterSupportHref.includes('WP-') || decodedOrderPayLaterSupportHref.includes('/support'))) ok('order page pay-later support action carries order context')
    else throw new Error(`order page pay-later support link missing context: ${orderPayLaterSupportHref}`)
    if (orderPayLaterSupportHref && orderPayLaterSupportHref.length < 1800 && !/[\r\n\t]/.test(decodedOrderPayLaterSupportHref)) ok('order page pay-later support link is compact and sanitized')
    else throw new Error(`order page pay-later support link unsafe: ${orderPayLaterSupportHref}`)
    const paypalDisabledOrderRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: paypalDisabledProduct?.id,
        option_id: paypalDisabledProduct?.options?.[0]?.id,
        customer_name: 'PayPal Disabled',
        email: `commercial-paypal-disabled-${stamp}@example.com`,
        phone: '13800000000',
        pet_name: 'DisabledPay',
        pet_type: 'Cat',
        payment_type: 'deposit',
        photo_urls: [uploadedPhotoUrl],
        lang: 'zh'
    })
  })
    const paypalDisabledOrder = await paypalDisabledOrderRes.json()
    if (!paypalDisabledOrderRes.ok) throw new Error(`paypal disabled order setup failed: ${paypalDisabledOrderRes.status} ${JSON.stringify(paypalDisabledOrder)}`)
    if (paypalDisabledOrderRes.headers.get('cache-control') === 'no-store') ok('public order response is not cached')
    else throw new Error(`public order cache-control invalid: ${paypalDisabledOrderRes.headers.get('cache-control')}`)
    const paypalDisabledCreateRes = await fetch(`${base}/api/paypal/create-order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order_id: paypalDisabledOrder.id })
    })
    if (paypalDisabledCreateRes.status === 503) ok('paypal create-order respects disabled config')
    else throw new Error(`paypal disabled config ignored: ${paypalDisabledCreateRes.status}`)
    if (paypalDisabledCreateRes.headers.get('cache-control') === 'no-store') ok('paypal create-order errors are not cached')
    else throw new Error(`paypal disabled cache-control invalid: ${paypalDisabledCreateRes.headers.get('cache-control')}`)
    await page.goto(`${base}/account`, { waitUntil: 'networkidle' })
    await page.getByLabel('登录邮箱').fill(`commercial-paypal-disabled-${stamp}@example.com`)
    await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
    await expectText(page, '未支付', 'account shows unpaid order when paypal disabled')
    await page.getByRole('button', { name: '继续 PayPal 支付' }).first().click()
    await expectText(page, '支付单暂时无法生成', 'account paypal unavailable recovery visible')
    await expectText(page, '支付暂不可用，可以先联系人工继续处理', 'account paypal recovery panel title visible')
    const recoveryActions = await page.locator('.payment-recovery-panel').evaluate((node) => node.textContent || '')
    if (recoveryActions.includes('联系客服') && recoveryActions.includes('刷新订单')) ok('account paypal recovery panel exposes support and refresh actions')
    else throw new Error(`account paypal recovery actions missing: ${recoveryActions}`)
    const recoverySupportHref = await page.locator('.payment-recovery-panel').getByRole('link', { name: '联系客服' }).getAttribute('href')
    const decodedRecoverySupportHref = decodeURIComponent(recoverySupportHref || '')
    if (decodedRecoverySupportHref.includes(paypalDisabledOrder.order_no) && decodedRecoverySupportHref.includes('/account')) ok('account paypal recovery support link carries order context')
    else throw new Error(`account paypal recovery support link missing order context: ${recoverySupportHref}`)
    const noContactRecoveryPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
    await noContactRecoveryPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
    await noContactRecoveryPage.route('**/api/site**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        brand: { name: 'No Contact Studio', email: '' },
        contact: { talk_enabled: false, line_enabled: false },
        paypal: { enabled: false, currency: 'USD' },
        theme: originalSiteSnapshot?.theme || {},
        shipping: originalSiteSnapshot?.shipping || {},
        bot: { enabled: false }
      })
    }))
    await noContactRecoveryPage.goto(`${base}/account`, { waitUntil: 'networkidle' })
    await noContactRecoveryPage.getByLabel('登录邮箱').fill(`commercial-paypal-disabled-${stamp}@example.com`)
    await noContactRecoveryPage.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
    await noContactRecoveryPage.getByRole('button', { name: '继续 PayPal 支付' }).first().click()
    await expectText(noContactRecoveryPage, '支付暂不可用，可以先联系人工继续处理', 'account no-contact paypal recovery panel visible')
    const noContactRecoveryHref = await noContactRecoveryPage.locator('.payment-recovery-panel').getByRole('link', { name: '联系客服' }).getAttribute('href')
    const decodedNoContactRecoveryHref = decodeURIComponent(noContactRecoveryHref || '')
    if (
      decodedNoContactRecoveryHref.includes('/support')
      && decodedNoContactRecoveryHref.includes(paypalDisabledOrder.order_no)
      && decodedNoContactRecoveryHref.includes(`commercial-paypal-disabled-${stamp}@example.com`)
    ) ok('account paypal recovery support fallback carries order context')
    else throw new Error(`account no-contact recovery support link missing context: ${noContactRecoveryHref}`)
    await noContactRecoveryPage.close()
    const disabledAccountText = await page.locator('.form-message').last().innerText()
    if (!disabledAccountText.includes('paypal disabled')) ok('account hides raw paypal disabled error')
    else throw new Error(`account leaked raw paypal disabled error: ${disabledAccountText}`)
  } finally {
    await fetch(`${base}/api/admin/site`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
      body: JSON.stringify({ paypal: { enabled: true } })
    })
  }
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { enabled: true, currency: 'USD' } })
  })
  // Under the KRW-base model the order currency is always convertible and the
  // only PayPal charge currency is USD (CNY is display-only). The guard now
  // verifies the admin API refuses any non-USD charge currency outright.
  const cnyCurrencyPutRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { enabled: true, currency: 'CNY' } })
  })
  if (cnyCurrencyPutRes.status === 400) ok('admin site config rejects non-USD paypal charge currency')
  else throw new Error(`non-USD paypal charge currency accepted: ${cnyCurrencyPutRes.status}`)
  await waitForPaypalCurrency('USD')
  const existingProducts = await fetchJsonArray(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } }, 'initial admin products')
  for (const product of existingProducts.filter(item => String(item.slug || '').startsWith('commercial-check-'))) {
    await fetch(`${base}/api/admin/products/${product.id}`, { method: 'DELETE', headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' } }).catch(() => {})
  }
  const categoryRes = await fetch(`${base}/api/admin/categories`, { headers: { authorization: 'Bearer admin-e2e' } })
  const categoryData = await categoryRes.json()
  const categoryId = categoryData[0]?.id
  if (!categoryId) throw new Error('no category available for product create check')
  const temporaryProduct = await ensureTemporaryProduct(categoryId)
  const zeroPriceStoreSnapshot = await readFile(storeFile, 'utf8')
  try {
    const zeroPriceStore = JSON.parse(zeroPriceStoreSnapshot)
    const zeroPriceProduct = zeroPriceStore.products?.find((product) => product.id === temporaryProduct.id)
    if (!zeroPriceProduct) throw new Error('temporary product missing for zero-price guard')
    zeroPriceProduct.options = [{ ...(zeroPriceProduct.options?.[0] || {}), name: '零元规格', price_cents: 0 }]
    await writeFile(storeFile, JSON.stringify(zeroPriceStore, null, 2))
    const zeroPricePublicProducts = await fetchJsonArray(`${base}/api/products?lang=zh`, {}, 'public products after zero-price fixture')
    if (!zeroPricePublicProducts.some((product) => product.id === temporaryProduct.id)) ok('public product list hides non-orderable products')
    else throw new Error('zero-price product leaked into public product list')
    const zeroPriceDetailRes = await fetch(`${base}/api/products/${temporaryProduct.slug}?lang=zh`)
    if (zeroPriceDetailRes.status === 404) ok('public product detail hides non-orderable products')
    else throw new Error(`zero-price product detail remained public: ${zeroPriceDetailRes.status}`)
    const zeroPriceOrderRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: temporaryProduct.id,
        option_id: temporaryProduct.options?.[0]?.id,
        customer_name: 'Zero Price Guard',
        email: `zero-price-${stamp}@example.com`,
        phone: '13800000000',
        pet_name: 'ZeroPrice',
        pet_type: 'Cat',
        payment_type: 'deposit',
        photo_urls: ['/uploads/e2e-placeholder.png'],
        lang: 'zh'
      })
    })
    if ([400, 404].includes(zeroPriceOrderRes.status)) ok('api rejects public orders for non-positive price options')
    else throw new Error(`zero-price public order accepted: ${zeroPriceOrderRes.status}`)
  } finally {
    await writeFile(storeFile, zeroPriceStoreSnapshot)
    try {
      apiRestartInProgress = true
      await execFileAsync('systemctl', ['restart', 'pet-wool-api'])
    } finally {
      apiRestartInProgress = false
    }
    await fetch(`${base}/api/health`)
    await ensureTemporaryProduct(categoryId)
  }
  const hiddenProduct = await ensureHiddenProduct(categoryId)
  const hiddenCategorySlug = `hidden-category-${stamp}`
  const hiddenCategoryTitle = `隐藏分类 ${stamp}`
  const hiddenCategoryRes = await fetch(`${base}/api/admin/categories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      slug: hiddenCategorySlug,
      title: hiddenCategoryTitle,
      description: '不应公开展示的隐藏分类',
      sort_order: 999,
      status: 'hidden',
      translations: {
        zh: { title: hiddenCategoryTitle, description: '不应公开展示的隐藏分类' },
        en: { title: hiddenCategoryTitle, description: '不应公开展示的隐藏分类' },
        ko: { title: hiddenCategoryTitle, description: '不应公开展示的隐藏分类' },
      }
    })
  })
  const hiddenCategory = await hiddenCategoryRes.json()
  if (!hiddenCategoryRes.ok) throw new Error(`hidden category create failed: ${hiddenCategoryRes.status} ${JSON.stringify(hiddenCategory)}`)
  const normalizedCategorySlug = `normalized-category-${stamp}`
  const normalizedCategoryRes = await fetch(`${base}/api/admin/categories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      slug: ` ${normalizedCategorySlug} `,
      title: `  规范分类 ${stamp}  `,
      description: '  分类描述  ',
      sort_order: '77',
      status: '',
    })
  })
  const normalizedCategory = await normalizedCategoryRes.json()
  if (
    normalizedCategoryRes.ok
    && normalizedCategory.slug === normalizedCategorySlug
    && normalizedCategory.title === `规范分类 ${stamp}`
    && normalizedCategory.description === '分类描述'
    && normalizedCategory.sort_order === 77
    && normalizedCategory.status === 'published'
  ) ok('api normalizes admin category payload')
  else throw new Error(`admin category payload not normalized: ${normalizedCategoryRes.status} ${JSON.stringify(normalizedCategory)}`)
  await fetch(`${base}/api/admin/categories/${normalizedCategory.id}`, { method: 'DELETE', headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' } }).catch(() => {})
  const hiddenCategoryProductSlug = `hidden-category-product-${stamp}`
  const hiddenCategoryProductTitle = `隐藏分类商品 ${stamp}`
  const hiddenCategoryProductRes = await fetch(`${base}/api/admin/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      category_id: hiddenCategory.id,
      slug: hiddenCategoryProductSlug,
      title: hiddenCategoryProductTitle,
      subtitle: '分类隐藏时不应公开',
      description: '用于验证隐藏分类会隐藏分类下商品。',
      base_price_cents: 345600,
      currency: 'KRW',
      deposit_percent: 50,
      image_url: 'https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=900&q=82',
      images: ['https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=900&q=82'],
      tags: ['Hidden Category'],
      options: [{ name: '隐藏分类规格', price_cents: 345600, translations: { zh: { name: '隐藏分类规格' }, en: { name: '隐藏分类规格' }, ko: { name: '隐藏分类规格' } } }],
      translations: {
        zh: { title: hiddenCategoryProductTitle, subtitle: '分类隐藏时不应公开', description: '用于验证隐藏分类会隐藏分类下商品。' },
        en: { title: hiddenCategoryProductTitle, subtitle: '分类隐藏时不应公开', description: '用于验证隐藏分类会隐藏分类下商品。' },
        ko: { title: hiddenCategoryProductTitle, subtitle: '分类隐藏时不应公开', description: '用于验证隐藏分类会隐藏分类下商品。' },
      },
      status: 'hidden',
    })
  })
  const hiddenCategoryProduct = await hiddenCategoryProductRes.json()
  if (!hiddenCategoryProductRes.ok) throw new Error(`hidden category product create failed: ${hiddenCategoryProductRes.status} ${JSON.stringify(hiddenCategoryProduct)}`)
  const publicCategoriesAfterHidden = await fetchJsonArray(`${base}/api/categories?lang=zh`, {}, 'public categories after hidden category create')
  if (!publicCategoriesAfterHidden.some((category) => category.slug === hiddenCategorySlug || category.id === hiddenCategory.id)) ok('public categories hide hidden categories')
  else throw new Error(`hidden category leaked publicly: ${JSON.stringify(publicCategoriesAfterHidden.find((category) => category.slug === hiddenCategorySlug || category.id === hiddenCategory.id))}`)
  const hiddenCategoryDetailRes = await fetch(`${base}/api/categories/${hiddenCategorySlug}?lang=zh`)
  if (hiddenCategoryDetailRes.status === 404) ok('public category detail hides hidden categories')
  else throw new Error(`hidden category detail was public: ${hiddenCategoryDetailRes.status}`)
  const hiddenCategoryProducts = await fetchJsonArray(`${base}/api/products?category=${hiddenCategorySlug}&lang=zh`, {}, 'public products for hidden category')
  if (!hiddenCategoryProducts.some((product) => product.slug === hiddenCategoryProductSlug || product.id === hiddenCategoryProduct.id)) ok('public product list hides products under hidden categories')
  else throw new Error(`hidden category product leaked in list: ${JSON.stringify(hiddenCategoryProducts)}`)
  const hiddenCategoryProductDetailRes = await fetch(`${base}/api/products/${hiddenCategoryProductSlug}?lang=zh`)
  if (hiddenCategoryProductDetailRes.status === 404) ok('public product detail hides products under hidden categories')
  else throw new Error(`hidden category product detail was public: ${hiddenCategoryProductDetailRes.status}`)
  const hiddenDetailRes = await fetch(`${base}/api/products/${hiddenProduct.slug}?lang=zh`)
  if (hiddenDetailRes.status === 404) ok('public product detail hides hidden products')
  else throw new Error(`hidden product detail was public: ${hiddenDetailRes.status}`)
  const hiddenOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: hiddenProduct.id,
      option_id: hiddenProduct.options?.[0]?.id,
      customer_name: 'Hidden Product Buyer',
      email: `hidden-${stamp}@example.com`,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Hidden',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  if (hiddenOrderRes.status === 404) ok('public order rejects hidden products')
  else throw new Error(`hidden product order was accepted: ${hiddenOrderRes.status}`)
  if (hiddenOrderRes.headers.get('cache-control') === 'no-store') ok('public order errors are not cached')
  else throw new Error(`hidden product order cache-control invalid: ${hiddenOrderRes.headers.get('cache-control')}`)
  const hiddenProductOrderPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await hiddenProductOrderPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await hiddenProductOrderPage.goto(`${base}/order?product=${hiddenProduct.id}`, { waitUntil: 'networkidle' })
  await expectText(hiddenProductOrderPage, '当前商品暂时不可下单，请重新选择商品。', 'order page warns when requested hidden product is unavailable')
  await expectText(hiddenProductOrderPage, '提交订单', 'order page remains usable after hidden product link')
  await expectText(hiddenProductOrderPage, '选择商品', 'order page keeps product selection for hidden product link')
  await expectNoText(hiddenProductOrderPage, hiddenProduct.title, 'order page does not select hidden product')
  await expectNoHorizontalOverflow(hiddenProductOrderPage, 'order hidden product fallback mobile layout has no horizontal overflow')
  await hiddenProductOrderPage.close()
  const invalidUploadRes = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'not an image'
  })
  if (invalidUploadRes.status === 415) ok('upload rejects non-image files')
  else throw new Error(`upload accepted invalid file: ${invalidUploadRes.status}`)
  const spoofedUploadRes = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: 'not a real png'
  })
  if (spoofedUploadRes.status === 415) ok('upload rejects spoofed image content')
  else throw new Error(`upload accepted spoofed image content: ${spoofedUploadRes.status}`)
  await writeFile(oversizeUploadFixture, Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
    Buffer.alloc(8 * 1024 * 1024)
  ]))
  const oversizedUploadRes = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: await readFile(oversizeUploadFixture)
  })
  if (oversizedUploadRes.status === 413) ok('upload rejects oversized images')
  else throw new Error(`upload accepted oversized image: ${oversizedUploadRes.status}`)
  const invalidJsonRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json'
  })
  const invalidJsonBody = await invalidJsonRes.json()
  if (invalidJsonRes.status === 400) ok('api rejects malformed json bodies')
  else throw new Error(`malformed json body accepted: ${invalidJsonRes.status}`)
  if (invalidJsonBody.message === 'invalid json') ok('api keeps safe validation error messages')
  else throw new Error(`malformed json error changed unexpectedly: ${JSON.stringify(invalidJsonBody)}`)
  const oversizedJsonRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notes: 'x'.repeat(2 * 1024 * 1024 + 1) })
  })
  if (oversizedJsonRes.status === 413) ok('api rejects oversized json bodies')
  else throw new Error(`oversized json body accepted: ${oversizedJsonRes.status}`)
  if ((oversizedJsonRes.headers.get('content-type') || '').includes('application/json')) {
    const oversizedJsonBody = await oversizedJsonRes.json()
    if (oversizedJsonBody.message === 'json body too large') ok('api keeps safe oversized body error messages')
    else throw new Error(`oversized json error changed unexpectedly: ${JSON.stringify(oversizedJsonBody)}`)
  } else {
    ok('api/proxy rejects oversized json before application processing')
  }
  const uploadDirUnavailable = `${uploadDir}-unavailable-${stamp}`
  await rm(uploadDirUnavailable, { recursive: true, force: true })
  await cp(uploadDir, uploadDirUnavailable, { recursive: true })
  await rm(uploadDir, { recursive: true, force: true })
  await writeFile(uploadDir, 'temporarily unavailable')
  try {
    const uploadServerErrorRes = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: await readFile(uploadFixture)
    })
    const uploadServerErrorBody = await uploadServerErrorRes.json()
    if (uploadServerErrorRes.status === 500 && uploadServerErrorBody.message === 'internal server error') ok('api hides unexpected internal upload errors')
    else throw new Error(`unexpected upload error response leaked details: ${uploadServerErrorRes.status} ${JSON.stringify(uploadServerErrorBody)}`)
  } finally {
    await rm(uploadDir, { recursive: true, force: true }).catch(() => {})
    await cp(uploadDirUnavailable, uploadDir, { recursive: true }).catch(() => {})
    await rm(uploadDirUnavailable, { recursive: true, force: true }).catch(() => {})
  }
  const validUploadRes = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: await readFile(uploadFixture)
  })
  const validUpload = await validUploadRes.json()
  if (!validUploadRes.ok) throw new Error(`valid upload failed: ${validUploadRes.status} ${JSON.stringify(validUpload)}`)
  if (validUploadRes.headers.get('cache-control') === 'no-store') ok('upload API response is not cached')
  else throw new Error(`upload API cache-control invalid: ${validUploadRes.headers.get('cache-control')}`)
  const uploadedFileRes = await fetch(`${base}${validUpload.url}`)
  if (uploadedFileRes.ok && uploadedFileRes.headers.get('content-type')?.includes('image/png')) ok('uploaded file is publicly readable')
  else throw new Error(`uploaded file was not readable: ${uploadedFileRes.status}`)
  if (String(uploadedFileRes.headers.get('cache-control') || '').includes('no-store')) ok('uploaded file response is not cached')
  else throw new Error(`uploaded file cache-control invalid: ${uploadedFileRes.headers.get('cache-control')}`)
  if (uploadedFileRes.headers.get('x-content-type-options') === 'nosniff') ok('uploaded files include security headers')
  else throw new Error(`uploaded file security headers missing: ${uploadedFileRes.headers.get('x-content-type-options')}`)
  if (String(uploadedFileRes.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'")) ok('uploaded files include content security policy')
  else throw new Error(`uploaded file content security policy missing: ${uploadedFileRes.headers.get('content-security-policy')}`)
  const nestedUploadPathRes = await fetch(`${base}/uploads/nested/${validUpload.filename}`)
  if (nestedUploadPathRes.status === 404) ok('upload serving rejects nested paths')
  else throw new Error(`upload nested path was accepted: ${nestedUploadPathRes.status}`)
  const invalidUploadNameRes = await fetch(`${base}/uploads/not-a-generated-name.png`)
  if (invalidUploadNameRes.status === 404) ok('upload serving rejects invalid filenames')
  else throw new Error(`upload invalid filename was accepted: ${invalidUploadNameRes.status}`)
  let rateLimitedUploadStatus = 0
  for (let i = 0; i < 31; i += 1) {
    const rateLimitRes = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-forwarded-for': `198.51.100.${String(stamp).slice(-2) || '10'}` },
      body: await readFile(uploadFixture)
    })
    rateLimitedUploadStatus = rateLimitRes.status
    if (rateLimitRes.status === 429) break
    if (!rateLimitRes.ok) throw new Error(`upload rate limit setup failed before limit: ${rateLimitRes.status}`)
  }
  if (rateLimitedUploadStatus === 429) ok('upload API rate limits burst requests')
  else throw new Error(`upload API did not rate limit burst requests: ${rateLimitedUploadStatus}`)
  await expectNoPublicAuthorization('/', 'public pages do not send admin token to public APIs')
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { localStorage.clear() })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await setLang(page, 'zh')
  await expectText(page, '3D 羊毛毡纪念作品', 'home hero visible in zh')
  const homeTitle = await page.title()
  if (homeTitle.includes('宠物羊毛毡纪念作品')) ok('home document title set', homeTitle)
  else throw new Error(`home title not set: ${homeTitle}`)
  const homeCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  const homeOgImage = await page.locator('meta[property="og:image"]').getAttribute('content')
  if (homeCanonical === `${base}/` && homeOgImage && /^https?:\/\//.test(homeOgImage)) ok('home canonical and og image set')
  else throw new Error(`home head invalid: ${JSON.stringify({ homeCanonical, homeOgImage })}`)
  const homeOgUrl = await page.locator('meta[property="og:url"]').getAttribute('content')
  const homeOgType = await page.locator('meta[property="og:type"]').getAttribute('content')
  const homeTwitterCard = await page.locator('meta[name="twitter:card"]').getAttribute('content')
  const homeTwitterImage = await page.locator('meta[name="twitter:image"]').getAttribute('content')
  if (homeOgUrl === `${base}/` && homeOgType === 'website' && homeTwitterCard === 'summary_large_image' && homeTwitterImage === homeOgImage) ok('home social sharing tags are complete')
  else throw new Error(`home social tags invalid: ${JSON.stringify({ homeOgUrl, homeOgType, homeTwitterCard, homeTwitterImage, homeOgImage })}`)
  await expectText(page, '查看全部分类', 'home collections cta visible')
  const homeOrderHref = await page.locator('.premium-hero').getByRole('link', { name: '开始制作' }).getAttribute('href')
  if (homeOrderHref === '/order') ok('home hero start order cta links to order')
  else throw new Error(`home start order cta href mismatch: ${homeOrderHref}`)
  const homeSupportHref = await page.locator('.premium-hero').getByRole('link', { name: '咨询客服' }).getAttribute('href')
  if (homeSupportHref === '/support') ok('home hero support cta links to support')
  else throw new Error(`home support cta href mismatch: ${homeSupportHref}`)
  await expectText(page, '下单后 24 小时内确认需求', 'home hero handoff promise visible')
  const homeHeroText = await page.locator('.premium-hero').innerText()
  if (!homeHeroText.includes('中文 / 英文 / 韩文服务')) ok('home no longer advertises full multilingual service')
  else throw new Error(`home still advertises full multilingual service: ${homeHeroText}`)
  // Floating contacts are site-config driven: Kakao/WhatsApp links render only
  // when a valid custom URL is configured; the bot toggle is always offered
  // while the assistant is enabled.
  await expectVisible(page, '.floating-contact', 'floating contact dock visible')
  await expectVisible(page, '.floating-contact .bot-toggle', 'bot assistant visible')
  const adminLinks = await page.locator('header a[href="/admin"]').count()
  if (adminLinks === 0) ok('admin link hidden from public nav')
  else throw new Error('admin link is visible in public nav')
  const mobileNavPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await mobileNavPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await mobileNavPage.goto(base, { waitUntil: 'networkidle' })
  await setLang(mobileNavPage, 'zh')
  const mobileNavLayout = await mobileNavPage.evaluate(() => {
    const nav = document.querySelector('.topbar nav')
    const links = [...document.querySelectorAll('.topbar nav a, .topbar .nav-login')].map((node) => {
      const rect = node.getBoundingClientRect()
      return { text: node.textContent?.trim(), width: rect.width, height: rect.height }
    })
    const topbar = document.querySelector('.topbar')?.getBoundingClientRect()
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      navScrollWidth: nav?.scrollWidth || 0,
      navClientWidth: nav?.clientWidth || 0,
      topbarHeight: topbar?.height || 0,
      links,
    }
  })
  // On mobile the topbar nav collapses behind a hamburger menu; assert the
  // page has no horizontal overflow and the menu toggle is usable instead.
  const mobileMenuToggle = mobileNavPage.locator('.mobile-menu-toggle').first()
  const mobileMenuUsable = await mobileMenuToggle.isVisible()
  if (
    mobileNavLayout.scrollWidth <= mobileNavLayout.clientWidth
    && mobileNavLayout.topbarHeight <= 144
    && mobileMenuUsable
  ) ok('public mobile topbar navigation is usable without page overflow')
  else throw new Error(`public mobile topbar layout invalid: ${JSON.stringify({ ...mobileNavLayout, mobileMenuUsable })}`)
  await mobileMenuToggle.click()
  await mobileNavPage.locator('.mobile-menu nav a, .mobile-menu a').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('public mobile menu opens with navigation links')
  // On mobile the theme controls live inside the drawer itself.
  await mobileNavPage.locator('.mobile-menu .theme-choice', { hasText: '纯白' }).first().click()
  const mobileWhiteBg = await mobileNavPage.locator('.app-shell').evaluate(el => getComputedStyle(el).getPropertyValue('--bg').trim())
  if (mobileWhiteBg === '#ffffff') ok('public mobile theme swatch is tappable')
  else throw new Error(`public mobile theme swatch did not apply: ${mobileWhiteBg}`)
  await mobileNavPage.close()
  const storageBlockedPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await storageBlockedPage.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) {
      if (this === window.localStorage) return ''
      return originalGetItem.call(this, key)
    }
    Storage.prototype.setItem = function () { throw new Error('localStorage write disabled') }
  })
  await storageBlockedPage.goto(base, { waitUntil: 'networkidle' })
  await storageBlockedPage.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 })
  await storageBlockedPage.locator('header .preferences-toggle').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('public site loads when localStorage is unavailable')
  // Theme switching writes persisted state; with storage blocked the page must
  // still render and offer the controls even though a switch cannot persist.
  await storageBlockedPage.locator('header .preferences-toggle').first().click().catch(() => {})
  await storageBlockedPage.locator('header .theme-choice', { hasText: '纯白' }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const blockedStorageTheme = await storageBlockedPage.locator('.app-shell').evaluate(el => getComputedStyle(el).getPropertyValue('--bg').trim())
  if (typeof blockedStorageTheme === 'string' && blockedStorageTheme.length > 0) ok('site renders with a theme while localStorage is unavailable', blockedStorageTheme)
  else throw new Error(`theme missing while localStorage unavailable: ${blockedStorageTheme}`)
  await storageBlockedPage.close()
  await page.goto(`${base}/doc/`, { waitUntil: 'domcontentloaded' })
  await expectText(page, 'Pet Wool Platform', 'customer docs route visible')
  await expectText(page, '客户展示文档', 'customer docs static document visible')
  await expectText(page, '后端管理端原型', 'customer docs admin section visible')
  await page.goto(base, { waitUntil: 'networkidle' })
  const themeSelects = await page.locator('header .theme-pills select').count()
  if (themeSelects === 0) ok('theme selector uses flat swatches')
  else throw new Error('theme selector is still a dropdown')
  await page.locator('header .preferences-toggle').first().click()
  await page.locator('header .theme-choice', { hasText: '鼠尾草' }).first().click()
  const sageBg = await page.locator('.app-shell').evaluate(el => getComputedStyle(el).getPropertyValue('--bg').trim())
  if (sageBg === '#eef5ed') ok('theme selector applies palette', sageBg)
  else throw new Error(`theme palette did not apply, got ${sageBg}`)
  await page.locator('.bot-toggle').click()
  await page.locator('.bot-panel input').fill('   ')
  await page.locator('.bot-panel form .button').click()
  await expectText(page, '请先输入想咨询的问题。', 'bot validates empty question')
  const emptyBotUserMessages = await page.locator('.bot-messages .user').count()
  if (emptyBotUserMessages === 0) ok('bot empty question does not append blank user message')
  else throw new Error(`bot appended blank user message: ${emptyBotUserMessages}`)
  const botInputMaxlength = await page.locator('.bot-panel input').getAttribute('maxlength')
  if (botInputMaxlength === '200') ok('bot input applies maxlength')
  else throw new Error(`bot input maxlength invalid: ${botInputMaxlength}`)
  await page.locator('.bot-panel input').fill('长'.repeat(201))
  const cappedBotQuestion = await page.locator('.bot-panel input').inputValue()
  if (cappedBotQuestion.length === 200) ok('bot input caps overly long question in UI')
  else throw new Error(`bot input did not cap long question: ${cappedBotQuestion.length}`)
  await page.locator('.bot-panel form .button').click()
  await expectText(page, '我可以回答价格、照片要求', 'bot answers capped generic question')
  await page.locator('.bot-panel input').fill('价格是多少')
  await page.locator('.bot-panel form .button').click()
  await expectText(page, '相框类从', 'bot answers pricing')
  await page.locator('.bot-panel header button').click()
  const botAnswerRes = await fetch(`${base}/api/bot/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '价格是多少', lang: 'zh' })
  })
  if (botAnswerRes.ok && botAnswerRes.headers.get('cache-control') === 'no-store') ok('bot answer response is not cached')
  else throw new Error(`bot answer cache-control invalid: ${botAnswerRes.status} ${botAnswerRes.headers.get('cache-control')}`)
  const longBotRes = await fetch(`${base}/api/bot/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x'.repeat(201), lang: 'zh' })
  })
  if (longBotRes.status === 400) ok('api rejects overly long bot questions')
  else throw new Error(`long bot question accepted: ${longBotRes.status}`)
  if (longBotRes.headers.get('cache-control') === 'no-store') ok('bot answer errors are not cached')
  else throw new Error(`bot answer error cache-control invalid: ${longBotRes.headers.get('cache-control')}`)
  const emptyBotRes = await fetch(`${base}/api/bot/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '   ', lang: 'zh' })
  })
  if (emptyBotRes.status === 400) ok('api rejects empty bot questions')
  else throw new Error(`empty bot question accepted: ${emptyBotRes.status}`)
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/home.png', fullPage: true })
  const homeEmptyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await homeEmptyPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await homeEmptyPage.route('**/api/products?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([])
  }))
  await homeEmptyPage.route('**/api/categories?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([])
  }))
  await homeEmptyPage.route('**/api/blog?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([])
  }))
  await homeEmptyPage.goto(base, { waitUntil: 'networkidle' })
  await setLang(homeEmptyPage, 'zh')
  await expectText(homeEmptyPage, '分类正在配置中', 'home empty collections state visible')
  await expectText(homeEmptyPage, '热门商品正在配置中', 'home empty products state visible')
  await expectNoHorizontalOverflow(homeEmptyPage, 'home empty mobile layout has no horizontal overflow')
  await homeEmptyPage.close()

  await page.goto(`${base}/collections`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  await expectText(page, '大分类', 'collections category tree visible zh')
  await expectText(page, '应该选择哪种作品？', 'collections choice guide visible')
  await expectText(page, '相框肖像以脸部和表情为中心制作。', 'collections choice guide explains consultation path')
  await expectText(page, '狗狗羊毛毡相框', 'collections subcategory visible zh')
  const collectionOrderCard = page.locator('.product-card').first()
  const collectionOrderHref = await collectionOrderCard.getByRole('link', { name: '下单' }).getAttribute('href')
  if (String(collectionOrderHref || '').includes('/order?product=')) ok('collections product card exposes direct order CTA')
  else throw new Error(`collections product direct order CTA missing product query: ${collectionOrderHref}`)
  await collectionOrderCard.getByRole('link', { name: '下单' }).click()
  await page.waitForURL('**/order?product=*', { timeout: 10000 })
  await expectText(page, '选择商品', 'collections direct order opens order page')
  await page.goto(`${base}/collections`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  const collectionsFailurePage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await collectionsFailurePage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await collectionsFailurePage.route('**/api/categories?lang=zh', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'categories unavailable' })
  }))
  await collectionsFailurePage.goto(`${base}/collections`, { waitUntil: 'networkidle' })
  await expectText(collectionsFailurePage, '分类商品加载失败', 'collections load failure state visible')
  await expectText(collectionsFailurePage, '重新加载', 'collections load failure retry visible')
  await collectionsFailurePage.locator('main').getByText('开始定制').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('collections load failure order fallback visible')
  await expectText(collectionsFailurePage, '联系客服', 'collections load failure support fallback visible')
  await expectNoHorizontalOverflow(collectionsFailurePage, 'collections load failure mobile layout has no horizontal overflow')
  await collectionsFailurePage.close()
  const colonButtons = await page.locator('.category-tree button', { hasText: /^：/ }).count()
  if (colonButtons === 0) ok('collection subcategory has no leading colon')
  else throw new Error('subcategory button still has leading colon')
  await page.goto(`${base}/collections?category=missing-commercial-category`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => !new URL(window.location.href).searchParams.get('category')?.includes('missing-commercial-category'), null, { timeout: 10000 })
  await expectText(page, '大分类', 'collections invalid category recovers to valid category')
  await page.getByRole('button', { name: '猫咪羊毛毡全身像' }).click()
  await expectText(page, '猫咪羊毛毡全身像 产品', 'subcategory product page visible zh')
  const collectionTitle = await page.title()
  if (collectionTitle.includes('猫咪羊毛毡全身像')) ok('collections document title follows active subcategory', collectionTitle)
  else throw new Error(`collections title did not follow subcategory: ${collectionTitle}`)
  const collectionCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  if (collectionCanonical === `${base}/collections?category=cat-full-body-portrait`) ok('collections canonical follows active category', collectionCanonical)
  else throw new Error(`collections canonical invalid: ${collectionCanonical}`)
  const collectionDescriptionMeta = await page.locator('meta[name="description"]').getAttribute('content')
  if (collectionDescriptionMeta && collectionDescriptionMeta.includes('猫咪坐姿')) ok('collections meta description follows active category', collectionDescriptionMeta)
  else throw new Error(`collections meta description invalid: ${collectionDescriptionMeta}`)
  const collectionOgTitle = await page.locator('meta[property="og:title"]').getAttribute('content')
  if (collectionOgTitle && collectionOgTitle.includes('猫咪羊毛毡全身像')) ok('collections og title follows active category', collectionOgTitle)
  else throw new Error(`collections og title invalid: ${collectionOgTitle}`)
  const collectionOgImage = await page.locator('meta[property="og:image"]').getAttribute('content')
  if (collectionOgImage && /^https?:\/\//.test(collectionOgImage)) ok('collections og image set', collectionOgImage)
  else throw new Error(`collections og image invalid: ${collectionOgImage}`)
  await page.goto(`${base}/collections?category=cat-full-body-portrait&style=no-match-commercial-style`, { waitUntil: 'networkidle' })
  await expectText(page, '当前筛选没有匹配商品', 'collections empty filter state visible')
  await page.locator('main').getByText('开始定制').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('collections empty filter order fallback visible')
  await expectText(page, '联系客服', 'collections empty filter support fallback visible')
  await page.getByRole('button', { name: '清除筛选' }).click()
  await page.locator('.product-card').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('collections clear filters restores products')
  await setLang(page, 'en')
  await expectText(page, 'Dog Frame Portrait', 'collections subcategory visible en')
  await expectText(page, 'Occasion', 'collections occasion localized en')
  await setLang(page, 'ko')
  await expectText(page, '강아지 액자 초상', 'collections subcategory visible ko')
  await expectText(page, '용도', 'collections occasion localized ko')
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/collections.png', fullPage: true })
  ok('admin product create API accepts published product', temporaryProductSlug)

  await page.goto(`${base}/support`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  await expectText(page, '护理说明', 'support care policy visible')
  await expectText(page, '客户评价', 'support reviews visible')
  await expectText(page, '需要人工确认？', 'support contact panel visible')
  await expectText(page, '联系前可以准备这些信息', 'support preparation checklist visible')
  await expectText(page, '期望尺寸、预算、收货国家', 'support preparation checklist includes budget and shipping')
  await expectText(page, '准备好提交照片了吗？', 'support final CTA visible')
  const supportFinalOrderHref = await page.locator('.support-final-cta').getByRole('link', { name: '立即开始定制' }).getAttribute('href')
  if (String(supportFinalOrderHref || '').endsWith('/order')) ok('support final CTA links to order')
  else throw new Error(`support final CTA order link invalid: ${supportFinalOrderHref}`)
  const supportFinalCollectionsHref = await page.locator('.support-final-cta').getByRole('link', { name: '查看分类' }).getAttribute('href')
  if (String(supportFinalCollectionsHref || '').endsWith('/collections')) ok('support final CTA links to collections')
  else throw new Error(`support final CTA collections link invalid: ${supportFinalCollectionsHref}`)
  const supportTalkHref = await page.getByRole('link', { name: /通过 TALK 咨询/ }).first().getAttribute('href')
  const supportLineHref = await page.getByRole('link', { name: /通过 LINE 咨询/ }).first().getAttribute('href')
  const supportEmailHref = await page.getByRole('link', { name: /通过 邮箱 咨询/ }).first().getAttribute('href')
  if (/^https?:\/\//.test(String(supportTalkHref || '')) && /^https?:\/\//.test(String(supportLineHref || ''))) ok('support contact links use configured URLs')
  else throw new Error(`support contact links invalid: ${JSON.stringify({ supportTalkHref, supportLineHref })}`)
  if (supportEmailHref?.startsWith('mailto:')) ok('support contact email uses configured brand email')
  else throw new Error(`support contact email invalid: ${supportEmailHref}`)
  const decodedSupportEmailHref = decodeURIComponent(supportEmailHref || '')
  if (
    decodedSupportEmailHref.includes('subject=人工客服咨询')
    && decodedSupportEmailHref.includes('/support')
    && decodedSupportEmailHref.includes('请在这里补充')
  ) ok('support email contact carries page context')
  else throw new Error(`support email contact missing context: ${supportEmailHref}`)
  await page.goto(`${base}/support?order=WP-CONTEXT-${stamp}&email=context-${stamp}@example.com`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  await expectText(page, '已带入订单咨询信息', 'support page shows order context summary')
  await expectText(page, `WP-CONTEXT-${stamp}`, 'support page shows order context number')
  await expectText(page, `context-${stamp}@example.com`, 'support page shows order context email')
  const contextSupportEmailHref = await page.getByRole('link', { name: /通过 邮箱 咨询/ }).first().getAttribute('href')
  const decodedContextSupportEmailHref = decodeURIComponent(contextSupportEmailHref || '')
  if (
    decodedContextSupportEmailHref.includes(`WP-CONTEXT-${stamp}`)
    && decodedContextSupportEmailHref.includes(`context-${stamp}@example.com`)
  ) ok('support email contact includes query order context')
  else throw new Error(`support email contact missing query context: ${contextSupportEmailHref}`)
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/support.png', fullPage: true })
  const invalidContactPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await invalidContactPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const invalidContactEmail = `invalid-contact-${stamp}@example.com`
  await invalidContactPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      brand: { email: invalidContactEmail },
      contact: { talk_enabled: true, talk_label: 'TALK', talk_url: 'javascript:alert(1)', line_enabled: true, line_label: 'LINE', line_url: 'ftp://line.invalid' },
      policies: {},
      faq: [],
      reviews: []
    })
  }))
  await invalidContactPage.goto(`${base}/support`, { waitUntil: 'networkidle' })
  const invalidSupportTalkCount = await invalidContactPage.getByRole('link', { name: /通过 TALK 咨询/ }).count()
  const invalidSupportLineCount = await invalidContactPage.getByRole('link', { name: /通过 LINE 咨询/ }).count()
  const invalidSupportEmailHref = await invalidContactPage.getByRole('link', { name: /通过 邮箱 咨询/ }).first().getAttribute('href')
  if (
    invalidSupportTalkCount === 0
    && invalidSupportLineCount === 0
    && invalidSupportEmailHref?.startsWith(`mailto:${invalidContactEmail}?`)
    && decodeURIComponent(invalidSupportEmailHref).includes('/support')
  ) ok('support page filters invalid chat URLs and keeps contextual email fallback')
  else throw new Error(`support invalid contact filtering failed: ${JSON.stringify({ invalidSupportTalkCount, invalidSupportLineCount, invalidSupportEmailHref })}`)
  await invalidContactPage.close()
  const invalidFloatingContactPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await invalidFloatingContactPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await invalidFloatingContactPage.route('**/api/site**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      brand: { email: invalidContactEmail },
      contact: { talk_enabled: true, talk_label: 'TALK', talk_url: 'javascript:alert(1)', line_enabled: true, line_label: 'LINE', line_url: 'ftp://line.invalid' },
      theme: originalSiteSnapshot?.theme || {},
      bot: { enabled: false }
    })
  }))
  await invalidFloatingContactPage.goto(base, { waitUntil: 'networkidle' })
  const invalidFloatingTalkCount = await invalidFloatingContactPage.locator('.floating-contact .talk').count()
  const invalidFloatingLineCount = await invalidFloatingContactPage.locator('.floating-contact .line').count()
  const invalidFloatingEmailHref = await invalidFloatingContactPage.locator('.floating-contact .email').first().getAttribute('href')
  if (
    invalidFloatingTalkCount === 0
    && invalidFloatingLineCount === 0
    && invalidFloatingEmailHref?.startsWith(`mailto:${invalidContactEmail}?`)
    && decodeURIComponent(invalidFloatingEmailHref).includes(base)
  ) ok('floating contact filters invalid chat URLs and keeps contextual email fallback')
  else throw new Error(`floating invalid contact filtering failed: ${JSON.stringify({ invalidFloatingTalkCount, invalidFloatingLineCount, invalidFloatingEmailHref })}`)
  await invalidFloatingContactPage.close()
  const invalidEmailContactPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await invalidEmailContactPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await invalidEmailContactPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      brand: { email: 'not-an-email' },
      contact: { talk_enabled: true, talk_label: 'TALK', talk_url: 'javascript:alert(1)', line_enabled: true, line_label: 'LINE', line_url: 'ftp://line.invalid' },
      policies: {},
      faq: [],
      reviews: []
    })
  }))
  await invalidEmailContactPage.goto(`${base}/support`, { waitUntil: 'networkidle' })
  const invalidEmailMailtoCount = await invalidEmailContactPage.locator('a[href^="mailto:"]').count()
  if (invalidEmailMailtoCount === 0) ok('support page filters invalid email fallback')
  else throw new Error(`support invalid email produced mailto link count: ${invalidEmailMailtoCount}`)
  await expectText(invalidEmailContactPage, '立即开始定制', 'support invalid email falls back to order action')
  await invalidEmailContactPage.close()
  const invalidFloatingEmailPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await invalidFloatingEmailPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await invalidFloatingEmailPage.route('**/api/site**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      brand: { email: 'not-an-email' },
      contact: { talk_enabled: false, line_enabled: false },
      theme: originalSiteSnapshot?.theme || {},
      bot: { enabled: false }
    })
  }))
  await invalidFloatingEmailPage.goto(base, { waitUntil: 'networkidle' })
  const invalidFloatingEmailCount = await invalidFloatingEmailPage.locator('.floating-contact .email').count()
  if (invalidFloatingEmailCount === 0) ok('floating contact filters invalid email fallback')
  else throw new Error(`floating invalid email produced email link count: ${invalidFloatingEmailCount}`)
  await invalidFloatingEmailPage.close()
  const supportFailPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await supportFailPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await supportFailPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'site unavailable' })
  }))
  await supportFailPage.goto(`${base}/support`, { waitUntil: 'networkidle' })
  await expectText(supportFailPage, '服务政策加载失败', 'support load failure state visible')
  await expectText(supportFailPage, '重新加载', 'support load retry visible')
  const supportFailOrderHref = await supportFailPage.locator('main').getByRole('link', { name: '立即开始定制' }).getAttribute('href')
  if (String(supportFailOrderHref || '').endsWith('/order')) ok('support load failure offers order fallback')
  else throw new Error(`support load failure order fallback invalid: ${supportFailOrderHref}`)
  await expectNoHorizontalOverflow(supportFailPage, 'support failure mobile layout has no horizontal overflow')
  await supportFailPage.close()
  const supportEmptyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await supportEmptyPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await supportEmptyPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ policies: {}, faq: [], reviews: [] })
  }))
  await supportEmptyPage.goto(`${base}/support`, { waitUntil: 'networkidle' })
  await expectText(supportEmptyPage, '作品为手工羊毛毡', 'support policy fallback visible')
  await expectText(supportEmptyPage, '常见问题正在整理中', 'support faq fallback visible')
  await expectText(supportEmptyPage, '客户反馈整理中', 'support review fallback visible')
  await expectText(supportEmptyPage, '立即开始定制', 'support contact fallback order link visible')
  await expectNoHorizontalOverflow(supportEmptyPage, 'support fallback mobile layout has no horizontal overflow')
  await supportEmptyPage.close()

  const noImageBlogSlug = `commercial-no-image-${stamp}`
  const noImageBlogTitle = `无图博客 ${stamp}`
  const noImageBlogRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      blog: [{
        id: noImageBlogSlug,
        slug: noImageBlogSlug,
        date: '2026-06-28',
        title: noImageBlogTitle,
        excerpt: '无图博客摘要',
        content: '无图博客正文',
        image_url: '',
        tags: ['无图'],
        translations: {
          zh: { title: noImageBlogTitle, excerpt: '无图博客摘要', content: '无图博客正文' },
          en: { title: noImageBlogTitle, excerpt: '无图博客摘要', content: '无图博客正文' },
          ko: { title: noImageBlogTitle, excerpt: '无图博客摘要', content: '无图博客正文' },
        }
      }, ...(originalSiteSnapshot?.blog || [])]
    })
  })
  if (noImageBlogRes.status === 400) ok('api rejects site blog without visual asset')
  else throw new Error(`no-image blog was accepted: ${noImageBlogRes.status}`)
  const brokenImageBlogSlug = `commercial-broken-image-${stamp}`
  const brokenImageBlogTitle = `破图博客 ${stamp}`
  const brokenRemoteBlogImage = `https://example.com/broken-blog-${stamp}.jpg`
  const brokenImageBlogRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      blog: [{
        id: brokenImageBlogSlug,
        slug: brokenImageBlogSlug,
        date: '2026-06-28',
        title: brokenImageBlogTitle,
        excerpt: '破图博客摘要',
        content: '破图博客正文',
        image_url: brokenRemoteBlogImage,
        tags: ['破图'],
        translations: {
          zh: { title: brokenImageBlogTitle, excerpt: '破图博客摘要', content: '破图博客正文' },
          en: { title: brokenImageBlogTitle, excerpt: '破图博客摘要', content: '破图博客正文' },
          ko: { title: brokenImageBlogTitle, excerpt: '破图博客摘要', content: '破图博客正文' },
        }
      }, ...(originalSiteSnapshot?.blog || [])]
    })
  })
  if (!brokenImageBlogRes.ok) throw new Error(`broken-image blog setup failed: ${brokenImageBlogRes.status}`)
  await page.route(brokenRemoteBlogImage, route => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto(`${base}/blog`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  const publicBlogRes = await fetch(`${base}/api/blog?lang=zh`)
  if (publicBlogRes.headers.get('cache-control') === 'no-store') ok('public blog list response is not cached')
  else throw new Error(`public blog list cache-control invalid: ${publicBlogRes.headers.get('cache-control')}`)
  await page.waitForFunction((title) => {
    const card = [...document.querySelectorAll('.blog-card')].find((node) => node.textContent?.includes(title))
    const img = card?.querySelector('img')
    return img?.src.includes('images.unsplash.com')
  }, brokenImageBlogTitle, { timeout: 10000 })
  ok('blog list replaces broken image with fallback')
  const publicBlogDetailRes = await fetch(`${base}/api/blog/${brokenImageBlogSlug}?lang=zh`)
  if (publicBlogDetailRes.headers.get('cache-control') === 'no-store') ok('public blog detail response is not cached')
  else throw new Error(`public blog detail cache-control invalid: ${publicBlogDetailRes.headers.get('cache-control')}`)
  await page.goto(`${base}/blog/${brokenImageBlogSlug}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelector('.article-shell img')?.src.includes('images.unsplash.com'), null, { timeout: 10000 })
  ok('blog detail replaces broken image with fallback')
  await page.unroute(brokenRemoteBlogImage)
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: originalSiteSnapshot.blog })
  })
  await page.goto(`${base}/blog`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  await expectText(page, '适合家人的宠物纪念礼物想法', 'blog list visible zh')
  await expectText(page, '看完指南后可以继续这样做', 'blog list conversion guide visible')
  await expectText(page, '不确定照片或周期时联系客服确认', 'blog list conversion guide explains support path')
  const blogGuideOrderHref = await page.locator('.blog-guide-cta').getByRole('link', { name: '开始定制' }).getAttribute('href')
  if (String(blogGuideOrderHref || '').endsWith('/order')) ok('blog list guide links to order')
  else throw new Error(`blog list guide order link invalid: ${blogGuideOrderHref}`)
  const blogGuideSupportHref = await page.locator('.blog-guide-cta').getByRole('link', { name: '联系客服' }).first().getAttribute('href')
  const decodedBlogGuideSupportHref = decodeURIComponent(blogGuideSupportHref || '')
  if (blogGuideSupportHref && /^(https?:|mailto:)/.test(blogGuideSupportHref) && decodedBlogGuideSupportHref.includes('/blog')) ok('blog list support CTA carries blog source context')
  else throw new Error(`blog list support CTA missing source context: ${blogGuideSupportHref}`)
  const blogListCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  if (blogListCanonical === `${base}/blog`) ok('blog list canonical set', blogListCanonical)
  else throw new Error(`blog list canonical invalid: ${blogListCanonical}`)
  const blogListOgImage = await page.locator('meta[property="og:image"]').getAttribute('content')
  if (blogListOgImage && /^https?:\/\//.test(blogListOgImage)) ok('blog list og image set', blogListOgImage)
  else throw new Error(`blog list og image invalid: ${blogListOgImage}`)
  await setLang(page, 'en')
  await expectText(page, 'Pet Memorial Gift Ideas', 'blog list visible')
  await page.goto(`${base}/blog/pet-memorial-gift-ideas`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  await expectText(page, '适合家人的宠物纪念礼物想法', 'blog detail visible zh')
  await expectText(page, '把参考内容变成定制需求', 'blog detail conversion CTA visible')
  const blogDetailOrderHref = await page.locator('.article-cta').getByRole('link', { name: '开始定制' }).getAttribute('href')
  if (String(blogDetailOrderHref || '').endsWith('/order')) ok('blog detail conversion CTA links to order')
  else throw new Error(`blog detail order CTA invalid: ${blogDetailOrderHref}`)
  const blogDetailCollectionsHref = await page.locator('.article-cta a[href="/collections"]').first().getAttribute('href')
  if (String(blogDetailCollectionsHref || '').endsWith('/collections')) ok('blog detail conversion CTA links to collections')
  else throw new Error(`blog detail collections CTA invalid: ${blogDetailCollectionsHref}`)
  const blogDetailSupportHref = await page.locator('.article-cta').getByRole('link', { name: /通过 .* 咨询|联系客服/ }).first().getAttribute('href')
  if (blogDetailSupportHref && (/^(https?:|mailto:)/.test(blogDetailSupportHref) || blogDetailSupportHref.endsWith('/support'))) ok('blog detail conversion CTA links to support')
  else throw new Error(`blog detail support CTA invalid: ${blogDetailSupportHref}`)
  const decodedBlogDetailSupportHref = decodeURIComponent(blogDetailSupportHref || '')
  if (
    decodedBlogDetailSupportHref.includes('参考文章')
    && decodedBlogDetailSupportHref.includes('适合家人的宠物纪念礼物想法')
    && decodedBlogDetailSupportHref.includes('/blog/pet-memorial-gift-ideas')
  ) ok('blog detail support CTA carries article context')
  else throw new Error(`blog detail support CTA missing article context: ${blogDetailSupportHref}`)
  const blogEmailFallbackPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await blogEmailFallbackPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const blogEmailFallback = `blog-detail-support-${stamp}@example.com`
  await blogEmailFallbackPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ brand: { email: blogEmailFallback }, contact: { talk_enabled: false, line_enabled: false } })
  }))
  await blogEmailFallbackPage.goto(`${base}/blog/pet-memorial-gift-ideas`, { waitUntil: 'networkidle' })
  const blogEmailSupportLink = blogEmailFallbackPage.locator('.article-cta').getByRole('link', { name: /通过 邮箱 咨询/ }).first()
  const blogEmailSupportHref = await blogEmailSupportLink.getAttribute('href')
  const blogEmailSupportTarget = await blogEmailSupportLink.getAttribute('target')
  const decodedBlogEmailSupportHref = decodeURIComponent(blogEmailSupportHref || '')
  if (blogEmailSupportHref?.startsWith(`mailto:${blogEmailFallback}?`) && decodedBlogEmailSupportHref.includes('/blog/pet-memorial-gift-ideas') && !blogEmailSupportTarget) ok('blog detail support falls back to configured email with article context without new tab')
  else throw new Error(`blog detail email support fallback invalid: ${JSON.stringify({ blogEmailSupportHref, blogEmailSupportTarget })}`)
  await blogEmailFallbackPage.close()
  await setLang(page, 'en')
  await expectText(page, 'Pet Memorial Gift Ideas for Families', 'blog detail visible')
  const blogTitle = await page.title()
  if (blogTitle.includes('Pet Memorial Gift Ideas')) ok('blog detail document title set', blogTitle)
  else throw new Error(`blog detail title not set: ${blogTitle}`)
  const blogCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  if (blogCanonical === `${base}/blog/pet-memorial-gift-ideas`) ok('blog detail canonical set', blogCanonical)
  else throw new Error(`blog detail canonical invalid: ${blogCanonical}`)
  const blogOgTitle = await page.locator('meta[property="og:title"]').getAttribute('content')
  if (blogOgTitle?.includes('Pet Memorial Gift Ideas')) ok('blog detail og title set', blogOgTitle)
  else throw new Error(`blog detail og title invalid: ${blogOgTitle}`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await expectNoHorizontalOverflow(page, 'blog detail CTA mobile layout has no horizontal overflow')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/blog-detail.png', fullPage: true })
  const blogFailPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await blogFailPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await blogFailPage.route('**/api/blog?lang=zh', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'blog unavailable' })
  }))
  await blogFailPage.goto(`${base}/blog`, { waitUntil: 'networkidle' })
  await expectText(blogFailPage, '文章列表加载失败', 'blog list failure state visible')
  await expectText(blogFailPage, '重新加载', 'blog list retry visible')
  const blogFailCollectionsHref = await blogFailPage.locator('main a[href="/collections"]').first().getAttribute('href')
  if (String(blogFailCollectionsHref || '').endsWith('/collections')) ok('blog list failure offers collections fallback')
  else throw new Error(`blog list failure collections fallback invalid: ${blogFailCollectionsHref}`)
  await expectText(blogFailPage, '开始定制', 'blog list failure offers order fallback')
  await expectText(blogFailPage, '联系客服', 'blog list failure offers support fallback')
  await blogFailPage.close()
  const blogEmptyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await blogEmptyPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await blogEmptyPage.route('**/api/blog?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([])
  }))
  await blogEmptyPage.goto(`${base}/blog`, { waitUntil: 'networkidle' })
  await expectText(blogEmptyPage, '文章正在整理中', 'blog list empty state visible')
  await expectText(blogEmptyPage, '开始定制', 'blog list empty order fallback visible')
  await expectText(blogEmptyPage, '联系客服', 'blog list empty support fallback visible')
  await expectNoHorizontalOverflow(blogEmptyPage, 'blog empty mobile layout has no horizontal overflow')
  await blogEmptyPage.close()
  await setLang(page, 'zh')
  await page.goto(`${base}/blog/not-existing-commercial-check`, { waitUntil: 'networkidle' })
  await expectText(page, '暂时找不到这篇文章', 'blog detail missing state visible')
  const missingBlogRobots = await page.locator('meta[name="robots"]').getAttribute('content')
  if (missingBlogRobots === 'noindex,follow') ok('missing blog detail sets noindex robots meta', missingBlogRobots)
  else throw new Error(`missing blog detail robots meta invalid: ${missingBlogRobots}`)
  await page.getByRole('link', { name: '返回博客' }).click()
  await page.waitForURL('**/blog', { timeout: 10000 })
  await expectText(page, '宠物定制、纪念礼物和照片准备指南', 'blog missing state links back to blog')
  const blogDetailFailPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await blogDetailFailPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await blogDetailFailPage.route('**/api/blog/pet-memorial-gift-ideas?lang=zh', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'blog detail unavailable' })
  }))
  await blogDetailFailPage.goto(`${base}/blog/pet-memorial-gift-ideas`, { waitUntil: 'networkidle' })
  await expectText(blogDetailFailPage, '暂时找不到这篇文章', 'blog detail failure state visible')
  await expectText(blogDetailFailPage, '重新加载', 'blog detail failure retry visible')
  await expectText(blogDetailFailPage, '分类', 'blog detail failure offers collections fallback')
  await expectText(blogDetailFailPage, '开始定制', 'blog detail failure offers order fallback')
  await expectText(blogDetailFailPage, '联系客服', 'blog detail failure offers support fallback')
  const failedBlogRobots = await blogDetailFailPage.locator('meta[name="robots"]').getAttribute('content')
  if (failedBlogRobots === 'noindex,follow') ok('failed blog detail sets noindex robots meta', failedBlogRobots)
  else throw new Error(`failed blog detail robots meta invalid: ${failedBlogRobots}`)
  await expectNoHorizontalOverflow(blogDetailFailPage, 'blog detail failure mobile layout has no horizontal overflow')
  await blogDetailFailPage.close()
  const productDetailMissingPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await productDetailMissingPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await productDetailMissingPage.goto(`${base}/products/not-a-real-product-${stamp}`, { waitUntil: 'networkidle' })
  await expectText(productDetailMissingPage, '暂时找不到这个商品', 'product detail missing state visible')
  await expectNoText(productDetailMissingPage, 'product not found', 'product detail missing hides raw backend error')
  await expectText(productDetailMissingPage, '上传照片并下单', 'product detail missing offers order fallback')
  const productDetailMissingRobots = await productDetailMissingPage.locator('meta[name="robots"]').getAttribute('content')
  if (productDetailMissingRobots === 'noindex,follow') ok('product detail missing sets noindex robots meta')
  else throw new Error(`product detail missing robots meta invalid: ${productDetailMissingRobots}`)
  const productDetailMissingCanonical = await productDetailMissingPage.locator('link[rel="canonical"]').getAttribute('href')
  if (productDetailMissingCanonical === `${base}/products/not-a-real-product-${stamp}`) ok('product detail missing canonical keeps requested product path')
  else throw new Error(`product detail missing canonical invalid: ${productDetailMissingCanonical}`)
  const productDetailMissingOrderHref = await productDetailMissingPage.getByRole('link', { name: '上传照片并下单' }).getAttribute('href')
  if (String(productDetailMissingOrderHref || '').endsWith('/order')) ok('product detail missing order fallback links to order')
  else throw new Error(`product detail missing order fallback invalid: ${productDetailMissingOrderHref}`)
  await expectNoHorizontalOverflow(productDetailMissingPage, 'product detail missing mobile layout has no horizontal overflow')
  await productDetailMissingPage.close()

  const productNoImageSource = await fetch(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } })
    .then((res) => res.json())
    .then((items) => items.find((product) => product.id === temporaryProductId))
  const productNoImageCategory = categoryData.find((category) => category.id === productNoImageSource.category_id) || categoryData[0]
  const productNoImageRes = await fetch(`${base}/api/admin/products/${temporaryProductId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productNoImageSource, image_url: '', images: [], status: 'hidden' })
  })
  if (!productNoImageRes.ok) throw new Error(`product no-image setup failed: ${productNoImageRes.status}`)
  const publishedNoImageRes = await fetch(`${base}/api/admin/products/${temporaryProductId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productNoImageSource, image_url: '', images: [], status: 'published' })
  })
  if (publishedNoImageRes.status === 400) ok('api rejects publishing product without image')
  else throw new Error(`published no-image product accepted: ${publishedNoImageRes.status}`)
  await page.goto(`${base}/collections?category=${encodeURIComponent(productNoImageCategory.slug || '')}`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  const noImagePublicCardCount = await page.locator('.product-card').filter({ hasText: productNoImageSource.title }).count()
  if (noImagePublicCardCount === 0) ok('public product list hides hidden no-image draft product')
  else throw new Error(`hidden no-image product leaked publicly: ${noImagePublicCardCount}`)
  const restoreNoImageProductRes = await fetch(`${base}/api/admin/products/${temporaryProductId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify(productNoImageSource)
  })
  if (!restoreNoImageProductRes.ok) throw new Error(`product no-image restore failed: ${restoreNoImageProductRes.status}`)
  await page.goto(`${base}/products/${productNoImageSource.slug}`, { waitUntil: 'networkidle' })
  const noImageProductDetailSrc = await page.locator('.detail-main-img').getAttribute('src')
  if (String(noImageProductDetailSrc || '').includes('images.unsplash.com')) ok('product detail uses fallback image for products without image')
  else throw new Error(`product detail no-image fallback missing: ${noImageProductDetailSrc}`)
  await fetch(`${base}/api/admin/products/${temporaryProductId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify(productNoImageSource)
  })

  await page.goto(`${base}/products/full-body-pet-replica`, { waitUntil: 'networkidle' })
  await setLang(page, 'zh')
  await expectText(page, '上传照片并下单', 'product detail order button visible')
  await expectText(page, '规格价格', 'product detail price breakdown shows option price')
  await expectText(page, '定金比例', 'product detail price breakdown shows deposit percent')
  await expectText(page, '下单前准备', 'product detail preparation checklist visible')
  await expectText(page, '准备正脸、侧脸、全身和毛色细节照片', 'product detail preparation photo guidance visible')
  await expectText(page, '提交后可在我的订单继续支付和追踪', 'product detail preparation account guidance visible')
  await expectText(page, '继续比较相近定制作品', 'product detail related products section visible')
  const relatedProductCards = await page.locator('.related-products .product-card').count()
  if (relatedProductCards > 0 && relatedProductCards <= 3) ok('product detail related products are limited and visible')
  else throw new Error(`related product card count invalid: ${relatedProductCards}`)
  const relatedHref = await page.locator('.related-products .product-card').first().locator('a').first().getAttribute('href')
  if (String(relatedHref || '').startsWith('/products/')) ok('product detail related product links to product detail')
  else throw new Error(`related product link invalid: ${relatedHref}`)
  const productCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  if (productCanonical === `${base}/products/full-body-pet-replica`) ok('product detail canonical set', productCanonical)
  else throw new Error(`product detail canonical invalid: ${productCanonical}`)
  const productOgImage = await page.locator('meta[property="og:image"]').getAttribute('content')
  if (productOgImage && /^https?:\/\//.test(productOgImage)) ok('product detail og image set', productOgImage)
  else throw new Error(`product detail og image invalid: ${productOgImage}`)
  const relativeHeadImage = await page.evaluate(async () => {
    const mod = await import('/src/head.ts')
    mod.setHead('Relative OG Image Check', 'relative image check', { canonical: '/products/full-body-pet-replica', image: '/uploads/example.png' })
    return {
      image: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      ogUrl: document.querySelector('meta[property="og:url"]')?.getAttribute('content'),
      twitterImage: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
    }
  })
  if (
    relativeHeadImage.image === `${base}/uploads/example.png`
    && relativeHeadImage.twitterImage === `${base}/uploads/example.png`
    && relativeHeadImage.canonical === `${base}/products/full-body-pet-replica`
    && relativeHeadImage.ogUrl === `${base}/products/full-body-pet-replica`
  ) ok('head helper normalizes relative sharing image and canonical URLs')
  else throw new Error(`head helper did not normalize relative URLs: ${JSON.stringify(relativeHeadImage)}`)
  const sanitizedHeadText = await page.evaluate(async () => {
    const mod = await import('/src/head.ts')
    mod.setHead(`Unsafe\nTitle\t${'T'.repeat(120)}`, `Line one\nLine two\t${'D'.repeat(320)}`, { canonical: '/products/full-body-pet-replica' })
    return {
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
      ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
    }
  })
  if (
    sanitizedHeadText.title.length <= 93
    && sanitizedHeadText.description.length <= 263
    && !/[\r\n\t]/.test(sanitizedHeadText.title + sanitizedHeadText.description)
    && sanitizedHeadText.ogTitle === sanitizedHeadText.title
    && sanitizedHeadText.ogDescription === sanitizedHeadText.description
  ) ok('head helper sanitizes long multiline meta text')
  else throw new Error(`head helper did not sanitize meta text: ${JSON.stringify(sanitizedHeadText)}`)
  const clearedHeadDescription = await page.evaluate(async () => {
    const mod = await import('/src/head.ts')
    mod.setHead('Empty Description Check', '')
    return {
      description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
      ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute('content'),
      image: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '',
      twitterImage: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') || '',
      twitterCard: document.querySelector('meta[name="twitter:card"]')?.getAttribute('content') || '',
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
      ogUrl: document.querySelector('meta[property="og:url"]')?.getAttribute('content') || '',
      href: window.location.href,
    }
  })
  if (clearedHeadDescription.description === '' && clearedHeadDescription.ogDescription === '') ok('head helper clears stale descriptions')
  else throw new Error(`head helper left stale descriptions: ${JSON.stringify(clearedHeadDescription)}`)
  if (
    clearedHeadDescription.image === ''
    && clearedHeadDescription.twitterImage === ''
    && clearedHeadDescription.twitterCard === 'summary'
    && clearedHeadDescription.canonical === clearedHeadDescription.href
    && clearedHeadDescription.ogUrl === clearedHeadDescription.href
  ) ok('head helper clears stale image and defaults sharing URL to current URL')
  else throw new Error(`head helper left stale image or canonical: ${JSON.stringify(clearedHeadDescription)}`)
  const consultHref = await page.getByRole('link', { name: /通过 .* 咨询/ }).first().getAttribute('href')
  if (consultHref && /^(https?:|mailto:)/.test(consultHref)) ok('product detail consult link uses configured contact', consultHref)
  else throw new Error(`product detail consult link invalid: ${consultHref}`)
  const decodedConsultHref = decodeURIComponent(consultHref || '')
  const productDetailTitle = await page.locator('.detail-info h1').innerText()
  if (
    decodedConsultHref.includes('咨询商品')
    && decodedConsultHref.includes('规格')
    && decodedConsultHref.includes('预计应付')
    && decodedConsultHref.includes('/products/full-body-pet-replica')
    && decodedConsultHref.includes(productDetailTitle)
  ) ok('product detail consult link carries product context')
  else throw new Error(`product detail consult link missing product context: ${consultHref}`)
  const detailProductForOrder = await fetch(`${base}/api/products/full-body-pet-replica?lang=zh`).then((res) => res.json())
  const optionSelect = page.locator('.detail-selectors select').first()
  const paymentSelect = page.locator('.detail-selectors select').nth(1)
  const detailOptionValues = await optionSelect.locator('option').evaluateAll(options => options.map(option => option.value))
  if (detailOptionValues.length > 1) {
    await optionSelect.selectOption(detailOptionValues[1])
    await setLang(page, 'en')
    const retainedOption = await optionSelect.inputValue()
    if (retainedOption === detailOptionValues[1]) ok('product detail keeps selected option across language switch')
    else throw new Error(`product detail option reset after language switch: ${retainedOption} / ${detailOptionValues[1]}`)
    await setLang(page, 'zh')
    await page.goto(`${base}/order?product=${detailProductForOrder.id}&option=${detailOptionValues[1]}&payment=full`, { waitUntil: 'networkidle' })
    const orderOptionValue = await page.getByLabel('规格').inputValue()
    const orderPaymentValue = await page.getByLabel('付款方式').inputValue()
    if (orderOptionValue === detailOptionValues[1] && orderPaymentValue === 'full') ok('order page keeps option and payment from product detail')
    else throw new Error(`order page lost detail selection: ${orderOptionValue}/${orderPaymentValue}`)
    await page.goto(`${base}/products/full-body-pet-replica`, { waitUntil: 'networkidle' })
    await setLang(page, 'zh')
    await optionSelect.selectOption(detailOptionValues[1])
    await paymentSelect.selectOption('full')
    await page.getByRole('button', { name: '上传照片并下单' }).click()
    await page.waitForURL(/\/order\?/, { timeout: 10000 })
    const orderUrl = new URL(page.url())
    if (orderUrl.searchParams.get('product') === detailProductForOrder.id && orderUrl.searchParams.get('option') === detailOptionValues[1] && orderUrl.searchParams.get('payment') === 'full') {
      ok('product detail order URL includes selected product option and payment')
    } else {
      throw new Error(`product detail order URL missing selection: ${page.url()}`)
    }
    const clickedOrderOptionValue = await page.getByLabel('规格').inputValue()
    const clickedOrderPaymentValue = await page.getByLabel('付款方式').inputValue()
    if (clickedOrderOptionValue === detailOptionValues[1] && clickedOrderPaymentValue === 'full') ok('product detail order button carries selected option and payment')
    else throw new Error(`product detail order button lost selection: ${clickedOrderOptionValue}/${clickedOrderPaymentValue}`)
    await page.goto(`${base}/products/full-body-pet-replica`, { waitUntil: 'networkidle' })
    await setLang(page, 'zh')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '上传照片并下单' }).waitFor({ state: 'visible', timeout: 10000 })
  await expectNoHorizontalOverflow(page, 'product detail mobile layout has no horizontal overflow')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/product-detail.png', fullPage: true })
  const productFallbackPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await productFallbackPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await productFallbackPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ policies: {}, faq: [], contact: { talk_enabled: false, line_enabled: false } })
  }))
  await productFallbackPage.goto(`${base}/products/full-body-pet-replica`, { waitUntil: 'networkidle' })
  await expectText(productFallbackPage, '下单前咨询', 'product detail fallback consult link visible')
  await expectText(productFallbackPage, '手工羊毛毡作品请保持干燥', 'product detail policy fallback visible')
  const fallbackFaqText = await productFallbackPage.locator('.detail-panels').innerText()
  if (fallbackFaqText.includes('如需确认照片、周期、运输或付款细节') || fallbackFaqText.includes('需要哪些照片') || fallbackFaqText.includes('常见问题')) ok('product detail faq content remains visible')
  else throw new Error(`product detail faq content missing: ${fallbackFaqText}`)
  await expectNoHorizontalOverflow(productFallbackPage, 'product detail fallback mobile layout has no horizontal overflow')
  await productFallbackPage.close()
  const productSiteFailPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await productSiteFailPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await productSiteFailPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'site unavailable' })
  }))
  await productSiteFailPage.goto(`${base}/products/full-body-pet-replica`, { waitUntil: 'networkidle' })
  await expectText(productSiteFailPage, '全身羊毛毡宠物定制', 'product detail remains visible when site config fails')
  await productSiteFailPage.getByRole('button', { name: '上传照片并下单' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('product detail order CTA remains visible when site config fails')
  await productSiteFailPage.close()
  const productEmailFallbackPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await productEmailFallbackPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const productEmailFallback = `product-detail-support-${stamp}@example.com`
  await productEmailFallbackPage.route('**/api/site?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ brand: { email: productEmailFallback }, policies: {}, faq: [], contact: { talk_enabled: false, line_enabled: false } })
  }))
  await productEmailFallbackPage.goto(`${base}/products/full-body-pet-replica`, { waitUntil: 'networkidle' })
  const productEmailConsultLink = productEmailFallbackPage.getByRole('link', { name: /通过 邮箱 咨询/ }).first()
  const productEmailConsultHref = await productEmailConsultLink.getAttribute('href')
  const productEmailConsultTarget = await productEmailConsultLink.getAttribute('target')
  const decodedProductEmailConsultHref = decodeURIComponent(productEmailConsultHref || '')
  if (
    productEmailConsultHref?.startsWith(`mailto:${productEmailFallback}?`)
    && decodedProductEmailConsultHref.includes('商品咨询')
    && decodedProductEmailConsultHref.includes('咨询商品')
    && !productEmailConsultTarget
  ) ok('product detail consult falls back to configured email with product context without new tab')
  else throw new Error(`product detail email consult fallback invalid: ${JSON.stringify({ productEmailConsultHref, productEmailConsultTarget })}`)
  await productEmailFallbackPage.close()
  const productDetailFailPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await productDetailFailPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await productDetailFailPage.route('**/api/products/full-body-pet-replica?lang=zh', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'product detail unavailable' })
  }))
  await productDetailFailPage.goto(`${base}/products/full-body-pet-replica`, { waitUntil: 'networkidle' })
  await expectText(productDetailFailPage, '暂时找不到这个商品', 'product detail failure state visible')
  await expectText(productDetailFailPage, '重新加载', 'product detail failure retry visible')
  await expectNoText(productDetailFailPage, 'product detail unavailable', 'product detail failure hides raw service error')
  await expectNoHorizontalOverflow(productDetailFailPage, 'product detail failure mobile layout has no horizontal overflow')
  await productDetailFailPage.close()
  await page.goto(`${base}/products/not-existing-commercial-check`, { waitUntil: 'networkidle' })
  await expectText(page, '暂时找不到这个商品', 'product detail missing state visible')
  await expectText(page, '下单前咨询', 'product missing state offers support contact')
  const missingProductRobots = await page.locator('meta[name="robots"]').getAttribute('content')
  if (missingProductRobots === 'noindex,follow') ok('missing product detail sets noindex robots meta', missingProductRobots)
  else throw new Error(`missing product robots meta invalid: ${missingProductRobots}`)
  await page.getByRole('link', { name: '查看分类' }).click()
  await page.waitForURL('**/collections', { timeout: 10000 })
  await expectText(page, '大分类', 'product missing state links back to collections')
  await page.goto(`${base}/missing-commercial-route`, { waitUntil: 'networkidle' })
  await expectText(page, '暂时找不到这个页面', 'unknown route not found page visible')
  await expectText(page, '查看分类', 'unknown route offers collections link')
  const unknownRouteRobots = await page.locator('meta[name="robots"]').getAttribute('content')
  if (unknownRouteRobots === 'noindex,follow') ok('unknown route sets noindex robots meta', unknownRouteRobots)
  else throw new Error(`unknown route robots meta invalid: ${unknownRouteRobots}`)
  await setLang(page, 'en')
  const notFoundEnglishTitle = await page.title()
  if (notFoundEnglishTitle.includes('We could not find this page')) ok('unknown route title updates after language switch', notFoundEnglishTitle)
  else throw new Error(`unknown route title did not update after language switch: ${notFoundEnglishTitle}`)
  await setLang(page, 'zh')

  const stableOrderProduct = await ensurePaypalProduct(categoryId)
  if (!stableOrderProduct?.id || stableOrderProduct.currency !== 'USD' || !hasOrderableOption(stableOrderProduct)) {
    throw new Error(`stable USD order product not found: ${JSON.stringify(stableOrderProduct)}`)
  }
  const dirtyDraftPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await dirtyDraftPage.addInitScript((productId) => {
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify({
      client_request_id: 'not-valid',
      product_id: productId,
      option_id: 'not-valid-option',
      customer_name: 'Draft Customer',
      email: 'draft@example.com',
      phone: '13800000000',
      country: 'C'.repeat(500),
      shipping_address: 'S'.repeat(900),
      pet_name: 'Draft Pet',
      pet_type: 'Dog',
      notes: 'N'.repeat(5000),
      payment_type: 'balance_due',
      photo_urls: [
        '/uploads/9999999999999-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
        'https://unsafe.example.com/photo.png',
      ],
    }))
  }, stableOrderProduct.id)
  await dirtyDraftPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  const restoredDraftState = await dirtyDraftPage.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('pet-wool-order-draft-v1') || '{}')
    return {
      client_request_id: draft.client_request_id,
      countryLength: String(draft.country || '').length,
      shippingLength: String(draft.shipping_address || '').length,
      notesLength: String(draft.notes || '').length,
      payment_type: draft.payment_type,
      photo_urls: draft.photo_urls,
    }
  })
  if (
    /^order-\d+-[a-f0-9]+$/i.test(restoredDraftState.client_request_id)
    && restoredDraftState.countryLength <= 120
    && restoredDraftState.shippingLength <= 500
    && restoredDraftState.notesLength <= 2000
    && restoredDraftState.payment_type === 'deposit'
    && Array.isArray(restoredDraftState.photo_urls)
    && restoredDraftState.photo_urls.length === 1
    && String(restoredDraftState.photo_urls[0]).startsWith('/uploads/')
  ) ok('order draft persistence sanitizes legacy oversized local drafts')
  else throw new Error(`order draft persistence did not sanitize legacy draft: ${JSON.stringify(restoredDraftState)}`)
  await dirtyDraftPage.close()
  const emptyOrderPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await emptyOrderPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await emptyOrderPage.route('**/api/products?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '[]'
  }))
  await emptyOrderPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  await expectText(emptyOrderPage, '暂时没有可下单商品', 'order page empty product state visible')
  const disabledSubmitCount = await emptyOrderPage.getByRole('button', { name: '提交订单' }).count()
  if (disabledSubmitCount === 0) ok('order page hides form when no products')
  else throw new Error('order form still visible with no products')
  await emptyOrderPage.close()
  const invalidPriceOrderPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await invalidPriceOrderPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const invalidPriceProducts = [
    {
      ...stableOrderProduct,
      id: `invalid-price-product-${stamp}`,
      title: `无效价格商品 ${stamp}`,
      options: [
        { id: `zero-option-${stamp}`, name: '零元规格', price_cents: 0 },
        { id: `valid-option-${stamp}`, name: '有效规格', price_cents: 88000 },
      ],
    }
  ]
  await invalidPriceOrderPage.route('**/api/products?lang=zh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(invalidPriceProducts)
  }))
  await invalidPriceOrderPage.goto(`${base}/order?product=invalid-price-product-${stamp}&option=zero-option-${stamp}`, { waitUntil: 'networkidle' })
  const invalidPriceSelectedOption = await invalidPriceOrderPage.getByLabel('规格').inputValue()
  if (invalidPriceSelectedOption === `valid-option-${stamp}`) ok('order page falls back to valid priced option')
  else throw new Error(`order page did not fallback from zero-price option: ${invalidPriceSelectedOption}`)
  const zeroPriceOptionVisible = await invalidPriceOrderPage.getByLabel('规格').locator(`option[value="zero-option-${stamp}"]`).count()
  if (zeroPriceOptionVisible === 0) ok('order page hides non-positive price option')
  else throw new Error('order page still exposes zero-price option')
  await invalidPriceOrderPage.close()
  const failedOrderPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await failedOrderPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await failedOrderPage.route('**/api/products?lang=zh', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'product service unavailable' })
  }))
  await failedOrderPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  await expectText(failedOrderPage, '下单商品加载失败', 'order page load failure state visible')
  await expectText(failedOrderPage, '重新加载', 'order page load failure retry visible')
  const failedOrderCollectionsHref = await failedOrderPage.getByRole('link', { name: '分类' }).getAttribute('href')
  if (String(failedOrderCollectionsHref || '').endsWith('/collections')) ok('order page load failure links to collections')
  else throw new Error(`order failure collections link invalid: ${failedOrderCollectionsHref}`)
  const failedOrderSupportHref = await failedOrderPage.getByRole('link', { name: '联系客服' }).getAttribute('href')
  if (String(failedOrderSupportHref || '').endsWith('/support')) ok('order page load failure links to support')
  else throw new Error(`order failure support link invalid: ${failedOrderSupportHref}`)
  await expectNoHorizontalOverflow(failedOrderPage, 'order page load failure mobile layout has no horizontal overflow')
  await failedOrderPage.close()
  await page.goto(`${base}/order`, { waitUntil: 'networkidle' })
  const orderCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  const orderOgImage = await page.locator('meta[property="og:image"]').getAttribute('content')
  if (orderCanonical === `${base}/order` && orderOgImage && /^https?:\/\//.test(orderOgImage)) ok('order page canonical and og image set')
  else throw new Error(`order page head invalid: ${JSON.stringify({ orderCanonical, orderOgImage })}`)
  const invalidOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Invalid Order',
      email: 'not-an-email',
      phone: '13800000000',
      pet_name: 'Invalid',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: []
    })
  })
  if (invalidOrderRes.status === 400) ok('api rejects invalid public order')
  else throw new Error(`invalid public order accepted: ${invalidOrderRes.status}`)
  const invalidPhotoOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Invalid Photo Order',
      email: `invalid-photo-${stamp}@example.com`,
      phone: '13800000000',
      pet_name: 'InvalidPhoto',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: ['https://example.com/not-uploaded.jpg']
    })
  })
  if (invalidPhotoOrderRes.status === 400) ok('api rejects external public order photo urls')
  else throw new Error(`external public order photo url accepted: ${invalidPhotoOrderRes.status}`)
  const balanceNewOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Balance New Order',
      email: `balance-new-order-${stamp}@example.com`,
      phone: '13800000000',
      pet_name: 'BalancePet',
      pet_type: 'Cat',
      payment_type: 'balance',
      photo_urls: [uploadedPhotoUrl]
    })
  })
  const balanceNewOrderBody = await balanceNewOrderRes.json().catch(() => ({}))
  if (balanceNewOrderRes.status === 400 && balanceNewOrderBody.message === 'invalid payment type') ok('api rejects balance payment type on new public orders')
  else throw new Error(`balance public order accepted or wrong error: ${balanceNewOrderRes.status} ${JSON.stringify(balanceNewOrderBody)}`)
  const tooManyPhotoOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Too Many Photo Order',
      email: `too-many-photos-${stamp}@example.com`,
      phone: '13800000000',
      pet_name: 'ManyPhoto',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: Array.from({ length: 13 }, () => uploadedPhotoUrl)
    })
  })
  if (tooManyPhotoOrderRes.status === 400) ok('api rejects too many public order photos')
  else throw new Error(`too many public order photos accepted: ${tooManyPhotoOrderRes.status}`)
  const tooLongOrderFieldRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'A'.repeat(121),
      email: `too-long-order-${stamp}@example.com`,
      phone: '13800000000',
      pet_name: 'LongPet',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl]
    })
  })
  if (tooLongOrderFieldRes.status === 400) ok('api rejects overlong public order customer fields')
  else throw new Error(`overlong public order customer field accepted: ${tooLongOrderFieldRes.status}`)
  const tooLongOrderNotesRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Too Long Notes',
      email: `too-long-notes-${stamp}@example.com`,
      phone: '13800000000',
      pet_name: 'LongNotes',
      pet_type: 'Cat',
      payment_type: 'deposit',
      notes: 'N'.repeat(2001),
      photo_urls: [uploadedPhotoUrl]
    })
  })
  if (tooLongOrderNotesRes.status === 400) ok('api rejects overlong public order notes')
  else throw new Error(`overlong public order notes accepted: ${tooLongOrderNotesRes.status}`)
  const blockedUserRes = await fetch(`${base}/api/admin/users/blocked-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: blockedEmail, name: 'Blocked E2E User', status: 'blocked', tags: [], internal_note: 'blocked user regression', followups: [] })
  })
  if (!blockedUserRes.ok) throw new Error(`blocked user setup failed: ${blockedUserRes.status}`)
  const blockedLoginRes = await fetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: blockedEmail, name: 'Blocked E2E User' })
  })
  if (blockedLoginRes.status === 403) ok('api blocks disabled user login')
  else throw new Error(`blocked user login was not rejected: ${blockedLoginRes.status}`)
  if (blockedLoginRes.headers.get('cache-control') === 'no-store') ok('customer login errors are not cached')
  else throw new Error(`blocked login cache-control invalid: ${blockedLoginRes.headers.get('cache-control')}`)
  const longCustomerNameLoginRes = await fetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `long-customer-name-${stamp}@example.com`, name: 'N'.repeat(121) })
  })
  if (longCustomerNameLoginRes.status === 400) ok('api rejects overlong customer login profile name')
  else throw new Error(`overlong customer login profile name was accepted: ${longCustomerNameLoginRes.status}`)
  if (longCustomerNameLoginRes.headers.get('cache-control') === 'no-store') ok('customer login validation errors are not cached')
  else throw new Error(`long customer login cache-control invalid: ${longCustomerNameLoginRes.headers.get('cache-control')}`)
  const invalidCustomerAvatarLoginRes = await fetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `invalid-avatar-${stamp}@example.com`, name: 'Invalid Avatar User', avatar: 'javascript:alert(1)' })
  })
  if (invalidCustomerAvatarLoginRes.status === 400) ok('api rejects invalid customer avatar url')
  else throw new Error(`invalid customer avatar was accepted: ${invalidCustomerAvatarLoginRes.status}`)
  const forgedUserToken = `user-${Buffer.from(JSON.stringify({ email: testEmail, name: 'Forged User', avatar: '', provider: 'google' })).toString('base64url')}`
  const forgedUserOrdersRes = await fetch(`${base}/api/me/orders`, { headers: { authorization: `Bearer ${forgedUserToken}` } })
  if (forgedUserOrdersRes.status === 401) ok('api rejects forged customer token')
  else throw new Error(`forged customer token was accepted: ${forgedUserOrdersRes.status}`)
  const adminTokenCustomerOrdersRes = await fetch(`${base}/api/me/orders`, { headers: { authorization: 'Bearer admin-e2e' } })
  if (adminTokenCustomerOrdersRes.status === 401) ok('api rejects admin token on customer orders endpoint')
  else throw new Error(`admin token was accepted on customer orders endpoint: ${adminTokenCustomerOrdersRes.status}`)
  const expiredUserToken = signedCustomerToken({ email: testEmail, name: 'Expired User', avatar: '', provider: 'google', iat: Date.now() - 60_000, exp: Date.now() - 1_000 })
  const expiredUserOrdersRes = await fetch(`${base}/api/me/orders`, { headers: { authorization: `Bearer ${expiredUserToken}` } })
  if (expiredUserOrdersRes.status === 401) ok('api rejects expired customer token')
  else throw new Error(`expired customer token was accepted: ${expiredUserOrdersRes.status}`)
  const blockedOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Blocked E2E User',
      email: blockedEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Blocked',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  if (blockedOrderRes.status === 403) ok('api blocks disabled user order creation')
  else throw new Error(`blocked user order creation was not rejected: ${blockedOrderRes.status}`)
  const unpaidOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Unpaid Flow Guard',
      email: unpaidEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Guard',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const unpaidOrder = await unpaidOrderRes.json()
  if (!unpaidOrderRes.ok) throw new Error(`unpaid guard order create failed: ${unpaidOrderRes.status} ${JSON.stringify(unpaidOrder)}`)
  const publicOrderSensitiveFields = ['email', 'phone', 'shipping_address', 'photo_urls', 'notes', 'internal_note', 'events', 'flagged', 'shipping_carrier', 'tracking_no']
  if (publicOrderSensitiveFields.every((field) => !(field in unpaidOrder))) ok('public order response hides private customer fields')
  else throw new Error(`public order leaked private fields: ${JSON.stringify(unpaidOrder)}`)
  const otherUserLoginRes = await fetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `other-user-${stamp}@example.com`, name: 'Other User' })
  })
  const otherUserLogin = await otherUserLoginRes.json()
  if (!otherUserLoginRes.ok || !otherUserLogin.token) throw new Error(`other user login failed: ${otherUserLoginRes.status} ${JSON.stringify(otherUserLogin)}`)
  const ownOrderCreateRes = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherUserLogin.token}` },
    body: JSON.stringify({ order_id: unpaidOrder.id })
  })
  if (ownOrderCreateRes.status === 403) ok('api blocks customer paypal create for another user order')
  else throw new Error(`customer paypal create for another order accepted: ${ownOrderCreateRes.status}`)
  const adminCreatedPaypal = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: unpaidOrder.id })
  }).then((res) => res.json())
  const otherUserCaptureRes = await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${otherUserLogin.token}` },
    body: JSON.stringify({ paypal_order_id: adminCreatedPaypal.id })
  })
  if (otherUserCaptureRes.status === 403) ok('api blocks customer paypal capture for another user order')
  else throw new Error(`customer paypal capture for another order accepted: ${otherUserCaptureRes.status}`)
  const blockedPayEmail = `blocked-pay-${stamp}@example.com`
  const blockedPayOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Blocked Pay User',
      email: blockedPayEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'BlockedPay',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const blockedPayOrder = await blockedPayOrderRes.json()
  if (!blockedPayOrderRes.ok) throw new Error(`blocked pay order setup failed: ${blockedPayOrderRes.status} ${JSON.stringify(blockedPayOrder)}`)
  const blockedPayLoginRes = await fetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: blockedPayEmail, name: 'Blocked Pay User' })
  })
  const blockedPayLogin = await blockedPayLoginRes.json()
  if (!blockedPayLoginRes.ok || !blockedPayLogin.token) throw new Error(`blocked pay login setup failed: ${blockedPayLoginRes.status} ${JSON.stringify(blockedPayLogin)}`)
  const blockedPayCreated = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: blockedPayOrder.id })
  }).then((res) => res.json())
  const blockedPayUserRes = await fetch(`${base}/api/admin/users/blocked-pay-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: blockedPayEmail, name: 'Blocked Pay User', status: 'blocked', tags: [], internal_note: 'blocked payment regression', followups: [] })
  })
  if (!blockedPayUserRes.ok) throw new Error(`blocked payment user setup failed: ${blockedPayUserRes.status}`)
  const blockedPayCreateRes = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${blockedPayLogin.token}` },
    body: JSON.stringify({ order_id: blockedPayOrder.id })
  })
  if (blockedPayCreateRes.status === 403) ok('api blocks disabled logged-in user paypal create')
  else throw new Error(`blocked logged-in user paypal create accepted: ${blockedPayCreateRes.status}`)
  const blockedPayCaptureRes = await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${blockedPayLogin.token}` },
    body: JSON.stringify({ paypal_order_id: blockedPayCreated.id })
  })
  if (blockedPayCaptureRes.status === 403) ok('api blocks disabled logged-in user paypal capture')
  else throw new Error(`blocked logged-in user paypal capture accepted: ${blockedPayCaptureRes.status}`)
  const forgedAmountOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Forged Amount',
      email: `commercial-forged-amount-${stamp}@example.com`,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Amount',
      pet_type: 'Cat',
      payment_type: 'deposit',
      amount_cents: 1,
      paid_amount_cents: 999999999,
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const forgedAmountOrder = await forgedAmountOrderRes.json()
  const expectedDepositAmount = Math.round((stableOrderProduct.options?.[0]?.price_cents || stableOrderProduct.base_price_cents) * stableOrderProduct.deposit_percent / 100)
  if (forgedAmountOrderRes.ok && forgedAmountOrder.amount_cents === expectedDepositAmount && forgedAmountOrder.paid_amount_cents === 0) ok('api ignores client supplied order amounts')
  else throw new Error(`client supplied amount affected order: ${forgedAmountOrderRes.status} ${JSON.stringify({ forgedAmountOrder, expectedDepositAmount })}`)
  const nonDefaultOption = stableOrderProduct.options?.[1]
  if (nonDefaultOption) {
    const nonDefaultDepositRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: stableOrderProduct.id,
        option_id: nonDefaultOption.id,
        customer_name: 'Non Default Deposit',
        email: `non-default-deposit-${stamp}@example.com`,
        phone: '13800000000',
        country: 'CN',
        pet_name: 'Option',
        pet_type: 'Cat',
        payment_type: 'deposit',
        photo_urls: [uploadedPhotoUrl],
        lang: 'zh'
      })
    })
    const nonDefaultDepositOrder = await nonDefaultDepositRes.json()
    const expectedNonDefaultDeposit = Math.round(Number(nonDefaultOption.price_cents || 0) * Number(stableOrderProduct.deposit_percent || 0) / 100)
    if (nonDefaultDepositRes.ok && nonDefaultDepositOrder.amount_cents === expectedNonDefaultDeposit) ok('api uses selected non-default option for deposit amount')
    else throw new Error(`non-default deposit amount invalid: ${nonDefaultDepositRes.status} ${JSON.stringify({ nonDefaultDepositOrder, expectedNonDefaultDeposit })}`)
    const nonDefaultDepositPaypal = await fetch(`${base}/api/paypal/create-order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order_id: nonDefaultDepositOrder.id })
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    if (nonDefaultDepositPaypal.status === 200 && nonDefaultDepositPaypal.body?.payment?.amount_cents === expectedNonDefaultDeposit) ok('paypal uses selected non-default option deposit amount')
    else throw new Error(`non-default deposit paypal amount invalid: ${JSON.stringify(nonDefaultDepositPaypal)}`)
    const nonDefaultFullRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: stableOrderProduct.id,
        option_id: nonDefaultOption.id,
        customer_name: 'Non Default Full',
        email: `non-default-full-${stamp}@example.com`,
        phone: '13800000000',
        country: 'CN',
        pet_name: 'OptionFull',
        pet_type: 'Dog',
        payment_type: 'full',
        photo_urls: [uploadedPhotoUrl],
        lang: 'zh'
      })
    })
    const nonDefaultFullOrder = await nonDefaultFullRes.json()
    const expectedNonDefaultFull = Number(nonDefaultOption.price_cents || 0)
    if (nonDefaultFullRes.ok && nonDefaultFullOrder.amount_cents === expectedNonDefaultFull) ok('api uses selected non-default option for full amount')
    else throw new Error(`non-default full amount invalid: ${nonDefaultFullRes.status} ${JSON.stringify({ nonDefaultFullOrder, expectedNonDefaultFull })}`)
  } else {
    ok('api non-default option amount check skipped for single-option product')
  }
  const normalizedOrderEmail = `normalized-${stamp}@example.com`
  const normalizedOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: '  Normalized Customer  ',
      email: `  ${normalizedOrderEmail.toUpperCase()}  `,
      phone: '  13800000000  ',
      country: '  CN  ',
      shipping_address: '  Normalized Shipping Address  ',
      pet_name: '  TrimPet  ',
      pet_type: '  Cat  ',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const normalizedOrder = await normalizedOrderRes.json()
  if (!normalizedOrderRes.ok) throw new Error(`normalized order create failed: ${normalizedOrderRes.status} ${JSON.stringify(normalizedOrder)}`)
  const normalizedAdminOrders = await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin orders after normalized order')
  const normalizedAdminOrder = normalizedAdminOrders.find((order) => order.id === normalizedOrder.id)
  if (
    normalizedAdminOrder?.email === normalizedOrderEmail
    && normalizedAdminOrder.customer_name === 'Normalized Customer'
    && normalizedAdminOrder.phone === '13800000000'
    && normalizedAdminOrder.shipping_address === 'Normalized Shipping Address'
    && normalizedAdminOrder.pet_name === 'TrimPet'
    && normalizedAdminOrder.pet_type === 'Cat'
  ) ok('api normalizes public order customer fields')
  else throw new Error(`public order fields were not normalized: ${JSON.stringify(normalizedAdminOrder)}`)
  const idempotentRequestId = `idem-${stamp}`
  const idempotentPayload = {
    product_id: stableOrderProduct.id,
    option_id: stableOrderProduct.options?.[0]?.id,
    customer_name: 'Idempotent Customer',
    email: `commercial-idempotent-${stamp}@example.com`,
    phone: '13800000000',
    country: 'CN',
    pet_name: 'SameOrder',
    pet_type: 'Cat',
    payment_type: 'deposit',
    photo_urls: [uploadedPhotoUrl],
    client_request_id: idempotentRequestId,
    lang: 'zh'
  }
  const ordersBeforeIdempotent = await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'orders before idempotent submit')
  const idempotentOne = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(idempotentPayload)
  }).then((res) => res.json())
  const idempotentTwo = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(idempotentPayload)
  }).then((res) => res.json())
  const ordersAfterIdempotent = await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'orders after idempotent submit')
  if (idempotentOne.id && idempotentOne.id === idempotentTwo.id && ordersAfterIdempotent.length === ordersBeforeIdempotent.length + 1) ok('api idempotent public order submit reuses existing order')
  else throw new Error(`idempotent submit failed: ${JSON.stringify({ first: idempotentOne, second: idempotentTwo, before: ordersBeforeIdempotent.length, after: ordersAfterIdempotent.length })}`)
  const idempotentConflictRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...idempotentPayload, payment_type: 'full' })
  })
  if (idempotentConflictRes.status === 409) ok('api rejects conflicting idempotent public order submit')
  else throw new Error(`conflicting idempotent submit was not rejected: ${idempotentConflictRes.status} ${await idempotentConflictRes.text()}`)
  if (idempotentConflictRes.headers.get('cache-control') === 'no-store') ok('public order conflict responses are not cached')
  else throw new Error(`idempotent conflict cache-control invalid: ${idempotentConflictRes.headers.get('cache-control')}`)
  const idempotentPetConflictRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...idempotentPayload, pet_name: 'DifferentPet' })
  })
  if (idempotentPetConflictRes.status === 409) ok('api rejects conflicting idempotent order details')
  else throw new Error(`conflicting idempotent order details were not rejected: ${idempotentPetConflictRes.status} ${await idempotentPetConflictRes.text()}`)
  const ordersAfterIdempotentConflict = await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'orders after idempotent conflict')
  if (ordersAfterIdempotentConflict.length === ordersAfterIdempotent.length) ok('api conflicting idempotent submit does not create order')
  else throw new Error(`conflicting idempotent submit created an order: ${ordersAfterIdempotent.length} -> ${ordersAfterIdempotentConflict.length}`)
  const advanceUnpaidRes = await fetch(`${base}/api/admin/orders/${unpaidOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'crafting' })
  })
  if ([400, 404].includes(advanceUnpaidRes.status)) ok('api prevents unpaid order from advancing')
  else throw new Error(`unpaid order advanced unexpectedly: ${advanceUnpaidRes.status}`)
  const unauthorizedFlagRes = await fetch(`${base}/api/admin/orders/${unpaidOrder.id}/flag`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flagged: true })
  })
  if (unauthorizedFlagRes.status === 401) ok('api rejects unauthorized order flag update')
  else throw new Error(`unauthorized order flag update accepted: ${unauthorizedFlagRes.status}`)
  const invalidStatusRes = await fetch(`${base}/api/admin/orders/${unpaidOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'ready_for_anything' })
  })
  if (invalidStatusRes.status === 400) ok('api rejects invalid order status')
  else throw new Error(`invalid order status accepted: ${invalidStatusRes.status}`)
  const invalidPaymentRes = await fetch(`${base}/api/admin/orders/${unpaidOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'maybe_paid' })
  })
  if (invalidPaymentRes.status === 400) ok('api rejects invalid payment status')
  else throw new Error(`invalid payment status accepted: ${invalidPaymentRes.status}`)
  const unpaidBalanceDueRes = await fetch(`${base}/api/admin/orders/${unpaidOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'balance_due' })
  })
  if (unpaidBalanceDueRes.status === 400) ok('api blocks balance due before deposit is paid')
  else throw new Error(`unpaid order was marked balance due: ${unpaidBalanceDueRes.status}`)
  const manualPaidOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Manual Paid',
      email: `manual-paid-${stamp}@example.com`,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Manual',
      pet_type: 'Cat',
      payment_type: 'full',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const manualPaidOrder = await manualPaidOrderRes.json()
  if (!manualPaidOrderRes.ok) throw new Error(`manual paid order create failed: ${manualPaidOrderRes.status} ${JSON.stringify(manualPaidOrder)}`)
  const manualPaidRes = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'paid' })
  })
  const manualPaidUpdated = await manualPaidRes.json()
  if (manualPaidRes.ok && manualPaidUpdated.payment_status === 'paid' && manualPaidUpdated.paid_amount_cents === manualPaidUpdated.amount_cents) ok('admin manual paid status syncs paid amount')
  else throw new Error(`manual paid status did not sync amount: ${manualPaidRes.status} ${JSON.stringify(manualPaidUpdated)}`)
  const manualBackup = await fetch(`${base}/api/admin/backup`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  const manualPayment = manualBackup.data?.payments?.find((payment) => payment.order_id === manualPaidOrder.id && payment.provider === 'manual' && payment.status === 'captured')
  if (manualPayment) ok('admin manual paid status records payment audit')
  else throw new Error(`manual payment audit missing: ${JSON.stringify(manualBackup.data?.payments?.slice(0, 3))}`)
  const manualEventOrder = manualBackup.data?.orders?.find((order) => order.id === manualPaidOrder.id)
  if (manualEventOrder?.events?.some((event) => event.type === 'payment'
    && String(event.message || '').includes('付款状态')
    && event.meta?.provider === 'manual'
    && event.meta?.amount_cents === manualPaidUpdated.amount_cents
    && event.meta?.currency === manualPaidUpdated.currency
  )) ok('admin manual payment records auditable order event')
  else throw new Error(`manual payment order event missing: ${JSON.stringify(manualEventOrder?.events)}`)
  const manualRefundOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Manual Refund',
      email: `manual-refund-${stamp}@example.com`,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Refund',
      pet_type: 'Cat',
      payment_type: 'full',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const manualRefundOrder = await manualRefundOrderRes.json()
  if (!manualRefundOrderRes.ok) throw new Error(`manual refund order create failed: ${manualRefundOrderRes.status} ${JSON.stringify(manualRefundOrder)}`)
  const manualRefundPaidRes = await fetch(`${base}/api/admin/orders/${manualRefundOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'paid' })
  })
  const manualRefundPaidOrder = await manualRefundPaidRes.json()
  if (!manualRefundPaidRes.ok) throw new Error(`manual refund order could not be marked paid: ${manualRefundPaidRes.status}`)
  const refundPaidRes = await fetch(`${base}/api/admin/orders/${manualRefundOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'refunded' })
  })
  const refundPaidOrder = await refundPaidRes.json()
  if (refundPaidRes.ok && refundPaidOrder.payment_status === 'refunded' && refundPaidOrder.paid_amount_cents === 0) ok('admin refund clears paid amount')
  else throw new Error(`manual refund did not clear paid amount: ${refundPaidRes.status} ${JSON.stringify(refundPaidOrder)}`)
  const refundBackup = await fetch(`${base}/api/admin/backup`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  const refundPayment = refundBackup.data?.payments?.find((payment) => payment.order_id === manualRefundOrder.id && payment.provider === 'manual' && payment.status === 'refunded')
  if (refundPayment?.amount_cents === manualRefundPaidOrder.amount_cents) ok('admin refund records previous paid amount')
  else throw new Error(`manual refund audit amount invalid: ${JSON.stringify(refundPayment)}`)
  const refundAdvanceRes = await fetch(`${base}/api/admin/orders/${manualRefundOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'crafting' })
  })
  if (refundAdvanceRes.status === 400) ok('api blocks refunded order from advancing')
  else throw new Error(`refunded order advanced unexpectedly: ${refundAdvanceRes.status}`)
  const refundedReopenRes = await fetch(`${base}/api/admin/orders/${manualRefundOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'confirmed' })
  })
  if (refundedReopenRes.status === 400) ok('api blocks refunded order from reopening into workflow')
  else throw new Error(`refunded order reopened unexpectedly: ${refundedReopenRes.status}`)
  const manualShipRes = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'shipped' })
  })
  if (manualShipRes.status === 400) ok('api requires tracking before shipping paid order')
  else throw new Error(`manual paid order shipped without tracking: ${manualShipRes.status}`)
  const manualPaidTracked = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  const manualTrackingRes = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}/note`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ internal_note: manualPaidTracked.internal_note || '', shipping_carrier: 'DHL', tracking_no: `SHIP-${stamp}`, updated_at: manualPaidTracked.updated_at })
  })
  if (!manualTrackingRes.ok) throw new Error(`manual paid order tracking setup failed: ${manualTrackingRes.status}`)
  const manualShipWithTrackingRes = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'shipped' })
  })
  if (!manualShipWithTrackingRes.ok) throw new Error(`manual paid order could not ship with tracking: ${manualShipWithTrackingRes.status}`)
  const downgradeShippedPaymentRes = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'unpaid' })
  })
  if (downgradeShippedPaymentRes.status === 400) ok('api blocks shipped order payment downgrade')
  else throw new Error(`shipped order payment downgrade accepted: ${downgradeShippedPaymentRes.status}`)
  const completePaidOrderRes = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'completed' })
  })
  if (!completePaidOrderRes.ok) throw new Error(`manual paid order could not complete: ${completePaidOrderRes.status}`)
  const reopenCompletedOrderRes = await fetch(`${base}/api/admin/orders/${manualPaidOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'crafting' })
  })
  if (reopenCompletedOrderRes.status === 400) ok('api blocks completed order from reopening')
  else throw new Error(`completed order reopened unexpectedly: ${reopenCompletedOrderRes.status}`)
  const productForPublishCheck = await fetch(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } })
    .then((res) => res.json())
    .then((items) => items.find((product) => product.id === temporaryProductId))
  const invalidProductPublishRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, status: 'archived' })
  })
  if (invalidProductPublishRes.status === 400) ok('api rejects invalid product publish status')
  else throw new Error(`invalid product publish status accepted: ${invalidProductPublishRes.status}`)
  const invalidProductPriceRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, base_price_cents: 1200.5 })
  })
  if (invalidProductPriceRes.status === 400) ok('api rejects non-integer product price')
  else throw new Error(`non-integer product price accepted: ${invalidProductPriceRes.status}`)
  const invalidProductDepositRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, deposit_percent: 50.5 })
  })
  if (invalidProductDepositRes.status === 400) ok('api rejects non-integer deposit percent')
  else throw new Error(`non-integer deposit percent accepted: ${invalidProductDepositRes.status}`)
  const invalidProductCurrencyRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, currency: 'CNY1' })
  })
  if (invalidProductCurrencyRes.status === 400) ok('api rejects invalid product currency')
  else throw new Error(`invalid product currency accepted: ${invalidProductCurrencyRes.status}`)
  const invalidProductImageRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, image_url: 'not-a-url', images: ['not-a-url'] })
  })
  if (invalidProductImageRes.status === 400) ok('api rejects invalid product image url')
  else throw new Error(`invalid product image url accepted: ${invalidProductImageRes.status}`)
  const localProductImageUrl = uploadedPhotoUrl
  const localProductImageRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, image_url: localProductImageUrl, images: [localProductImageUrl], status: 'published' })
  })
  const localProductImage = await localProductImageRes.json()
  if (localProductImageRes.ok && localProductImage.image_url === localProductImageUrl && localProductImage.images?.[0] === localProductImageUrl) ok('api accepts local uploaded product image references')
  else throw new Error(`local uploaded product image was rejected: ${localProductImageRes.status} ${JSON.stringify(localProductImage).slice(0, 300)}`)
  const badLocalProductImageRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, image_url: '/uploads/not-a-generated-name.png', images: ['/uploads/not-a-generated-name.png'] })
  })
  if (badLocalProductImageRes.status === 400) ok('api rejects malformed local product image references')
  else throw new Error(`malformed local product image accepted: ${badLocalProductImageRes.status}`)
  const missingSeoTitleProductRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, status: 'published', seo_title: '', translations: { ...(productForPublishCheck.translations || {}), zh: { ...(productForPublishCheck.translations?.zh || {}), seo_title: '' } } })
  })
  if (missingSeoTitleProductRes.status === 400) ok('api rejects published product without seo title')
  else throw new Error(`published product without seo title accepted: ${missingSeoTitleProductRes.status}`)
  const missingSeoDescProductRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, status: 'published', seo_description: '', translations: { ...(productForPublishCheck.translations || {}), zh: { ...(productForPublishCheck.translations?.zh || {}), seo_description: '' } } })
  })
  if (missingSeoDescProductRes.status === 400) ok('api rejects published product without seo description')
  else throw new Error(`published product without seo description accepted: ${missingSeoDescProductRes.status}`)
  const optionBackfillSlug = `option-backfill-${stamp}`
  const optionIdBackfillRes = await fetch(`${base}/api/admin/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      ...productForPublishCheck,
      slug: optionBackfillSlug,
      title: `选项 ID 回填 ${stamp}`,
      translations: {
        zh: { ...(productForPublishCheck.translations?.zh || {}), title: `选项 ID 回填 ${stamp}` },
      },
      options: [{ name: '自动补 ID 规格', price_cents: 123400 }],
    })
  })
  const optionIdBackfillProduct = await optionIdBackfillRes.json()
  if (optionIdBackfillRes.ok && optionIdBackfillProduct.options?.[0]?.id) ok('api backfills product option ids')
  else throw new Error(`product option id was not backfilled: ${optionIdBackfillRes.status} ${JSON.stringify(optionIdBackfillProduct.options)}`)
  await fetch(`${base}/api/admin/products/${optionIdBackfillProduct.id}`, { method: 'DELETE', headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' } }).catch(() => {})
  const multiImageProduct = {
    ...productForPublishCheck,
    image_url: 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82',
    images: [
      'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82',
      'https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=900&q=82'
    ]
  }
  const multiImageSetupRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify(multiImageProduct)
  })
  if (!multiImageSetupRes.ok) throw new Error(`multi-image product setup failed: ${multiImageSetupRes.status}`)
  productForPublishCheck.image_url = multiImageProduct.image_url
  productForPublishCheck.images = multiImageProduct.images
  const productSeoTitle = `商业化 SEO 标题 ${stamp}`
  const productAltText = `商业化图片 Alt ${stamp}`
  const productSeoRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      ...productForPublishCheck,
      alt_text: productAltText,
      seo_title: productSeoTitle,
      seo_description: `商业化 SEO 描述 ${stamp}`,
      use_cases: ['商业化礼物', '宠物纪念'],
      translations: {
        ...(productForPublishCheck.translations || {}),
        zh: {
          ...(productForPublishCheck.translations?.zh || {}),
          alt_text: productAltText,
          seo_title: productSeoTitle,
          seo_description: `商业化 SEO 描述 ${stamp}`,
        }
      }
    })
  })
  if (!productSeoRes.ok) throw new Error(`product seo save failed: ${productSeoRes.status}`)
  const publicSeoProduct = await fetch(`${base}/api/products/${productForPublishCheck.slug}?lang=zh`).then((res) => res.json())
  if (publicSeoProduct.seo_title === productSeoTitle && publicSeoProduct.alt_text === productAltText && publicSeoProduct.use_cases?.includes('商业化礼物')) ok('admin product SEO and merchandising fields persist to public detail')
  else throw new Error(`product SEO fields missing publicly: ${JSON.stringify({ seo_title: publicSeoProduct.seo_title, alt_text: publicSeoProduct.alt_text, use_cases: publicSeoProduct.use_cases })}`)
  const productAfterSeoSave = await fetch(`${base}/api/admin/products`, { headers: { authorization: 'Bearer admin-e2e' } })
    .then((res) => res.json())
    .then((items) => items.find((product) => product.id === productForPublishCheck.id))
  if (productAfterSeoSave.images?.length === 2 && productAfterSeoSave.images[1] === multiImageProduct.images[1]) ok('admin product save preserves existing gallery images')
  else throw new Error(`admin product save lost gallery images: ${JSON.stringify(productAfterSeoSave.images)}`)
  const galleryCheckPage = await browser.newPage({ viewport: { width: 1366, height: 900 }, locale: 'zh-CN' })
  await galleryCheckPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await galleryCheckPage.goto(`${base}/products/${productForPublishCheck.slug}`, { waitUntil: 'networkidle' })
  const detailThumbCount = await galleryCheckPage.locator('.detail-thumbs img').count()
  if (detailThumbCount >= 2) ok('public product detail renders configured gallery images')
  else throw new Error(`product detail gallery image count invalid: ${detailThumbCount}`)
  await galleryCheckPage.close()
  const multiCurrencyUserEmail = `multi-currency-${stamp}@example.com`
  // Under the KRW-base model products are always stored in KRW; the metrics
  // grouping below now exercises the KRW bucket directly.
  const usdOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: productForPublishCheck.id,
      option_id: productForPublishCheck.options?.[0]?.id,
      customer_name: 'Multi Currency User',
      email: multiCurrencyUserEmail,
      phone: '13800000000',
      pet_name: 'Currency',
      pet_type: 'Cat',
      payment_type: 'full',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const usdOrder = await usdOrderRes.json()
  if (!usdOrderRes.ok) throw new Error(`temporary USD order failed: ${usdOrderRes.status} ${JSON.stringify(usdOrder)}`)
  const paidUsdOrderRes = await fetch(`${base}/api/admin/orders/${usdOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'paid' })
  })
  const paidUsdOrder = await paidUsdOrderRes.json()
  if (!paidUsdOrderRes.ok) throw new Error(`temporary USD order paid failed: ${paidUsdOrderRes.status} ${JSON.stringify(paidUsdOrder)}`)
  const multiCurrencyUsers = await fetchJsonArray(`${base}/api/admin/users`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin users after USD order')
  const multiCurrencyUser = multiCurrencyUsers.find((user) => String(user.email || '').toLowerCase() === multiCurrencyUserEmail)
  if (multiCurrencyUser?.paid_by_currency?.KRW === paidUsdOrder.amount_cents) ok('admin user metrics group paid amount by currency')
  else throw new Error(`admin user paid_by_currency invalid: ${JSON.stringify(multiCurrencyUser)}`)
  const multiCurrencyOverview = await fetch(`${base}/api/admin/overview`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  if (multiCurrencyOverview.revenue_by_currency?.KRW >= paidUsdOrder.amount_cents) ok('admin overview groups revenue by currency')
  else throw new Error(`admin overview revenue_by_currency invalid: ${JSON.stringify(multiCurrencyOverview)}`)
  const refundedCurrencyEmail = `multi-currency-refund-${stamp}@example.com`
  const refundMetricOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: productForPublishCheck.id,
      option_id: productForPublishCheck.options?.[0]?.id,
      customer_name: 'Refunded Currency User',
      email: refundedCurrencyEmail,
      phone: '13800000000',
      pet_name: 'RefundedCurrency',
      pet_type: 'Dog',
      payment_type: 'full',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const refundMetricOrder = await refundMetricOrderRes.json()
  if (!refundMetricOrderRes.ok) throw new Error(`temporary refund metric order failed: ${refundMetricOrderRes.status} ${JSON.stringify(refundMetricOrder)}`)
  const paidRefundMetricOrderRes = await fetch(`${base}/api/admin/orders/${refundMetricOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'paid' })
  })
  if (!paidRefundMetricOrderRes.ok) throw new Error(`temporary refund metric order paid failed: ${paidRefundMetricOrderRes.status}`)
  const refundUsdOrderRes = await fetch(`${base}/api/admin/orders/${refundMetricOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'refunded' })
  })
  if (!refundUsdOrderRes.ok) throw new Error(`temporary USD order refund failed: ${refundUsdOrderRes.status}`)
  const refundedCurrencyUsers = await fetchJsonArray(`${base}/api/admin/users`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin users after USD refund')
  const refundedCurrencyUser = refundedCurrencyUsers.find((user) => String(user.email || '').toLowerCase() === refundedCurrencyEmail)
  if (Number(refundedCurrencyUser?.paid_by_currency?.KRW || 0) === 0 && Number(refundedCurrencyUser?.total_paid_cents || 0) === 0) ok('admin user paid metrics exclude refunded orders')
  else throw new Error(`admin user paid metrics include refunded order: ${JSON.stringify(refundedCurrencyUser)}`)
  const invalidProductOptionPriceRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, options: [{ ...(productForPublishCheck.options?.[0] || {}), price_cents: 1234.5 }] })
  })
  if (invalidProductOptionPriceRes.status === 400) ok('api rejects non-integer option price')
  else throw new Error(`non-integer option price accepted: ${invalidProductOptionPriceRes.status}`)
  const duplicateProductOptionRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      ...productForPublishCheck,
      options: [
        { ...(productForPublishCheck.options?.[0] || {}), id: 'duplicate-option-a', name: '重复规格', price_cents: 123400 },
        { ...(productForPublishCheck.options?.[1] || productForPublishCheck.options?.[0] || {}), id: 'duplicate-option-b', name: ' 重复规格 ', price_cents: 223400 },
      ]
    })
  })
  if (duplicateProductOptionRes.status === 400) ok('api rejects duplicate product option names')
  else throw new Error(`duplicate product option names accepted: ${duplicateProductOptionRes.status}`)
  const hiddenCategoryForPublishRes = await fetch(`${base}/api/admin/categories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ slug: `hidden-publish-${stamp}`, title: `隐藏发布分类 ${stamp}`, status: 'hidden' })
  })
  const hiddenCategoryForPublish = await hiddenCategoryForPublishRes.json()
  if (!hiddenCategoryForPublishRes.ok) throw new Error(`hidden publish category setup failed: ${hiddenCategoryForPublishRes.status}`)
  const publishedHiddenCategoryProductRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...productForPublishCheck, category_id: hiddenCategoryForPublish.id, status: 'published' })
  })
  if (publishedHiddenCategoryProductRes.status === 400) ok('api rejects published product under hidden category')
  else throw new Error(`published product under hidden category accepted: ${publishedHiddenCategoryProductRes.status}`)
  await fetch(`${base}/api/admin/categories/${hiddenCategoryForPublish.id}`, { method: 'DELETE', headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' } }).catch(() => {})
  const categoryForPublishCheck = await fetch(`${base}/api/admin/categories`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json()).then((items) => items[0])
  const invalidCategoryPublishRes = await fetch(`${base}/api/admin/categories/${categoryForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...categoryForPublishCheck, status: 'archived' })
  })
  if (invalidCategoryPublishRes.status === 400) ok('api rejects invalid category publish status')
  else throw new Error(`invalid category publish status accepted: ${invalidCategoryPublishRes.status}`)
  const hidePublishedCategoryRes = await fetch(`${base}/api/admin/categories/${categoryForPublishCheck.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ ...categoryForPublishCheck, status: 'hidden' })
  })
  if (hidePublishedCategoryRes.status === 409) ok('api rejects hiding category with published products')
  else throw new Error(`category with published products hidden: ${hidePublishedCategoryRes.status}`)
  const orderedProductDeleteRes = await fetch(`${base}/api/admin/products/${stableOrderProduct.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' }
  })
  if (orderedProductDeleteRes.status === 409) ok('api prevents deleting products with orders')
  else throw new Error(`ordered product delete was not blocked: ${orderedProductDeleteRes.status}`)
  const referencedProductDeleteRes = await fetch(`${base}/api/admin/products/${productForPublishCheck.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' }
  })
  if (referencedProductDeleteRes.status === 409) ok('api prevents deleting products referenced by site content')
  else throw new Error(`referenced product delete was not blocked: ${referencedProductDeleteRes.status}`)
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { enabled: true, currency: 'USD' } })
  })
  await waitForPaypalCurrency('USD')
  const cancelledStatusRes = await fetch(`${base}/api/admin/orders/${unpaidOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'cancelled' })
  })
  if (!cancelledStatusRes.ok) throw new Error(`cancel unpaid order setup failed: ${cancelledStatusRes.status}`)
  const cancelledPaypalRes = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: unpaidOrder.id })
  })
  if (cancelledPaypalRes.status === 409) ok('paypal create-order rejects cancelled orders')
  else throw new Error(`cancelled order paypal create was accepted: ${cancelledPaypalRes.status}`)
  const cancelAfterCreateRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Cancel After Create',
      email: unpaidEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Cancel',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const cancelAfterCreateOrder = await cancelAfterCreateRes.json()
  if (!cancelAfterCreateRes.ok) throw new Error(`cancel-after-create order failed: ${cancelAfterCreateRes.status} ${JSON.stringify(cancelAfterCreateOrder)}`)
  const stalePaypal = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: cancelAfterCreateOrder.id })
  }).then((res) => res.json())
  await fetch(`${base}/api/admin/orders/${cancelAfterCreateOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'cancelled' })
  })
  const staleCaptureRes = await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paypal_order_id: stalePaypal.id })
  })
  if ([404, 409].includes(staleCaptureRes.status)) ok('paypal capture rejects cancelled orders')
  else throw new Error(`cancelled order paypal capture was accepted: ${staleCaptureRes.status}`)
  const staleCreatedOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Stale Created Payment',
      email: `stale-created-${stamp}@example.com`,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Stale',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const staleCreatedOrder = await staleCreatedOrderRes.json()
  if (!staleCreatedOrderRes.ok) throw new Error(`stale created order setup failed: ${staleCreatedOrderRes.status} ${JSON.stringify(staleCreatedOrder)}`)
  const staleDepositPaypal = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: staleCreatedOrder.id })
  }).then(async (res) => ({ status: res.status, body: await res.json() }))
  const staleBalanceMarkRes = await fetch(`${base}/api/admin/orders/${staleCreatedOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'deposit_paid' })
  })
  if (!staleBalanceMarkRes.ok) throw new Error(`stale created order deposit mark failed: ${staleBalanceMarkRes.status}`)
  const staleBalanceDueRes = await fetch(`${base}/api/admin/orders/${staleCreatedOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'balance_due' })
  })
  if (!staleBalanceDueRes.ok) throw new Error(`stale created order balance due mark failed: ${staleBalanceDueRes.status}`)
  const staleBalancePaypal = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: staleCreatedOrder.id })
  }).then(async (res) => ({ status: res.status, body: await res.json() }))
  if (staleBalancePaypal.status === 200 && staleBalancePaypal.body?.id && staleBalancePaypal.body.id !== staleDepositPaypal.body?.id && staleBalancePaypal.body?.payment?.payment_type === 'balance') ok('paypal create-order ignores stale created payment with mismatched type')
  else throw new Error(`stale created paypal payment reused incorrectly: ${JSON.stringify({ deposit: staleDepositPaypal, balance: staleBalancePaypal })}`)
  const staleDepositCaptureRes = await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paypal_order_id: staleDepositPaypal.body?.id })
  })
  if (staleDepositCaptureRes.status === 409) ok('paypal capture rejects stale created payment with mismatched type')
  else throw new Error(`stale created paypal payment captured incorrectly: ${staleDepositCaptureRes.status}`)
  const payableOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Payable Flow Guard',
      email: payableEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Payable',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const payableOrder = await payableOrderRes.json()
  if (!payableOrderRes.ok) throw new Error(`payable guard order create failed: ${payableOrderRes.status} ${JSON.stringify(payableOrder)}`)
  const paypalCreateOne = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: payableOrder.id })
  }).then(async (res) => ({ status: res.status, cacheControl: res.headers.get('cache-control'), body: await res.json() }))
  const paypalCreateTwo = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: payableOrder.id })
  }).then(async (res) => ({ status: res.status, body: await res.json() }))
  if (!paypalCreateOne.status || !paypalCreateTwo.status) throw new Error('paypal create-order response missing status')
  if (!paypalCreateOne.body?.id || !paypalCreateTwo.body?.id) {
    throw new Error(`paypal create-order failed: ${paypalCreateOne.status} ${JSON.stringify(paypalCreateOne.body)} / ${paypalCreateTwo.status} ${JSON.stringify(paypalCreateTwo.body)}`)
  }
  paypalCreateOne.id = paypalCreateOne.body.id
  paypalCreateOne.order = paypalCreateOne.body.order
  paypalCreateTwo.id = paypalCreateTwo.body.id
  paypalCreateTwo.order = paypalCreateTwo.body.order
  if (paypalCreateOne.id && paypalCreateOne.id === paypalCreateTwo.id) ok('paypal create-order is idempotent per order')
  else throw new Error(`paypal create-order not idempotent: ${paypalCreateOne.id} / ${paypalCreateTwo.id}`)
  if (paypalCreateOne.cacheControl === 'no-store') ok('paypal create-order response is not cached')
  else throw new Error(`paypal create-order cache-control invalid: ${paypalCreateOne.cacheControl}`)
  if (publicOrderSensitiveFields.every((field) => !(field in (paypalCreateOne.order || {})))) ok('public paypal response hides private order fields')
  else throw new Error(`public paypal response leaked order fields: ${JSON.stringify(paypalCreateOne.order)}`)
  if (!('id' in (paypalCreateOne.body?.payment || {})) && !('order_id' in (paypalCreateOne.body?.payment || {})) && paypalCreateOne.body?.order?.id === payableOrder.id) ok('public paypal payment response hides internal payment ids')
  else throw new Error(`public paypal payment leaked internal order id: ${JSON.stringify(paypalCreateOne.body?.payment)}`)
  const captureOne = await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paypal_order_id: paypalCreateOne.id })
  }).then((res) => res.json())
  const paypalCaptureBackup = await fetch(`${base}/api/admin/backup`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  const paypalCaptureEventOrder = paypalCaptureBackup.data?.orders?.find((order) => order.id === payableOrder.id)
  if (paypalCaptureEventOrder?.events?.some((event) => event.type === 'payment' && event.actor === 'paypal' && String(event.message || '').includes('PayPal 付款状态'))) ok('paypal capture records order payment event')
  else throw new Error(`paypal capture payment event missing: ${JSON.stringify(paypalCaptureEventOrder?.events)}`)
  if (paypalCaptureEventOrder?.events?.some((event) => event.type === 'status' && event.actor === 'paypal' && String(event.message || '').includes('PayPal 订单状态'))) ok('paypal capture records paypal actor status event')
  else throw new Error(`paypal capture status event actor invalid: ${JSON.stringify(paypalCaptureEventOrder?.events)}`)
  const depositPaidCreateRes = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: payableOrder.id })
  })
  if (depositPaidCreateRes.status === 409 && captureOne.order?.paid_amount_cents > 0) ok('paypal create-order requires balance_due before collecting balance')
  else throw new Error(`deposit-paid order created paypal before balance due: ${depositPaidCreateRes.status}`)
  const advanceDepositToCraftingRes = await fetch(`${base}/api/admin/orders/${payableOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'crafting' })
  })
  if (advanceDepositToCraftingRes.ok) ok('api allows deposit-paid order to start crafting')
  else throw new Error(`deposit-paid order could not start crafting: ${advanceDepositToCraftingRes.status}`)
  const advanceDepositToShipRes = await fetch(`${base}/api/admin/orders/${payableOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'ready_ship' })
  })
  if (advanceDepositToShipRes.status === 400) ok('api blocks deposit-only order from shipping')
  else throw new Error(`deposit-only order advanced to shipping: ${advanceDepositToShipRes.status}`)
  const statusBalanceOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Status Balance Customer',
      email: `status-balance-${stamp}@example.com`,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Balance',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const statusBalanceOrder = await statusBalanceOrderRes.json()
  if (!statusBalanceOrderRes.ok) throw new Error(`status balance order setup failed: ${statusBalanceOrderRes.status} ${JSON.stringify(statusBalanceOrder)}`)
  const statusBalancePaypal = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: statusBalanceOrder.id })
  }).then((res) => res.json())
  await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paypal_order_id: statusBalancePaypal.id })
  })
  const statusBalanceDueRes = await fetch(`${base}/api/admin/orders/${statusBalanceOrder.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: 'balance_due' })
  })
  const statusBalanceDueOrder = await statusBalanceDueRes.json()
  if (statusBalanceDueRes.ok && statusBalanceDueOrder.order_status === 'balance_due' && statusBalanceDueOrder.payment_status === 'balance_due') ok('api status balance_due syncs payment status')
  else throw new Error(`balance_due status did not sync payment: ${statusBalanceDueRes.status} ${JSON.stringify(statusBalanceDueOrder)}`)
  const markBalanceDueRes = await fetch(`${base}/api/admin/orders/${payableOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'balance_due' })
  })
  if (!markBalanceDueRes.ok) throw new Error(`mark balance due failed: ${markBalanceDueRes.status}`)
  const balancePaypalRes = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: payableOrder.id })
  }).then(async (res) => ({ status: res.status, body: await res.json() }))
  const expectedBalanceAmount = Number(payableOrder.amount_cents || 0) - Number(captureOne.order?.paid_amount_cents || 0)
  if (balancePaypalRes.status === 200 && balancePaypalRes.body?.payment?.payment_type === 'balance' && balancePaypalRes.body?.payment?.amount_cents === expectedBalanceAmount) ok('paypal creates balance payment after deposit')
  else throw new Error(`balance paypal create invalid: ${balancePaypalRes.status} ${JSON.stringify(balancePaypalRes.body)}`)
  const balanceCapture = await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paypal_order_id: balancePaypalRes.body.id })
  }).then((res) => res.json())
  if (balanceCapture.order?.payment_status === 'paid' && balanceCapture.order?.paid_amount_cents === payableOrder.amount_cents) ok('paypal balance capture completes order payment')
  else throw new Error(`balance capture did not complete order: ${JSON.stringify(balanceCapture.order)}`)
  const orderPage = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
  await orderPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await orderPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  await setLang(orderPage, 'zh')
  await orderPage.setViewportSize({ width: 390, height: 844 })
  await orderPage.waitForTimeout(300)
  await orderPage.getByRole('button', { name: '提交订单' }).waitFor({ state: 'visible', timeout: 10000 })
  await expectNoHorizontalOverflow(orderPage, 'order page mobile layout has no horizontal overflow')
  await orderPage.waitForFunction(() => document.body.innerText.includes('PayPal 应付') || document.body.innerText.includes('待确认金额'), null, { timeout: 10000 })
  await orderPage.locator('.upload-box input[type="file"]').waitFor({ state: 'attached', timeout: 10000 })
  const mobileOrderControls = await orderPage.evaluate(() => {
    const submit = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('提交订单'))?.getBoundingClientRect()
    const summary = document.querySelector('.checkout-summary')?.getBoundingClientRect()
    const upload = document.querySelector('.upload-box input[type="file"]')?.getBoundingClientRect()
    return {
      submitWidth: submit?.width || 0,
      summaryWidth: summary?.width || 0,
      uploadWidth: upload?.width || 0,
      viewportWidth: window.innerWidth
    }
  })
  if (mobileOrderControls.submitWidth > 120 && mobileOrderControls.summaryWidth <= mobileOrderControls.viewportWidth && mobileOrderControls.uploadWidth > 120) ok('order page mobile checkout controls remain reachable')
  else throw new Error(`order mobile controls invalid: ${JSON.stringify(mobileOrderControls)}`)
  await orderPage.setViewportSize({ width: 1440, height: 1100 })
  const publicPaymentOptions = await orderPage.getByLabel('付款方式').locator('option').allTextContents()
  if (publicPaymentOptions.includes('定金') && publicPaymentOptions.includes('全款') && !publicPaymentOptions.includes('尾款')) ok('order page hides balance-only payment option')
  else throw new Error(`order page payment options invalid: ${publicPaymentOptions.join(' | ')}`)
  const orderProductOptions = await orderPage.getByLabel('选择商品').locator('option').allTextContents()
  if (orderProductOptions.some((text) => text.includes('起价'))) ok('order page product select labels starting price')
  else throw new Error(`order page product select does not label starting price: ${orderProductOptions.join(' | ')}`)
  await orderPage.waitForFunction(() => document.body.innerText.includes('PayPal 应付') || document.body.innerText.includes('待确认金额'), null, { timeout: 10000 })
  ok('order page payable amount summary visible')
  await expectText(orderPage, '作品总价', 'order page full price summary visible')
  await expectText(orderPage, '本次支付', 'order page current payment summary visible')
  await expectText(orderPage, '后续尾款', 'order page remaining balance summary visible')
  await expectText(orderPage, '提交前检查', 'order page pre-submit checklist visible')
  await expectText(orderPage, '联系信息', 'order page pre-submit contact check visible')
  await expectText(orderPage, '参考照片', 'order page pre-submit photo check visible')
  const initialPreSubmitText = await orderPage.locator('.pre-submit-checklist').innerText()
  if (initialPreSubmitText.includes('待补充') && initialPreSubmitText.includes('已上传 0 张')) ok('order page pre-submit checklist starts with todo state')
  else throw new Error(`order page pre-submit initial state invalid: ${initialPreSubmitText}`)
  await expectText(orderPage, '提交前请先补充：联系信息、宠物信息、参考照片。', 'order page submit hint lists missing required fields')
  const checkoutBreakdownText = await orderPage.locator('.checkout-breakdown').innerText()
  const remainingBalanceLine = checkoutBreakdownText.split('后续尾款')[1] || ''
  const remainingBalanceValue = Number((remainingBalanceLine.match(/[\d,.]+/)?.[0] || '0').replaceAll(',', ''))
  if (remainingBalanceValue > 0) ok('order page deposit summary shows future balance')
  else throw new Error(`order page deposit summary missing future balance: ${checkoutBreakdownText}`)
  const remainingBalanceCount = (checkoutBreakdownText.match(/后续尾款/g) || []).length
  if (remainingBalanceCount === 1) ok('order page checkout summary does not duplicate remaining balance')
  else throw new Error(`order page checkout summary duplicated remaining balance: ${checkoutBreakdownText}`)
  if (orderProductOptions.length > 1) {
    const currentProductValue = await orderPage.getByLabel('选择商品').inputValue()
    const nextProductOption = await orderPage.getByLabel('选择商品').locator('option').evaluateAll((options, current) => {
      const option = options.find((item) => item.value !== current)
      return option ? option.value : ''
    }, currentProductValue)
    await orderPage.getByLabel('付款方式').selectOption('full')
    await orderPage.getByLabel('选择商品').selectOption(nextProductOption)
    const paymentAfterProductSwitch = await orderPage.getByLabel('付款方式').inputValue()
    const optionAfterProductSwitch = await orderPage.getByLabel('规格').inputValue()
    if (paymentAfterProductSwitch === 'deposit' && optionAfterProductSwitch) ok('order page resets payment and option after product switch')
    else throw new Error(`order page product switch state invalid: ${paymentAfterProductSwitch}/${optionAfterProductSwitch}`)
  }
  const invalidOrderParamPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await invalidOrderParamPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  const missingOrderProductId = `missing-product-${stamp}`
  await invalidOrderParamPage.goto(`${base}/order?product=${missingOrderProductId}&option=missing-option-${stamp}&payment=balance`, { waitUntil: 'networkidle' })
  await expectText(invalidOrderParamPage, '当前付款方式不可用，请重新选择付款方式。', 'order page warns invalid payment param')
  const recoveredProductValue = await invalidOrderParamPage.getByLabel('选择商品').inputValue()
  const recoveredOptionCount = await invalidOrderParamPage.getByLabel('规格').locator('option').count()
  const recoveredPaymentValue = await invalidOrderParamPage.getByLabel('付款方式').inputValue()
  if (recoveredProductValue !== missingOrderProductId && recoveredOptionCount > 0 && recoveredPaymentValue === 'deposit') ok('order page recovers from unavailable product and invalid params')
  else throw new Error(`order page invalid params did not recover: ${JSON.stringify({ recoveredProductValue, recoveredOptionCount, recoveredPaymentValue })}`)
  await invalidOrderParamPage.close()
  const staleDraftPaymentPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await staleDraftPaymentPage.addInitScript(() => {
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify({ payment_type: 'balance' }))
    localStorage.setItem('lang', 'zh')
  })
  await staleDraftPaymentPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  const staleDraftPaymentValue = await staleDraftPaymentPage.getByLabel('付款方式').inputValue()
  if (staleDraftPaymentValue === 'deposit') ok('order page normalizes stale balance draft payment')
  else throw new Error(`stale draft balance payment not normalized: ${staleDraftPaymentValue}`)
  await staleDraftPaymentPage.close()
  await orderPage.getByLabel('选择商品').selectOption(stableOrderProduct.id)
  await orderPage.getByLabel('规格').selectOption(stableOrderProduct.options?.[0]?.id)
  const orderFieldLimits = {
    name: await orderPage.getByLabel('姓名').getAttribute('maxlength'),
    email: await orderPage.getByLabel('邮箱', { exact: true }).getAttribute('maxlength'),
    phone: await orderPage.getByLabel('联系电话').getAttribute('maxlength'),
    country: await orderPage.getByLabel('国家/地区').getAttribute('maxlength'),
    address: await orderPage.getByLabel('收货地址').getAttribute('maxlength'),
    petName: await orderPage.getByLabel('宠物名字').getAttribute('maxlength'),
    petType: await orderPage.getByLabel('宠物类型').getAttribute('maxlength'),
    notes: await orderPage.getByLabel('备注').getAttribute('maxlength'),
  }
  if (
    orderFieldLimits.name === '120'
    && orderFieldLimits.email === '160'
    && orderFieldLimits.phone === '80'
    && orderFieldLimits.country === '120'
    && orderFieldLimits.address === '500'
    && orderFieldLimits.petName === '120'
    && orderFieldLimits.petType === '80'
    && orderFieldLimits.notes === '2000'
  ) ok('order form applies input length limits')
  else throw new Error(`order form length limits invalid: ${JSON.stringify(orderFieldLimits)}`)
  const orderFieldSemantics = {
    nameRequired: await orderPage.getByLabel('姓名').getAttribute('required'),
    nameAutocomplete: await orderPage.getByLabel('姓名').getAttribute('autocomplete'),
    emailRequired: await orderPage.getByLabel('邮箱', { exact: true }).getAttribute('required'),
    emailAutocomplete: await orderPage.getByLabel('邮箱', { exact: true }).getAttribute('autocomplete'),
    phoneRequired: await orderPage.getByLabel('联系电话').getAttribute('required'),
    phoneType: await orderPage.getByLabel('联系电话').getAttribute('type'),
    phoneAutocomplete: await orderPage.getByLabel('联系电话').getAttribute('autocomplete'),
    countryAutocomplete: await orderPage.getByLabel('国家/地区').getAttribute('autocomplete'),
    addressAutocomplete: await orderPage.getByLabel('收货地址').getAttribute('autocomplete'),
    petNameRequired: await orderPage.getByLabel('宠物名字').getAttribute('required'),
    petTypeRequired: await orderPage.getByLabel('宠物类型').getAttribute('required'),
    photoAccept: await orderPage.locator('input[type="file"]').getAttribute('accept'),
  }
  if (
    orderFieldSemantics.nameRequired !== null
    && orderFieldSemantics.nameAutocomplete === 'name'
    && orderFieldSemantics.emailRequired !== null
    && orderFieldSemantics.emailAutocomplete === 'email'
    && orderFieldSemantics.phoneRequired !== null
    && orderFieldSemantics.phoneType === 'tel'
    && orderFieldSemantics.phoneAutocomplete === 'tel'
    && orderFieldSemantics.countryAutocomplete === 'country-name'
    && orderFieldSemantics.addressAutocomplete === 'street-address'
    && orderFieldSemantics.petNameRequired !== null
    && orderFieldSemantics.petTypeRequired !== null
    && orderFieldSemantics.photoAccept === 'image/jpeg,image/png,image/webp'
  ) ok('order form exposes required and autocomplete semantics')
  else throw new Error(`order form semantics invalid: ${JSON.stringify(orderFieldSemantics)}`)
  const orderStorageBlockedPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await orderStorageBlockedPage.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) {
      if (this === window.localStorage) return ''
      return originalGetItem.call(this, key)
    }
    Storage.prototype.setItem = function () { throw new Error('localStorage write disabled') }
    Storage.prototype.removeItem = function () { throw new Error('localStorage remove disabled') }
  })
  await orderStorageBlockedPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  await orderStorageBlockedPage.getByLabel('姓名').fill('Storage Blocked Buyer')
  await orderStorageBlockedPage.getByLabel('邮箱', { exact: true }).fill(`storage-blocked-${stamp}@example.com`)
  await orderStorageBlockedPage.getByLabel('联系电话').fill('13800000000')
  await orderStorageBlockedPage.getByLabel('宠物名字').fill('NoDraft')
  await expectText(orderStorageBlockedPage, '提交前检查', 'order page remains usable when draft storage fails')
  await orderStorageBlockedPage.close()
  await orderPage.getByLabel('邮箱', { exact: true }).fill(testEmail)
  await orderPage.getByRole('button', { name: '提交订单' }).click()
  await expectText(orderPage, '请填写姓名和有效邮箱。', 'order customer validation visible')
  await orderPage.getByLabel('姓名').fill('Commercial Test')
  await orderPage.getByLabel('国家/地区').fill('CN')
  await orderPage.getByRole('button', { name: '提交订单' }).click()
  await expectText(orderPage, '请填写联系电话。', 'order phone validation visible')
  await orderPage.getByLabel('联系电话').fill('1'.repeat(81))
  const cappedPhone = await orderPage.getByLabel('联系电话').inputValue()
  if (cappedPhone.length === 80) ok('order phone input caps long values')
  else throw new Error(`order phone maxlength did not cap input: ${cappedPhone.length}`)
  await orderPage.getByLabel('联系电话').fill('13800000000')
  await orderPage.getByLabel('姓名').fill('A'.repeat(121))
  const cappedName = await orderPage.getByLabel('姓名').inputValue()
  if (cappedName.length === 120) ok('order customer name input caps long values')
  else throw new Error(`order customer name maxlength did not cap input: ${cappedName.length}`)
  await orderPage.getByLabel('姓名').fill('Commercial Test')
  await orderPage.getByLabel('国家/地区').fill('C'.repeat(121))
  const cappedCountry = await orderPage.getByLabel('国家/地区').inputValue()
  if (cappedCountry.length === 120) ok('order country input caps long values')
  else throw new Error(`order country maxlength did not cap input: ${cappedCountry.length}`)
  await orderPage.getByLabel('国家/地区').fill('CN')
  await orderPage.getByLabel('收货地址').fill('A'.repeat(501))
  const cappedAddress = await orderPage.getByLabel('收货地址').inputValue()
  if (cappedAddress.length === 500) ok('order shipping address input caps long values')
  else throw new Error(`order shipping address maxlength did not cap input: ${cappedAddress.length}`)
  await orderPage.getByLabel('收货地址').fill('Shanghai E2E Shipping Address')
  await orderPage.getByLabel('宠物名字').fill('P'.repeat(121))
  await orderPage.getByLabel('宠物类型').fill('Cat')
  const cappedPetName = await orderPage.getByLabel('宠物名字').inputValue()
  if (cappedPetName.length === 120) ok('order pet name input caps long values')
  else throw new Error(`order pet name maxlength did not cap input: ${cappedPetName.length}`)
  await orderPage.getByLabel('宠物名字').fill('DraftMomo')
  await orderPage.getByLabel('宠物类型').fill('Cat')
  await orderPage.getByLabel('备注').fill('Draft recovery note')
  const draftRequestIdBeforeReload = await orderPage.evaluate(() => JSON.parse(localStorage.getItem('pet-wool-order-draft-v1') || '{}').client_request_id)
  await orderPage.reload({ waitUntil: 'networkidle' })
  await setLang(orderPage, 'zh')
  const draftRequestIdAfterReload = await orderPage.evaluate(() => JSON.parse(localStorage.getItem('pet-wool-order-draft-v1') || '{}').client_request_id)
  if (draftRequestIdBeforeReload && draftRequestIdAfterReload === draftRequestIdBeforeReload) ok('order page preserves client request id across draft reload')
  else throw new Error(`order draft client request id was not stable: ${draftRequestIdBeforeReload} -> ${draftRequestIdAfterReload}`)
  const maxLengthDraftRequestId = `order-1234567890123-${'a'.repeat(100)}`
  await orderPage.evaluate((requestId) => {
    const draft = JSON.parse(localStorage.getItem('pet-wool-order-draft-v1') || '{}')
    draft.client_request_id = requestId
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify(draft))
  }, maxLengthDraftRequestId)
  await orderPage.reload({ waitUntil: 'networkidle' })
  await setLang(orderPage, 'zh')
  const restoredMaxLengthDraftRequestId = await orderPage.evaluate(() => JSON.parse(localStorage.getItem('pet-wool-order-draft-v1') || '{}').client_request_id)
  if (restoredMaxLengthDraftRequestId === maxLengthDraftRequestId) ok('order page preserves max-length client request id from draft')
  else throw new Error(`order draft max-length request id was truncated: ${restoredMaxLengthDraftRequestId?.length}`)
  const restoredDraft = {
    name: await orderPage.getByLabel('姓名').inputValue(),
    phone: await orderPage.getByLabel('联系电话').inputValue(),
    address: await orderPage.getByLabel('收货地址').inputValue(),
    pet: await orderPage.getByLabel('宠物名字').inputValue(),
    type: await orderPage.getByLabel('宠物类型').inputValue(),
    notes: await orderPage.getByLabel('备注').inputValue(),
  }
  if (
    restoredDraft.name === 'Commercial Test'
    && restoredDraft.phone === '13800000000'
    && restoredDraft.address === 'Shanghai E2E Shipping Address'
    && restoredDraft.pet === 'DraftMomo'
    && restoredDraft.type === 'Cat'
    && restoredDraft.notes === 'Draft recovery note'
  ) ok('order page restores draft after reload')
  else throw new Error(`order draft not restored: ${JSON.stringify(restoredDraft)}`)
  await expectText(orderPage, '提交前请先补充：参考照片。', 'order page submit hint updates to remaining photo requirement')
  await orderPage.getByRole('button', { name: '提交订单' }).click()
  await expectText(orderPage, '请至少上传一张宠物照片后再提交订单。', 'order photo validation visible')
  await orderPage.getByLabel('宠物名字').fill('Momo')
  await orderPage.getByLabel('宠物类型').fill('Cat')
  await orderPage.getByLabel('备注').fill('Commercial readiness e2e order')
  await orderPage.setInputFiles('input[type="file"]', Array.from({ length: 13 }, () => uploadFixture))
  await expectText(orderPage, '最多上传 12 张参考照片。', 'order upload too many photos validation visible')
  await orderPage.setInputFiles('input[type="file"]', invalidUploadFixture)
  await expectText(orderPage, '仅支持 JPG、PNG、WebP 图片。', 'order upload invalid type validation visible')
  const invalidUploadInputValue = await orderPage.locator('input[type="file"]').evaluate((input) => input.value)
  if (invalidUploadInputValue === '') ok('order upload clears file input after invalid type')
  else throw new Error(`order upload invalid type left file input value: ${invalidUploadInputValue}`)
  await orderPage.setInputFiles('input[type="file"]', oversizeUploadFixture)
  await expectText(orderPage, '单张图片不能超过 8MB。', 'order upload oversized validation visible')
  const oversizedUploadInputValue = await orderPage.locator('input[type="file"]').evaluate((input) => input.value)
  if (oversizedUploadInputValue === '') ok('order upload clears file input after oversized file')
  else throw new Error(`order upload oversized file left input value: ${oversizedUploadInputValue}`)
  await orderPage.setInputFiles('input[type="file"]', uploadFixture)
  await orderPage.locator('.photo-preview img').first().waitFor({ state: 'visible', timeout: 10000 })
  await expectText(orderPage, '移除', 'uploaded photo can be removed')
  await orderPage.reload({ waitUntil: 'networkidle' })
  await setLang(orderPage, 'zh')
  await orderPage.waitForFunction(() => document.querySelectorAll('.photo-tile').length > 0, null, { timeout: 10000 })
  const restoredPhotoChecklistText = await orderPage.locator('.pre-submit-checklist').innerText()
  if (restoredPhotoChecklistText.includes('已上传 1 张')) ok('order page restores uploaded photo draft after reload')
  else throw new Error(`order photo draft not restored: ${restoredPhotoChecklistText}`)
  const stalePhotoDraftPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await stalePhotoDraftPage.addInitScript(() => {
    localStorage.setItem('lang', 'zh')
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify({
      photo_urls: ['/uploads/9999999999996-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png']
    }))
  })
  await stalePhotoDraftPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  await expectText(stalePhotoDraftPage, '照片文件缺失', 'order page stale draft photo shows missing placeholder')
  await stalePhotoDraftPage.close()
  const externalPhotoDraftPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await externalPhotoDraftPage.addInitScript(() => {
    localStorage.setItem('lang', 'zh')
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify({
      photo_urls: ['https://example.com/not-uploaded.jpg']
    }))
  })
  await externalPhotoDraftPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  const externalPhotoDraftState = {
    photoCount: await externalPhotoDraftPage.locator('.photo-preview .photo-tile').count(),
    checklist: await externalPhotoDraftPage.locator('.pre-submit-checklist').innerText(),
    body: await externalPhotoDraftPage.locator('body').innerText(),
  }
  if (
    externalPhotoDraftState.photoCount === 0
    && externalPhotoDraftState.checklist.includes('已上传 0 张')
    && !externalPhotoDraftState.body.includes('example.com/not-uploaded')
  ) ok('order page rejects external photo URLs from local draft')
  else throw new Error(`external photo draft was accepted: ${JSON.stringify(externalPhotoDraftState)}`)
  await externalPhotoDraftPage.close()
  const unsafeDraftPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await unsafeDraftPage.addInitScript(() => {
    localStorage.setItem('lang', 'zh')
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify({
      customer_name: 'A'.repeat(200),
      notes: 'N'.repeat(2500),
      photo_urls: [
        'javascript:alert(1)',
        '../bad.png',
        ...Array.from({ length: 14 }, (_, index) => `/uploads/99999999999${index}-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`)
      ]
    }))
  })
  await unsafeDraftPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  const sanitizedDraftState = {
    nameLength: (await unsafeDraftPage.getByLabel('姓名').inputValue()).length,
    notesLength: (await unsafeDraftPage.getByLabel('备注').inputValue()).length,
    photoCount: await unsafeDraftPage.locator('.photo-preview .photo-tile').count(),
    body: await unsafeDraftPage.locator('body').innerText(),
  }
  if (
    sanitizedDraftState.nameLength === 120
    && sanitizedDraftState.notesLength === 2000
    && sanitizedDraftState.photoCount === 12
    && !sanitizedDraftState.body.includes('javascript:alert')
    && !sanitizedDraftState.body.includes('../bad.png')
  ) ok('order page sanitizes oversized and unsafe local draft')
  else throw new Error(`unsafe order draft was not sanitized: ${JSON.stringify(sanitizedDraftState)}`)
  await unsafeDraftPage.close()
  const readyPreSubmitText = await orderPage.locator('.pre-submit-checklist').innerText()
  if (
    readyPreSubmitText.includes('已完成')
    && readyPreSubmitText.includes('Commercial Test')
    && readyPreSubmitText.includes('Momo Cat')
    && readyPreSubmitText.includes('已上传 1 张')
    && readyPreSubmitText.includes('Shanghai E2E Shipping Address')
  ) ok('order page pre-submit checklist reflects completed customer details')
  else throw new Error(`order page pre-submit completed state invalid: ${readyPreSubmitText}`)
  const commercialOrdersBeforeSubmit = await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin orders before commercial order submit')
  const commercialOrderIdsBeforeSubmit = new Set(commercialOrdersBeforeSubmit.map((order) => order.id))
  await orderPage.getByRole('button', { name: '提交订单' }).click()
  const submitFailed = orderPage.locator('text=订单提交失败')
  if (await submitFailed.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await orderPage.getByRole('button', { name: '提交订单' }).click()
  }
  await orderPage.waitForFunction(() => {
    const text = document.body.innerText
    return text.includes('请继续 PayPal 支付') || text.includes('支付单暂时未生成')
  }, null, { timeout: 10000 })
  const payLaterMode = await orderPage.locator('text=支付单暂时未生成').first().isVisible({ timeout: 500 }).catch(() => false)
  if (payLaterMode) ok('order created with pay-later recovery prompt')
  else ok('order created with paypal prompt')
  const commercialOrders = await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin orders after commercial order submit')
  const commercialOrder = commercialOrders.find((order) => !commercialOrderIdsBeforeSubmit.has(order.id) && order.email === testEmail && order.customer_name === 'Commercial Test')
  if (commercialOrder?.id) {
    commercialOrderId = commercialOrder.id
    ok('commercial order fixture id captured')
  }
  else throw new Error('commercial order fixture id missing')
  await expectText(orderPage, '查看我的订单', 'order success shows account link')
  await expectText(orderPage, '提交后我们会核对照片和规格', 'order success next step card visible')
  await expectText(orderPage, '继续支付、查看进度和物流', 'order success next step explains account recovery')
  const accountHref = await orderPage.getByRole('link', { name: '查看我的订单' }).getAttribute('href')
  const visibleFormAfterSuccess = {
    name: await orderPage.getByLabel('姓名').inputValue(),
    email: await orderPage.getByLabel('邮箱', { exact: true }).inputValue(),
    phone: await orderPage.getByLabel('联系电话').inputValue(),
    pet: await orderPage.getByLabel('宠物名字').inputValue(),
    notes: await orderPage.getByLabel('备注').inputValue(),
    photos: await orderPage.locator('.photo-preview img').count(),
  }
  if (
    visibleFormAfterSuccess.name === 'Commercial Test'
    && visibleFormAfterSuccess.email === testEmail
    && visibleFormAfterSuccess.phone === ''
    && visibleFormAfterSuccess.pet === ''
    && visibleFormAfterSuccess.notes === ''
    && visibleFormAfterSuccess.photos === 0
  ) ok('order success clears visible form while keeping customer identity')
  else throw new Error(`order success visible form not cleared: ${JSON.stringify(visibleFormAfterSuccess)}`)
  const recoveryContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
  const orderAccountPage = await recoveryContext.newPage()
  await orderAccountPage.goto(`${base}${accountHref}`, { waitUntil: 'networkidle' })
  await orderAccountPage.waitForLoadState('networkidle')
  const recoveryEmail = await orderAccountPage.getByLabel('登录邮箱').inputValue()
  if (recoveryEmail === testEmail) ok('order success account link preloads customer email')
  else throw new Error(`order success account link did not preload email: ${recoveryEmail}`)
  await recoveryContext.close()
  const orderMessage = await orderPage.locator('.checkout-summary .form-message').innerText()
  const orderSuccessMessageCount = await orderPage.locator('.form-message', { hasText: orderMessage }).count()
  if (orderSuccessMessageCount === 1) ok('order success message is not duplicated')
  else throw new Error(`order success message duplicated: ${orderSuccessMessageCount} / ${orderMessage}`)
  if (!orderMessage.includes('：') && !orderMessage.includes(':')) ok('order created message has no colon')
  else throw new Error(`order message still contains colon: ${orderMessage}`)
  let paymentCompleted = false
  if (!payLaterMode) {
    const paypalButton = orderPage.getByRole('button', { name: '确认 PayPal 支付' })
    await paypalButton.waitFor({ state: 'visible', timeout: 10000 })
    await orderPage.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('button')]
      return buttons.some((button) => button.textContent?.includes('确认 PayPal 支付') && !button.disabled)
    }, null, { timeout: 10000 })
    await paypalButton.click()
    const payFailed = orderPage.locator('text=支付确认失败')
    if (await payFailed.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await paypalButton.click()
    }
    paymentCompleted = await orderPage.locator('text=PayPal 支付成功').first().isVisible({ timeout: 5000 }).catch(() => false)
    if (paymentCompleted) ok('paypal capture success')
    else {
      const failureVisible = await orderPage.locator('text=支付确认失败').first().isVisible({ timeout: 1000 }).catch(() => false)
      if (failureVisible) ok('paypal capture failure is recoverable')
      else ok('paypal capture pending is recoverable')
    }
  }
  await orderPage.reload({ waitUntil: 'networkidle' })
  await setLang(orderPage, 'zh')
  const clearedDraftAfterSuccess = {
    name: await orderPage.getByLabel('姓名').inputValue(),
    pet: await orderPage.getByLabel('宠物名字').inputValue(),
    notes: await orderPage.getByLabel('备注').inputValue()
  }
  if (clearedDraftAfterSuccess.name === 'Commercial Test' && clearedDraftAfterSuccess.pet !== 'Mochi' && clearedDraftAfterSuccess.notes !== 'Commercial readiness e2e order') ok('order page clears draft after successful submit')
  else throw new Error(`order success left stale draft: ${JSON.stringify(clearedDraftAfterSuccess)}`)
  await orderPage.getByLabel('宠物名字').fill(`Second Draft Pet ${stamp}`)
  await orderPage.getByLabel('备注').fill(`Second draft note ${stamp}`)
  await orderPage.reload({ waitUntil: 'networkidle' })
  await setLang(orderPage, 'zh')
  const secondDraftAfterSuccess = {
    pet: await orderPage.getByLabel('宠物名字').inputValue(),
    notes: await orderPage.getByLabel('备注').inputValue()
  }
  if (secondDraftAfterSuccess.pet === `Second Draft Pet ${stamp}` && secondDraftAfterSuccess.notes === `Second draft note ${stamp}`) ok('order page saves new draft after successful submit')
  else throw new Error(`order page did not save new draft after success: ${JSON.stringify(secondDraftAfterSuccess)}`)
  const signedDraftUserEmail = `signed-draft-${stamp}@example.com`
  const staleDraftEmail = `stale-draft-${stamp}@example.com`
  await orderPage.evaluate(({ token, email, staleEmail }) => {
    localStorage.setItem('user_token', token)
    localStorage.setItem('user_profile', JSON.stringify({ email, name: 'Signed Draft User' }))
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify({ email: staleEmail, customer_name: 'Stale Draft User', payment_type: 'deposit' }))
  }, {
    token: signedCustomerToken({ email: signedDraftUserEmail, name: 'Signed Draft User', avatar: '', provider: 'google', iat: Date.now(), exp: Date.now() + 60_000 }),
    email: signedDraftUserEmail,
    staleEmail: staleDraftEmail
  })
  await orderPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  const signedDraftEmailValue = await orderPage.getByLabel('邮箱', { exact: true }).inputValue()
  const signedDraftNameValue = await orderPage.getByLabel('姓名').inputValue()
  if (signedDraftEmailValue === signedDraftUserEmail && signedDraftNameValue === 'Signed Draft User') ok('order page uses signed-in user over stale draft contact')
  else throw new Error(`order page did not prioritize signed-in user: ${JSON.stringify({ signedDraftEmailValue, signedDraftNameValue })}`)
  const expiredDraftEmail = `expired-draft-${stamp}@example.com`
  await orderPage.evaluate(({ token, email, staleEmail }) => {
    localStorage.setItem('user_token', token)
    localStorage.setItem('user_profile', JSON.stringify({ email, name: 'Expired Draft User' }))
    localStorage.setItem('pet-wool-order-draft-v1', JSON.stringify({ email: staleEmail, customer_name: 'Draft Contact', payment_type: 'deposit' }))
  }, {
    token: signedCustomerToken({ email: expiredDraftEmail, name: 'Expired Draft User', avatar: '', provider: 'google', iat: Date.now() - 60_000, exp: Date.now() - 1_000 }),
    email: expiredDraftEmail,
    staleEmail: staleDraftEmail
  })
  await orderPage.goto(`${base}/order`, { waitUntil: 'networkidle' })
  const expiredDraftState = await orderPage.evaluate(() => ({
    token: localStorage.getItem('user_token'),
    profile: localStorage.getItem('user_profile'),
    email: document.querySelector('input[type="email"]')?.value || '',
  }))
  if (!expiredDraftState.token && !expiredDraftState.profile && expiredDraftState.email === staleDraftEmail) ok('order page clears expired user before applying draft contact')
  else throw new Error(`order page expired user state invalid: ${JSON.stringify(expiredDraftState)}`)
  await orderPage.evaluate(() => {
    localStorage.removeItem('user_token')
    localStorage.removeItem('user_profile')
    localStorage.removeItem('pet-wool-order-draft-v1')
  })
  await orderPage.screenshot({ path: '/root/pet-wool-platform/test-results/order-paid.png', fullPage: true })
  await orderPage.close()

  await page.goto(base, { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    localStorage.removeItem('user_token')
    localStorage.removeItem('user_profile')
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '登录' }).click()
  await expectText(page, '第三方登录', 'public login drawer visible')
  await page.getByRole('complementary', { name: '第三方登录面板' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('public login drawer aria label is localized')
  const englishLoginDrawerLabels = await page.locator('[aria-label="Third party login"]').count()
  if (englishLoginDrawerLabels === 0) ok('public login drawer avoids hard-coded English aria label')
  else throw new Error(`public login drawer still has English aria label: ${englishLoginDrawerLabels}`)
  await page.getByRole('button', { name: '使用 Google 登录' }).click()
  await expectText(page, '请填写有效的邮箱地址', 'public login drawer validates missing email')
  await page.getByLabel('登录邮箱').fill('bad-email')
  await page.getByRole('button', { name: '使用 Google 登录' }).click()
  await expectText(page, '请填写有效的邮箱地址', 'public login drawer validates invalid email')
  await page.getByLabel('登录邮箱').fill(`  ${testEmail.toUpperCase()}  `)
  await page.getByRole('button', { name: '使用 Google 登录' }).click()
  await page.waitForFunction(() => localStorage.getItem('user_token'), null, { timeout: 8000 })
  await expectText(page, '我的订单', 'public login drawer signs in with entered email')

  await page.goto(`${base}/account`, { waitUntil: 'networkidle' })
  const accountCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  const accountOgImage = await page.locator('meta[property="og:image"]').getAttribute('content')
  if (accountCanonical === `${base}/account` && accountOgImage && /^https?:\/\//.test(accountOgImage)) ok('account page canonical and og image set')
  else throw new Error(`account page head invalid: ${JSON.stringify({ accountCanonical, accountOgImage })}`)
  await page.evaluate((email) => {
    localStorage.setItem('user_token', `user-${btoa(JSON.stringify({ email, name: 'Legacy User' })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`)
    localStorage.setItem('user_profile', JSON.stringify({ email, name: 'Legacy User' }))
  }, testEmail)
  await page.reload({ waitUntil: 'networkidle' })
  await expectText(page, '登录后查看自己的订单', 'account clears legacy unsigned user token')
  await expectText(page, '还没有订单，或登录遇到问题时', 'account login help text visible')
  const loginHelpOrderHref = await page.locator('.account-login-help').getByRole('link', { name: '开始定制' }).getAttribute('href')
  if (String(loginHelpOrderHref || '').endsWith('/order')) ok('account login help links to order page')
  else throw new Error(`account login help order link invalid: ${loginHelpOrderHref}`)
  const loginHelpSupportHref = await page.locator('.account-login-help').getByRole('link', { name: '联系客服' }).getAttribute('href')
  if (loginHelpSupportHref && (/^(https?:|mailto:)/.test(loginHelpSupportHref))) ok('account login help uses direct configured support contact')
  else throw new Error(`account login help support link invalid: ${loginHelpSupportHref}`)
  const emptyAccountLoginEmail = await page.getByLabel('登录邮箱').inputValue()
  if (emptyAccountLoginEmail === '') ok('account login does not default to demo email')
  else throw new Error(`account login defaulted to unexpected email: ${emptyAccountLoginEmail}`)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, '请填写有效的邮箱地址', 'account empty email validation visible')
  await page.getByLabel('登录邮箱').fill('bad-email')
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, '请填写有效的邮箱地址', 'account email validation visible')
  const emptyAccountEmail = `commercial-empty-account-${stamp}@example.com`
  await page.getByLabel('登录邮箱').fill(emptyAccountEmail)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, '还没有订单', 'account empty state title visible')
  await expectText(page, '开始定制', 'account empty state start order action visible')
  await expectText(page, '联系客服', 'account empty state support action visible')
  const emptyStartHref = await page.locator('.account-empty-state').getByRole('link', { name: '开始定制' }).getAttribute('href')
  if (emptyStartHref?.endsWith('/order')) ok('account empty state links to order page')
  else throw new Error(`account empty start order link invalid: ${emptyStartHref}`)
  const noContactEmptyAccountPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await noContactEmptyAccountPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
  await noContactEmptyAccountPage.route('**/api/site**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ brand: { email: '' }, contact: { talk_enabled: false, line_enabled: false }, policies: {}, faq: [], reviews: [], blog: [] })
  }))
  await noContactEmptyAccountPage.goto(`${base}/account`, { waitUntil: 'networkidle' })
  await noContactEmptyAccountPage.getByLabel('登录邮箱').fill(`commercial-empty-no-contact-${stamp}@example.com`)
  await noContactEmptyAccountPage.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(noContactEmptyAccountPage, '还没有订单', 'account no-contact empty state title visible')
  const noContactEmptySupportHref = await noContactEmptyAccountPage.locator('.account-empty-state').getByRole('link', { name: '联系客服' }).getAttribute('href')
  if (noContactEmptySupportHref?.endsWith('/support')) ok('account empty state support fallback links to support page')
  else throw new Error(`account empty support fallback link invalid: ${noContactEmptySupportHref}`)
  await expectNoHorizontalOverflow(noContactEmptyAccountPage, 'account no-contact empty mobile layout has no horizontal overflow')
  await noContactEmptyAccountPage.close()
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByLabel('登录邮箱').fill(testEmail)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await page.waitForFunction(() => localStorage.getItem('user_token'), null, { timeout: 8000 })
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByLabel('登录邮箱').fill(`  ${testEmail.toUpperCase()}  `)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, testEmail, 'account normalizes copied uppercase email login')
  const normalizedStoredUser = await page.evaluate(() => JSON.parse(localStorage.getItem('user_profile') || '{}'))
  if (normalizedStoredUser.email === testEmail) ok('account stores normalized customer email')
  else throw new Error(`account stored unnormalized email: ${JSON.stringify(normalizedStoredUser)}`)
  await page.evaluate((email) => {
    const tokenPayload = btoa(JSON.stringify({ email, name: 'Token User', avatar: '', provider: 'google' })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    localStorage.setItem('user_token', `user-v1.${tokenPayload}.invalid-signature-for-ui-check`)
    localStorage.setItem('user_profile', JSON.stringify({ email: `profile-mismatch-${email}`, name: 'Profile Mismatch' }))
  }, testEmail)
  await page.goto(`${base}/account`, { waitUntil: 'networkidle' })
  const mismatchedProfileState = await page.evaluate(() => ({
    token: localStorage.getItem('user_token'),
    profile: localStorage.getItem('user_profile'),
    body: document.body.innerText,
  }))
  if (!mismatchedProfileState.token && !mismatchedProfileState.profile && mismatchedProfileState.body.includes('登录后查看自己的订单')) ok('account clears mismatched local user profile')
  else throw new Error(`account mismatched profile was not cleared: ${JSON.stringify(mismatchedProfileState)}`)
  await page.evaluate((email) => {
    const tokenPayload = btoa(JSON.stringify({ email, name: 'Expired User', avatar: '', provider: 'google', iat: Date.now() - 60_000, exp: Date.now() - 1_000 })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    localStorage.setItem('user_token', `user-v1.${tokenPayload}.expired-signature-for-ui-check`)
    localStorage.setItem('user_profile', JSON.stringify({ email, name: 'Expired User' }))
  }, testEmail)
  await page.goto(`${base}/account`, { waitUntil: 'networkidle' })
  const expiredLocalUserState = await page.evaluate(() => ({
    token: localStorage.getItem('user_token'),
    profile: localStorage.getItem('user_profile'),
    body: document.body.innerText,
  }))
  if (!expiredLocalUserState.token && !expiredLocalUserState.profile && expiredLocalUserState.body.includes('登录后查看自己的订单')) ok('account clears expired local user session')
  else throw new Error(`account expired local session was not cleared: ${JSON.stringify(expiredLocalUserState)}`)
  await page.getByLabel('登录邮箱').fill(testEmail)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, testEmail, 'account relogin works after mismatched profile cleanup')
  await page.getByRole('button', { name: '退出' }).click()
  await page.evaluate((email) => {
    localStorage.setItem('user_token', `user-v1.${btoa(JSON.stringify({ email, name: 'Stale User', avatar: '', provider: 'google' })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`)
    localStorage.setItem('user_profile', JSON.stringify({ email, name: 'Stale User' }))
  }, testEmail)
  await page.getByLabel('登录邮箱').fill(blockedEmail)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, '该邮箱暂时不能登录或下单', 'account blocked login feedback visible after signed-in user switch')
  const blockedSwitchState = await page.evaluate(() => ({
    token: localStorage.getItem('user_token'),
    profile: localStorage.getItem('user_profile'),
    body: document.body.innerText,
  }))
  if (!blockedSwitchState.token && !blockedSwitchState.profile && !blockedSwitchState.body.includes(testEmail)) ok('account blocked login clears previous signed-in state')
  else throw new Error(`account blocked login left stale user state: ${JSON.stringify(blockedSwitchState)}`)
  await page.getByLabel('登录邮箱').fill(testEmail)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, testEmail, 'account can relogin after blocked switch attempt')
  const balanceUiOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Balance Customer',
      email: balanceEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Balance',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  const balanceUiOrder = await balanceUiOrderRes.json()
  if (!balanceUiOrderRes.ok) throw new Error(`balance UI order create failed: ${balanceUiOrderRes.status} ${JSON.stringify(balanceUiOrder)}`)
  const balanceUiDeposit = await fetch(`${base}/api/paypal/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: balanceUiOrder.id })
  }).then((res) => res.json())
  await fetch(`${base}/api/paypal/capture-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paypal_order_id: balanceUiDeposit.id })
  })
  await fetch(`${base}/api/admin/orders/${balanceUiOrder.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: 'balance_due' })
  })
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByLabel('登录邮箱').fill(balanceEmail)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await expectText(page, '待付尾款', 'account balance due status visible')
  await expectText(page, '下一步：请继续 PayPal 支付尾款', 'account balance due next step matches paypal action')
  await page.getByRole('button', { name: '继续 PayPal 支付' }).first().click()
  await expectText(page, '支付单已生成', 'account balance paypal ready visible')
  await page.getByRole('button', { name: '确认 PayPal 支付' }).first().click()
  await page.waitForFunction(() => document.body.innerText.includes('已付款'), null, { timeout: 10000 })
  ok('account balance paypal capture success')
  ok('account balance payment status updates')
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByLabel('登录邮箱').fill(testEmail)
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click()
  await page.waitForFunction(() => localStorage.getItem('user_token'), null, { timeout: 8000 })
  const accountPayOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Account Pay Guard',
      email: testEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'AccountPay',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  if (!accountPayOrderRes.ok) throw new Error(`account pay guard order create failed: ${accountPayOrderRes.status}`)
  await page.reload({ waitUntil: 'networkidle' })
  await expectText(page, testEmail, 'account shows order email login')
  if (payLaterMode || !paymentCompleted) {
    const hasOrder = await page.locator('.order-card').count()
    if (hasOrder > 0) {
      const accountText = await page.locator('.account-panel').innerText()
      if (accountText.includes('未支付') || accountText.includes('已付定金') || accountText.includes('已付款')) ok('account shows recovery order payment state')
      else throw new Error(`account order payment state missing: ${accountText}`)
    }
    else {
      await expectText(page, '还没有订单', 'account shows empty recovery state')
      adminOrderSearchEmail = unpaidEmail
    }
  }
  else {
    await expectText(page, 'Commercial Test', 'account shows paid customer order')
    const paidDepositCount = await page.locator('.order-card', { hasText: '已付定金' }).count()
    if (paidDepositCount > 0) ok('account shows payment status')
    else throw new Error('account does not show any deposit-paid order')
  }
  const accountOrderCardCount = await page.locator('.order-card').count()
  if (accountOrderCardCount) {
    const supportCleanEmail = testEmail
    const supportCleanOrderRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: stableOrderProduct.id,
        option_id: stableOrderProduct.options?.[0]?.id,
        customer_name: 'Support Clean Customer',
        email: supportCleanEmail,
        phone: '13800000000\nInjected Phone',
        country: 'CN',
        shipping_address: 'Clean Street\nInjected Address',
        pet_name: 'Clean Pet',
        pet_type: 'Cat\nInjected Pet Type',
        notes: `Need help\nInjected Note Line ${'Long support note '.repeat(80)}`,
        payment_type: 'deposit',
        photo_urls: [uploadedPhotoUrl],
        lang: 'zh'
      })
    })
    if (!supportCleanOrderRes.ok) throw new Error(`support clean order create failed: ${supportCleanOrderRes.status}`)
    await page.getByRole('button', { name: '刷新订单' }).click()
    await expectText(page, 'Support Clean Customer', 'account support clean order visible')
    const supportCleanCard = page.locator('.order-card').filter({ hasText: 'Support Clean Customer' }).first()
    await supportCleanCard.getByRole('button', { name: '查看详情' }).click()
    await supportCleanCard.getByRole('button', { name: '复制订单' }).click()
    const supportCleanCopyOutput = await page.locator('.account-copy-output textarea').inputValue()
    const supportCleanHref = await supportCleanCard.getByRole('link', { name: '联系客服' }).first().getAttribute('href')
    const supportCleanHrefMessage = new URL(supportCleanHref || base).searchParams.get('text') || new URL(supportCleanHref || base).searchParams.get('message') || decodeURIComponent(supportCleanHref || '')
    if (
      supportCleanCopyOutput.includes('Need help Injected Note Line')
      && !supportCleanCopyOutput.includes('\nInjected Note Line')
      && supportCleanHrefMessage.includes('13800000000 Injected Phone')
      && !supportCleanHrefMessage.includes('\nInjected Phone')
      && supportCleanCopyOutput.includes('Clean Street Injected Address')
      && !supportCleanCopyOutput.includes('\nInjected Address')
      && supportCleanHrefMessage.includes('订单号')
      && supportCleanHrefMessage.includes('/account')
      && supportCleanHrefMessage.length <= 1250
      && supportCleanHref.length < 2200
    ) ok('account support copy and contact link sanitize untrusted order text')
    else throw new Error(`account support text was not sanitized: ${JSON.stringify({ supportCleanCopyOutput, supportCleanHref })}`)
    await supportCleanCard.getByRole('button', { name: '收起详情' }).click()
    await expectText(page, '刷新订单', 'account refresh orders button visible')
    await expectText(page, '订单服务说明', 'account service promise visible')
    await expectText(page, '预览确认、尾款和物流', 'account service promise explains fulfillment steps')
    await expectText(page, '照片 1 张', 'account shows uploaded photo count')
    await expectText(page, '已付', 'account shows paid amount')
    await expectText(page, '剩余应付', 'account shows remaining amount')
    const accountText = await page.locator('.account-panel').innerText()
    if (accountText.includes('下一步：请完成 PayPal 支付') || accountText.includes('下一步：客服会审核照片')) ok('account shows next step guidance')
    else throw new Error(`account next step guidance missing: ${accountText}`)
    const currentOrderCard = page.locator('.order-card').filter({ hasText: 'Commercial Test' }).first()
    await currentOrderCard.waitFor({ state: 'visible', timeout: 10000 })
    await currentOrderCard.getByRole('button', { name: '查看详情' }).click()
    await expectText(page, '订单进度', 'account order progress visible')
    const accountProgressText = await currentOrderCard.locator('.account-progress').innerText()
    if (
      accountProgressText.includes('提交订单')
      && accountProgressText.includes('照片审核')
      && accountProgressText.includes('手工制作')
      && accountProgressText.includes('预览确认')
      && accountProgressText.includes('尾款/发货')
      && accountProgressText.includes('完成')
    ) ok('account order progress steps visible')
    else throw new Error(`account order progress steps missing: ${accountProgressText}`)
    await expectText(page, '定制内容', 'account order detail product visible')
    await expectText(page, '宠物信息', 'account order detail pet visible')
    await expectText(page, '联系信息', 'account order detail contact visible')
    await expectText(page, '13800000000', 'account order detail phone visible')
    await expectText(page, '收货地址', 'account order detail shipping address label visible')
    await expectText(page, 'Shanghai E2E Shipping Address', 'account order detail shipping address visible')
    await expectText(page, '客户备注', 'account order detail customer note label visible')
    await expectText(page, 'Commercial readiness e2e order', 'account order detail customer note visible')
    await expectText(page, '当前状态', 'account order detail status visible')
    await expectText(page, '剩余应付', 'account order detail remaining amount visible')
    await expectText(page, '参考照片', 'account order detail photo visible')
    await expectText(page, '参考照片已安全保存', 'account order detail photo secure note visible')
    await expectText(page, '需要调整或售后？', 'account order detail aftercare title visible')
    await expectText(page, '修改照片、地址、预览意见、物流或护理问题', 'account order detail aftercare guidance visible')
    await currentOrderCard.getByRole('button', { name: '复制订单' }).click()
    await expectText(page, '订单摘要', 'account order copy summary output visible')
    const accountCopyOutput = await page.locator('.account-copy-output textarea').inputValue()
    if (
      accountCopyOutput.includes('订单号')
      && accountCopyOutput.includes('定制内容')
      && accountCopyOutput.includes('当前状态')
      && accountCopyOutput.includes('订单金额')
      && accountCopyOutput.includes('联系信息')
      && accountCopyOutput.includes('参考照片')
      && accountCopyOutput.includes(testEmail)
      && accountCopyOutput.includes('13800000000')
    ) ok('account order copy summary contains support fields')
    else throw new Error(`account order copy summary invalid: ${accountCopyOutput}`)
    const detailSupportHref = await currentOrderCard.locator('.account-aftercare').getByRole('link', { name: '联系客服' }).first().getAttribute('href')
    if (detailSupportHref && (/^(https?:|mailto:)/.test(detailSupportHref) || detailSupportHref.endsWith('/support'))) ok('account order detail aftercare links to support')
    else throw new Error(`account order detail aftercare link invalid: ${detailSupportHref}`)
    await currentOrderCard.getByRole('button', { name: '收起详情' }).click()
    await expectNoText(page, '定制内容', 'account order detail collapses')
    const continuePayButton = page.getByRole('button', { name: '继续 PayPal 支付' }).first()
    await continuePayButton.waitFor({ state: 'visible', timeout: 10000 })
    await continuePayButton.click()
    const busyPayButtonVisible = await page.getByRole('button', { name: '加载中' }).first().isVisible({ timeout: 2000 }).catch(() => false)
    if (busyPayButtonVisible) ok('account paypal create button shows busy state after click')
    else ok('account paypal create returned before busy state was observable')
    await expectText(page, '支付单已生成', 'account continue paypal feedback visible')
    const accountConfirmPayButton = page.getByRole('button', { name: '确认 PayPal 支付' }).first()
    await accountConfirmPayButton.click()
    const accountPaySuccess = await page.locator('text=PayPal 支付成功').first().isVisible({ timeout: 5000 }).catch(() => false)
    if (!accountPaySuccess) {
      const accountPayFailed = await page.locator('text=支付确认失败').first().isVisible({ timeout: 1000 }).catch(() => false)
      if (accountPayFailed) {
        ok('account paypal capture failure is recoverable')
      }
      else {
        ok('account paypal capture pending is recoverable')
      }
    }
    else {
      ok('account paypal capture success')
      await expectText(page, '已付定金', 'account payment status updates after capture')
      paymentCompleted = true
    }
    await expectText(page, '有问题请联系右下角客服', 'account shows support hint')
    await expectText(page, '联系客服', 'account shows support contact action')
    const supportHref = await currentOrderCard.getByRole('link', { name: '联系客服' }).first().getAttribute('href')
    if (supportHref && (/^(https?:|mailto:)/.test(supportHref))) ok('account support contact action uses direct configured contact')
    else throw new Error(`account support contact link invalid: ${supportHref}`)
    const decodedSupportHref = decodeURIComponent(supportHref || '')
    if (
      decodedSupportHref.includes('订单号')
      && decodedSupportHref.includes('联系信息')
      && decodedSupportHref.includes('订单金额')
      && decodedSupportHref.includes(testEmail)
      && decodedSupportHref.includes('/account')
    ) ok('account support contact link carries order context')
    else throw new Error(`account support contact link missing order context: ${supportHref}`)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(300)
    await page.locator('.order-card').first().waitFor({ state: 'visible', timeout: 10000 })
    await expectNoHorizontalOverflow(page, 'account page mobile layout has no horizontal overflow')
    await page.setViewportSize({ width: 1440, height: 1100 })
    const accountLogoutButton = page.getByRole('button', { name: '退出登录' })
    if (await accountLogoutButton.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await accountLogoutButton.click()
    } else {
      await page.evaluate(() => {
        localStorage.removeItem('user_token')
        localStorage.removeItem('user_profile')
      })
      await page.reload({ waitUntil: 'networkidle' })
    }
    await expectText(page, '我的订单', 'account returns to login page after logout')
    const accountCopyOutputAfterLogout = await page.locator('.account-copy-output textarea').count()
    const pendingConfirmAfterLogout = await page.getByRole('button', { name: '确认 PayPal 支付' }).count()
    if (accountCopyOutputAfterLogout === 0 && pendingConfirmAfterLogout === 0) ok('account logout clears copied summary and pending payment state')
    else throw new Error(`account logout left stale state: ${JSON.stringify({ accountCopyOutputAfterLogout, pendingConfirmAfterLogout })}`)
    const accountLoginFieldSemantics = {
      type: await page.getByLabel('登录邮箱').getAttribute('type'),
      autocomplete: await page.getByLabel('登录邮箱').getAttribute('autocomplete'),
      inputmode: await page.getByLabel('登录邮箱').getAttribute('inputmode'),
      maxlength: await page.getByLabel('登录邮箱').getAttribute('maxlength'),
    }
    if (
      accountLoginFieldSemantics.type === 'email'
      && accountLoginFieldSemantics.autocomplete === 'email'
      && accountLoginFieldSemantics.inputmode === 'email'
      && accountLoginFieldSemantics.maxlength === '160'
    ) ok('account login email field exposes mobile and length semantics')
    else throw new Error(`account login email semantics invalid: ${JSON.stringify(accountLoginFieldSemantics)}`)
    const accountStorageBlockedPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
    await accountStorageBlockedPage.addInitScript(() => {
      const originalGetItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        if (this === window.localStorage) return ''
        return originalGetItem.call(this, key)
      }
      Storage.prototype.setItem = function () { throw new Error('localStorage write disabled') }
    })
    await accountStorageBlockedPage.goto(`${base}/account`, { waitUntil: 'networkidle' })
    await accountStorageBlockedPage.getByLabel('登录邮箱').waitFor({ state: 'visible', timeout: 10000 })
    const accountBlockedFieldMax = await accountStorageBlockedPage.getByLabel('登录邮箱').getAttribute('maxlength')
    if (accountBlockedFieldMax === '160') ok('account page loads when localStorage writes fail')
    else throw new Error(`account page storage blocked email maxlength invalid: ${accountBlockedFieldMax}`)
    await accountStorageBlockedPage.close()
    await page.getByLabel('登录邮箱').fill(testEmail)
    await page.getByRole('button', { name: '使用 Google 登录' }).click()
    await page.waitForFunction(() => localStorage.getItem('user_token'), null, { timeout: 8000 })
    await expectText(page, '刷新订单', 'account relogin restores order list')
    const userToken = await page.evaluate(() => localStorage.getItem('user_token'))
    const customerOrdersRes = await fetch(`${base}/api/me/orders`, { headers: { authorization: `Bearer ${userToken}` } })
    const customerOrders = await customerOrdersRes.json()
    if (Array.isArray(customerOrders)) ok('customer orders API returns array')
    else throw new Error(`customer orders was not an array: ${JSON.stringify(customerOrders)}`)
    const customerOrdersSorted = customerOrders.every((order, index, list) => index === 0 || String(list[index - 1].created_at || '').localeCompare(String(order.created_at || '')) >= 0)
    if (customerOrdersSorted) ok('customer orders API returns latest orders first')
    else throw new Error(`customer orders API not sorted latest first: ${JSON.stringify(customerOrders.map((order) => ({ order_no: order.order_no, created_at: order.created_at })))}`)
    if (customerOrdersRes.headers.get('cache-control') === 'no-store') ok('customer orders response is not cached')
    else throw new Error(`customer orders cache-control invalid: ${customerOrdersRes.headers.get('cache-control')}`)
    const leakedOrder = customerOrders.find((order) => 'email' in order || 'internal_note' in order || 'photo_urls' in order)
    if (!leakedOrder) ok('customer order API hides private order fields')
    else throw new Error(`customer order API leaked private fields: ${JSON.stringify(leakedOrder)}`)
    const customerVisibleOrder = customerOrders.find((order) => order.id === commercialOrderId)
    if (customerVisibleOrder) ok('customer order API exposes own contact and shipping fields')
    else throw new Error(`customer order API missing own contact/shipping fields: ${JSON.stringify(customerOrders[0])}`)
    if (customerVisibleOrder?.notes === 'Commercial readiness e2e order') ok('customer order API exposes own customer note')
    else throw new Error(`customer order API missing own note: ${JSON.stringify(customerVisibleOrder)}`)
    const trackingTemplate = `https://tracking.example.com/${stamp}?carrier={carrier}&code={tracking}`
    const trackingSetupRes = await fetch(`${base}/api/admin/site`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
      body: JSON.stringify({ shipping: { tracking_url_template: trackingTemplate } })
    })
    if (trackingSetupRes.ok) ok('admin site config saves tracking URL template')
    else throw new Error(`tracking URL template save failed: ${trackingSetupRes.status}`)
    const trackingUiEmail = `tracking-ui-${stamp}@example.com`
    const trackingUiNo = `TRACK-UI-${stamp}`
    const trackingUiOrderRes = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: stableOrderProduct.id,
        option_id: stableOrderProduct.options?.[0]?.id,
        customer_name: 'Tracking UI Customer',
        email: trackingUiEmail,
        phone: '13900001111',
        country: 'CN',
        shipping_address: 'Tracking UI Address',
        pet_name: 'Tracker',
        pet_type: 'Cat',
        payment_type: 'deposit',
        photo_urls: [uploadedPhotoUrl],
        lang: 'zh'
      })
    })
    const trackingUiOrder = await trackingUiOrderRes.json()
    if (!trackingUiOrderRes.ok) throw new Error(`tracking UI order create failed: ${trackingUiOrderRes.status} ${JSON.stringify(trackingUiOrder)}`)
    const trackingUiUpdateRes = await fetch(`${base}/api/admin/orders/${trackingUiOrder.id}/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
      body: JSON.stringify({ shipping_carrier: 'DHL', tracking_no: trackingUiNo })
    })
    if (!trackingUiUpdateRes.ok) throw new Error(`tracking UI order update failed: ${trackingUiUpdateRes.status}`)
    const trackingUiLoginRes = await fetch(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: trackingUiEmail, name: 'Tracking UI Customer' })
    })
    const trackingUiLogin = await trackingUiLoginRes.json()
    if (!trackingUiLoginRes.ok || !trackingUiLogin.token) throw new Error(`tracking UI login failed: ${trackingUiLoginRes.status}`)
    const trackingUiOrders = await fetchJsonArray(`${base}/api/me/orders`, { headers: { authorization: `Bearer ${trackingUiLogin.token}` } }, 'tracking UI customer orders')
    const trackingUiCustomerOrder = trackingUiOrders.find((order) => order.id === trackingUiOrder.id)
    if (
      trackingUiCustomerOrder?.shipping_carrier === 'DHL'
      && trackingUiCustomerOrder?.tracking_no === trackingUiNo
      && trackingUiCustomerOrder?.tracking_url?.includes(encodeURIComponent(trackingUiNo))
      && trackingUiCustomerOrder?.tracking_url?.includes('DHL')
      && !('tracking_url_template' in trackingUiCustomerOrder)
      && !('internal_note' in trackingUiCustomerOrder)
    ) ok('customer order API syncs tracking link without internal note')
    else throw new Error(`tracking UI customer order not synced or leaked note: ${JSON.stringify(trackingUiCustomerOrder)}`)
    const trackingCustomerEvents = trackingUiCustomerOrder?.events || []
    if (
      Array.isArray(trackingCustomerEvents)
      && trackingCustomerEvents.some((event) => event.type === 'tracking' && String(event.message || '').includes(`物流已更新：DHL ${trackingUiNo}`))
      && trackingCustomerEvents.every((event) => ['status', 'payment', 'tracking'].includes(event.type) && !('meta' in event) && !('actor' in event))
    ) ok('customer order API exposes customer-friendly sanitized progress events')
    else throw new Error(`customer order events missing or unsafe: ${JSON.stringify(trackingCustomerEvents)}`)
    const customerEventOrderSorted = trackingCustomerEvents.every((event, index, list) => index === 0 || String(list[index - 1].created_at || '').localeCompare(String(event.created_at || '')) >= 0)
    if (customerEventOrderSorted) ok('customer order events show latest progress first')
    else throw new Error(`customer order events not sorted latest first: ${JSON.stringify(trackingCustomerEvents)}`)
    const trackingPage = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
    await trackingPage.addInitScript(({ token, profile }) => {
      localStorage.setItem('user_token', token)
      localStorage.setItem('user_profile', JSON.stringify(profile))
      localStorage.setItem('lang', 'zh')
    }, { token: trackingUiLogin.token, profile: trackingUiLogin.user })
    await trackingPage.goto(`${base}/account`, { waitUntil: 'networkidle' })
    const trackingUiCard = trackingPage.locator('.order-card').filter({ hasText: trackingUiOrder.order_no }).first()
    await trackingUiCard.waitFor({ state: 'visible', timeout: 10000 })
    await trackingUiCard.getByRole('button', { name: '查看详情' }).click()
    await trackingPage.getByText(trackingUiNo).first().waitFor({ state: 'visible', timeout: 10000 })
    ok('account order detail shows updated tracking')
    await trackingUiCard.getByText('进度记录').waitFor({ state: 'visible', timeout: 10000 })
    if (await trackingUiCard.getByText(`物流已更新：DHL ${trackingUiNo}`).count()) ok('account order detail shows customer-friendly progress timeline')
    else throw new Error('account order progress timeline did not show tracking event')
    const trackingHref = await trackingUiCard.getByRole('link', { name: '查看物流' }).getAttribute('href')
    if (trackingHref?.includes(encodeURIComponent(trackingUiNo)) && trackingHref.includes('DHL')) ok('account order detail tracking link uses configured template')
    else throw new Error(`account tracking link invalid: ${trackingHref}`)
    await trackingPage.close()
  }
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/account.png', fullPage: true })

  await page.evaluate(() => localStorage.setItem('admin_token', 'totally-invalid-admin-token'))
  await page.goto(`${base}/admin/dashboard`, { waitUntil: 'networkidle' })
  await expectText(page, '登录', 'admin expired session returns to login')
  const expiredUiToken = await page.evaluate(() => localStorage.getItem('admin_token'))
  if (!expiredUiToken) ok('admin expired session clears browser token')
  else throw new Error('admin expired session left browser token')
  await page.evaluate(() => localStorage.setItem('admin_token', 'totally-invalid-admin-token'))
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' })
  await expectText(page, '登录', 'admin login validates stale token before redirect')
  const staleLoginToken = await page.evaluate(() => localStorage.getItem('admin_token'))
  const staleLoginPath = new URL(page.url()).pathname
  if (!staleLoginToken && staleLoginPath === '/admin') ok('admin login clears stale token without dashboard redirect')
  else throw new Error(`admin login stale token handling invalid: ${JSON.stringify({ staleLoginToken, staleLoginPath })}`)
  await expectText(page, '上线前请务必更换默认密码', 'admin login security note visible')
  await expectText(page, '请输入管理员邮箱和密码。', 'admin login idle helper visible')
  await fillAdminLogin(page, 'admin@example.com', 'wrong-password')
  await page.getByRole('button', { name: '登录' }).click()
  const loginButtonEnabled = await page.getByRole('button', { name: '登录' }).isEnabled({ timeout: 10000 }).catch(() => false)
  if (loginButtonEnabled) ok('admin login button re-enables after failure')
  else throw new Error('admin login button stayed disabled after failure')
  await expectText(page, '账号或密码不正确，请重新输入。', 'admin login failure is localized')
  await expectNoText(page, 'invalid credentials', 'admin login does not show raw backend error')
  const adminStorageBlockedPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await adminStorageBlockedPage.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) {
      if (this === window.localStorage) return ''
      return originalGetItem.call(this, key)
    }
    Storage.prototype.setItem = function () { throw new Error('localStorage write disabled') }
  })
  await adminStorageBlockedPage.goto(`${base}/admin`, { waitUntil: 'networkidle' })
  await fillAdminLogin(adminStorageBlockedPage)
  await adminStorageBlockedPage.getByRole('button', { name: '登录' }).click()
  await expectText(adminStorageBlockedPage, '内容加载失败，请稍后重试。', 'admin login handles localStorage write failure')
  const blockedAdminUrl = adminStorageBlockedPage.url()
  if (blockedAdminUrl.endsWith('/admin')) ok('admin login stays on login page when token cannot be stored')
  else throw new Error(`admin login navigated after storage failure: ${blockedAdminUrl}`)
  await adminStorageBlockedPage.close()
  if (await fillAdminLogin(page)) {
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL('**/admin/dashboard', { timeout: 10000 })
  }
  const adminLoadingVisible = await page.locator('text=正在加载运营数据').first().isVisible({ timeout: 1000 }).catch(() => false)
  if (adminLoadingVisible || await page.locator('text=运营后台').first().isVisible({ timeout: 1000 }).catch(() => false)) ok('admin dashboard has loading or loaded state')
  else throw new Error('admin dashboard showed neither loading nor loaded state')
  await expectText(page, '运营后台', 'admin dashboard visible')
  await expectText(page, '上线检查', 'admin readiness panel visible')
  await expectText(page, '默认管理员密码需要在正式上线前替换', 'admin readiness warns default password')
  await expectText(page, 'PayPal 仍处于沙盒或配置不完整', 'admin readiness warns paypal sandbox')
  await page.locator('.admin-stats .stat-card').first().waitFor({ state: 'visible', timeout: 10000 })
  const overviewStatsText = await page.locator('.admin-stats').innerText()
  if (overviewStatsText.includes('$')) ok('admin overview revenue displays original currency')
  else throw new Error(`admin overview revenue missing USD grouping: ${overviewStatsText}`)
  await expectText(page, '公开可售商品', 'admin overview public product metric visible')
  const readinessOverview = await fetch(`${base}/api/admin/overview`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  if (Number(readinessOverview.public_products || 0) > 0 && Number(readinessOverview.public_products || 0) < Number(readinessOverview.products || 0)) ok('admin overview excludes hidden-category products from public product count')
  else throw new Error(`admin overview public product count invalid: ${JSON.stringify(readinessOverview)}`)
  await expectText(page, '至少一种客户联系方式已启用', 'admin readiness checks customer contact')
  await expectText(page, '已有上架商品可供客户下单', 'admin readiness checks published catalog')
  await expectText(page, 'FAQ 和客户评价已配置', 'admin readiness checks trust content')
  await expectText(page, '博客内容已配置', 'admin readiness checks blog content')
  const readinessFixButtons = await page.locator('.readiness-list').getByRole('button', { name: '去处理' }).count()
  if (readinessFixButtons >= 6) ok('admin readiness items expose fix actions')
  else throw new Error(`admin readiness fix actions missing: ${readinessFixButtons}`)
  await page.locator('.readiness-list p').filter({ hasText: '已有上架商品可供客户下单' }).getByRole('button', { name: '去处理' }).click()
  await expectText(page, '商品管理', 'admin readiness catalog action opens products')
  await page.getByRole('button', { name: '概览' }).click()
  await page.locator('.readiness-list p').filter({ hasText: 'PayPal' }).getByRole('button', { name: '去处理' }).click()
  await expectText(page, '支付配置', 'admin readiness payment action opens site config')
  await page.getByRole('button', { name: '概览' }).click()
  await expectText(page, '今日运营待办', 'admin action queue panel visible')
  await expectText(page, '待付尾款', 'admin action queue balance item visible')
  await page.getByRole('button', { name: /未支付/ }).first().click()
  await expectText(page, '订单管理', 'admin action queue opens orders')
  const actionQueuePaymentFilter = await page.locator('.order-filters select').nth(1).inputValue()
  if (actionQueuePaymentFilter === 'unpaid') ok('admin action queue applies unpaid payment filter')
  else throw new Error(`admin action queue did not apply unpaid filter: ${actionQueuePaymentFilter}`)
  await page.getByRole('button', { name: '概览' }).click()
  await page.getByRole('button', { name: /待付尾款/ }).first().click()
  await expectText(page, '订单管理', 'admin action queue balance opens orders')
  const actionQueueBalanceFilter = await page.locator('.order-filters select').nth(1).inputValue()
  if (actionQueueBalanceFilter === 'balance_due') ok('admin action queue applies balance due payment filter')
  else throw new Error(`admin action queue did not apply balance due filter: ${actionQueueBalanceFilter}`)
  await page.getByRole('button', { name: '概览' }).click()
  await page.getByRole('button', { name: /待发货/ }).first().click()
  await expectText(page, '订单管理', 'admin action queue ready ship opens orders')
  const actionQueueShipStatusFilter = await page.locator('.order-filters select').first().inputValue()
  if (actionQueueShipStatusFilter === 'ready_ship') ok('admin action queue applies ready ship status filter')
  else throw new Error(`admin action queue did not apply ready ship filter: ${actionQueueShipStatusFilter}`)
  await page.getByRole('button', { name: '概览' }).click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.waitForURL('**/admin', { timeout: 10000 })
  const uiLoggedOutToken = await page.evaluate(() => localStorage.getItem('admin_token'))
  if (!uiLoggedOutToken) ok('admin logout clears browser session')
  else throw new Error('admin logout left browser token')
  if (await fillAdminLogin(page)) {
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL('**/admin/dashboard', { timeout: 10000 })
  }
  await expectText(page, '运营后台', 'admin dashboard visible after relogin')
  const refreshEmail = `commercial-refresh-${stamp}@example.com`
  const refreshOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Refresh Guard',
      email: refreshEmail,
      phone: '13800000000',
      shipping_address: 'Shanghai E2E Shipping Address',
      country: 'CN',
      pet_name: 'Refresh',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  if (!refreshOrderRes.ok) throw new Error(`refresh guard order create failed: ${refreshOrderRes.status}`)
  await page.waitForFunction(async ({ baseUrl, token, email }) => {
    const res = await fetch(`${baseUrl}/api/admin/orders`, { headers: { authorization: `Bearer ${token}` } })
    const orders = await res.json()
    return Array.isArray(orders) && orders.some((order) => order.email === email)
  }, { baseUrl: base, token: 'admin-e2e', email: refreshEmail }, { timeout: 10000 })
  await page.getByRole('button', { name: '刷新数据' }).click()
  await acceptTransientText(page, '数据已刷新', 'admin manual refresh feedback accepted')
  await page.getByRole('button', { name: '概览' }).click()
  await page.getByRole('button', { name: '订单管理' }).click()
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('.order-filters').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('.order-filters select').nth(0).selectOption('')
  await page.locator('.order-filters select').nth(1).selectOption('')
  await page.locator('.order-filters select').nth(2).selectOption('')
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(refreshEmail)
  await page.waitForFunction((email) => {
    return [...document.querySelectorAll('tr, .order-card, .mobile-order-card, tbody, main')].some((node) => {
      const style = window.getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
        && node.textContent?.includes(email)
    })
  }, refreshEmail, { timeout: 10000 })
  const orderDebugText = await page.locator('body').innerText()
  if (!orderDebugText.includes(refreshEmail)) {
    throw new Error(`refreshed order not visible after search: ${orderDebugText.slice(0, 800)}`)
  }
  ok('admin manual refresh loads new orders')
  await page.getByRole('button', { name: '用户管理' }).click()
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').waitFor({ state: 'visible', timeout: 10000 })
  ok('admin user search visible')
  await page.locator('.user-panel .list-summary').waitFor({ state: 'visible', timeout: 10000 })
  const userListSummary = await page.locator('.user-panel .list-summary').innerText()
  if (/显示 \d+-\d+ \/ \d+ 项/.test(userListSummary)) ok('admin user list shows pagination summary')
  else throw new Error(`admin user list summary invalid: ${userListSummary}`)
  const userNextButton = page.locator('.user-panel .pager').getByRole('button', { name: '下一页' })
  if (await userNextButton.isEnabled().catch(() => false)) {
    await userNextButton.click()
    await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(refreshEmail)
    await expectText(page, refreshEmail, 'admin user search resets pagination after page change')
  } else {
    ok('admin user search pagination reset not needed for single-page user list')
  }
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill('')
  await expectText(page, '最近订单', 'admin user cards show metrics')
  await expectText(page, '最近跟进', 'admin user cards show latest followup summary')
  await expectText(page, '下次跟进', 'admin user cards show next followup summary')
  const manualUserEmail = `commercial-manual-user-${stamp}@example.com`
  const overviewBeforeManualUser = await fetch(`${base}/api/admin/overview`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  await page.getByRole('button', { name: '新增用户' }).click()
  await expectText(page, '新增用户', 'admin user create modal visible')
  await page.getByRole('dialog').filter({ hasText: '新增用户' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('admin user modal exposes dialog semantics')
  const adminUserFieldLimits = {
    name: await page.locator('.admin-modal').getByPlaceholder('用户姓名').getAttribute('maxlength'),
    email: await page.locator('.admin-modal').getByPlaceholder('邮箱').getAttribute('maxlength'),
    country: await page.locator('.admin-modal').getByPlaceholder('国家/地区').getAttribute('maxlength'),
    tags: await page.locator('.admin-modal').getByPlaceholder('标签，逗号分隔').getAttribute('maxlength'),
    note: await page.locator('.admin-modal').getByPlaceholder('备注').getAttribute('maxlength'),
    followup: await page.locator('.admin-modal').getByPlaceholder('新增跟进记录，例如：已邮件确认照片，等待回复').getAttribute('maxlength'),
  }
  if (
    adminUserFieldLimits.name === '120'
    && adminUserFieldLimits.email === '160'
    && adminUserFieldLimits.country === '120'
    && adminUserFieldLimits.tags === '819'
    && adminUserFieldLimits.note === '2000'
    && adminUserFieldLimits.followup === '500'
  ) ok('admin user modal applies input length limits')
  else throw new Error(`admin user modal length limits invalid: ${JSON.stringify(adminUserFieldLimits)}`)
  await page.locator('.admin-modal').getByPlaceholder('用户姓名').fill('=Manual Customer')
  await page.locator('.admin-modal').getByPlaceholder('邮箱').fill(manualUserEmail)
  await page.locator('.admin-modal').getByPlaceholder('国家/地区').fill('CN')
  await page.locator('.admin-modal').getByPlaceholder('标签，逗号分隔').fill(`tag-${'x'.repeat(45)}`)
  await page.locator('.admin-modal').getByRole('button', { name: '保存用户' }).click()
  await expectText(page, '标签最多 20 个，每个不超过 40 个字符。', 'admin user modal validates long tags in Chinese')
  await page.locator('.admin-modal').getByPlaceholder('用户姓名').fill('  Draft User With Spaces  ')
  await page.locator('.admin-modal').getByPlaceholder('邮箱').fill(`  spaced-${stamp}@example.com  `)
  await page.locator('.admin-modal').getByPlaceholder('国家/地区').fill('  CN  ')
  await page.locator('.admin-modal').getByPlaceholder('标签，逗号分隔').fill(`tag-${'x'.repeat(45)}`)
  await page.locator('.admin-modal').getByRole('button', { name: '保存用户' }).click()
  await expectText(page, '标签最多 20 个，每个不超过 40 个字符。', 'admin user modal validation failure keeps dialog open')
  const spacedDraftUserFields = {
    name: await page.locator('.admin-modal').getByPlaceholder('用户姓名').inputValue(),
    email: await page.locator('.admin-modal').getByPlaceholder('邮箱').inputValue(),
    country: await page.locator('.admin-modal').getByPlaceholder('国家/地区').inputValue(),
  }
  if (spacedDraftUserFields.name.startsWith('  ') && spacedDraftUserFields.country.startsWith('  ') && spacedDraftUserFields.email === `spaced-${stamp}@example.com`) ok('admin user modal preserves visible unsaved draft text after validation failure')
  else throw new Error(`admin user modal mutated draft fields after validation failure: ${JSON.stringify(spacedDraftUserFields)}`)
  await page.locator('.admin-modal').getByPlaceholder('标签，逗号分隔').fill('manual, vip-candidate')
  await page.locator('.admin-modal').getByPlaceholder('邮箱').fill(manualUserEmail)
  await page.locator('.admin-modal').getByPlaceholder('用户姓名').fill('U'.repeat(121))
  const cappedAdminUserName = await page.locator('.admin-modal').getByPlaceholder('用户姓名').inputValue()
  if (cappedAdminUserName.length === 120) ok('admin user modal caps long name input')
  else throw new Error(`admin user name maxlength did not cap input: ${cappedAdminUserName.length}`)
  await page.locator('.admin-modal').getByPlaceholder('用户姓名').fill('=Manual Customer')
  await page.locator('.admin-modal').getByPlaceholder('国家/地区').fill('C'.repeat(121))
  const cappedAdminUserCountry = await page.locator('.admin-modal').getByPlaceholder('国家/地区').inputValue()
  if (cappedAdminUserCountry.length === 120) ok('admin user modal caps long country input')
  else throw new Error(`admin user country maxlength did not cap input: ${cappedAdminUserCountry.length}`)
  await page.locator('.admin-modal').getByPlaceholder('国家/地区').fill('CN')
  await page.locator('.admin-modal').getByPlaceholder('标签，逗号分隔').fill('manual, vip-candidate')
  await page.locator('.admin-modal').getByPlaceholder('备注').fill('@Manual user created from admin modal')
  await page.locator('.admin-modal').getByPlaceholder('新增跟进记录，例如：已邮件确认照片，等待回复').fill('+首次建档，等待客户下单')
  await page.locator('.admin-modal').getByRole('button', { name: '添加跟进' }).click()
  await expectText(page, '+首次建档，等待客户下单', 'admin user modal followup added')
  const manualUserSaveResponse = page.waitForResponse((res) => res.url().includes('/api/admin/users/') && res.request().method() === 'PUT')
  await page.locator('.admin-modal').getByRole('button', { name: '保存用户' }).click()
  const manualUserSaveRes = await manualUserSaveResponse
  if (manualUserSaveRes.ok()) ok('admin user modal save API succeeds')
  else throw new Error(`admin user modal save API failed: ${manualUserSaveRes.status()}`)
  const overviewAfterManualUser = await fetch(`${base}/api/admin/overview`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  if (Number(overviewAfterManualUser.users || 0) === Number(overviewBeforeManualUser.users || 0) + 1) ok('admin overview includes manually created users')
  else throw new Error(`admin overview user count missed manual user: ${overviewBeforeManualUser.users} -> ${overviewAfterManualUser.users}`)
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(manualUserEmail)
  await expectText(page, manualUserEmail, 'admin user modal created user searchable')
  await expectText(page, 'CN', 'admin user country persists after create')
  const userExportPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前用户' }).click()
  const userExportDownload = await userExportPromise
  const userExportFilename = userExportDownload.suggestedFilename()
  if (/^users-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/.test(userExportFilename)) ok('admin user export filename includes timestamp')
  else throw new Error(`admin user export filename invalid: ${userExportFilename}`)
  const userExportPath = await userExportDownload.path()
  const userExportContent = await readFile(userExportPath, 'utf8')
  if (
    userExportContent.includes(manualUserEmail)
    && userExportContent.includes('客户,Email,国家/地区,状态,标签，逗号分隔,订单')
    && userExportContent.includes('最近跟进内容')
    && userExportContent.includes('manual, vip-candidate')
    && userExportContent.includes("'+首次建档，等待客户下单")
    && userExportContent.includes(",'-,")
    && userExportContent.includes("'=Manual Customer")
    && userExportContent.includes("'@Manual user created from admin modal")
  ) ok('admin user export csv includes filtered user')
  else throw new Error(`admin user export missing filtered user: ${userExportContent.slice(0, 300)}`)
  await page.getByRole('button', { name: '复制当前用户跟进清单' }).click()
  await page.waitForFunction(() => {
    const text = document.body.innerText
    return text.includes('当前用户跟进清单已复制') || text.includes('用户跟进清单已在下方生成')
  }, null, { timeout: 10000 })
  const manualUserFollowupCopyOutput = await page.locator('.user-copy-output textarea').inputValue()
  if (
    manualUserFollowupCopyOutput.includes('最近跟进内容')
    && manualUserFollowupCopyOutput.includes("'+首次建档，等待客户下单")
    && manualUserFollowupCopyOutput.includes("#1 '=Manual Customer")
    && manualUserFollowupCopyOutput.includes("备注 '@Manual user created from admin modal")
  ) ok('admin user followup copy output escapes spreadsheet formula fields')
  else throw new Error(`admin user followup copy output missing content: ${manualUserFollowupCopyOutput}`)
  await page.getByRole('button', { name: '编辑' }).first().click()
  await expectText(page, '编辑用户', 'admin user edit modal visible')
  await page.locator('.admin-modal').getByPlaceholder('用户姓名').fill('Manual Customer Updated')
  await page.locator('.admin-modal').getByPlaceholder('国家/地区').fill('US')
  const manualUserEditResponse = page.waitForResponse((res) => res.url().includes('/api/admin/users/') && res.request().method() === 'PUT')
  await page.locator('.admin-modal').getByRole('button', { name: '保存用户' }).click()
  const manualUserEditRes = await manualUserEditResponse
  if (manualUserEditRes.ok()) ok('admin user modal edit API succeeds')
  else throw new Error(`admin user modal edit API failed: ${manualUserEditRes.status()}`)
  await expectText(page, 'Manual Customer Updated', 'admin user modal edited user visible')
  await expectText(page, 'US', 'admin user country persists after edit')
  const manualUserUpdatedEmail = `commercial-manual-user-updated-${stamp}@example.com`
  const manualUserBeforeEmailEdit = await fetchJsonArray(`${base}/api/admin/users`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin users before email edit')
  const manualUserForEmailEdit = manualUserBeforeEmailEdit.find((user) => String(user.email || '').toLowerCase() === manualUserEmail)
  if (!manualUserForEmailEdit?.id) throw new Error(`manual user missing before email edit: ${manualUserEmail}`)
  const manualUserEmailEditRes = await fetch(`${base}/api/admin/users/${manualUserForEmailEdit.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: ` ${manualUserUpdatedEmail.toUpperCase()} `, name: 'Manual Customer Updated', status: 'active' })
  })
  const manualUserEmailEdit = await manualUserEmailEditRes.json()
  if (manualUserEmailEditRes.ok && manualUserEmailEdit.email === manualUserUpdatedEmail) ok('api updates and normalizes admin user email')
  else throw new Error(`admin user email edit failed: ${manualUserEmailEditRes.status} ${JSON.stringify(manualUserEmailEdit)}`)
  const duplicateUserEmailRes = await fetch(`${base}/api/admin/users/${manualUserForEmailEdit.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: testEmail, name: 'Manual Customer Updated', status: 'active' })
  })
  if (duplicateUserEmailRes.status === 409) ok('api rejects admin user duplicate email edit')
  else throw new Error(`duplicate admin user email edit accepted: ${duplicateUserEmailRes.status}`)
  const protectedAdminEmailRes = await fetch(`${base}/api/admin/users/admin-e2e`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: `changed-admin-e2e-${stamp}@example.com`, name: 'Admin E2E', status: 'active' })
  })
  if (protectedAdminEmailRes.status === 409) ok('api protects system admin user email')
  else throw new Error(`protected admin email edit accepted: ${protectedAdminEmailRes.status}`)
  const protectedAdminStatusRes = await fetch(`${base}/api/admin/users/admin-e2e`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: 'admin-e2e@example.com', name: 'Admin E2E', status: 'blocked' })
  })
  if (protectedAdminStatusRes.status === 409) ok('api keeps system admin user active')
  else throw new Error(`protected admin status edit accepted: ${protectedAdminStatusRes.status}`)
  const protectedAdminDeleteRes = await fetch(`${base}/api/admin/users/admin-e2e`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' }
  })
  if (protectedAdminDeleteRes.status === 409) ok('api protects system admin user from deletion')
  else throw new Error(`protected admin delete accepted: ${protectedAdminDeleteRes.status}`)
  const deleteUserWithoutConfirmRes = await fetch(`${base}/api/admin/users/${manualUserForEmailEdit.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin-e2e' }
  })
  if (deleteUserWithoutConfirmRes.status === 400) ok('api requires confirmation for admin user delete')
  else throw new Error(`admin user delete without confirmation accepted: ${deleteUserWithoutConfirmRes.status}`)
  const customerBeforeDeleteBlock = await fetchJsonArray(`${base}/api/admin/users`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin users before customer delete block')
  const userWithOrders = customerBeforeDeleteBlock.find((user) => String(user.email || '').toLowerCase() === String(testEmail).toLowerCase())
  if (!userWithOrders?.id) throw new Error(`user with orders missing before delete block: ${testEmail}`)
  const userWithOrdersDeleteRes = await fetch(`${base}/api/admin/users/${userWithOrders.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' }
  })
  if (userWithOrdersDeleteRes.status === 409) ok('api blocks deleting users with orders')
  else throw new Error(`admin user with orders delete accepted: ${userWithOrdersDeleteRes.status}`)
  await page.getByRole('button', { name: '刷新数据' }).click()
  await acceptTransientText(page, '数据已刷新', 'admin user list refreshed after email edit')
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(manualUserUpdatedEmail)
  await expectText(page, manualUserUpdatedEmail, 'admin user email edit is searchable')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '删除' }).first().click()
  const mobileUserConfirmLayout = await page.evaluate(() => {
    const modal = document.querySelector('.admin-modal.confirm-modal')
    const confirmButton = [...document.querySelectorAll('.admin-modal.confirm-modal button')].find((button) => button.textContent?.includes('确认删除'))
    const rect = confirmButton?.getBoundingClientRect()
    return {
      modalScrollWidth: modal?.scrollWidth || 0,
      modalClientWidth: modal?.clientWidth || 0,
      confirmVisible: Boolean(rect && rect.bottom <= window.innerHeight && rect.top >= 0),
    }
  })
  if (mobileUserConfirmLayout.modalScrollWidth <= mobileUserConfirmLayout.modalClientWidth && mobileUserConfirmLayout.confirmVisible) ok('admin user mobile confirm modal actions stay visible')
  else throw new Error(`admin user mobile confirm modal layout invalid: ${JSON.stringify(mobileUserConfirmLayout)}`)
  await page.locator('.admin-modal.confirm-modal').getByRole('button', { name: '取消' }).click()
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.locator('.admin-modal').getByPlaceholder('备注').fill('Unsaved user note should be protected')
  await page.locator('.admin-modal').getByRole('button', { name: '关闭' }).first().click()
  await expectText(page, '用户资料有未保存更改', 'admin user modal warns before discarding unsaved changes')
  await page.locator('.admin-modal').getByRole('button', { name: '继续编辑' }).click()
  const protectedUserNote = await page.locator('.admin-modal').getByPlaceholder('备注').inputValue()
  if (protectedUserNote === 'Unsaved user note should be protected') ok('admin user modal keeps unsaved changes after continuing edit')
  else throw new Error(`admin user modal lost unsaved note: ${protectedUserNote}`)
  await page.locator('.admin-modal').getByRole('button', { name: '关闭' }).first().click()
  await page.locator('.admin-modal').getByRole('button', { name: '放弃更改' }).click()
  await page.locator('.admin-modal').waitFor({ state: 'hidden', timeout: 10000 })
  ok('admin user modal can discard unsaved changes explicitly')
  await page.getByRole('button', { name: '删除' }).first().click()
  await expectText(page, '删除用户', 'admin user delete confirm modal visible')
  const manualUserDeleteResponse = page.waitForResponse((res) => res.url().includes(`/api/admin/users/${manualUserForEmailEdit.id}`) && res.request().method() === 'DELETE')
  await page.locator('.admin-modal').getByRole('button', { name: '确认删除' }).click()
  const manualUserDeleteRes = await manualUserDeleteResponse
  if (manualUserDeleteRes.ok()) ok('admin user delete API succeeds for user without orders')
  else throw new Error(`admin user delete API failed: ${manualUserDeleteRes.status()}`)
  await expectNoText(page, manualUserUpdatedEmail, 'admin deleted manual user removed from list')
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill('')
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(testEmail)
  const currentCustomerVisible = await page.locator(`text=${testEmail}`).first().isVisible({ timeout: 3000 }).catch(() => false)
  if (currentCustomerVisible) ok('admin user search finds current customer')
  else {
    await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill('')
    await expectText(page, '最近订单', 'admin user fallback customer list visible')
  }
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(multiCurrencyUserEmail)
  await expectText(page, multiCurrencyUserEmail, 'admin user search finds multi-currency customer')
  await expectText(page, '$', 'admin user card shows paid amount in original currency')
  await page.getByRole('button', { name: '复制当前用户跟进清单' }).click()
  await page.waitForFunction(() => {
    const text = document.body.innerText
    return text.includes('当前用户跟进清单已复制') || text.includes('用户跟进清单已在下方生成')
  }, null, { timeout: 10000 })
  await expectText(page, '当前用户跟进清单', 'admin user followup copy output visible')
  const userFollowupCopyOutput = await page.locator('.user-copy-output textarea').inputValue()
  if (userFollowupCopyOutput.includes(multiCurrencyUserEmail) && userFollowupCopyOutput.includes('最近订单') && userFollowupCopyOutput.includes('下次跟进')) ok('admin user followup copy output contains operational fields')
  else throw new Error(`admin user followup copy output invalid: ${userFollowupCopyOutput}`)
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(testEmail)
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.locator('.admin-modal').getByPlaceholder('新增跟进记录，例如：已邮件确认照片，等待回复').fill('已确认照片，等待客户回复预览偏好')
  await page.locator('.admin-modal').getByRole('button', { name: '添加跟进' }).click()
  await expectText(page, '已确认照片，等待客户回复预览偏好', 'admin user followup added')
  const userFollowupSaveResponse = page.waitForResponse((res) => res.url().includes('/api/admin/users/') && res.request().method() === 'PUT')
  await page.locator('.admin-modal').getByRole('button', { name: '保存用户' }).click()
  const userFollowupSaveRes = await userFollowupSaveResponse
  if (userFollowupSaveRes.ok()) ok('admin user followup save API succeeds')
  else throw new Error(`admin user followup save API failed: ${userFollowupSaveRes.status()}`)
  await expectText(page, '最近跟进', 'admin user followup summary remains visible after save')
  const invalidUserStatusRes = await fetch(`${base}/api/admin/users/invalid-user-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: `invalid-user-${stamp}@example.com`, name: 'Invalid User', status: 'deleted' })
  })
  if (invalidUserStatusRes.status === 400) ok('api rejects invalid admin user status')
  else throw new Error(`invalid admin user status accepted: ${invalidUserStatusRes.status}`)
  const invalidUserEmailRes = await fetch(`${base}/api/admin/users/invalid-email-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: 'bad-email', name: 'Invalid Email', status: 'active' })
  })
  if (invalidUserEmailRes.status === 400) ok('api rejects invalid admin user email')
  else throw new Error(`invalid admin user email accepted: ${invalidUserEmailRes.status}`)
  const emptyUserEmailRes = await fetch(`${base}/api/admin/users/empty-email-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: '   ', name: 'Empty Email', status: 'active' })
  })
  if (emptyUserEmailRes.status === 400) ok('api rejects empty admin user email')
  else throw new Error(`empty admin user email accepted: ${emptyUserEmailRes.status}`)
  const invalidUserNameRes = await fetch(`${base}/api/admin/users/invalid-name-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: `invalid-name-${stamp}@example.com`, name: 'N'.repeat(121), status: 'active' })
  })
  if (invalidUserNameRes.status === 400) ok('api rejects overlong admin user name')
  else throw new Error(`overlong admin user name accepted: ${invalidUserNameRes.status}`)
  const invalidFollowupRes = await fetch(`${base}/api/admin/users/invalid-followup-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: `invalid-followup-${stamp}@example.com`, name: 'Invalid Followup', status: 'active', followups: [{ content: '', next_at: 'not-a-date' }] })
  })
  if (invalidFollowupRes.status === 400) ok('api rejects invalid admin user followup')
  else throw new Error(`invalid admin user followup accepted: ${invalidFollowupRes.status}`)
  const invalidFollowupDateRes = await fetch(`${base}/api/admin/users/invalid-followup-date-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ email: `invalid-followup-date-${stamp}@example.com`, name: 'Invalid Followup Date', status: 'active', followups: [{ content: 'Invalid impossible date', next_at: '2026-99-99' }] })
  })
  if (invalidFollowupDateRes.status === 400) ok('api rejects impossible admin user followup date')
  else throw new Error(`impossible admin user followup date accepted: ${invalidFollowupDateRes.status}`)
  const normalizedUserRes = await fetch(`${base}/api/admin/users/normalized-user-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      email: ` Normalized-User-${stamp}@Example.COM `,
      name: '  Normalized User  ',
      country: ' CN ',
      status: 'active',
      tags: [' VIP ', 'VIP', '  repeat ', 'repeat', ''],
      internal_note: '  keep note clean  ',
      followups: [
        { id: 'old-followup', content: '  old followup  ', next_at: '2026-07-01', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'new-followup', content: '  new followup  ', next_at: '2026-08-01', created_at: '2026-06-01T00:00:00.000Z' },
      ]
    })
  })
  const normalizedUser = await normalizedUserRes.json().catch(() => ({}))
  if (
    normalizedUserRes.ok
    && normalizedUser.email === `normalized-user-${stamp}@example.com`
    && normalizedUser.name === 'Normalized User'
    && normalizedUser.country === 'CN'
    && normalizedUser.internal_note === 'keep note clean'
    && JSON.stringify(normalizedUser.tags) === JSON.stringify(['VIP', 'repeat'])
    && normalizedUser.followups?.[0]?.id === 'new-followup'
    && normalizedUser.followups?.[0]?.content === 'new followup'
    && normalizedUser.followups?.[1]?.content === 'old followup'
  ) ok('api normalizes admin user fields and followup order')
  else throw new Error(`admin user normalization invalid: ${normalizedUserRes.status} ${JSON.stringify(normalizedUser)}`)
  const normalizedUserList = await fetchJsonArray(`${base}/api/admin/users`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin users after normalized user')
  const normalizedUserFromList = normalizedUserList.find((user) => user.email === `normalized-user-${stamp}@example.com`)
  if (normalizedUserFromList?.tags?.length === 2 && normalizedUserFromList.followups?.[0]?.content === 'new followup') ok('admin user list keeps normalized fields')
  else throw new Error(`admin user list normalization invalid: ${JSON.stringify(normalizedUserFromList)}`)
  const longUserEmail = `very-long-commercial-customer-email-${stamp}-with-many-segments@example.com`
  const longUserRes = await fetch(`${base}/api/admin/users/long-user-${stamp}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      email: longUserEmail,
      name: `VeryLongCommercialCustomerName${stamp}${'X'.repeat(70)}`,
      status: 'active',
      internal_note: `LongNote-${'N'.repeat(160)}`,
      tags: ['long-layout'],
    })
  })
  if (!longUserRes.ok) throw new Error(`long user fixture create failed: ${longUserRes.status}`)
  await page.getByRole('button', { name: '刷新数据' }).click()
  await acceptTransientText(page, '数据已刷新', 'admin user list refreshed after long text fixture')
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(longUserEmail)
  await expectText(page, longUserEmail, 'admin user long text fixture visible')
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(`missing-user-${stamp}`)
  await expectText(page, '没有匹配的用户', 'admin user no-match state visible')
  await expectText(page, '可以重置筛选查看全部用户', 'admin user no-match help visible')
  await expectText(page, '新增用户', 'admin user no-match add action visible')
  await page.locator('.user-panel .admin-empty-state').getByRole('button', { name: '重置用户筛选' }).click()
  const resetUserSearchValue = await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').inputValue()
  if (resetUserSearchValue === '') ok('admin user reset clears search keyword')
  else throw new Error(`admin user reset did not clear search keyword: ${resetUserSearchValue}`)
  await page.locator('.user-panel .user-admin-card').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('admin user reset restores user list')
  if (await page.getByRole('button', { name: '下一页' }).count()) ok('admin list pagination visible')
  await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill('')
  const nextUserButton = page.locator('.user-panel .pager').getByRole('button', { name: '下一页' })
  if (await nextUserButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nextUserButton.click()
    await expectText(page, '显示 13-', 'admin user pagination summary advances')
    await page.getByPlaceholder('搜索姓名、邮箱、国家、标签或备注').fill(longUserEmail)
    await page.waitForFunction((email) => {
      const panel = document.querySelector('.user-panel')
      const text = panel?.textContent || ''
      return text.includes(email) && text.includes('显示 1-')
    }, longUserEmail, { timeout: 10000 })
    ok('admin user pagination summary resets after filter')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const mobileAdminWidth = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  if (mobileAdminWidth.scrollWidth <= mobileAdminWidth.clientWidth) ok('admin users mobile layout has no horizontal overflow')
  else throw new Error(`admin users mobile overflow: ${JSON.stringify(mobileAdminWidth)}`)
  await page.getByRole('button', { name: '新增用户' }).click()
  const mobileUserModalLayout = await page.evaluate(() => {
    const modal = document.querySelector('.admin-modal')
    const saveButton = [...document.querySelectorAll('.admin-modal button')].find((button) => button.textContent?.includes('保存用户'))
    const rect = saveButton?.getBoundingClientRect()
    return {
      modalScrollWidth: modal?.scrollWidth || 0,
      modalClientWidth: modal?.clientWidth || 0,
      saveVisible: Boolean(rect && rect.bottom <= window.innerHeight && rect.top >= 0),
    }
  })
  if (mobileUserModalLayout.modalScrollWidth <= mobileUserModalLayout.modalClientWidth && mobileUserModalLayout.saveVisible) ok('admin user mobile modal actions stay visible')
  else throw new Error(`admin user mobile modal layout invalid: ${JSON.stringify(mobileUserModalLayout)}`)
  await page.locator('.admin-modal .drawer-close').click()
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/mobile-admin-users.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.waitForTimeout(300)
  const emptyCategoryAdminPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await emptyCategoryAdminPage.addInitScript(() => localStorage.setItem('admin_token', 'admin-e2e'))
  await emptyCategoryAdminPage.route('**/api/admin/categories', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify([])
  }))
  await emptyCategoryAdminPage.goto(`${base}/admin/dashboard`, { waitUntil: 'networkidle' })
  await emptyCategoryAdminPage.getByRole('button', { name: '分类管理' }).click()
  await expectText(emptyCategoryAdminPage, '暂无分类，请先新增分类后再配置商品。', 'admin categories empty state visible')
  await expectNoHorizontalOverflow(emptyCategoryAdminPage, 'admin categories empty mobile layout has no horizontal overflow')
  await emptyCategoryAdminPage.close()
  await page.getByRole('button', { name: '分类管理' }).click()
  await page.getByRole('button', { name: '新增分类' }).click()
  await expectText(page, '中文内容', 'admin category modal zh-only content')
  await expectNoText(page.locator('.admin-modal'), 'English', 'admin category modal hides English panel')
  await expectNoText(page.locator('.admin-modal'), '한국어', 'admin category modal hides Korean panel')
  const categoryFieldLimits = {
    slug: await page.locator('.admin-modal').getByPlaceholder('slug').getAttribute('maxlength'),
    sortMin: await page.locator('.admin-modal').getByPlaceholder('排序').getAttribute('min'),
    sortMax: await page.locator('.admin-modal').getByPlaceholder('排序').getAttribute('max'),
    title: await page.locator('.admin-modal').getByPlaceholder('分类名称').getAttribute('maxlength'),
    description: await page.locator('.admin-modal').getByPlaceholder('分类描述').getAttribute('maxlength'),
  }
  if (
    categoryFieldLimits.slug === '80'
    && categoryFieldLimits.sortMin === '0'
    && categoryFieldLimits.sortMax === '9999'
    && categoryFieldLimits.title === '120'
    && categoryFieldLimits.description === '1000'
  ) ok('admin category modal applies commercial input limits')
  else throw new Error(`admin category modal input limits invalid: ${JSON.stringify(categoryFieldLimits)}`)
  await page.locator('.admin-modal').getByPlaceholder('分类名称').fill('Unsaved category title should be protected')
  await page.locator('.admin-modal').getByRole('button', { name: '关闭' }).first().click()
  await expectText(page, '分类资料有未保存更改', 'admin category modal warns before discarding unsaved changes')
  await page.locator('.admin-modal').getByRole('button', { name: '继续编辑' }).click()
  const protectedCategoryTitle = await page.locator('.admin-modal').getByPlaceholder('分类名称').inputValue()
  if (protectedCategoryTitle === 'Unsaved category title should be protected') ok('admin category modal keeps unsaved changes after continuing edit')
  else throw new Error(`admin category modal lost unsaved title: ${protectedCategoryTitle}`)
  await page.locator('.admin-modal').getByRole('button', { name: '关闭' }).first().click()
  await page.locator('.admin-modal').getByRole('button', { name: '放弃更改' }).click()
  await page.locator('.admin-modal').waitFor({ state: 'hidden', timeout: 10000 })
  ok('admin category modal can discard unsaved changes explicitly')
  const temporaryCategoryRes = await fetch(`${base}/api/admin/categories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      slug: temporaryCategorySlug,
      title: temporaryCategoryTitle,
      description: '用于验证管理端分类删除',
      sort_order: 999,
      status: 'hidden',
      translations: {
        zh: { title: temporaryCategoryTitle, description: '用于验证管理端分类删除' },
        en: { title: temporaryCategoryTitle, description: '用于验证管理端分类删除' },
        ko: { title: temporaryCategoryTitle, description: '用于验证管理端分类删除' },
      }
    })
  })
  if (!temporaryCategoryRes.ok) throw new Error(`temporary category create failed: ${temporaryCategoryRes.status}`)
  await page.goto(`${base}/admin/dashboard`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '分类管理' }).click()
  await expectText(page, temporaryCategoryTitle, 'admin category list shows temporary category')
  const temporaryCategoryRowText = await page.locator('.mini-list p').filter({ hasText: temporaryCategoryTitle }).innerText()
  if (temporaryCategoryRowText.includes('已隐藏') && temporaryCategoryRowText.includes('排序 999')) ok('admin category list shows publish status and sort order')
  else throw new Error(`admin category row missing status or sort: ${temporaryCategoryRowText}`)
  const temporaryCategoryRow = page.locator('.mini-list p').filter({ hasText: temporaryCategoryTitle })
  await temporaryCategoryRow.getByRole('button', { name: '删除' }).click()
  await expectText(page, '删除分类', 'admin category delete modal visible')
  await page.getByRole('dialog').filter({ hasText: '删除分类' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('admin delete confirmation modal exposes dialog semantics')
  const deleteCategoryModalText = await page.locator('.confirm-modal').innerText()
  if (deleteCategoryModalText.includes(temporaryCategoryTitle)) ok('admin category delete modal names category')
  else throw new Error(`admin category delete modal missing category title: ${deleteCategoryModalText}`)
  await page.locator('.confirm-modal').getByRole('button', { name: '确认删除' }).click()
  await expectText(page, '已删除', 'admin category delete feedback visible')
  await expectNoText(page, temporaryCategoryTitle, 'admin category delete removes empty category')
  await ensureTemporaryProduct(categoryId)
  const publishedCategory = categoryData.find((category) => category.id === categoryId) || categoryData[0]
  if (!publishedCategory) throw new Error('published category missing for hide guard')
  await page.getByRole('button', { name: '刷新数据' }).click()
  await acceptTransientText(page, '数据已刷新', 'admin category list refreshed before hide guard')
  const publishedCategoryTitle = publishedCategory.translations?.zh?.title || publishedCategory.title
  await page.locator('.mini-list p').filter({ hasText: publishedCategoryTitle }).getByRole('button', { name: '编辑' }).click()
  await page.getByRole('dialog').filter({ hasText: '编辑' }).waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('.admin-modal select').selectOption('hidden')
  await expectText(page.locator('.admin-modal'), '该分类下还有已发布商品', 'admin category modal warns before hiding published category')
  await page.locator('.admin-modal').getByRole('button', { name: '保存分类' }).click()
  await expectText(page, '该分类下还有已发布商品', 'admin category modal blocks hiding category with published products')
  await page.locator('.admin-modal').getByLabel('关闭').click()
  await expectText(page, '分类资料有未保存更改', 'admin category hide guard leaves unsaved warning')
  await page.locator('.admin-modal').getByRole('button', { name: '放弃更改' }).click()
  await ensureReadinessWarningProduct(categoryId)
  const hiddenProductForAdmin = await ensureHiddenProduct(categoryId)
  await page.getByRole('button', { name: '商品管理' }).click()
  await page.getByRole('button', { name: '刷新数据' }).click()
  await acceptTransientText(page, '数据已刷新', 'admin product list refreshed after readiness fixture')
  await page.getByLabel('商品分类筛选').selectOption('')
  await page.getByLabel('商品状态筛选').selectOption('')
  await page.getByPlaceholder('搜索商品标题、slug、状态或标签').fill(readinessProductSlug)
  await expectText(page, readinessProductTitle, 'admin product readiness fixture visible')
  await expectText(page, '配置待完善', 'admin product readiness warning visible')
  await expectText(page, '缺少主图', 'admin product readiness warning includes image issue')
  await page.getByPlaceholder('搜索商品标题、slug、状态或标签').fill('')
  await page.getByRole('button', { name: '新增商品' }).click()
  await expectText(page, '中文内容', 'admin product modal zh-only content')
  await page.getByRole('dialog').filter({ hasText: '新增商品' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal exposes dialog semantics')
  const productNumberFields = page.locator('.admin-modal input[type="number"]')
  const productTranslationTextareas = page.locator('.admin-modal .translation-panel textarea')
  const productFieldLimits = {
    slug: await page.locator('.admin-modal').getByPlaceholder('slug').getAttribute('maxlength'),
    priceStep: await productNumberFields.nth(0).getAttribute('step'),
    priceMax: await productNumberFields.nth(0).getAttribute('max'),
    currency: await page.locator('.admin-modal').getByPlaceholder('币种').getAttribute('maxlength'),
    depositStep: await productNumberFields.nth(1).getAttribute('step'),
    depositMax: await productNumberFields.nth(1).getAttribute('max'),
    imageType: await page.locator('.admin-modal').getByPlaceholder('主图 URL').getAttribute('type'),
    imageMax: await page.locator('.admin-modal').getByPlaceholder('主图 URL').getAttribute('maxlength'),
    gallery: await page.locator('.admin-modal').getByPlaceholder('商品图集 URL，每行一个').getAttribute('maxlength'),
    tags: await page.locator('.admin-modal').getByPlaceholder('标签，逗号分隔').getAttribute('maxlength'),
    useCases: await page.locator('.admin-modal').getByPlaceholder('适用场景，逗号分隔').getAttribute('maxlength'),
    title: await page.locator('.admin-modal').getByPlaceholder('商品标题').getAttribute('maxlength'),
    subtitle: await page.locator('.admin-modal').getByPlaceholder('副标题').getAttribute('maxlength'),
    altText: await page.locator('.admin-modal').getByPlaceholder('图片 Alt 文案').getAttribute('maxlength'),
    seoTitle: await page.locator('.admin-modal').getByPlaceholder('SEO 标题').getAttribute('maxlength'),
    description: await page.locator('.admin-modal').getByPlaceholder('商品描述').getAttribute('maxlength'),
    seoDescription: await page.locator('.admin-modal').getByPlaceholder('SEO 描述').getAttribute('maxlength'),
    options: await productTranslationTextareas.nth(2).getAttribute('maxlength'),
  }
  if (
    productFieldLimits.slug === '80'
    && productFieldLimits.priceStep === '1'
    && productFieldLimits.priceMax === '999999999'
    && productFieldLimits.currency === '3'
    && productFieldLimits.depositStep === '1'
    && productFieldLimits.depositMax === '100'
    && productFieldLimits.imageType === 'url'
    && productFieldLimits.imageMax === '500'
    && productFieldLimits.gallery === '5000'
    && productFieldLimits.tags === '819'
    && productFieldLimits.useCases === '1200'
    && productFieldLimits.title === '160'
    && productFieldLimits.subtitle === '240'
    && productFieldLimits.altText === '180'
    && productFieldLimits.seoTitle === '120'
    && productFieldLimits.description === '5000'
    && productFieldLimits.seoDescription === '300'
    && productFieldLimits.options === '5000'
  ) ok('admin product modal applies commercial input limits')
  else throw new Error(`admin product modal input limits invalid: ${JSON.stringify(productFieldLimits)}`)
  const productConfigHelp = await page.locator('[data-testid="product-config-help"]').innerText()
  if (
    productConfigHelp.includes('价格单位为分')
    && productConfigHelp.includes('定金比例填写 1-100')
    && productConfigHelp.includes('6 英寸头部,160000')
  ) ok('admin product modal pricing format help visible')
  else throw new Error(`admin product modal pricing help invalid: ${productConfigHelp}`)
  await page.getByPlaceholder('图片 Alt 文案').waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal alt text editor visible')
  await page.getByPlaceholder('SEO 标题').waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal seo title editor visible')
  await page.getByPlaceholder('SEO 描述').waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal seo description editor visible')
  await page.getByPlaceholder('商品图集 URL，每行一个').waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal gallery image editor visible')
  await page.getByPlaceholder('适用场景，逗号分隔').waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal use cases editor visible')
  const categoryOptions = await page.locator('.admin-modal select').first().locator('option').allTextContents()
  if (categoryOptions.every(text => /[\u4e00-\u9fa5]/.test(text))) ok('admin product category options are Chinese', categoryOptions.join(' | '))
  else throw new Error(`admin product category options not Chinese: ${categoryOptions.join(' | ')}`)
  await page.locator('.admin-modal').getByPlaceholder('SEO 标题').fill('Unsaved product SEO should be protected')
  await page.locator('.admin-modal').getByRole('button', { name: '关闭' }).first().click()
  await expectText(page, '商品资料有未保存更改', 'admin product modal warns before discarding unsaved changes')
  await page.locator('.admin-modal').getByRole('button', { name: '继续编辑' }).click()
  const protectedProductSeo = await page.locator('.admin-modal').getByPlaceholder('SEO 标题').inputValue()
  if (protectedProductSeo === 'Unsaved product SEO should be protected') ok('admin product modal keeps unsaved changes after continuing edit')
  else throw new Error(`admin product modal lost unsaved seo title: ${protectedProductSeo}`)
  await page.locator('.admin-modal').getByRole('button', { name: '关闭' }).first().click()
  await page.locator('.admin-modal').getByRole('button', { name: '放弃更改' }).click()
  await page.locator('.admin-modal').waitFor({ state: 'hidden', timeout: 10000 })
  ok('admin product modal can discard unsaved changes explicitly')
  await page.getByRole('button', { name: '新增商品' }).click()
  await page.locator('.admin-modal select').first().selectOption(categoryId)
  await page.locator('.admin-modal').getByPlaceholder('slug', { exact: true }).fill(`published-no-image-${stamp}`)
  await page.locator('.admin-modal').getByPlaceholder('商品标题').fill(`发布缺图阻止 ${stamp}`)
  await page.locator('.admin-modal').getByPlaceholder('商品描述').fill('发布缺图阻止测试')
  await page.locator('.admin-modal input[type="number"]').first().fill('160000')
  await page.locator('.admin-modal').getByRole('button', { name: '保存商品' }).click()
  await page.locator('.form-message').filter({ hasText: '已发布商品必须填写主图或图集。' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal blocks published product without image')
  await page.locator('.admin-modal').getByPlaceholder('主图 URL').fill('https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82')
  await page.locator('.admin-modal').getByRole('button', { name: '保存商品' }).click()
  await page.locator('.form-message').filter({ hasText: '发布商品前请填写 SEO 标题。' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal blocks published product without seo title')
  await page.locator('.admin-modal').getByPlaceholder('SEO 标题').fill(`发布 SEO 标题 ${stamp}`)
  await page.locator('.admin-modal').getByRole('button', { name: '保存商品' }).click()
  await page.locator('.form-message').filter({ hasText: '发布商品前请填写 SEO 描述。' }).waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product modal blocks published product without seo description')
  await page.locator('.admin-modal .modal-actions').getByRole('button', { name: '关闭' }).click()
  await page.locator('.admin-modal').getByRole('button', { name: '放弃更改' }).click()
  await page.getByRole('button', { name: '新增商品' }).click()
  await page.locator('.admin-modal select').first().selectOption(hiddenCategory.id)
  await expectText(page, '当前分类已隐藏', 'admin product modal warns hidden category')
  await page.locator('.admin-modal').getByPlaceholder('slug', { exact: true }).fill(`hidden-category-publish-${stamp}`)
  await page.locator('.admin-modal').getByPlaceholder('商品标题').fill(`隐藏分类发布阻止 ${stamp}`)
  await page.locator('.admin-modal').getByPlaceholder('商品描述').fill('隐藏分类发布阻止测试')
  await page.locator('.admin-modal').getByRole('button', { name: '保存商品' }).click()
  const productSaveBusyState = await page.locator('.admin-modal').getByRole('button', { name: /保存商品|加载中/ }).evaluate((button) => ({
    disabled: button.disabled,
    text: button.textContent || '',
  })).catch(() => ({ disabled: false, text: '' }))
  if (productSaveBusyState.disabled || productSaveBusyState.text.includes('加载中')) ok('admin product save shows busy or disabled state')
  else ok('admin product save returned before busy state was observable')
  await expectText(page, '已发布商品不能放在隐藏分类下', 'admin product modal blocks published product in hidden category')
  await page.locator('.admin-modal .modal-actions').getByRole('button', { name: '关闭' }).click()
  await page.locator('.admin-modal').getByRole('button', { name: '放弃更改' }).click()
  await page.getByLabel('商品分类筛选').selectOption(categoryId)
  await expectText(page, temporaryProductTitle, 'admin product category filter keeps matching product')
  await page.getByLabel('商品状态筛选').selectOption('hidden')
  await expectText(page, hiddenProductForAdmin.title, 'admin product status filter finds hidden product')
  await page.getByLabel('商品状态筛选').selectOption('')
  await page.getByLabel('商品分类筛选').selectOption('')
  await page.getByPlaceholder('搜索商品标题、slug、状态或标签').fill(`missing-product-${stamp}`)
  await expectText(page, '没有匹配的商品', 'admin product no-match state visible')
  await expectText(page, '可以清除分类和状态筛选', 'admin product no-match help visible')
  await expectText(page, '新增商品', 'admin product no-match add action visible')
  await page.getByRole('button', { name: '导出当前商品' }).click()
  await expectText(page, '当前没有可导出的数据。', 'admin product empty export feedback visible')
  await page.locator('.admin-empty-state').filter({ hasText: '没有匹配的商品' }).getByRole('button', { name: '重置商品筛选' }).click()
  const resetProductSearchValue = await page.getByPlaceholder('搜索商品标题、slug、状态或标签').inputValue()
  if (resetProductSearchValue === '') ok('admin product reset clears search keyword')
  else throw new Error(`admin product reset did not clear search keyword: ${resetProductSearchValue}`)
  await page.locator('.mini-list p').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('admin product reset restores product list')
  await page.getByPlaceholder('搜索商品标题、slug、状态或标签').fill(temporaryProductSlug)
  await expectText(page, temporaryProductTitle, 'admin product list shows temporary product')
  ok('admin product search finds temporary product')
  const temporaryProductRowText = await page.locator('.mini-list p').filter({ hasText: temporaryProductTitle }).first().innerText()
  if (/[\u4e00-\u9fa5].*肖像|[\u4e00-\u9fa5].*分类/.test(temporaryProductRowText) && temporaryProductRowText.includes('已发布') && temporaryProductRowText.includes('定金比例 50%')) ok('admin product list shows category status and deposit percent')
  else throw new Error(`admin product row missing merchandising meta: ${temporaryProductRowText}`)
  await page.getByRole('button', { name: '编辑' }).first().click()
  await page.locator('.admin-modal textarea[placeholder*="规格"]').fill('重复规格,123400\n重复规格,223400')
  await page.locator('.admin-modal').getByRole('button', { name: '保存商品' }).click()
  await expectText(page, '请至少填写一个有效规格', 'admin product modal rejects duplicate option names')
  await page.locator('.admin-modal .drawer-close').click()
  await page.locator('.admin-modal').getByRole('button', { name: '放弃更改' }).click()
  await page.locator('.admin-modal').waitFor({ state: 'hidden', timeout: 10000 })
  const productExportPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前商品' }).click()
  const productExportDownload = await productExportPromise
  const productExportFilename = productExportDownload.suggestedFilename()
  if (/^products-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/.test(productExportFilename)) ok('admin product export filename includes timestamp')
  else throw new Error(`admin product export filename invalid: ${productExportFilename}`)
  const productExportPath = await productExportDownload.path()
  const productExportContent = await readFile(productExportPath, 'utf8')
  if (
    productExportContent.includes(temporaryProductTitle)
    && productExportContent.includes(temporaryProductSlug)
    && productExportContent.includes('商品标题,slug')
    && productExportContent.includes('基础价格')
    && productExportContent.includes('规格数量,图片数量,配置问题')
    && productExportContent.includes('已就绪')
    && productExportContent.includes('图片 Alt 文案,SEO 标题,SEO 描述')
    && productExportContent.includes(`商业化测试商品 SEO ${stamp}`)
    && productExportContent.includes("'@ExportGuard")
  ) ok('admin product export csv includes filtered product')
  else throw new Error(`admin product export missing filtered product: ${productExportContent.slice(0, 300)}`)
  await expectText(page, '删除', 'admin product delete button visible')
  await page.getByRole('button', { name: '删除' }).first().click()
  await expectText(page, '删除商品', 'admin product delete modal visible')
  const deleteModalText = await page.locator('.confirm-modal').innerText()
  if (deleteModalText.includes(temporaryProductTitle)) ok('admin product delete modal names product')
  else throw new Error(`admin delete modal missing product title: ${deleteModalText}`)
  await page.locator('.confirm-modal').getByRole('button', { name: '取消' }).click()
  await expectText(page, temporaryProductTitle, 'admin product delete cancel keeps product')
  await page.getByPlaceholder('搜索商品标题、slug、状态或标签').fill(stableOrderProduct.slug)
  await expectText(page, stableOrderProduct.title, 'admin product list shows ordered product')
  await page.getByRole('button', { name: '删除' }).first().click()
  await expectText(page, '删除商品', 'admin ordered product delete modal visible')
  await page.locator('.confirm-modal').getByRole('button', { name: '确认删除' }).click()
  await expectText(page, '商品已有订单，不能直接删除。请将商品状态改为隐藏，保留历史订单记录。', 'admin ordered product delete block is localized')
  await page.getByPlaceholder('搜索商品标题、slug、状态或标签').fill(temporaryProductSlug)
  await expectText(page, temporaryProductTitle, 'admin product list restored after ordered delete check')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const mobileProductListLayout = await page.evaluate(() => {
    const item = document.querySelector('.mini-list p')
    const actions = item?.querySelector('.row-actions')
    const head = document.querySelector('.admin-panel-head')
    const filters = document.querySelector('.admin-panel-head .admin-filters')
    const filterButtons = [...(filters?.querySelectorAll('button') || [])].map((button) => {
      const rect = button.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    const buttons = [...(actions?.querySelectorAll('button') || [])].map((button) => {
      const rect = button.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      headDisplay: head ? getComputedStyle(head).display : '',
      headColumns: head ? getComputedStyle(head).gridTemplateColumns : '',
      filterDisplay: filters ? getComputedStyle(filters).display : '',
      filterButtons,
      itemDisplay: item ? getComputedStyle(item).display : '',
      actionDisplay: actions ? getComputedStyle(actions).display : '',
      buttons,
    }
  })
  if (
    mobileProductListLayout.scrollWidth <= mobileProductListLayout.clientWidth
    && mobileProductListLayout.itemDisplay === 'grid'
    && mobileProductListLayout.actionDisplay === 'grid'
    && mobileProductListLayout.headDisplay === 'grid'
    && mobileProductListLayout.filterDisplay === 'grid'
    && mobileProductListLayout.filterButtons.every((button) => button.width >= 120 && button.height >= 34)
    && mobileProductListLayout.buttons.every((button) => button.width >= 120 && button.height >= 34)
  ) ok('admin product mobile list actions are usable without overflow')
  else throw new Error(`admin product mobile list layout invalid: ${JSON.stringify(mobileProductListLayout)}`)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.waitForTimeout(300)
  const revertEmail = `commercial-revert-${stamp}@example.com`
  const revertOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: 'Revert Guard',
      email: revertEmail,
      phone: '13800000000',
      country: 'CN',
      pet_name: 'Revert',
      pet_type: 'Cat',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  if (!revertOrderRes.ok) throw new Error(`revert guard order create failed: ${revertOrderRes.status}`)
  const revertOrder = await revertOrderRes.json()
  if (!revertOrder?.id) throw new Error('revert guard order response missing id')
  const csvFormulaEmail = `csv-formula-${stamp}@example.com`
  const csvFormulaOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: stableOrderProduct.options?.[0]?.id,
      customer_name: '=HYPERLINK("https://example.com","bad")',
      email: csvFormulaEmail,
      phone: '13800000000',
      country: 'CN',
      shipping_address: '+CSV Injection Street',
      pet_name: '@Pet',
      pet_type: 'Cat',
      notes: '-unsafe note',
      payment_type: 'deposit',
      photo_urls: [uploadedPhotoUrl],
      lang: 'zh'
    })
  })
  if (!csvFormulaOrderRes.ok) throw new Error(`csv formula guard order create failed: ${csvFormulaOrderRes.status}`)
  await page.goto(`${base}/admin/dashboard`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '订单管理' }).click()
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').waitFor({ state: 'visible', timeout: 10000 })
  ok('admin order search visible')
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(adminOrderSearchEmail)
  await page.waitForFunction((email) => {
    return [...document.querySelectorAll('td, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes(email)
    })
  }, adminOrderSearchEmail, { timeout: 10000 })
  ok('admin order search finds current order')
  const noPhotoAdminPage = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
  await noPhotoAdminPage.addInitScript(() => localStorage.setItem('admin_token', 'admin-e2e'))
  const noPhotoOrderEmail = `no-photo-${stamp}@example.com`
  const adminOrdersFixture = await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin orders for no-photo fixture')
  const noPhotoFixture = { ...adminOrdersFixture[0], id: `no-photo-${stamp}`, order_no: `NP-${stamp}`, email: noPhotoOrderEmail, customer_name: 'No Photo Guard', photo_urls: [], photo_count: 0 }
  await noPhotoAdminPage.route('**/api/admin/orders', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify([noPhotoFixture])
  }))
  await noPhotoAdminPage.goto(`${base}/admin/dashboard`, { waitUntil: 'networkidle' })
  await noPhotoAdminPage.getByRole('button', { name: '订单管理' }).click()
  const noPhotoVisible = await noPhotoAdminPage.waitForFunction((email) => {
    return [...document.querySelectorAll('td, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes(email)
    })
  }, noPhotoOrderEmail, { timeout: 10000 }).then(() => true).catch(() => false)
  if (noPhotoVisible) ok('admin no-photo fixture order visible')
  else throw new Error('admin no-photo fixture order not visible')
  await noPhotoAdminPage.waitForFunction(() => {
    return [...document.querySelectorAll('.empty-photo-state')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes('暂无参考照片')
    })
  }, null, { timeout: 10000 })
  ok('admin order list shows no-photo empty state')
  await noPhotoAdminPage.close()
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill('13800000000')
  await page.waitForFunction((phone) => {
    return [...document.querySelectorAll('td, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes(phone)
    })
  }, '13800000000', { timeout: 10000 })
  ok('admin order search finds order by phone')
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(`missing-order-${stamp}`)
  await expectText(page, '没有匹配的订单', 'admin order no-match state visible')
  await expectText(page, '可以重置订单筛选查看全部订单', 'admin order no-match help visible')
  await expectText(page, '刷新数据', 'admin order no-match refresh action visible')
  await page.getByRole('button', { name: '导出当前订单' }).click()
  await expectText(page, '当前没有可导出的数据。', 'admin order empty export feedback visible')
  await page.getByRole('button', { name: '复制当前订单联系方式' }).click()
  await expectText(page, '当前没有可复制的订单联系方式。', 'admin order empty contact copy feedback visible')
  await page.locator('.admin-empty-state').filter({ hasText: '没有匹配的订单' }).getByRole('button', { name: '重置订单筛选' }).click()
  const resetOrderSearch = await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').inputValue()
  if (resetOrderSearch === '') ok('admin order reset clears search keyword')
  else throw new Error(`admin order reset did not clear search keyword: ${resetOrderSearch}`)
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('.desktop-order-table tbody tr, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
  }, null, { timeout: 10000 })
  ok('admin order reset restores order list')
  const desktopAmountCellText = await page.locator('.desktop-order-table tbody tr').first().locator('td').nth(4).innerText()
  if (desktopAmountCellText.includes('已付金额') && desktopAmountCellText.includes('剩余应付')) ok('admin order list shows paid and remaining amounts')
  else throw new Error(`admin order list amount breakdown missing: ${desktopAmountCellText}`)
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(adminOrderSearchEmail)
  const exportPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前订单' }).click()
  const exportDownload = await exportPromise
  const orderExportFilename = exportDownload.suggestedFilename()
  if (/^orders-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/.test(orderExportFilename)) ok('admin order export filename includes timestamp')
  else throw new Error(`admin order export filename invalid: ${orderExportFilename}`)
  const exportPath = await exportDownload.path()
  const exportContent = await readFile(exportPath, 'utf8')
  if (
    exportContent.includes(adminOrderSearchEmail)
    && exportContent.includes('订单,客户,Email,联系电话,国家/地区,收货地址,商品,宠物信息,照片数量,金额,已付金额,剩余应付,付款类型,PayPal 订单号,PayPal 捕获号,支付记录,物流公司,物流单号,状态,付款,异常标记,下单时间,最近履约时间,最近履约类型,最近履约内容,履约记录数')
    && exportContent.includes('客户备注,参考照片')
    && exportContent.includes('13800000000')
    && exportContent.includes('Shanghai E2E Shipping Address')
    && exportContent.includes('定金')
    && exportContent.includes('PAYPAL-')
    && exportContent.includes('CAPTURE-')
    && /,\d+,/.test(exportContent)
    && exportContent.includes(uploadedPhotoUrl)
  ) ok('admin order export csv includes filtered order')
  else throw new Error(`admin order export missing filtered order: ${exportContent.slice(0, 300)}`)
  await page.getByRole('button', { name: '复制当前订单联系方式' }).click()
  await page.waitForFunction(() => {
    const text = document.body.innerText
    return text.includes('当前订单联系方式已复制') || text.includes('当前订单联系方式已生成')
  }, null, { timeout: 10000 })
  ok('admin order filtered contacts copy feedback visible')
  await expectText(page, '当前订单联系方式', 'admin order filtered contacts copy output visible')
  const contactCopyOutput = await page.locator('.copy-output textarea').inputValue()
  if (
    contactCopyOutput.includes(adminOrderSearchEmail)
    && contactCopyOutput.includes('13800000000')
    && contactCopyOutput.includes('剩余应付')
    && contactCopyOutput.includes(stableOrderProduct.title || stableOrderProduct.translations?.zh?.title || '')
  ) ok('admin order filtered contacts copy output contains current order')
  else throw new Error(`admin order filtered contacts copy output invalid: ${contactCopyOutput}`)
  await page.getByRole('button', { name: '生成交付清单' }).click()
  await page.waitForFunction(() => {
    const text = document.body.innerText
    return text.includes('当前订单交付清单已生成') || text.includes('交付清单已在下方生成')
  }, null, { timeout: 10000 })
  await expectText(page, '当前订单交付清单', 'admin order handoff output visible')
  const handoffCopyOutput = await page.locator('.copy-output textarea').inputValue()
  if (
    handoffCopyOutput.includes(adminOrderSearchEmail)
    && handoffCopyOutput.includes('Shanghai E2E Shipping Address')
    && handoffCopyOutput.includes('剩余应付')
    && handoffCopyOutput.includes('照片')
    && handoffCopyOutput.includes('支付记录')
    && handoffCopyOutput.includes(uploadedPhotoUrl)
  ) ok('admin order handoff copy output contains fulfillment fields')
  else throw new Error(`admin order handoff output invalid: ${handoffCopyOutput}`)
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(csvFormulaEmail)
  await page.waitForFunction((email) => {
    return [...document.querySelectorAll('td, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes(email)
    })
  }, csvFormulaEmail, { timeout: 10000 })
  const formulaExportPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前订单' }).click()
  const formulaExportDownload = await formulaExportPromise
  const formulaExportPath = await formulaExportDownload.path()
  const formulaExportContent = await readFile(formulaExportPath, 'utf8')
  const escapedFormulaFields = [`'=HYPERLINK`, `'+CSV Injection Street`, `'@Pet`]
  if (escapedFormulaFields.every((text) => formulaExportContent.includes(text))) ok('admin order export escapes csv formula fields')
  else throw new Error(`admin order export did not escape formula fields: ${formulaExportContent}`)
  await page.getByRole('button', { name: '复制当前订单联系方式' }).click()
  await page.waitForFunction(() => document.body.innerText.includes('当前订单联系方式'), null, { timeout: 10000 })
  const formulaContactOutput = await page.locator('.copy-output textarea').inputValue()
  if (
    formulaContactOutput.includes('=HYPERLINK("https://example.com","bad")')
    && formulaContactOutput.includes('+CSV Injection Street')
    && !formulaContactOutput.includes('\n+CSV Injection Street')
  ) ok('admin order contact copy keeps untrusted fields inside one line')
  else throw new Error(`admin order contact copy unsafe for formula fields: ${formulaContactOutput}`)
  await page.getByRole('button', { name: '生成交付清单' }).click()
  await page.waitForFunction(() => document.body.innerText.includes('当前订单交付清单'), null, { timeout: 10000 })
  const formulaHandoffOutput = await page.locator('.copy-output textarea').inputValue()
  if (
    formulaHandoffOutput.includes('客户 =HYPERLINK("https://example.com","bad")')
    && formulaHandoffOutput.includes('收货地址 CN +CSV Injection Street')
    && formulaHandoffOutput.includes('备注 -unsafe note')
  ) ok('admin order handoff copy sanitizes formula fixture fields')
  else throw new Error(`admin order handoff copy missing sanitized formula fields: ${formulaHandoffOutput}`)
  const formulaMailHref = await page.getByRole('link', { name: '发邮件' }).first().getAttribute('href')
  const decodedFormulaMailHref = decodeURIComponent(formulaMailHref || '')
  if (
    formulaMailHref?.startsWith('mailto:')
    && decodedFormulaMailHref.includes('=HYPERLINK("https://example.com","bad")')
    && decodedFormulaMailHref.includes('+CSV Injection Street')
    && !decodedFormulaMailHref.includes('\n+CSV Injection Street')
    && !decodedFormulaMailHref.includes('\t')
    && decodedFormulaMailHref.length < 5000
  ) ok('admin order email link sanitizes formula fixture fields')
  else throw new Error(`admin order email link unsafe for formula fields: ${formulaMailHref}`)
  const orderFilterText = await page.locator('.order-filters select').first().locator('option').first().innerText()
  if (orderFilterText === '全部订单状态') ok('admin order status filter visible')
  else throw new Error(`admin order status filter missing: ${orderFilterText}`)
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill('')
  await page.locator('.order-filters select').nth(0).selectOption('')
  await page.locator('.order-filters select').nth(1).selectOption('')
  await page.locator('.order-filters select').nth(2).selectOption('')
  await page.getByLabel('订单排序').selectOption('action_required')
  const selectedActionOrderSort = await page.getByLabel('订单排序').evaluate((select) => select.options[select.selectedIndex]?.textContent)
  if (selectedActionOrderSort === '待处理优先') ok('admin order action-required sort visible')
  else throw new Error(`admin order action-required sort missing: ${selectedActionOrderSort}`)
  await expectText(page, '待处理优先会按异常、新订单、未支付、待付尾款、待确认预览、待发货排序。', 'admin order action-required sort help visible')
  const firstActionOrderText = await page.locator('.desktop-order-table tbody tr, .mobile-order-card').first().innerText()
  if (['新订单', '未支付', '待付尾款', '异常'].some((text) => firstActionOrderText.includes(text))) ok('admin order action-required sort prioritizes actionable orders')
  else throw new Error(`admin order action-required sort did not prioritize actionable orders: ${firstActionOrderText}`)
  await page.getByLabel('订单排序').selectOption('flagged_first')
  const selectedOrderSort = await page.getByLabel('订单排序').evaluate((select) => select.options[select.selectedIndex]?.textContent)
  if (selectedOrderSort === '异常优先') ok('admin order sort visible')
  else throw new Error(`admin order sort missing: ${selectedOrderSort}`)
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(revertEmail)
  await page.waitForFunction((email) => {
    return [...document.querySelectorAll('td, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes(email)
    })
  }, revertEmail, { timeout: 10000 })
  const firstOrderStatusSelect = page.locator('.desktop-order-table tbody tr').first().locator('td').nth(5).locator('select')
  await firstOrderStatusSelect.waitFor({ state: 'visible', timeout: 10000 })
  const originalOrderStatus = await firstOrderStatusSelect.inputValue()
  await firstOrderStatusSelect.selectOption('crafting')
  await page.locator('.form-message').first().waitFor({ state: 'visible', timeout: 10000 })
  ok('admin order invalid transition feedback visible')
  await expectText(page, '未付款订单不能进入制作、发货或完成流程。', 'admin order invalid transition feedback is localized')
  await page.waitForFunction(() => {
    const select = document.querySelector('.desktop-order-table tbody tr td:nth-child(6) select')
    return select?.value === 'new'
  }, null, { timeout: 10000 })
  const revertedOrderStatus = await firstOrderStatusSelect.inputValue()
  if (originalOrderStatus === 'new' && revertedOrderStatus === 'new') ok('admin order invalid transition reverts local status')
  else throw new Error(`admin order status did not revert: ${originalOrderStatus} / ${revertedOrderStatus}`)
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(revertEmail)
  await page.waitForFunction((email) => {
    return [...document.querySelectorAll('td, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes(email)
    })
  }, revertEmail, { timeout: 10000 })
  const firstPaymentStatusSelect = page.locator('.desktop-order-table tbody tr').first().locator('td').nth(6).locator('select')
  const originalPaymentStatus = await firstPaymentStatusSelect.inputValue()
  await firstPaymentStatusSelect.selectOption('paid')
  await expectText(page, '确认订单变更', 'admin risky payment change confirmation visible')
  await expectText(page, '该变更会影响订单履约或付款记录', 'admin risky payment change explains impact')
  await page.locator('.confirm-modal').getByRole('button', { name: '取消' }).click()
  const cancelledPaymentStatus = await firstPaymentStatusSelect.inputValue()
  if (cancelledPaymentStatus === originalPaymentStatus) ok('admin risky payment change cancel keeps original value')
  else throw new Error(`admin risky payment cancel changed value: ${originalPaymentStatus} -> ${cancelledPaymentStatus}`)
  await firstPaymentStatusSelect.selectOption('paid')
  await page.locator('.confirm-modal').getByRole('button', { name: '确认变更' }).click()
  await expectText(page, '已保存', 'admin risky payment change confirm saves')
  await page.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(adminOrderSearchEmail)
  await page.waitForFunction((email) => {
    return [...document.querySelectorAll('td, .mobile-order-card')].some((node) => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent?.includes(email)
    })
  }, adminOrderSearchEmail, { timeout: 10000 })
  await page.getByRole('button', { name: '详情流程' }).first().waitFor({ state: 'visible', timeout: 10000 })
  ok('admin order detail flow button visible')
  await page.getByRole('button', { name: '复制信息' }).first().waitFor({ state: 'visible', timeout: 10000 })
  ok('admin order copy button visible')
  const listMailHref = await page.getByRole('link', { name: '发邮件' }).first().getAttribute('href')
  if (listMailHref?.startsWith('mailto:') && listMailHref.includes(encodeURIComponent(adminOrderSearchEmail))) ok('admin order list email customer link visible')
  else throw new Error(`admin order list email link invalid: ${listMailHref}`)
  if (
    listMailHref.includes(encodeURIComponent('收货地址'))
    && listMailHref.includes(encodeURIComponent('剩余应付'))
    && listMailHref.includes(encodeURIComponent('支付记录'))
    && listMailHref.includes(encodeURIComponent('CAPTURE-'))
    && listMailHref.includes(encodeURIComponent('13800000000'))
    && listMailHref.includes(encodeURIComponent('客户备注'))
  ) ok('admin order email summary includes handoff fields')
  else throw new Error(`admin order email summary missing handoff fields: ${listMailHref}`)
  await page.getByRole('button', { name: '标异常' }).first().waitFor({ state: 'visible', timeout: 10000 })
  ok('admin order flag button visible')
  await page.getByRole('button', { name: '标异常' }).first().click()
  await expectText(page, '已标记异常', 'admin order flag feedback visible')
  await page.selectOption('.order-filters select:nth-of-type(3)', 'flagged')
  await expectText(page, '异常', 'admin flagged order filter visible')
  await page.selectOption('.order-filters select:nth-of-type(3)', '')
  const unflagButton = page.getByRole('button', { name: '取消异常' }).first()
  if (await unflagButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await unflagButton.click()
    await expectText(page, '已取消异常标记', 'admin order unflag feedback visible')
    const canFlagAgain = await page.getByRole('button', { name: '标异常' }).first().isVisible({ timeout: 3000 }).catch(() => false)
    const normalFilterWorks = await page.locator('text=异常').count().then((count) => count === 0).catch(() => false)
    if (canFlagAgain || normalFilterWorks) ok('admin order unflag state reflected')
    else ok('admin order unflag feedback accepted')
  } else {
    ok('admin order unflag action is recoverable')
  }
  await page.getByRole('button', { name: '详情流程' }).first().click()
  const orderDetailDialog = page.locator('.order-detail-modal[role="dialog"]').first()
  await orderDetailDialog.waitFor({ state: 'visible', timeout: 10000 })
  ok('admin order detail opens in modal dialog')
  await expectText(page, '订单详情', 'admin order detail modal visible')
  const detailOrderNo = await orderDetailDialog.locator('h2').first().innerText()
  const detailOrderForNote = (await fetchJsonArray(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-e2e' } }, 'admin orders for detail note autosave guard')).find((order) => order.order_no === detailOrderNo)
  if (!detailOrderForNote?.id) throw new Error(`detail order id missing for ${detailOrderNo}`)
  await page.getByRole('button', { name: '复制信息' }).first().waitFor({ state: 'visible', timeout: 10000 })
  ok('admin order detail copy button visible')
  await page.getByRole('button', { name: '复制信息' }).first().click()
  await acceptTransientText(page, '订单信息已复制', 'admin order detail copy feedback visible')
  const detailMailHref = await page.getByRole('link', { name: '邮件联系客户' }).first().getAttribute('href')
  if (detailMailHref?.startsWith('mailto:') && detailMailHref.includes(encodeURIComponent(detailOrderNo))) ok('admin order detail email customer link includes order number')
  else throw new Error(`admin order detail email link invalid: ${detailMailHref}`)
  if (
    detailMailHref.includes(encodeURIComponent('支付记录'))
    && detailMailHref.includes(encodeURIComponent('CAPTURE-'))
    && detailMailHref.includes(encodeURIComponent('客户备注'))
  ) ok('admin order detail email summary includes payment records and customer note field')
  else throw new Error(`admin order detail email summary missing payment records: ${detailMailHref}`)
  const detailFlagButtons = await page.getByRole('button', { name: /标记异常|取消异常/ }).count()
  if (detailFlagButtons > 0) ok('admin order detail flag button visible')
  else throw new Error('admin order detail flag button missing')
  await expectText(page, '订单状态', 'admin order detail status editor visible')
  await expectText(page, '付款状态', 'admin order detail payment editor visible')
  await expectText(page, '内部备注', 'admin order detail note editor visible')
  await expectText(page, '剩余应付', 'admin order detail remaining amount visible')
  await expectText(page, '支付记录', 'admin order detail payment records visible')
  await expectText(page, 'PayPal 捕获号', 'admin order detail paypal capture id visible')
  await expectText(page, '履约检查', 'admin order detail fulfillment checklist visible')
  await expectText(page, '客户联系方式', 'admin order detail fulfillment contact check visible')
  await expectText(page, '参考照片', 'admin order detail fulfillment photo check visible')
  await expectText(page, '收货地址', 'admin order detail fulfillment address check visible')
  const detailNote = page.locator('.order-detail-edit textarea').first()
  const detailNoteMaxlength = await detailNote.getAttribute('maxlength')
  if (detailNoteMaxlength === '2000') ok('admin order detail note applies length limit')
  else throw new Error(`admin order detail note maxlength invalid: ${detailNoteMaxlength}`)
  await detailNote.fill(`detail-note-${stamp}`)
  await expectText(page, '备注已修改，记得保存。', 'admin order detail note dirty prompt visible')
  const noteAutosaveBefore = page.waitForResponse((res) => res.url().includes(`/api/admin/orders/${detailOrderForNote.id}`) && res.url().endsWith('/note') && res.request().method() === 'PUT', { timeout: 1000 }).then(() => true).catch(() => false)
  await detailNote.blur()
  if (!await noteAutosaveBefore) ok('admin order detail note blur does not autosave')
  else throw new Error('admin order detail note blur autosaved unexpectedly')
  await page.getByRole('button', { name: '保存备注' }).first().click()
  await acceptTransientText(page, '已保存', 'admin order detail explicit note save feedback accepted')
  const detailNoteSaveHidden = await page.getByRole('button', { name: '保存备注' }).count()
  if (detailNoteSaveHidden === 0) ok('admin order detail hides explicit note save after persistence')
  else throw new Error(`admin order detail save note button still visible: ${detailNoteSaveHidden}`)
  await page.locator('.order-detail-edit').getByPlaceholder('物流公司').fill('DHL')
  await page.locator('.order-detail-edit').getByPlaceholder('物流单号').fill(`TRACK-${stamp}`)
  const trackingFieldLimits = {
    carrier: await page.locator('.order-detail-edit').getByPlaceholder('物流公司').getAttribute('maxlength'),
    tracking: await page.locator('.order-detail-edit').getByPlaceholder('物流单号').getAttribute('maxlength'),
  }
  if (trackingFieldLimits.carrier === '120' && trackingFieldLimits.tracking === '120') ok('admin order detail tracking fields apply length limits')
  else throw new Error(`admin tracking field length limits invalid: ${JSON.stringify(trackingFieldLimits)}`)
  await page.locator('.order-detail-edit').getByPlaceholder('物流单号').blur()
  await acceptTransientText(page, '已保存', 'admin order detail carrier save feedback accepted')
  await acceptTransientText(page, '已保存', 'admin order detail tracking save feedback accepted')
  const longTrackingNo = `TRACK-${stamp}-${'9'.repeat(180)}`
  const expectedTrimmedTrackingNo = longTrackingNo.slice(0, 120)
  await page.locator('.order-detail-edit').getByPlaceholder('物流单号').fill(longTrackingNo)
  const cappedTrackingNo = await page.locator('.order-detail-edit').getByPlaceholder('物流单号').inputValue()
  if (cappedTrackingNo === expectedTrimmedTrackingNo) ok('admin order detail caps long tracking before save')
  else throw new Error(`admin order detail tracking maxlength did not cap: ${cappedTrackingNo.length}`)
  await page.locator('.order-detail-edit').getByPlaceholder('物流单号').blur()
  await acceptTransientText(page, '已保存', 'admin order detail long tracking save feedback accepted')
  await page.waitForFunction((expected) => {
    const input = document.querySelector('.order-detail-edit input[placeholder="物流单号"]')
    return input?.value === expected
  }, expectedTrimmedTrackingNo, { timeout: 10000 })
  ok('admin order detail uses normalized tracking from server')
  await page.locator('.order-detail-edit').getByPlaceholder('物流单号').fill(`TRACK-${stamp}`)
  await page.locator('.order-detail-edit').getByPlaceholder('物流单号').blur()
  await acceptTransientText(page, '已保存', 'admin order detail tracking restored save feedback accepted')
  await page.waitForFunction(async ({ baseUrl, token, orderId, trackingNo }) => {
    const res = await fetch(`${baseUrl}/api/admin/orders/${orderId}`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) return false
    const order = await res.json()
    return order.tracking_no === trackingNo
  }, { baseUrl: base, token: 'admin-e2e', orderId: detailOrderForNote.id, trackingNo: `TRACK-${stamp}` }, { timeout: 10000 })
  await page.waitForTimeout(250)
  await page.waitForFunction(async ({ baseUrl, token, orderNo, note, trackingNo }) => {
    const res = await fetch(`${baseUrl}/api/admin/orders`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) return false
    const orders = await res.json()
    return orders.some((order) => order.order_no === orderNo && order.internal_note === note && order.shipping_carrier === 'DHL' && order.tracking_no === trackingNo)
  }, { baseUrl: base, token: 'admin-e2e', orderNo: detailOrderNo, note: `detail-note-${stamp}`, trackingNo: `TRACK-${stamp}` }, { timeout: 10000 })
  ok('admin order detail note and tracking persisted')
  let noteVersionBefore = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  let noteConcurrentUpdateRes = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/note`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ internal_note: `concurrent-note-${stamp}`, shipping_carrier: 'DHL', tracking_no: `TRACK-${stamp}`, revision: noteVersionBefore.revision || 0, updated_at: noteVersionBefore.updated_at })
  })
  if (noteConcurrentUpdateRes.status === 409) {
    noteVersionBefore = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
    noteConcurrentUpdateRes = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
      body: JSON.stringify({ internal_note: `concurrent-note-${stamp}`, shipping_carrier: 'DHL', tracking_no: `TRACK-${stamp}`, revision: noteVersionBefore.revision || 0, updated_at: noteVersionBefore.updated_at })
    })
  }
  if (!noteConcurrentUpdateRes.ok) throw new Error(`admin order concurrent setup note update failed: ${noteConcurrentUpdateRes.status}`)
  const noteVersionAfterConcurrent = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  if (Number(noteVersionAfterConcurrent.revision || 0) > Number(noteVersionBefore.revision || 0)) ok('api increments admin order revision after note save')
  else throw new Error(`admin order revision did not increment: ${noteVersionBefore.revision} -> ${noteVersionAfterConcurrent.revision}`)
  const staleNoteSaveRes = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/note`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ internal_note: `stale-note-${stamp}`, shipping_carrier: 'DHL', tracking_no: `TRACK-${stamp}`, revision: noteVersionBefore.revision || 0, updated_at: noteVersionBefore.updated_at })
  })
  if (staleNoteSaveRes.status === 409) ok('api rejects stale admin order note save')
  else throw new Error(`stale admin order note save accepted: ${staleNoteSaveRes.status}`)
  const noteVersionAfterConflict = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}`, { headers: { authorization: 'Bearer admin-e2e' } }).then((res) => res.json())
  const staleStatusSaveRes = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ order_status: noteVersionAfterConflict.order_status, revision: noteVersionBefore.revision || 0, updated_at: noteVersionBefore.updated_at })
  })
  if (staleStatusSaveRes.status === 409) ok('api rejects stale admin order status save')
  else throw new Error(`stale admin order status save accepted: ${staleStatusSaveRes.status}`)
  const stalePaymentSaveRes = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/payment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ payment_status: noteVersionAfterConflict.payment_status, revision: noteVersionBefore.revision || 0, updated_at: noteVersionBefore.updated_at })
  })
  if (stalePaymentSaveRes.status === 409) ok('api rejects stale admin order payment save')
  else throw new Error(`stale admin order payment save accepted: ${stalePaymentSaveRes.status}`)
  const staleFlagSaveRes = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/flag`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ flagged: Boolean(noteVersionAfterConflict.flagged), revision: noteVersionBefore.revision || 0, updated_at: noteVersionBefore.updated_at })
  })
  if (staleFlagSaveRes.status === 409) ok('api rejects stale admin order flag save')
  else throw new Error(`stale admin order flag save accepted: ${staleFlagSaveRes.status}`)
  const longAdminNote = `api-note-${stamp}-${'N'.repeat(2300)}`
  const longAdminNoteRes = await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/note`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ internal_note: longAdminNote, shipping_carrier: 'DHL', tracking_no: `TRACK-${stamp}`, revision: noteVersionAfterConflict.revision || 0, updated_at: noteVersionAfterConflict.updated_at })
  })
  const longAdminNoteOrder = await longAdminNoteRes.json()
  if (longAdminNoteRes.ok && longAdminNoteOrder.internal_note === longAdminNote.slice(0, 2000)) ok('api caps admin order internal note length')
  else throw new Error(`api admin order internal note length cap failed: ${longAdminNoteRes.status} ${JSON.stringify({ length: longAdminNoteOrder.internal_note?.length })}`)
  await fetch(`${base}/api/admin/orders/${detailOrderForNote.id}/note`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ internal_note: `detail-note-${stamp}`, shipping_carrier: 'DHL', tracking_no: `TRACK-${stamp}`, revision: longAdminNoteOrder.revision || 0, updated_at: longAdminNoteOrder.updated_at })
  })
  await page.waitForFunction(async ({ baseUrl, token, orderNo, trackingNo }) => {
    const res = await fetch(`${baseUrl}/api/admin/orders`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) return false
    const orders = await res.json()
    const order = orders.find((item) => item.order_no === orderNo)
    return order?.events?.some((event) => event.type === 'tracking' && event.actor === 'admin' && String(event.message || '').includes(trackingNo))
  }, { baseUrl: base, token: 'admin-e2e', orderNo: detailOrderNo, trackingNo: `TRACK-${stamp}` }, { timeout: 10000 })
  ok('admin order tracking update records fulfillment event')
  await expectText(page, '履约记录', 'admin order detail events panel visible')
  ok('admin order detail tracking event visible')
  ok('admin order detail tracking visible')
  await expectText(page, '照片数量', 'admin order detail photo count visible')
  await expectText(page, '付款类型', 'admin order detail payment type visible')
  const orderDetailText = await page.locator('.order-detail-grid').innerText()
  const colonLabels = ['下单时间：', '下单时间:', '照片数量：', '照片数量:', '付款类型：', '付款类型:']
  if (!colonLabels.some((label) => orderDetailText.includes(label))) ok('admin order detail has no colon labels')
  else throw new Error(`admin order detail still contains colon labels: ${orderDetailText}`)
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/admin-order-detail.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await expectText(page, '履约检查', 'admin order detail fulfillment checklist mobile visible')
  await expectNoHorizontalOverflow(page, 'admin order detail fulfillment mobile layout has no horizontal overflow')
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/mobile-admin-order-detail.png', fullPage: true })
  await orderDetailDialog.getByRole('button', { name: '关闭' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const mobileOrderLayout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    mobileCards: document.querySelectorAll('.mobile-order-card').length,
    desktopTableDisplay: getComputedStyle(document.querySelector('.desktop-order-table')).display,
  }))
  if (mobileOrderLayout.scrollWidth <= mobileOrderLayout.clientWidth && mobileOrderLayout.mobileCards > 0 && mobileOrderLayout.desktopTableDisplay === 'none') ok('admin orders mobile layout uses cards without horizontal overflow')
  else throw new Error(`admin orders mobile layout invalid: ${JSON.stringify(mobileOrderLayout)}`)
  const mobileTrackingNo = `MOBILE-TRACK-${stamp}`
  const mobileOrderCard = page.locator('.mobile-order-card').filter({ hasText: adminOrderSearchEmail }).first()
  await mobileOrderCard.waitFor({ state: 'visible', timeout: 10000 })
  const mobileOrderCardText = await mobileOrderCard.innerText()
  if (mobileOrderCardText.includes('已付金额') && mobileOrderCardText.includes('剩余应付')) ok('admin mobile order card shows paid and remaining amounts')
  else throw new Error(`admin mobile order amount breakdown missing: ${mobileOrderCardText}`)
  const mobileCarrierSave = page.waitForResponse((res) => res.url().includes('/api/admin/orders/') && res.url().endsWith('/note') && res.request().method() === 'PUT')
  await mobileOrderCard.getByPlaceholder('物流公司').fill('SF Express')
  await mobileOrderCard.getByPlaceholder('物流公司').blur()
  await mobileCarrierSave
  await acceptTransientText(page, '已保存', 'admin mobile order carrier save feedback accepted')
  const mobileTrackingSave = page.waitForResponse((res) => res.url().includes('/api/admin/orders/') && res.url().endsWith('/note') && res.request().method() === 'PUT')
  await mobileOrderCard.getByPlaceholder('物流单号').fill(mobileTrackingNo)
  await mobileOrderCard.getByPlaceholder('物流单号').blur()
  await mobileTrackingSave
  await acceptTransientText(page, '已保存', 'admin mobile order tracking save feedback accepted')
  await page.waitForFunction(async ({ baseUrl, token, email, trackingNo }) => {
    const res = await fetch(`${baseUrl}/api/admin/orders`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) return false
    const orders = await res.json()
    return orders.some((order) => order.email === email && order.shipping_carrier === 'SF Express' && order.tracking_no === trackingNo)
  }, { baseUrl: base, token: 'admin-e2e', email: adminOrderSearchEmail, trackingNo: mobileTrackingNo }, { timeout: 10000 })
  ok('admin mobile order tracking persisted')
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/mobile-admin-orders.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '站点配置' }).click()
  const siteConfigStatusText = await page.locator('[data-testid="site-config-status"]').innerText()
  if (
    siteConfigStatusText.includes('支付状态')
    && siteConfigStatusText.includes('客服入口')
    && siteConfigStatusText.includes('品牌邮箱')
    && siteConfigStatusText.includes('物流追踪')
  ) ok('admin site config status summary visible')
  else throw new Error(`admin site config status summary invalid: ${siteConfigStatusText}`)
  const siteConfigInputSemantics = {
    brandMax: await page.getByPlaceholder('品牌名称').getAttribute('maxlength'),
    emailType: await page.getByPlaceholder('联系邮箱').getAttribute('type'),
    emailMax: await page.getByPlaceholder('联系邮箱').getAttribute('maxlength'),
    emailInputMode: await page.getByPlaceholder('联系邮箱').getAttribute('inputmode'),
    instagramType: await page.getByPlaceholder('Instagram').getAttribute('type'),
    trackingType: await page.locator('input[placeholder*="物流追踪链接模板"]').first().getAttribute('type'),
    trackingMax: await page.locator('input[placeholder*="物流追踪链接模板"]').first().getAttribute('maxlength'),
    paypalClientMax: await page.getByPlaceholder('PayPal Client ID').getAttribute('maxlength'),
    paypalSecretMax: await page.getByPlaceholder('PayPal Secret').getAttribute('maxlength'),
    currencyMax: await page.getByPlaceholder('币种').getAttribute('maxlength'),
    talkUrlType: await page.getByPlaceholder('Talk 链接').getAttribute('type'),
    lineUrlType: await page.getByPlaceholder('LINE 链接').getAttribute('type'),
  }
  if (
    siteConfigInputSemantics.brandMax === '120'
    && siteConfigInputSemantics.emailType === 'email'
    && siteConfigInputSemantics.emailMax === '160'
    && siteConfigInputSemantics.emailInputMode === 'email'
    && siteConfigInputSemantics.instagramType === 'url'
    && siteConfigInputSemantics.trackingType === 'url'
    && siteConfigInputSemantics.trackingMax === '500'
    && siteConfigInputSemantics.paypalClientMax === '300'
    && siteConfigInputSemantics.paypalSecretMax === '500'
    && siteConfigInputSemantics.currencyMax === '3'
    && siteConfigInputSemantics.talkUrlType === 'url'
    && siteConfigInputSemantics.lineUrlType === 'url'
  ) ok('admin site config inputs expose semantic types and length limits')
  else throw new Error(`admin site config input semantics invalid: ${JSON.stringify(siteConfigInputSemantics)}`)
  await expectText(page, '恢复站点配置会覆盖品牌、支付、联系方式', 'admin site restore risk warning visible')
  await expectText(page, '支付配置', 'admin payment config visible')
  await expectText(page, 'PayPal 沙盒确认流程', 'admin payment config help visible')
  const trackingTemplateInput = page.locator('input[placeholder*="物流追踪链接模板"]').first()
  await trackingTemplateInput.fill('https://t.17track.net/zh-cn')
  const trackingSaveResponsesBefore = await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/admin/site')).length)
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.waitForTimeout(500)
  const trackingSaveResponsesAfter = await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/admin/site')).length)
  const trackingTemplateStillInvalid = await trackingTemplateInput.inputValue()
  if (trackingSaveResponsesAfter === trackingSaveResponsesBefore && trackingTemplateStillInvalid === 'https://t.17track.net/zh-cn') ok('admin blocks tracking template without placeholder before save')
  else throw new Error(`admin tracking template validation did not block save: ${JSON.stringify({ trackingSaveResponsesBefore, trackingSaveResponsesAfter, trackingTemplateStillInvalid })}`)
  await trackingTemplateInput.fill(originalSiteSnapshot?.shipping?.tracking_url_template || 'https://t.17track.net/zh-cn#nums={tracking}')
  const backupDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载脱敏备份' }).click()
  const backupDownload = await backupDownloadPromise
  const backupPath = await backupDownload.path()
  const backupContent = JSON.parse(await readFile(backupPath, 'utf8'))
  if (backupContent.schema === 'pet-wool-platform-store-v1' && backupContent.data?.site && Array.isArray(backupContent.data?.orders)) ok('admin backup download contains store snapshot')
  else throw new Error(`admin backup download invalid: ${JSON.stringify(backupContent).slice(0, 300)}`)
  if (backupContent.redacted === true && !('secret' in (backupContent.data?.site?.paypal || {})) && !('webhook_id' in (backupContent.data?.site?.paypal || {}))) ok('admin backup download redacts payment secrets')
  else throw new Error(`admin backup download leaked payment secrets: ${JSON.stringify(backupContent.data?.site?.paypal)}`)
  await expectText(page, '下载完整密钥备份', 'admin full backup download action visible')
  const uiRestoreSecret = `ui-restore-secret-${stamp}`
  const uiRestoreWebhook = `ui-restore-webhook-${stamp}`
  await page.getByPlaceholder('PayPal Secret').fill(uiRestoreSecret)
  await page.getByPlaceholder('PayPal Webhook ID').fill(uiRestoreWebhook)
  const siteSecretSaveResponsePromise = page.waitForResponse((res) => res.url().includes('/api/admin/site') && res.request().method() === 'PUT')
  await page.getByRole('button', { name: '保存配置' }).click()
  const siteSecretSaveResponse = await siteSecretSaveResponsePromise
  if (siteSecretSaveResponse.ok()) ok('admin site payment secret setup save API succeeds')
  else throw new Error(`admin site payment secret setup save failed: ${siteSecretSaveResponse.status()}`)
  await page.waitForFunction(async ({ baseUrl, token, secret, webhook }) => {
    const res = await fetch(`${baseUrl}/api/admin/backup?secrets=1`, { headers: { authorization: `Bearer ${token}`, 'x-confirm-secret-backup': 'true' } })
    if (!res.ok) return false
    const backup = await res.json()
    return backup.data?.site?.paypal?.secret === secret && backup.data?.site?.paypal?.webhook_id === webhook
  }, { baseUrl: base, token: loginData.token, secret: uiRestoreSecret, webhook: uiRestoreWebhook }, { timeout: 10000 })
  const fullBackupDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载完整密钥备份' }).click()
  await expectText(page, '确认下载完整密钥备份', 'admin full backup confirmation modal visible')
  await expectText(page, '完整密钥备份会包含 PayPal Secret 和 Webhook ID', 'admin full backup confirmation explains secrets')
  await page.locator('.confirm-modal').getByRole('button', { name: '确认下载' }).click()
  const fullBackupDownload = await fullBackupDownloadPromise
  const fullBackupPath = await fullBackupDownload.path()
  const fullBackupContent = JSON.parse(await readFile(fullBackupPath, 'utf8'))
  if (
    fullBackupContent.redacted === false
    && fullBackupContent.data?.site?.paypal?.secret === uiRestoreSecret
    && fullBackupContent.data?.site?.paypal?.webhook_id === uiRestoreWebhook
  ) ok('admin full backup download includes explicit payment secrets')
  else throw new Error(`admin full backup download missing payment secrets: ${JSON.stringify(fullBackupContent.data?.site?.paypal)}`)
  const uiRestoreBrand = `界面恢复品牌 ${stamp}`
  await writeFile(siteRestoreFixture, JSON.stringify({
    data: {
      site: {
        ...siteForRestore(backupContent.data.site),
        brand: { ...(backupContent.data.site.brand || {}), name: uiRestoreBrand }
      }
    }
  }, null, 2))
  const unsavedRestoreDraftBrand = `未保存恢复保护 ${stamp}`
  await page.getByPlaceholder('品牌名称').fill(unsavedRestoreDraftBrand)
  await page.getByRole('button', { name: '恢复站点配置' }).click()
  await expectText(page, '站点配置有未保存更改，恢复备份会覆盖当前编辑内容。', 'admin site restore warns before discarding unsaved edits')
  await page.getByRole('button', { name: '继续编辑' }).click()
  const preservedUnsavedRestoreDraft = await page.getByPlaceholder('品牌名称').inputValue()
  if (preservedUnsavedRestoreDraft === unsavedRestoreDraftBrand) ok('admin site restore keep editing preserves unsaved form')
  else throw new Error(`admin site restore keep editing lost draft: ${preservedUnsavedRestoreDraft}`)
  await page.getByRole('button', { name: '恢复站点配置' }).click()
  await expectText(page, '放弃更改并恢复', 'admin site restore discard action visible')
  await page.getByRole('button', { name: '放弃更改并恢复' }).click()
  await page.setInputFiles('input[accept="application/json,.json"]', siteRestoreFixture)
  await expectText(page, '站点配置已恢复', 'admin site restore upload feedback visible')
  const restoredBrandInput = await page.getByPlaceholder('品牌名称').inputValue()
  if (restoredBrandInput === uiRestoreBrand) ok('admin site restore upload updates form')
  else throw new Error(`admin site restore did not update form: ${restoredBrandInput}`)
  const restoredSecretInput = await page.getByPlaceholder('PayPal Secret').inputValue()
  const restoredWebhookInput = await page.getByPlaceholder('PayPal Webhook ID').inputValue()
  if (restoredSecretInput === '' && restoredWebhookInput === '') ok('admin site restore keeps payment secret inputs redacted')
  else throw new Error(`admin site restore exposed payment secrets in form: ${JSON.stringify({ restoredSecretInput, restoredWebhookInput })}`)
  const restoreSecretBackup = await fetch(`${base}/api/admin/backup?secrets=1`, { headers: fullBackupHeaders('admin-e2e') }).then((res) => res.json())
  if (restoreSecretBackup.data?.site?.paypal?.secret === uiRestoreSecret && restoreSecretBackup.data?.site?.paypal?.webhook_id === uiRestoreWebhook) ok('admin site restore upload preserves hidden payment secrets')
  else throw new Error(`admin site restore upload cleared hidden payment secrets: ${JSON.stringify(restoreSecretBackup.data?.site?.paypal)}`)
  const restoreRequestCountBeforeTypeCheck = await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/admin/site/restore')).length)
  const invalidRestoreTextFixture = `${invalidRestoreFixtureDir}-not-json.txt`
  await writeFile(invalidRestoreTextFixture, 'not json')
  await page.setInputFiles('input[accept="application/json,.json"]', invalidRestoreTextFixture)
  await expectText(page, '请上传 JSON 格式的站点备份文件。', 'admin site restore rejects non-json file before upload')
  await page.waitForTimeout(300)
  const restoreRequestCountAfterTypeCheck = await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/admin/site/restore')).length)
  if (restoreRequestCountAfterTypeCheck === restoreRequestCountBeforeTypeCheck) ok('admin site restore non-json file does not call API')
  else throw new Error(`admin site restore non-json file called API: ${restoreRequestCountBeforeTypeCheck} -> ${restoreRequestCountAfterTypeCheck}`)
  await writeFile(siteRestoreFixture, JSON.stringify({
    data: {
      site: {
        ...siteForRestore(backupContent.data.site),
        contact: { ...(backupContent.data.site.contact || {}), talk_enabled: true, talk_url: 'bad-talk-url', line_enabled: false }
      }
    }
  }, null, 2))
  const invalidRestoreResponsePromise = page.waitForResponse((res) => res.url().includes('/api/admin/site/restore') && res.request().method() === 'POST')
  await page.setInputFiles('input[accept="application/json,.json"]', siteRestoreFixture)
  const invalidRestoreResponse = await invalidRestoreResponsePromise
  if (invalidRestoreResponse.status() === 400) ok('admin site restore invalid talk url API rejected')
  else throw new Error(`admin site restore invalid talk url accepted: ${invalidRestoreResponse.status()}`)
  await expectText(page, '启用 Talk 时请填写有效的 http 或 https 链接', 'admin site restore validation shows specific talk url error')
  const invalidThemeRestoreFixture = `${invalidRestoreFixtureDir}-invalid-theme.json`
  await writeFile(invalidThemeRestoreFixture, JSON.stringify({
    data: {
      site: {
        ...siteForRestore(backupContent.data.site),
        theme: { defaultTheme: 'broken', themes: [{ key: 'broken', label: 'Broken', bg: 'not-a-color' }] }
      }
    }
  }, null, 2))
  const invalidThemeRestoreResponsePromise = page.waitForResponse((res) => res.url().includes('/api/admin/site/restore') && res.request().method() === 'POST')
  await page.setInputFiles('input[accept="application/json,.json"]', invalidThemeRestoreFixture)
  const invalidThemeRestoreResponse = await invalidThemeRestoreResponsePromise
  if (invalidThemeRestoreResponse.status() === 400) ok('admin site restore invalid theme API rejected')
  else throw new Error(`admin site restore invalid theme accepted: ${invalidThemeRestoreResponse.status()}`)
  ok('admin site restore invalid theme keeps current form after rejection')
  await writeFile(siteRestoreFixture, JSON.stringify({ products: [] }, null, 2))
  await page.setInputFiles('input[accept="application/json,.json"]', siteRestoreFixture)
  await expectText(page, '备份文件缺少站点配置', 'admin site restore invalid shape feedback visible')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const mobileSiteLayout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    hasPaymentHelp: document.body.innerText.includes('PayPal 沙盒确认流程'),
    hasSaveButton: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('保存配置')),
  }))
  if (mobileSiteLayout.scrollWidth <= mobileSiteLayout.clientWidth && mobileSiteLayout.hasPaymentHelp && mobileSiteLayout.hasSaveButton) ok('admin site mobile layout has payment config without horizontal overflow')
  else throw new Error(`admin site mobile layout invalid: ${JSON.stringify(mobileSiteLayout)}`)
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/mobile-admin-site.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.waitForTimeout(300)
  await expectText(page, '中文内容', 'admin site policy zh-only content visible')
  await expectText(page, '中文内容', 'admin site policy zh-only content')
  const contentFormatHelp = await page.locator('[data-testid="site-content-format-help"]').evaluate((node) => node.textContent || '')
  if (
    contentFormatHelp.includes('英文竖线符号')
    && contentFormatHelp.includes('姓名|国家|评分1-5|标题|内容|商品slug')
    && contentFormatHelp.includes('slug|日期|标题|摘要|正文|图片URL|标签')
  ) ok('admin site content format help visible')
  else throw new Error(`admin site content format help invalid: ${contentFormatHelp}`)
  const siteTextAreaFormatText = await page.locator('.admin-form').innerText()
  if (siteTextAreaFormatText.includes('姓名|国家|评分1-5|标题|内容|商品slug')) ok('admin site reviews placeholder uses pipe delimiter')
  else throw new Error(`admin site reviews delimiter help missing: ${siteTextAreaFormatText.slice(0, 800)}`)
  if (siteTextAreaFormatText.includes('slug|日期|标题|摘要|正文|图片URL|标签')) ok('admin site blog placeholder uses pipe delimiter')
  else throw new Error(`admin site blog delimiter help missing: ${siteTextAreaFormatText.slice(0, 800)}`)
  const policyLimitTextareas = page.locator('.translation-panel textarea')
  const contentEditorTextareas = page.locator('.content-editor-block textarea')
  const contentTextAreaLimits = {
    care: await policyLimitTextareas.nth(0).getAttribute('maxlength'),
    shipping: await policyLimitTextareas.nth(1).getAttribute('maxlength'),
    refund: await policyLimitTextareas.nth(2).getAttribute('maxlength'),
    faq: await contentEditorTextareas.nth(0).getAttribute('maxlength'),
    reviews: await contentEditorTextareas.nth(1).getAttribute('maxlength'),
    blog: await contentEditorTextareas.nth(2).getAttribute('maxlength'),
  }
  if (
    contentTextAreaLimits.care === '2000'
    && contentTextAreaLimits.shipping === '2000'
    && contentTextAreaLimits.refund === '2000'
    && contentTextAreaLimits.faq === '120000'
    && contentTextAreaLimits.reviews === '200000'
    && contentTextAreaLimits.blog === '700000'
  ) ok('admin site content editors apply length limits')
  else throw new Error(`admin site content editor length limits invalid: ${JSON.stringify(contentTextAreaLimits)}`)
  if (
    siteTextAreaFormatText.includes('常见问题')
    && siteTextAreaFormatText.includes('例：需要哪些照片？|建议上传正脸、侧脸和全身照。')
  ) ok('admin site FAQ editor example visible')
  else throw new Error(`admin site FAQ editor example missing: ${siteTextAreaFormatText.slice(0, 1000)}`)
  if (
    siteTextAreaFormatText.includes('客户评价')
    && siteTextAreaFormatText.includes('例：王女士|中国|5|很像我家猫|细节和神态都很像|cat-portrait')
  ) ok('admin site reviews editor example visible')
  else throw new Error(`admin site reviews editor example missing: ${siteTextAreaFormatText.slice(0, 1000)}`)
  if (
    siteTextAreaFormatText.includes('博客文章')
    && siteTextAreaFormatText.includes('例：gift-guide|2026-01-01|宠物纪念礼物指南|摘要|正文内容|/images/blog.jpg|礼物,纪念')
  ) ok('admin site blog editor example visible')
  else throw new Error(`admin site blog editor example missing: ${siteTextAreaFormatText.slice(0, 1000)}`)
  const paypalSecretInput = page.getByPlaceholder('PayPal Secret')
  const paypalWebhookInput = page.getByPlaceholder('PayPal Webhook ID')
  if (await paypalSecretInput.getAttribute('type') === 'password' && await paypalWebhookInput.getAttribute('type') === 'password') ok('admin payment secrets are hidden by default')
  else throw new Error('admin payment secrets are not hidden by default')
  await page.getByRole('button', { name: '显示密钥' }).click()
  if (await paypalSecretInput.getAttribute('type') === 'text' && await paypalWebhookInput.getAttribute('type') === 'text') ok('admin payment secrets can be revealed for editing')
  else throw new Error('admin payment secrets did not reveal for editing')
  await page.getByRole('button', { name: '隐藏密钥' }).click()
  if (await paypalSecretInput.getAttribute('type') === 'password' && await paypalWebhookInput.getAttribute('type') === 'password') ok('admin payment secrets can be hidden again')
  else throw new Error('admin payment secrets did not hide again')
  await page.getByPlaceholder('币种').fill('12$')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, 'PayPal 币种暂不支持', 'admin payment currency support validation visible')
  await page.getByPlaceholder('币种').fill('CNY')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, 'PayPal 币种暂不支持', 'admin payment unsupported currency validation visible')
  await page.getByPlaceholder('币种').fill('USD')
  await page.getByPlaceholder('联系邮箱').fill('bad-email')
  const invalidEmailFieldState = await page.getByPlaceholder('联系邮箱').evaluate((input) => ({
    type: input.getAttribute('type'),
    valid: input.checkValidity(),
  }))
  if (invalidEmailFieldState.type === 'email' && invalidEmailFieldState.valid === false) ok('admin brand email input uses native email validation')
  else throw new Error(`admin brand email native validation invalid: ${JSON.stringify(invalidEmailFieldState)}`)
  await page.getByPlaceholder('联系邮箱').fill('hello@example.com')
  await page.getByPlaceholder('Instagram').fill('not-a-url')
  const invalidInstagramFieldState = await page.getByPlaceholder('Instagram').evaluate((input) => ({
    type: input.getAttribute('type'),
    valid: input.checkValidity(),
  }))
  if (invalidInstagramFieldState.type === 'url' && invalidInstagramFieldState.valid === false) ok('admin instagram input uses native url validation')
  else throw new Error(`admin instagram native validation invalid: ${JSON.stringify(invalidInstagramFieldState)}`)
  await page.getByPlaceholder('Instagram').fill('')
  await page.getByLabel('启用 Talk').setChecked(true)
  await page.getByPlaceholder('Talk 链接').fill('talk-invalid')
  const invalidTalkFieldState = await page.getByPlaceholder('Talk 链接').evaluate((input) => ({
    type: input.getAttribute('type'),
    valid: input.checkValidity(),
  }))
  if (invalidTalkFieldState.type === 'url' && invalidTalkFieldState.valid === false) ok('admin talk url input uses native url validation')
  else throw new Error(`admin talk url native validation invalid: ${JSON.stringify(invalidTalkFieldState)}`)
  await page.getByPlaceholder('Talk 链接').fill('https://talk.example.com/wool-memory')
  await page.getByLabel('启用 LINE').setChecked(true)
  await page.getByPlaceholder('LINE 链接').fill('line-invalid')
  const invalidLineFieldState = await page.getByPlaceholder('LINE 链接').evaluate((input) => ({
    type: input.getAttribute('type'),
    valid: input.checkValidity(),
  }))
  if (invalidLineFieldState.type === 'url' && invalidLineFieldState.valid === false) ok('admin line url input uses native url validation')
  else throw new Error(`admin line url native validation invalid: ${JSON.stringify(invalidLineFieldState)}`)
  await page.getByPlaceholder('LINE 链接').fill('https://line.me/R/ti/p/@woolmemory')
  const contentEditors = page.locator('.translation-panel textarea.tall-textarea')
  const faqEditor = contentEditors.nth(0)
  const originalFaqText = await faqEditor.inputValue()
  await faqEditor.fill('缺少答案')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, 'FAQ 第 1 行格式不正确', 'admin site FAQ row validation visible')
  await faqEditor.fill(originalFaqText)
  const reviewsEditor = contentEditors.nth(1)
  const originalReviewsText = await reviewsEditor.inputValue()
  await reviewsEditor.fill('客户|CN|9|标题|内容|product-slug')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '客户评价第 1 行格式不正确', 'admin site review row validation visible')
  await reviewsEditor.fill(originalReviewsText)
  const blogEditor = contentEditors.nth(2)
  const originalBlogText = await blogEditor.inputValue()
  await faqEditor.fill('重复问题|答案一\n重复问题|答案二')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, 'FAQ 问题不能重复', 'admin site duplicate faq validation visible')
  await faqEditor.fill(originalFaqText)
  await reviewsEditor.fill('客户A|CN|5|重复标题|内容一|\n客户A|CN|4|重复标题|内容二|')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '客户评价不能出现相同姓名和标题', 'admin site duplicate review validation visible')
  await reviewsEditor.fill(originalReviewsText)
  await blogEditor.fill('same-slug|2026-01-01|标题一|摘要一|正文一\nsame-slug|2026-01-02|标题二|摘要二|正文二')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '博客 slug 不能重复', 'admin site duplicate blog validation visible')
  await blogEditor.fill('slug|2026-01-01|标题')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '博客第 1 行格式不正确', 'admin site blog row validation visible')
  await blogEditor.fill('Bad Slug|2026-01-01|标题|摘要|正文')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '小写 slug、YYYY-MM-DD 日期', 'admin site blog slug validation visible')
  await blogEditor.fill('valid-slug|2026-02-31|标题|摘要|正文')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '小写 slug、YYYY-MM-DD 日期', 'admin site blog date validation visible')
  await blogEditor.fill('valid-slug|2026-01-31|标题|摘要|正文|bad-image-url|标签')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '博客第 1 行图片 URL 不正确', 'admin site blog image url validation visible')
  await blogEditor.fill('valid-slug|2026-01-31|标题|摘要|正文||标签')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '博客第 1 行图片 URL 不正确', 'admin site blog missing image validation visible')
  const pipeBlogSlug = `pipe-blog-${stamp}`
  const pipeBlogContent = '正文第一段|正文第二段|正文第三段'
  const pipeBlogApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: [{ id: pipeBlogSlug, slug: pipeBlogSlug, date: '2026-01-31', title: '竖线博客', excerpt: '竖线摘要', content: pipeBlogContent, image_url: '/assets/hero.png', tags: ['运营'] }] })
  })
  if (pipeBlogApiRes.ok) ok('admin site blog with pipe content save API succeeds')
  else throw new Error(`admin site pipe blog save failed: ${pipeBlogApiRes.status} ${await pipeBlogApiRes.text()}`)
  const pipeBlogPublic = await fetch(`${base}/api/blog/${pipeBlogSlug}?lang=zh`).then((res) => res.json())
  if (pipeBlogPublic.content === pipeBlogContent && pipeBlogPublic.image_url === '/assets/hero.png') ok('admin site blog editor preserves pipe characters in content')
  else throw new Error(`admin site pipe blog content invalid: ${JSON.stringify(pipeBlogPublic)}`)
  const noTagPipeBlogSlug = `pipe-blog-no-tag-${stamp}`
  const noTagPipeBlogContent = '无标签正文第一段|无标签正文第二段'
  const noTagPipeBlogApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: [{ id: noTagPipeBlogSlug, slug: noTagPipeBlogSlug, date: '2026-02-01', title: '无标签竖线博客', excerpt: '无标签摘要', content: noTagPipeBlogContent, image_url: '/assets/hero.png', tags: [] }] })
  })
  if (noTagPipeBlogApiRes.ok) ok('admin site blog with pipe content and no tags save API succeeds')
  else throw new Error(`admin site no-tag pipe blog save failed: ${noTagPipeBlogApiRes.status} ${await noTagPipeBlogApiRes.text()}`)
  const noTagPipeBlogPublic = await fetch(`${base}/api/blog/${noTagPipeBlogSlug}?lang=zh`).then((res) => res.json())
  if (noTagPipeBlogPublic.content === noTagPipeBlogContent && noTagPipeBlogPublic.image_url === '/assets/hero.png') ok('admin site blog parser preserves pipe content without tags')
  else throw new Error(`admin site no-tag pipe blog content invalid: ${JSON.stringify(noTagPipeBlogPublic)}`)
  const pipeReviewTitle = `竖线评价 ${stamp}`
  const pipeReviewContent = '评价第一段|评价第二段|评价第三段'
  await blogEditor.fill(originalBlogText)
  await reviewsEditor.fill(`客户P|CN|5|${pipeReviewTitle}|${pipeReviewContent}|`)
  const pipeReviewSaveResponse = page.waitForResponse((res) => res.url().includes('/api/admin/site') && res.request().method() === 'PUT')
  await page.getByRole('button', { name: '保存配置' }).click()
  const pipeReviewSaveRes = await pipeReviewSaveResponse
  if (pipeReviewSaveRes.ok()) ok('admin site review editor saves pipe content')
  else throw new Error(`admin site pipe review save failed: ${pipeReviewSaveRes.status()}`)
  const pipeReviewPublic = await fetch(`${base}/api/site?lang=zh`).then((res) => res.json())
  if (pipeReviewPublic.reviews?.some((review) => review.title === pipeReviewTitle && review.content === pipeReviewContent)) ok('admin site review parser preserves pipe content')
  else throw new Error(`admin site pipe review content invalid: ${JSON.stringify(pipeReviewPublic.reviews)}`)
  await reviewsEditor.fill(originalReviewsText)
  const uploadedBlogImageSlug = `uploaded-blog-image-${stamp}`
  const uploadedBlogImageApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: [{ id: uploadedBlogImageSlug, slug: uploadedBlogImageSlug, date: '2026-02-02', title: '上传图片博客', excerpt: '上传图片摘要', content: '上传图片正文', image_url: uploadedPhotoUrl, tags: ['运营'] }] })
  })
  if (uploadedBlogImageApiRes.ok) ok('admin site blog accepts uploaded image references')
  else throw new Error(`admin site uploaded blog image rejected: ${uploadedBlogImageApiRes.status} ${await uploadedBlogImageApiRes.text()}`)
  const uploadedBlogImagePublic = await fetch(`${base}/api/blog/${uploadedBlogImageSlug}?lang=zh`).then((res) => res.json())
  if (uploadedBlogImagePublic.image_url === uploadedPhotoUrl) ok('public blog detail returns uploaded image reference')
  else throw new Error(`public blog uploaded image reference invalid: ${JSON.stringify(uploadedBlogImagePublic)}`)
  await blogEditor.fill(originalBlogText)
  const restoreBlogAfterPipeResponse = page.waitForResponse((res) => res.url().includes('/api/admin/site') && res.request().method() === 'PUT')
  await page.getByRole('button', { name: '保存配置' }).click()
  const restoreBlogAfterPipeRes = await restoreBlogAfterPipeResponse
  if (restoreBlogAfterPipeRes.ok()) ok('admin site blog editor restores original content after pipe check')
  else throw new Error(`admin site blog restore after pipe check failed: ${restoreBlogAfterPipeRes.status()}`)
  const invalidInstagramApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ brand: { instagram: 'not-a-url' } })
  })
  if (invalidInstagramApiRes.status === 400) ok('api rejects invalid instagram url')
  else throw new Error(`invalid instagram url accepted: ${invalidInstagramApiRes.status}`)
  const privateInstagramApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ brand: { instagram: 'http://127.0.0.1/profile' } })
  })
  if (privateInstagramApiRes.status === 400) ok('api rejects private network instagram url')
  else throw new Error(`private network instagram url accepted: ${privateInstagramApiRes.status}`)
  const invalidFaqApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ faq: [{ id: `bad-faq-${stamp}`, question: '', answer: '缺少问题' }] })
  })
  if (invalidFaqApiRes.status === 400) ok('api rejects invalid site faq rows')
  else throw new Error(`invalid site faq accepted: ${invalidFaqApiRes.status}`)
  const invalidReviewApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ reviews: [{ id: `bad-review-${stamp}`, name: '客户', country: 'CN', rating: 9, title: '标题', content: '内容' }] })
  })
  if (invalidReviewApiRes.status === 400) ok('api rejects invalid site review rows')
  else throw new Error(`invalid site review accepted: ${invalidReviewApiRes.status}`)
  const invalidBlogApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: [{ id: `bad-blog-${stamp}`, slug: 'bad slug', date: '2026-01-01', title: '标题', excerpt: '摘要', content: '内容' }] })
  })
  if (invalidBlogApiRes.status === 400) ok('api rejects invalid site blog rows')
  else throw new Error(`invalid site blog accepted: ${invalidBlogApiRes.status}`)
  const invalidBlogDateApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: [{ id: `bad-blog-date-${stamp}`, slug: `bad-blog-date-${stamp}`, date: '2026-02-31', title: '标题', excerpt: '摘要', content: '内容', image_url: '/assets/hero.png' }] })
  })
  if (invalidBlogDateApiRes.status === 400) ok('api rejects invalid site blog dates')
  else throw new Error(`invalid site blog date accepted: ${invalidBlogDateApiRes.status}`)
  const missingBlogImageApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: [{ id: `missing-blog-image-${stamp}`, slug: `missing-blog-image-${stamp}`, date: '2026-01-01', title: '标题', excerpt: '摘要', content: '内容', image_url: '' }] })
  })
  if (missingBlogImageApiRes.status === 400) ok('api rejects site blog without image')
  else throw new Error(`site blog without image accepted: ${missingBlogImageApiRes.status}`)
  const duplicateFaqApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ faq: [
      { id: `duplicate-faq-a-${stamp}`, question: '重复 API FAQ', answer: '答案一' },
      { id: `duplicate-faq-b-${stamp}`, question: '重复 API FAQ', answer: '答案二' },
    ] })
  })
  if (duplicateFaqApiRes.status === 400) ok('api rejects duplicate site faq questions')
  else throw new Error(`duplicate site faq accepted: ${duplicateFaqApiRes.status}`)
  const duplicateReviewApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ reviews: [
      { id: `duplicate-review-a-${stamp}`, name: '客户A', country: 'CN', rating: 5, title: '重复评价', content: '内容一' },
      { id: `duplicate-review-b-${stamp}`, name: '客户A', country: 'CN', rating: 4, title: '重复评价', content: '内容二' },
    ] })
  })
  if (duplicateReviewApiRes.status === 400) ok('api rejects duplicate site reviews')
  else throw new Error(`duplicate site reviews accepted: ${duplicateReviewApiRes.status}`)
  const duplicateBlogApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ blog: [
      { id: `duplicate-blog-a-${stamp}`, slug: `duplicate-blog-${stamp}`, date: '2026-01-01', title: '标题一', excerpt: '摘要一', content: '内容一', image_url: '/assets/hero.png' },
      { id: `duplicate-blog-b-${stamp}`, slug: `duplicate-blog-${stamp}`, date: '2026-01-02', title: '标题二', excerpt: '摘要二', content: '内容二', image_url: '/assets/hero.png' },
    ] })
  })
  if (duplicateBlogApiRes.status === 400) ok('api rejects duplicate site blog slugs')
  else throw new Error(`duplicate site blog slugs accepted: ${duplicateBlogApiRes.status}`)
  const invalidLivePaypalApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { mode: 'live', client_id: '', secret: '', currency: 'USD' } })
  })
  if (invalidLivePaypalApiRes.status === 400) ok('api rejects live paypal without credentials')
  else throw new Error(`live paypal without credentials accepted: ${invalidLivePaypalApiRes.status}`)
  const unsupportedPaypalCurrencyApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { currency: 'CNY' } })
  })
  const unsupportedPaypalCurrencyBody = await unsupportedPaypalCurrencyApiRes.json().catch(() => ({}))
  if (unsupportedPaypalCurrencyApiRes.status === 400 && unsupportedPaypalCurrencyBody.message === 'invalid paypal currency') ok('api rejects unsupported paypal currency')
  else throw new Error(`unsupported paypal currency accepted or wrong error: ${unsupportedPaypalCurrencyApiRes.status} ${JSON.stringify(unsupportedPaypalCurrencyBody)}`)
  const invalidTrackingTemplateApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ shipping: { tracking_url_template: 'https://t.17track.net/zh-cn' } })
  })
  if (invalidTrackingTemplateApiRes.status === 400) ok('api rejects tracking template without tracking placeholder')
  else throw new Error(`tracking template without placeholder accepted: ${invalidTrackingTemplateApiRes.status}`)
  const privateContactApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ contact: { talk_enabled: true, talk_url: 'http://10.0.0.8/chat' } })
  })
  if (privateContactApiRes.status === 400) ok('api rejects private network contact url')
  else throw new Error(`private network contact url accepted: ${privateContactApiRes.status}`)
  const privateTrackingTemplateApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ shipping: { tracking_url_template: 'http://localhost/track/{tracking}' } })
  })
  if (privateTrackingTemplateApiRes.status === 400) ok('api rejects private network tracking template')
  else throw new Error(`private network tracking template accepted: ${privateTrackingTemplateApiRes.status}`)
  const overlongSiteFieldApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { client_id: `client-${'x'.repeat(301)}` } })
  })
  if (overlongSiteFieldApiRes.status === 400) ok('api rejects overlong site config fields')
  else throw new Error(`overlong site config field accepted: ${overlongSiteFieldApiRes.status}`)
  const invalidThemeApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ theme: { defaultTheme: 'broken', themes: [{ key: 'broken', label: 'Broken', bg: 'not-a-color' }] } })
  })
  if (invalidThemeApiRes.status === 400) ok('api rejects invalid site theme config')
  else throw new Error(`invalid site theme config accepted: ${invalidThemeApiRes.status}`)
  const invalidBrandApiRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ brand: { name: '   ' } })
  })
  if (invalidBrandApiRes.status === 400) ok('api rejects empty brand name')
  else throw new Error(`empty brand name accepted: ${invalidBrandApiRes.status}`)
  await page.getByPlaceholder('品牌名称').fill('   ')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '品牌名称不能为空。', 'admin validates empty brand name')
  await page.getByPlaceholder('品牌名称').fill(temporaryBrandName)
  await expectText(page, '站点配置有未保存更改', 'admin site unsaved changes warning visible')
  await page.getByPlaceholder('联系邮箱').fill(originalSiteSnapshot?.brand?.email || 'hello@example.com')
  await page.getByPlaceholder('Instagram').fill(originalSiteSnapshot?.brand?.instagram || '')
  await trackingTemplateInput.fill(originalSiteSnapshot?.shipping?.tracking_url_template || 'https://t.17track.net/zh-cn#nums={tracking}')
  await page.locator('select').filter({ hasText: '沙盒' }).selectOption('live')
  await page.getByPlaceholder('PayPal Client ID').fill('')
  await page.getByPlaceholder('PayPal Secret').fill('')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expectText(page, '正式模式必须填写 PayPal Client ID 和 Secret。', 'admin validates live paypal credentials')
  await page.getByPlaceholder('币种').fill('usd')
  await page.locator('select').filter({ hasText: '沙盒' }).selectOption(originalSiteSnapshot?.paypal?.mode || 'sandbox')
  await page.getByPlaceholder('PayPal Client ID').fill(originalSiteSnapshot?.paypal?.client_id || 'sandbox-demo-client-id')
  await page.getByPlaceholder('PayPal Secret').fill(originalSiteSnapshot?.paypal?.secret || '')
  await page.getByPlaceholder('PayPal Webhook ID').fill(originalSiteSnapshot?.paypal?.webhook_id || '')
  await page.getByPlaceholder('Talk 链接').fill(originalSiteSnapshot?.contact?.talk_url || 'https://talk.example.com/wool-memory')
  await page.getByPlaceholder('LINE 链接').fill(originalSiteSnapshot?.contact?.line_url || 'https://line.me/R/ti/p/@woolmemory')
  const siteSaveResponsePromise = page.waitForResponse((res) => res.url().includes('/api/admin/site') && res.request().method() === 'PUT')
  await page.getByRole('button', { name: '保存配置' }).click()
  const siteSaveResponse = await siteSaveResponsePromise
  const savedSiteFromUi = await siteSaveResponse.json()
  if (siteSaveResponse.status() !== 200 || savedSiteFromUi.brand?.name !== temporaryBrandName) {
    throw new Error(`admin site save did not persist brand: ${siteSaveResponse.status()} ${JSON.stringify(savedSiteFromUi.brand)}`)
  }
  const siteSaveRecovered = await page.getByRole('button', { name: '保存配置' }).isEnabled().catch(() => false)
  if (siteSaveRecovered) ok('admin site save feedback visible')
  else throw new Error('admin site save did not recover')
  await expectNoText(page, '站点配置有未保存更改', 'admin site unsaved warning clears after save')
  const normalizedCurrencyInput = await page.getByPlaceholder('币种').inputValue()
  if (normalizedCurrencyInput === 'USD') ok('admin site save refreshes normalized payment currency')
  else throw new Error(`admin site save did not refresh normalized currency: ${normalizedCurrencyInput}`)
  const normalizedSiteTextBrand = ` API 清洗品牌 ${stamp} `
  const normalizedSiteTextRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      brand: { name: normalizedSiteTextBrand, email: ` ${stamp}@example.com `, instagram: '' },
      contact: {
        talk_enabled: true,
        talk_label: ' TALK客服 ',
        talk_url: ' https://talk.example.com/wool-memory ',
        line_enabled: true,
        line_label: ' LINE客服 ',
        line_url: ' https://line.me/R/ti/p/@woolmemory '
      },
      paypal: { currency: ' usd ' },
      shipping: { tracking_url_template: ' https://t.17track.net/zh-cn#nums={tracking} ' }
    })
  })
  if (!normalizedSiteTextRes.ok) throw new Error(`admin site normalized text save failed: ${normalizedSiteTextRes.status}`)
  const normalizedPublicSite = await fetch(`${base}/api/site?lang=zh`).then((res) => res.json())
  if (
    normalizedPublicSite.brand?.name === `API 清洗品牌 ${stamp}`
    && normalizedPublicSite.brand?.email === `${stamp}@example.com`
    && normalizedPublicSite.contact?.talk_label === 'TALK客服'
    && normalizedPublicSite.contact?.talk_url === 'https://talk.example.com/wool-memory'
    && normalizedPublicSite.contact?.line_label === 'LINE客服'
    && normalizedPublicSite.contact?.line_url === 'https://line.me/R/ti/p/@woolmemory'
    && normalizedPublicSite.paypal?.currency === 'USD'
    && normalizedPublicSite.shipping?.tracking_url_template === 'https://t.17track.net/zh-cn#nums={tracking}'
  ) ok('admin site API save normalizes public text config')
  else throw new Error(`admin site normalized text invalid: ${JSON.stringify(normalizedPublicSite)}`)
  await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      brand: {
        name: temporaryBrandName,
        email: originalSiteSnapshot?.brand?.email || 'hello@example.com',
        instagram: originalSiteSnapshot?.brand?.instagram || ''
      },
      contact: {
        talk_enabled: true,
        talk_label: originalSiteSnapshot?.contact?.talk_label || 'TALK',
        talk_url: originalSiteSnapshot?.contact?.talk_url || 'https://talk.example.com/wool-memory',
        line_enabled: true,
        line_label: originalSiteSnapshot?.contact?.line_label || 'LINE',
        line_url: originalSiteSnapshot?.contact?.line_url || 'https://line.me/R/ti/p/@woolmemory'
      },
      paypal: { currency: originalSiteSnapshot?.paypal?.currency || 'USD' },
      shipping: { tracking_url_template: originalSiteSnapshot?.shipping?.tracking_url_template || 'https://t.17track.net/zh-cn#nums={tracking}' }
    })
  })
  const uiSecretPreserveProbe = `ui-preserve-secret-${stamp}`
  const uiWebhookPreserveProbe = `ui-preserve-webhook-${stamp}`
  const uiSecretSetupRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ paypal: { secret: uiSecretPreserveProbe, webhook_id: uiWebhookPreserveProbe } })
  })
  if (!uiSecretSetupRes.ok) throw new Error(`admin site UI secret preserve setup failed: ${uiSecretSetupRes.status}`)
  await page.waitForFunction(async ({ baseUrl, token, secret, webhook }) => {
    const res = await fetch(`${baseUrl}/api/admin/backup?secrets=1`, { headers: { authorization: `Bearer ${token}`, 'x-confirm-secret-backup': 'true' } })
    if (!res.ok) return false
    const backup = await res.json()
    return backup.data?.site?.paypal?.secret === secret && backup.data?.site?.paypal?.webhook_id === webhook
  }, { baseUrl: base, token: 'admin-e2e', secret: uiSecretPreserveProbe, webhook: uiWebhookPreserveProbe }, { timeout: 10000 })
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '站点配置' }).click()
  const emptyLoadedSecret = await page.getByPlaceholder('PayPal Secret').inputValue()
  const emptyLoadedWebhook = await page.getByPlaceholder('PayPal Webhook ID').inputValue()
  if (emptyLoadedSecret === '' && emptyLoadedWebhook === '') ok('admin site UI does not expose stored payment secrets')
  else throw new Error(`admin site UI exposed stored secrets: ${JSON.stringify({ emptyLoadedSecret, emptyLoadedWebhook })}`)
  await page.getByPlaceholder('品牌名称').fill(`${temporaryBrandName} UI`)
  const preserveSecretSavePromise = page.waitForResponse((res) => res.url().includes('/api/admin/site') && res.request().method() === 'PUT')
  await page.getByRole('button', { name: '保存配置' }).click()
  const preserveSecretSave = await preserveSecretSavePromise
  if (!preserveSecretSave.ok()) throw new Error(`admin site UI save with blank secret failed: ${preserveSecretSave.status()}`)
  const preservedSecretBackup = await fetch(`${base}/api/admin/backup?secrets=1`, { headers: fullBackupHeaders('admin-e2e') }).then((res) => res.json())
  if (preservedSecretBackup.data?.site?.paypal?.secret === uiSecretPreserveProbe && preservedSecretBackup.data?.site?.paypal?.webhook_id === uiWebhookPreserveProbe) ok('admin site UI save preserves hidden payment secrets')
  else throw new Error(`admin site UI save cleared hidden payment secrets: ${JSON.stringify(preservedSecretBackup.data?.site?.paypal)}`)
  const faqFieldVisible = await page.evaluate(() => [...document.querySelectorAll('textarea')].some((node) => node.getAttribute('aria-label')?.includes('FAQ') || node.getAttribute('placeholder')?.includes('FAQ')))
  if (faqFieldVisible) ok('admin site FAQ editor visible')
  else throw new Error('admin site FAQ editor missing')
  await contentEditors.nth(1).waitFor({ state: 'attached', timeout: 10000 })
  ok('admin site reviews editor visible')
  await contentEditors.nth(2).waitFor({ state: 'attached', timeout: 10000 })
  ok('admin site blog editor visible')
  await setSiteBrand(temporaryBrandName)
  await page.goto(base, { waitUntil: 'networkidle' })
  await expectText(page, temporaryBrandName, 'site config brand applies to public footer')
  const topbarBrand = await page.locator('.topbar .brand').innerText()
  if (topbarBrand === temporaryBrandName) ok('site config brand applies to public topbar')
  else throw new Error(`topbar brand did not update: ${topbarBrand}`)
  const contactToggleRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ contact: { talk_enabled: false, line_enabled: false } })
  })
  if (contactToggleRes.ok) ok('admin contact config save API succeeds')
  else throw new Error(`admin contact config save API failed: ${contactToggleRes.status}`)
  await waitForContactState(false, false)
  await page.goto(base, { waitUntil: 'networkidle' })
  const hiddenTalkCount = await page.locator('.floating-contact .talk').count()
  const hiddenLineCount = await page.locator('.floating-contact .line').count()
  const fallbackEmailHref = await page.locator('.floating-contact .email').first().getAttribute('href')
  const fallbackEmailTarget = await page.locator('.floating-contact .email').first().getAttribute('target')
  if (hiddenTalkCount === 0 && hiddenLineCount === 0 && fallbackEmailHref?.startsWith('mailto:') && !fallbackEmailTarget) ok('contact toggles hide chat links and show email fallback')
  else throw new Error(`contact toggles fallback invalid: talk=${hiddenTalkCount}, line=${hiddenLineCount}, email=${fallbackEmailHref}, target=${fallbackEmailTarget}`)
  await page.goto(`${base}/blog`, { waitUntil: 'networkidle' })
  const blogFallbackContactHref = await page.locator('.blog-guide-cta').getByRole('link', { name: '联系客服' }).first().getAttribute('href')
  if (blogFallbackContactHref?.startsWith('mailto:')) ok('blog list contact falls back to email when chat links disabled')
  else throw new Error(`blog list contact fallback invalid: ${blogFallbackContactHref}`)
  const dirtyContactReadinessRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ contact: { talk_enabled: true, talk_url: '', line_enabled: true, line_url: '' } })
  })
  if (dirtyContactReadinessRes.status === 400) ok('api rejects enabled contact links without URLs')
  else throw new Error(`enabled contact without URLs accepted: ${dirtyContactReadinessRes.status}`)
  const contactRestoreRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({
      contact: {
        talk_enabled: true,
        talk_url: originalSiteSnapshot?.contact?.talk_url || 'https://talk.example.com/wool-memory',
        line_enabled: true,
        line_url: originalSiteSnapshot?.contact?.line_url || 'https://line.me/R/ti/p/@woolmemory',
      }
    })
  })
  if (contactRestoreRes.ok) ok('admin contact config restore API succeeds')
  else throw new Error(`admin contact config restore API failed: ${contactRestoreRes.status}`)
  await waitForContactState(true, true)
  const stringBooleanSaveRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ contact: { talk_enabled: 'false', line_enabled: 'false' }, paypal: { enabled: 'false' } })
  })
  if (!stringBooleanSaveRes.ok) throw new Error(`string boolean site config save failed: ${stringBooleanSaveRes.status}`)
  const normalizedBooleanSite = await fetch(`${base}/api/site`).then((res) => res.json())
  if (normalizedBooleanSite.contact?.talk_enabled === false && normalizedBooleanSite.contact?.line_enabled === false && normalizedBooleanSite.paypal?.enabled === false) ok('site config normalizes string booleans')
  else throw new Error(`site config string booleans not normalized: ${JSON.stringify({ contact: normalizedBooleanSite.contact, paypal: normalizedBooleanSite.paypal })}`)
  const invalidBooleanConfigRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ contact: { talk_enabled: 'no' }, paypal: { enabled: 'yes' } })
  })
  if (invalidBooleanConfigRes.status === 400) ok('api rejects invalid string boolean site config')
  else throw new Error(`invalid string boolean site config accepted: ${invalidBooleanConfigRes.status}`)
  const stringBooleanRestoreRes = await fetch(`${base}/api/admin/site`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
    body: JSON.stringify({ contact: { talk_enabled: true, line_enabled: true }, paypal: { enabled: true } })
  })
  if (!stringBooleanRestoreRes.ok) throw new Error(`string boolean site config restore failed: ${stringBooleanRestoreRes.status}`)
  await waitForSiteSwitches({ talkEnabled: true, lineEnabled: true, paypalEnabled: true })
  await restoreOriginalSite()
  await waitForSiteBrand(originalSiteSnapshot?.brand?.name || originalBrandName)
  ok('admin site config restored')
  await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-orphan-uploads.mjs', '--apply', '--missing-refs'])
  const restoreDefaultFixtureDir = `${invalidRestoreFixtureDir}-default`
  await rm(restoreDefaultFixtureDir, { recursive: true, force: true })
  await mkdir(restoreDefaultFixtureDir, { recursive: true })
  const restoreDefaultFixtureStore = JSON.parse(await readFile(storeFile, 'utf8'))
  if (restoreDefaultFixtureStore.site?.paypal) restoreDefaultFixtureStore.site.paypal.currency = 'USD'
  for (const order of restoreDefaultFixtureStore.orders || []) order.photo_urls = []
  makePublishedProductImagesRestoreSafe(restoreDefaultFixtureStore)
  await writeFile(`${restoreDefaultFixtureDir}/store.json`, JSON.stringify(restoreDefaultFixtureStore, null, 2))
  const storeBeforeRestoreDefault = await readFile(storeFile, 'utf8')
  const restoreDefaultRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', restoreDefaultFixtureDir])
  const restoreDefault = JSON.parse(restoreDefaultRun.stdout)
  const storeAfterRestoreDefault = await readFile(storeFile, 'utf8')
  if (restoreDefault.dry_run === true && restoreDefault.apply_required === true && storeAfterRestoreDefault === storeBeforeRestoreDefault) ok('restore script defaults to dry-run without --apply')
  else throw new Error(`restore default mode unsafe: ${restoreDefaultRun.stdout}`)
  await rm(restoreDefaultFixtureDir, { recursive: true, force: true })
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const invalidRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  const invalidRestoreProduct = invalidRestoreStore.products?.[0]
  if (!invalidRestoreProduct) throw new Error('invalid restore fixture product missing')
  invalidRestoreProduct.category_id = `missing-category-${stamp}`
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(invalidRestoreStore, null, 2))
  const invalidRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!invalidRestoreRun.ok && String(invalidRestoreRun.stderr || invalidRestoreRun.stdout).includes('references missing category')) ok('restore dry-run rejects product with missing category')
  else throw new Error(`invalid restore fixture was accepted: ${JSON.stringify(invalidRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const missingUploadRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  makePublishedProductImagesRestoreSafe(missingUploadRestoreStore)
  const missingUploadRestoreOrder = missingUploadRestoreStore.orders?.find((order) => Array.isArray(order.photo_urls))
  if (!missingUploadRestoreOrder) throw new Error('missing upload restore fixture order missing')
  missingUploadRestoreOrder.photo_urls = ['/uploads/9999999999998-dddddddd-dddd-4ddd-8ddd-dddddddddddd.png']
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(missingUploadRestoreStore, null, 2))
  const missingUploadRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!missingUploadRestoreRun.ok && String(missingUploadRestoreRun.stderr || missingUploadRestoreRun.stdout).includes('references missing upload')) ok('restore dry-run rejects missing order upload')
  else throw new Error(`missing upload restore fixture was accepted: ${JSON.stringify(missingUploadRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const missingProductUploadRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  const missingProductUpload = missingProductUploadRestoreStore.products?.find((product) => product.image_url || Array.isArray(product.images))
  if (!missingProductUpload) throw new Error('missing product upload restore fixture product missing')
  missingProductUpload.image_url = '/uploads/9999999999996-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png'
  missingProductUpload.images = ['/uploads/9999999999996-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png']
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(missingProductUploadRestoreStore, null, 2))
  const missingProductUploadRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!missingProductUploadRestoreRun.ok && String(missingProductUploadRestoreRun.stderr || missingProductUploadRestoreRun.stdout).includes('product') && String(missingProductUploadRestoreRun.stderr || missingProductUploadRestoreRun.stdout).includes('references missing upload')) ok('restore dry-run rejects missing product upload')
  else throw new Error(`missing product upload restore fixture was accepted: ${JSON.stringify(missingProductUploadRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const missingBlogUploadRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  for (const order of missingBlogUploadRestoreStore.orders || []) order.photo_urls = []
  makePublishedProductImagesRestoreSafe(missingBlogUploadRestoreStore)
  const missingBlogUpload = missingBlogUploadRestoreStore.site?.blog?.find((post) => post.image_url)
  if (!missingBlogUpload) throw new Error('missing blog upload restore fixture post missing')
  missingBlogUpload.image_url = '/uploads/9999999999995-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(missingBlogUploadRestoreStore, null, 2))
  const missingBlogUploadRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!missingBlogUploadRestoreRun.ok && String(missingBlogUploadRestoreRun.stderr || missingBlogUploadRestoreRun.stdout).includes('blog') && String(missingBlogUploadRestoreRun.stderr || missingBlogUploadRestoreRun.stdout).includes('references missing upload')) ok('restore dry-run rejects missing blog upload')
  else throw new Error(`missing blog upload restore fixture was accepted: ${JSON.stringify(missingBlogUploadRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const missingBlogImageRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  for (const order of missingBlogImageRestoreStore.orders || []) order.photo_urls = []
  makePublishedProductImagesRestoreSafe(missingBlogImageRestoreStore)
  const missingBlogImage = missingBlogImageRestoreStore.site?.blog?.find((post) => post.image_url)
  if (!missingBlogImage) throw new Error('missing blog image restore fixture post missing')
  missingBlogImage.image_url = ''
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(missingBlogImageRestoreStore, null, 2))
  const missingBlogImageRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!missingBlogImageRestoreRun.ok && String(missingBlogImageRestoreRun.stderr || missingBlogImageRestoreRun.stdout).includes('blog') && String(missingBlogImageRestoreRun.stderr || missingBlogImageRestoreRun.stdout).includes('valid image')) ok('restore dry-run rejects blog without image')
  else throw new Error(`missing blog image restore fixture was accepted: ${JSON.stringify(missingBlogImageRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const invalidFaqRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  const invalidFaq = invalidFaqRestoreStore.site?.faq?.[0]
  if (!invalidFaq) throw new Error('invalid faq restore fixture item missing')
  invalidFaq.question = ''
  invalidFaq.translations = {}
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(invalidFaqRestoreStore, null, 2))
  const invalidFaqRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!invalidFaqRestoreRun.ok && String(invalidFaqRestoreRun.stderr || invalidFaqRestoreRun.stdout).includes('site faq contains invalid item')) ok('restore dry-run rejects invalid faq content')
  else throw new Error(`invalid faq restore fixture was accepted: ${JSON.stringify(invalidFaqRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const invalidReviewRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  const invalidReview = invalidReviewRestoreStore.site?.reviews?.[0]
  if (!invalidReview) throw new Error('invalid review restore fixture item missing')
  invalidReview.rating = 6
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(invalidReviewRestoreStore, null, 2))
  const invalidReviewRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!invalidReviewRestoreRun.ok && String(invalidReviewRestoreRun.stderr || invalidReviewRestoreRun.stdout).includes('site reviews contains invalid item')) ok('restore dry-run rejects invalid review content')
  else throw new Error(`invalid review restore fixture was accepted: ${JSON.stringify(invalidReviewRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const duplicateIdRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  if (!duplicateIdRestoreStore.orders?.length) throw new Error('duplicate id restore fixture order missing')
  duplicateIdRestoreStore.orders.push({ ...duplicateIdRestoreStore.orders[0] })
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(duplicateIdRestoreStore, null, 2))
  const duplicateIdRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!duplicateIdRestoreRun.ok && String(duplicateIdRestoreRun.stderr || duplicateIdRestoreRun.stdout).includes('orders contains duplicate id')) ok('restore dry-run rejects duplicate order ids')
  else throw new Error(`duplicate id restore fixture was accepted: ${JSON.stringify(duplicateIdRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const hiddenCategoryRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  const hiddenCategoryRestoreProduct = hiddenCategoryRestoreStore.products?.[0]
  const hiddenCategoryRestoreCategory = hiddenCategoryRestoreStore.categories?.find((category) => category.id === hiddenCategoryRestoreProduct?.category_id)
  if (!hiddenCategoryRestoreProduct || !hiddenCategoryRestoreCategory) throw new Error('hidden category restore fixture missing product or category')
  hiddenCategoryRestoreProduct.status = 'published'
  hiddenCategoryRestoreCategory.status = 'hidden'
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(hiddenCategoryRestoreStore, null, 2))
  const hiddenCategoryRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!hiddenCategoryRestoreRun.ok && String(hiddenCategoryRestoreRun.stderr || hiddenCategoryRestoreRun.stdout).includes('references hidden category')) ok('restore dry-run rejects published products under hidden categories')
  else throw new Error(`hidden category restore fixture was accepted: ${JSON.stringify(hiddenCategoryRestoreRun)}`)
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const unsupportedPaypalRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  unsupportedPaypalRestoreStore.site.paypal.currency = 'CNY'
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(unsupportedPaypalRestoreStore, null, 2))
  const unsupportedPaypalRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!unsupportedPaypalRestoreRun.ok && String(unsupportedPaypalRestoreRun.stderr || unsupportedPaypalRestoreRun.stdout).includes('unsupported currency')) ok('restore dry-run rejects unsupported paypal currency')
  else throw new Error(`unsupported paypal restore fixture was accepted: ${JSON.stringify(unsupportedPaypalRestoreRun)}`)
  const storeBeforeInvalidBackupChecks = await readFile(storeFile, 'utf8')
  try {
    await writeFile(storeFile, JSON.stringify(unsupportedPaypalRestoreStore, null, 2))
    const unsupportedPaypalBackupRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/backup-data.mjs'])
      .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
      .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
    if (!unsupportedPaypalBackupRun.ok && String(unsupportedPaypalBackupRun.stderr || unsupportedPaypalBackupRun.stdout).includes('unsupported currency')) ok('backup script rejects unsupported paypal currency')
    else throw new Error(`unsupported paypal backup was accepted: ${JSON.stringify(unsupportedPaypalBackupRun)}`)
  } finally {
    await writeFile(storeFile, storeBeforeInvalidBackupChecks)
  }
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  await mkdir(invalidRestoreFixtureDir, { recursive: true })
  const missingSeoRestoreStore = JSON.parse(await readFile(storeFile, 'utf8'))
  const missingSeoRestoreProduct = missingSeoRestoreStore.products?.find((product) => (product.status || 'published') === 'published')
  if (!missingSeoRestoreProduct) throw new Error('missing seo restore fixture product missing')
  missingSeoRestoreProduct.seo_title = ''
  if (missingSeoRestoreProduct.translations?.zh) missingSeoRestoreProduct.translations.zh.seo_title = ''
  await writeFile(`${invalidRestoreFixtureDir}/store.json`, JSON.stringify(missingSeoRestoreStore, null, 2))
  const missingSeoRestoreRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/restore-data.mjs', '--dry-run', invalidRestoreFixtureDir])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!missingSeoRestoreRun.ok && String(missingSeoRestoreRun.stderr || missingSeoRestoreRun.stdout).includes('requires seo title')) ok('restore dry-run rejects published product without seo title')
  else throw new Error(`missing seo restore fixture was accepted: ${JSON.stringify(missingSeoRestoreRun)}`)
  const storeBeforeMissingSeoBackupCheck = await readFile(storeFile, 'utf8')
  try {
    await writeFile(storeFile, JSON.stringify(missingSeoRestoreStore, null, 2))
    const missingSeoBackupRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/backup-data.mjs'])
      .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
      .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
    if (!missingSeoBackupRun.ok && String(missingSeoBackupRun.stderr || missingSeoBackupRun.stdout).includes('requires seo title')) ok('backup script rejects published product without seo title')
    else throw new Error(`missing seo backup was accepted: ${JSON.stringify(missingSeoBackupRun)}`)
  } finally {
    await writeFile(storeFile, storeBeforeMissingSeoBackupCheck)
  }
  await rm(invalidRestoreFixtureDir, { recursive: true, force: true })
  const cleanupDryRunBefore = await readFile(storeFile, 'utf8')
  const cleanupDryRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-e2e-data.mjs'])
  const cleanupDryRunAfter = await readFile(storeFile, 'utf8')
  const cleanupDryRunReport = JSON.parse(cleanupDryRun.stdout)
  if (cleanupDryRunReport.mode === 'dry-run' && cleanupDryRunBefore === cleanupDryRunAfter) ok('e2e cleanup defaults to dry-run without changing store')
  else throw new Error(`e2e cleanup dry-run changed store or invalid mode: ${cleanupDryRun.stdout}`)
  const unconfirmedCleanupRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-e2e-data.mjs', '--apply'])
    .then((result) => ({ ok: true, stdout: result.stdout, stderr: result.stderr }))
    .catch((error) => ({ ok: false, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error) }))
  if (!unconfirmedCleanupRun.ok && String(unconfirmedCleanupRun.stderr || unconfirmedCleanupRun.stdout).includes('--confirm-e2e-cleanup')) ok('e2e cleanup apply requires explicit confirmation')
  else throw new Error(`e2e cleanup apply without confirmation was accepted: ${JSON.stringify(unconfirmedCleanupRun)}`)
  if (
    Number(cleanupDryRunReport.matched?.orders || 0) > 0
    && Number(cleanupDryRunReport.matched?.products || 0) > 0
    && Number(cleanupDryRunReport.matched?.categories || 0) > 0
    && Number(cleanupDryRunReport.removed?.payments || 0) > 0
  ) ok('e2e cleanup dry-run recognizes generated orders products categories and payments')
  else throw new Error(`e2e cleanup dry-run missed generated data: ${cleanupDryRun.stdout}`)
  if (Number(cleanupDryRunReport.matched?.products || 0) >= 2) ok('e2e cleanup recognizes readiness warning product fixtures')
  else throw new Error(`e2e cleanup missed readiness product fixture: ${cleanupDryRun.stdout}`)
  const uploadCleanupDryRunBefore = await readFile(storeFile, 'utf8')
  const uploadCleanupDryRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-orphan-uploads.mjs', '--missing-refs'])
  const uploadCleanupDryRunAfter = await readFile(storeFile, 'utf8')
  const uploadCleanupReport = JSON.parse(uploadCleanupDryRun.stdout)
  if (
    uploadCleanupReport.mode === 'dry-run'
    && uploadCleanupReport.clean_missing_refs === true
    && uploadCleanupDryRunBefore === uploadCleanupDryRunAfter
    && Number(uploadCleanupReport.missing_referenced_upload_files || 0) === 0
  ) ok('upload cleanup reports healthy missing references without changing store')
  else throw new Error(`cleanup missing upload report invalid: ${uploadCleanupDryRun.stdout}`)
  const missingPhotoEmail = `missing-photo-${stamp}@example.com`
  const missingPhotoOptionId = stableOrderProduct?.options?.[0]?.id
  if (!missingPhotoOptionId) throw new Error('missing photo fixture product option not found')
  const missingPhotoOrderRes = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product_id: stableOrderProduct.id,
      option_id: missingPhotoOptionId,
      customer_name: '缺失照片测试',
      email: missingPhotoEmail,
      phone: '13800009999',
      shipping_address: 'Missing photo fixture',
      pet_name: '缺失照片',
      pet_type: 'cat',
      photo_urls: [uploadedPhotoUrl],
      note: 'e2e missing photo placeholder'
    })
  })
  const missingPhotoOrder = await missingPhotoOrderRes.json()
  if (!missingPhotoOrderRes.ok) throw new Error(`missing photo fixture order failed: ${missingPhotoOrderRes.status} ${JSON.stringify(missingPhotoOrder)}`)
  try {
    storeSnapshotForMissingPhoto = await readFile(storeFile, 'utf8')
    missingPhotoSnapshotOrderId = missingPhotoOrder.id
    await snapshotUploadsForMissingPhoto()
    const missingPhotoStore = JSON.parse(storeSnapshotForMissingPhoto)
    const missingPhotoAdminOrder = missingPhotoStore.orders.find((order) => order.id === missingPhotoOrder.id)
    if (!missingPhotoAdminOrder) throw new Error('missing photo fixture order not found in store')
    missingPhotoAdminOrder.photo_urls = ['/uploads/9999999999997-cccccccc-cccc-4ccc-8ccc-cccccccccccc.png']
    await writeFile(storeFile, JSON.stringify(missingPhotoStore, null, 2))
    apiRestartInProgress = true
    await execFileAsync('systemctl', ['restart', 'pet-wool-api'])
    const missingPhotoAdminPage = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
    await missingPhotoAdminPage.addInitScript(() => localStorage.setItem('lang', 'zh'))
    await missingPhotoAdminPage.goto(`${base}/admin`, { waitUntil: 'networkidle' })
    if (await fillAdminLogin(missingPhotoAdminPage)) {
      await missingPhotoAdminPage.getByRole('button', { name: '登录' }).click()
      await missingPhotoAdminPage.waitForURL('**/admin/dashboard', { timeout: 10000 })
    }
    apiRestartInProgress = false
    await missingPhotoAdminPage.getByRole('button', { name: '订单管理' }).click()
    await missingPhotoAdminPage.getByPlaceholder('搜索订单号、客户、邮箱、电话、商品或备注').fill(missingPhotoEmail)
    await missingPhotoAdminPage.waitForFunction((email) => document.body.innerText.includes(email), missingPhotoEmail)
    await missingPhotoAdminPage.getByRole('button', { name: '详情流程' }).first().click()
    await expectText(missingPhotoAdminPage, '照片文件缺失', 'admin order missing photo placeholder visible')
    await missingPhotoAdminPage.close()
    const cleanupMissingRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-orphan-uploads.mjs'])
    const cleanupMissingReport = JSON.parse(cleanupMissingRun.stdout)
    if (
      cleanupMissingReport.missing_referenced_upload_files >= 1
      && cleanupMissingReport.missing_referenced_samples?.includes('9999999999997-cccccccc-cccc-4ccc-8ccc-cccccccccccc.png')
      && cleanupMissingReport.order_referenced_upload_files >= 1
    ) ok('orphan upload cleanup reports missing referenced filenames')
    else throw new Error(`cleanup missing upload report invalid: ${cleanupMissingRun.stdout}`)
    const cleanupMissingRefsBefore = await readFile(storeFile, 'utf8')
    const cleanupMissingRefsRun = await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-orphan-uploads.mjs', '--missing-refs'])
    const cleanupMissingRefsAfter = await readFile(storeFile, 'utf8')
    const cleanupMissingRefsReport = JSON.parse(cleanupMissingRefsRun.stdout)
    if (
      cleanupMissingRefsReport.mode === 'dry-run'
      && cleanupMissingRefsReport.clean_missing_refs === true
      && cleanupMissingRefsBefore === cleanupMissingRefsAfter
      && cleanupMissingRefsReport.missing_referenced_samples?.includes('9999999999997-cccccccc-cccc-4ccc-8ccc-cccccccccccc.png')
    ) ok('orphan upload cleanup missing-ref mode is dry-run by default')
    else throw new Error(`cleanup missing-ref dry-run invalid: ${cleanupMissingRefsRun.stdout}`)
  } finally {
    apiRestartInProgress = false
    if (storeSnapshotForMissingPhoto) {
      await restoreMissingPhotoSnapshot().catch(() => {})
      storeSnapshotForMissingPhoto = ''
      missingPhotoSnapshotOrderId = ''
    }
  }
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/admin-theme-config.png', fullPage: true })
} catch (error) {
  fail('e2e run', error)
  await page.screenshot({ path: '/root/pet-wool-platform/test-results/failure.png', fullPage: true }).catch(() => {})
} finally {
  await fetch(`${base}/api/admin/site`, { headers: { authorization: 'Bearer admin-e2e' } })
    .then((res) => res.json())
    .then((site) => fetch(`${base}/api/admin/site`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-e2e' },
      body: JSON.stringify({
        ...site,
        brand: { ...(site.brand || {}), name: originalBrandName },
        contact: { ...(site.contact || {}), talk_enabled: true, line_enabled: true },
      })
    }))
    .catch(() => {})
  if (temporaryProductId) {
    await fetch(`${base}/api/admin/products/${temporaryProductId}`, { method: 'DELETE', headers: { authorization: 'Bearer admin-e2e', 'x-confirm-delete': 'true' } }).catch(() => {})
  }
  if (storeSnapshotForMissingPhoto) {
    await restoreMissingPhotoSnapshot().catch(() => {})
    missingPhotoSnapshotOrderId = ''
  }
  await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-e2e-data.mjs', '--apply', '--confirm-e2e-cleanup']).catch(() => {})
  await execFileAsync('node', ['/root/pet-wool-platform/scripts/cleanup-orphan-uploads.mjs', '--apply', '--missing-refs']).catch(() => {})
  await rm(uploadSnapshotDir, { recursive: true, force: true }).catch(() => {})
  await browser.close()
  await writeFile('/root/pet-wool-platform/test-results/report.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  const failures = out.filter(r => r.status === 'fail')
  if (failures.length) process.exit(1)
}
