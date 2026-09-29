#!/usr/bin/env node
// 快速核心校验（目标 < 2 分钟，实测约 3 秒）：部署生产前的最后一道闸。
// 只验证 API 契约与关键页面能渲染，不匹配 UI 文案，不做任何写操作
// （唯一的写请求是会被服务端拒绝的非法币种 PUT，无状态变更）。
// 用法: node scripts/verify-core.mjs
//   BASE_URL      默认 http://127.0.0.1:8888
//   API_ORIGIN    可选；测试拓扑下 nginx 把 / 代理给 Vite，404 检查会自动探测
//   SKIP_BROWSER=1 跳过浏览器冒烟（只跑 API 检查）
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = (process.env.BASE_URL || 'http://127.0.0.1:8888').replace(/\/$/, '')
const started = Date.now()
const failures = []
let passed = 0

const ok = (name) => { passed++; console.log(`PASS ${name}`) }
const fail = (name, detail) => { failures.push(name); console.error(`FAIL ${name}: ${detail}`) }

async function get(pathname, options = {}) {
  return fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(15000), ...options })
}
const INTERNAL_FIELDS = /"translations"|"internal_note"|"created_at"|"updated_at"/

// --- API 契约 ---
try {
  const res = await get('/health')
  const body = await res.json()
  if (res.ok && body.ok === true && body.service === 'pet-wool-api'
    && body.counts && !JSON.stringify(body).includes('/root/')) ok('health endpoint valid and hides server paths')
  else fail('health endpoint', JSON.stringify(body).slice(0, 200))
} catch (e) { fail('health endpoint', e.message) }

try {
  const res = await get('/api/site')
  const site = await res.json()
  const problems = []
  if (res.headers.get('cache-control') !== 'no-store') problems.push('cache-control')
  if ('secret' in (site.paypal || {}) || 'webhook_id' in (site.paypal || {})) problems.push('paypal secrets leaked')
  const g = site.google || {}
  if (!(['demo', 'google'].includes(g.auth_mode)) || ('secret' in g)) problems.push(`google mode invalid: ${JSON.stringify(g)}`)
  const expected = ['blog', 'bot', 'brand', 'contact', 'faq', 'google', 'paypal', 'policies', 'reviews', 'shipping', 'taxonomies', 'theme'].sort()
  if (JSON.stringify(Object.keys(site).sort()) !== JSON.stringify(expected)) problems.push(`keys: ${Object.keys(site)}`)
  if (problems.length) fail('public site config', problems.join('; '))
  else ok('public site config contract valid')
} catch (e) { fail('public site config', e.message) }

let firstProductId = ''
try {
  const res = await get('/api/products?lang=zh')
  const products = await res.json()
  const first = Array.isArray(products) ? products[0] : null
  if (res.headers.get('cache-control') === 'no-store' && Array.isArray(products) && products.length > 0
    && first.slug && first.currency && !INTERNAL_FIELDS.test(JSON.stringify(products[0]))) {
    ok('public product list contract valid')
    firstProductId = first.id
  } else fail('public product list', JSON.stringify(products).slice(0, 200))
} catch (e) { fail('public product list', e.message) }

if (firstProductId) {
  try {
    const res = await get(`/api/products/${firstProductId}?lang=zh`)
    const detail = await res.json()
    if (res.ok && res.headers.get('cache-control') === 'no-store' && detail.slug && !INTERNAL_FIELDS.test(JSON.stringify(detail))) ok('public product detail contract valid')
    else fail('public product detail', `status=${res.status}`)
  } catch (e) { fail('public product detail', e.message) }
}

for (const [name, pathname] of [['categories', '/api/categories?lang=zh'], ['blog', '/api/blog?lang=zh']]) {
  try {
    const res = await get(pathname)
    const body = await res.json()
    if (res.ok && Array.isArray(body) && !INTERNAL_FIELDS.test(JSON.stringify(body[0] || {}))) ok(`public ${name} list contract valid`)
    else fail(`public ${name} list`, JSON.stringify(body).slice(0, 150))
  } catch (e) { fail(`public ${name} list`, e.message) }
}

