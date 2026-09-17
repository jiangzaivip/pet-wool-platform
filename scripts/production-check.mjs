// Checks deployment-sensitive configuration without printing secrets.
// This command is intentionally read-only and should be run before a release.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const storeFile = path.join(rootDir, 'api-node', 'data', 'store.json')
const failures = []
const warnings = []
const paypalSupportedCurrencies = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF',
  'ILS', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD',
  'THB', 'TWD', 'USD',
])

function pass(label) { console.log(`PASS  ${label}`) }
function fail(label) { failures.push(label); console.log(`FAIL  ${label}`) }
function warn(label) { warnings.push(label); console.log(`WARN  ${label}`) }
function configured(value) { return Boolean(String(value || '').trim()) }
function isDemo(value) {
  return !configured(value) || /demo|example|placeholder|change_me|replace_with/i.test(String(value))
}

let store
try {
  store = JSON.parse(await readFile(storeFile, 'utf8'))
} catch (error) {
  fail(`store.json cannot be read: ${error.message}`)
  process.exitCode = 1
}

const adminAccounts = String(process.env.ADMIN_ACCOUNTS_JSON || '').trim()
if (adminAccounts) {
  try {
    const parsed = JSON.parse(adminAccounts)
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => isDemo(item.email) || isDemo(item.password_hash))) fail('ADMIN_ACCOUNTS_JSON contains a demo or incomplete account')
    else pass('multi-admin accounts configured')
  } catch {
    fail('ADMIN_ACCOUNTS_JSON is not valid JSON')
  }
} else if (process.env.ADMIN_EMAIL === 'admin@example.com' || isDemo(process.env.ADMIN_PASSWORD_HASH)) {
  fail('default administrator credentials are still active')
} else {
  pass('administrator credentials are not default')
}

if (/^(0|false|no)$/i.test(String(process.env.GOOGLE_DEMO_LOGIN || ''))) {
  const clientId = process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || store?.site?.google?.client_id
  if (isDemo(clientId)) fail('Google demo is disabled but no real client ID is configured')
  else pass('Google OAuth is configured without demo fallback')
} else {
  fail('GOOGLE_DEMO_LOGIN must be false for production')
}

const storedPaypal = store?.site?.paypal || {}
const paypal = storedPaypal
const paypalMode = String(paypal.mode || '').trim().toLowerCase()
const paypalCurrency = String(paypal.currency || 'USD').trim().toUpperCase()
if (/^(1|true|yes)$/i.test(String(process.env.PAYPAL_MOCK || ''))) fail('PAYPAL_MOCK must be false for production')
else if (paypalMode !== 'live') fail('PayPal is not in live mode')
else if (paypal.enabled === false) fail('PayPal is disabled')
else if (
  isDemo(paypal.client_id)
  || !configured(paypal.secret)
  || !configured(paypal.webhook_id)
  || /^https?:\/\//i.test(String(paypal.webhook_id || '').trim())
) fail('PayPal live credentials or webhook ID are incomplete')
else if (!paypalSupportedCurrencies.has(paypalCurrency)) fail('PayPal currency is unsupported')
else pass('PayPal live credentials and webhook are configured')

const publishedProducts = Array.isArray(store?.products)
  ? store.products.filter((product) => String(product.status || 'published') !== 'hidden')
  : []
const mismatchedProduct = publishedProducts.find((product) => (
  String(product.currency || '').trim().toUpperCase() !== paypalCurrency
))
if (mismatchedProduct) fail(`published product currency does not match PayPal currency: ${mismatchedProduct.slug || mismatchedProduct.id}`)
else if (publishedProducts.length) pass('published product currencies match PayPal')
else warn('no published products are present for payment currency validation')

const baseUrl = process.env.PUBLIC_BASE_URL || ''
if (!/^https:\/\//i.test(baseUrl)) fail('PUBLIC_BASE_URL must use HTTPS')
else pass('public base URL uses HTTPS')

if (!configured(process.env.SMTP_HOST) && !configured(process.env.SMTP_FROM)) warn('SMTP order notifications are disabled')
else if (!configured(process.env.SMTP_HOST) || !configured(process.env.SMTP_FROM)) fail('SMTP_HOST and SMTP_FROM must be configured together')
else if (configured(process.env.SMTP_USER) !== configured(process.env.SMTP_PASS)) fail('SMTP_USER and SMTP_PASS must be configured together')
else pass('SMTP order notifications are configured')

if (
  !configured(store?.site?.brand?.email)
  && !configured(store?.site?.contact?.kakao_id)
  && !configured(store?.site?.contact?.kakao_url)
  && !configured(store?.site?.contact?.whatsapp_id)
  && !configured(store?.site?.contact?.whatsapp_url)
) warn('no customer support contact is configured in site settings')

for (const requiredFile of [
  'api-node/server.mjs',
  'frontend/dist/index.html',
  'package.json',
  'package-lock.json',
  'install-systemd.sh',
]) {
  try {
    await readFile(path.join(rootDir, requiredFile))
    pass(`release file exists: ${requiredFile}`)
  } catch {
    fail(`release file is missing: ${requiredFile}`)
  }
}

console.log(`\n${failures.length} failure(s), ${warnings.length} warning(s)`)
if (failures.length) process.exitCode = 1