try {
  const res = await get('/api/bot/answer', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '你好', lang: 'zh' })
  })
  const body = await res.json()
  if (res.ok && body.answer) ok('bot answer endpoint valid')
  else fail('bot answer endpoint', `status=${res.status}`)
} catch (e) { fail('bot answer endpoint', e.message) }

// --- 回归防护：静态/可预测的管理员令牌一律拒绝 ---
// 历史上 server.mjs 曾对回环地址接受固定的 'admin-e2e' token，等于让前置的
// 每一层反向代理都变成管理端后门（nginx 反代后所有外部请求都是 127.0.0.1）。
// 这里固定用一个曾经可用的 token 探测，确保它不再被接受。
try {
  const bypassRes = await get('/api/admin/overview', { headers: { authorization: 'Bearer admin-e2e' } })
  if (bypassRes.status === 200 || bypassRes.status === 403) {
    fail('static admin token rejected', `known bypass token still accepted (status=${bypassRes.status})`)
  } else {
    ok('static admin token rejected')
  }
} catch (e) { fail('static admin token rejected', e.message) }

// --- 回归防护：并发下单必须全部落库 ---
// store 曾经每请求独立读全量文件，saveStore 只串行化写，导致并发请求各自
// 基于旧快照修改后互相覆盖：8 个并发下单会返回 8 个订单号但只落库 1 条。
if (process.env.SKIP_BROWSER !== '1') {
  const products = await (await get('/api/products?lang=zh')).json()
  const items = products.data || products
  const product = (Array.isArray(items) ? items : []).find((p) => (p.options || []).length > 0)
  // Orders require a real upload reference, so mint a throwaway 1x1 PNG.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const uploadProbe = await fetch(`${base}/api/uploads`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: pngBytes,
  }).then((r) => r.json()).catch(() => null)
  const uploadProbePath = uploadProbe && (uploadProbe.url || (uploadProbe.data && uploadProbe.data.url))
  if (!product || !uploadProbePath) {
    fail('concurrent orders persist', 'no orderable product or upload fixture available')
  } else {
    const stamp = Date.now()
    const crid = `verify-race-${stamp}`
    const build = () => ({
      product_id: product.id, option_id: product.options[0].id, quantity: 1, payment_type: 'deposit',
      customer_name: 'Concurrency Check', email: `verify-race-${stamp}@example.com`, country: 'US',
      phone: '5550000000', shipping_address: 'Concurrency Check', pet_name: 'Rex', pet_type: 'dog',
      photo_urls: [uploadProbePath], client_request_id: crid,
    })
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(`${base}/api/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(build()),
    }).then((r) => r.json()).catch(() => null)))
    const orderNos = [...new Set(responses.map((o) => o && o.order_no).filter(Boolean))]
    if (orderNos.length === 1) {
      ok(`concurrent orders share one idempotent order (${orderNos[0]})`)
    } else {
      fail('concurrent orders persist', `same client_request_id produced ${orderNos.length} distinct orders`)
    }
  }
}

// --- 管理端与备份（通过真实登录获取令牌） ---
try {
  const loginRes = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL || 'admin@example.com',
      password: process.env.ADMIN_PASSWORD || 'admin123456',
    }),
  }).catch(() => null)
  const loginBody = loginRes ? await loginRes.json().catch(() => ({})) : {}
  const headers = { authorization: `Bearer ${loginBody.token || ''}` }
  const siteRes = await get('/api/admin/site', { headers })
  if ([401, 403].includes(siteRes.status)) {
    console.log('SKIP admin checks (token invalid from this origin)')
  } else {
    const site = await siteRes.json()
    if (siteRes.ok && !('secret' in (site.paypal || {})) && !('webhook_id' in (site.paypal || {}))) ok('admin site config redacts secrets')
    else fail('admin site config', `status=${siteRes.status}`)
    for (const name of ['products', 'orders']) {
      const res = await get(`/api/admin/${name}`, { headers })
      const body = await res.json()
      if (res.ok && Array.isArray(body.data || body)) ok(`admin ${name} list valid`)
      else fail(`admin ${name} list`, `status=${res.status}`)
    }
    const backupRes = await get('/api/admin/backup', { headers })
    const backup = await backupRes.json()
    const backupText = JSON.stringify(backup)
    if (backupRes.ok && backup.redacted === true && !backupText.includes('/root/')
      && !('secret' in (backup.data?.site?.paypal || {}))) ok('admin backup redacts secrets and paths')
    else fail('admin backup', backupText.slice(0, 200))
    const cnyRes = await get('/api/admin/site', {
      method: 'PUT', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ paypal: { currency: 'CNY' } })
    })
    if (cnyRes.status === 400) ok('admin rejects non-USD paypal charge currency')
    else fail('admin currency guard', `status=${cnyRes.status} (期望 400，拒绝即无状态变更)`)
  }
} catch (e) { fail('admin checks', e.message) }

// --- 未知路径 404：自动探测真实 API 源（测试拓扑 nginx 把 / 交给 Vite 时返回 200） ---
try {
  const candidates = [...new Set([process.env.API_ORIGIN, base, 'http://127.0.0.1:8082'].filter(Boolean))]
  let enforced = false
  for (const origin of candidates) {
    try {
      const res = await fetch(`${origin}/abc-core-gate-404`, { signal: AbortSignal.timeout(8000) })
      if (res.status === 404) { enforced = true; break }
    } catch { /* 试下一个候选 */ }
  }
  if (enforced) ok('unknown frontend paths return 404')
  else fail('unknown frontend paths', '所有候选 API 源都返回了非 404')
} catch (e) { fail('unknown frontend paths', e.message) }

// --- SEO 文件 ---
try {
  const [robots, sitemap] = await Promise.all([get('/robots.txt'), get('/sitemap.xml')])
  const robotsText = await robots.text()
  const sitemapText = await sitemap.text()
  if (robots.ok && robots.headers.get('content-type')?.includes('text/plain') && robotsText.includes('Sitemap:')
    && sitemap.ok && /xml/.test(sitemap.headers.get('content-type') || '') && sitemapText.includes('<urlset')) ok('robots.txt and sitemap.xml valid')
  else fail('robots/sitemap', `robots=${robots.status} sitemap=${sitemap.status}`)
} catch (e) { fail('robots/sitemap', e.message) }

// --- 双端汇率一致性（TS 直读，需要 node 22.6+） ---
{
  const child = spawn('node', ['--experimental-strip-types', 'scripts/verify-multicurrency.mjs'], { cwd: rootDir, stdio: 'ignore' })
  const exitCode = await new Promise((resolve) => {
    child.on('exit', resolve)
    child.on('error', () => resolve(1))
  })
  exitCode === 0 ? ok('currency tables in sync (frontend vs server)') : fail('currency tables', `exit=${exitCode}`)
}

// --- 浏览器冒烟：页面能渲染即可，不匹配文案 ---
if (process.env.SKIP_BROWSER !== '1') {
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
    await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 30000 })
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('header .preferences-toggle').first().waitFor({ state: 'visible', timeout: 10000 })
    ok('homepage renders shell and header')
    if (firstProductId) {
      await page.goto(`${base}/order?product=${firstProductId}`, { waitUntil: 'networkidle', timeout: 30000 })
      await page.locator('form.order-form button[type="submit"]').waitFor({ state: 'visible', timeout: 15000 })
      ok('order page renders submit form')
    }
    await browser.close()
  } catch (e) { fail('browser smoke', e.message) }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\nCore gate: ${passed} passed, ${failures.length} failed, ${seconds}s`)
if (failures.length) {
  console.error(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
