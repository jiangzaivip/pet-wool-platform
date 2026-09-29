import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  PAYMENT_RATE_VERSION, capturedPaymentTransition, chargeAmountCents,
  paymentAmountSnapshot, paymentBaseAmountCents, paypalChargeCurrencyReady,
  validatePaymentSettlement, validatePaypalCaptureAmount, singleCurrencyTotal,
} from '../api-node/payment-amounts.mjs'

const baseOrder = { id: 'pure', currency: 'KRW', amount_cents: 1000, initial_payment_cents: 500, paid_amount_cents: 0, payment_type: 'deposit', payment_status: 'unpaid' }
const deposit = { order_id: 'pure', provider: 'paypal', status: 'created', payment_type: 'deposit', ...paymentAmountSnapshot(baseOrder) }
const capture = { currency: 'USD', amount_value: '0.36', capture_status: 'COMPLETED' }
assert.equal(paymentBaseAmountCents({ amount_cents: 73, currency: 'USD' }, { currency: 'USD' }), 73)
assert.equal(paymentBaseAmountCents({ amount_cents: 73, currency: 'USD' }, { currency: 'KRW' }), 0)
for (const invalid of [
  { ...deposit, base_currency: 'CNY' }, { ...deposit, base_currency: '' },
  { ...deposit, base_amount_cents: 0 }, { ...deposit, base_amount_cents: null },
  { ...deposit, base_amount_cents: 1.5 }, { ...deposit, base_currency: undefined },
]) {
  assert.equal(paymentBaseAmountCents(invalid, baseOrder), 0)
  assert.match(validatePaymentSettlement(baseOrder, invalid), /base amount or currency mismatch/)
}
const legacyOrder = { ...baseOrder, currency: 'USD', amount_cents: 73, initial_payment_cents: 73, payment_type: 'full' }
const legacyPayment = { order_id: 'pure', status: 'created', payment_type: 'full', currency: 'USD', amount_cents: 73 }
assert.equal(capturedPaymentTransition(legacyOrder, legacyPayment, { ...capture, amount_value: '0.73' }).paid_amount_cents, 73)
assert.match(validatePaypalCaptureAmount(deposit, { ...capture, currency: 'CNY' }), /currency mismatch/)
assert.match(validatePaypalCaptureAmount(deposit, { ...capture, amount_value: '0.37' }), /amount mismatch/)
assert.match(validatePaypalCaptureAmount(deposit, { ...capture, amount_value: '0.3601' }), /amount mismatch/)
assert.match(validatePaypalCaptureAmount(deposit, {}), /currency mismatch/)
assert.equal(chargeAmountCents(0, 'KRW'), 0)
assert.equal(chargeAmountCents(1, 'KRW'), 0)
for (const currency of ['KRW', 'CNY', 'EUR']) assert.equal(paypalChargeCurrencyReady(currency), false)
assert.throws(() => paymentAmountSnapshot({ ...baseOrder, initial_payment_cents: 1 }), /cannot be converted/)
const settled = { ...baseOrder, ...capturedPaymentTransition(baseOrder, deposit, capture) }
assert.equal(settled.paid_amount_cents, 500)
assert.equal(capturedPaymentTransition(settled, { ...deposit, status: 'captured' }, capture), null)
assert.throws(() => capturedPaymentTransition(settled, deposit, capture), /already paid/)
const due = { ...settled, payment_status: 'balance_due' }
const prior = { ...deposit, status: 'captured' }
assert.equal(paymentAmountSnapshot(due, [prior]).amount_cents, 37)
assert.equal(paymentAmountSnapshot(due, [{ ...prior, rate_version: 'historical' }]).amount_cents, 36)
const balancePayment = { order_id: 'pure', status: 'created', payment_type: 'balance', ...paymentAmountSnapshot(due, [prior]) }
assert.equal(capturedPaymentTransition(due, balancePayment, { ...capture, amount_value: '0.37' }).paid_amount_cents, 1000)
assert.throws(() => capturedPaymentTransition(due, deposit, capture), /no longer matches/)
assert.throws(() => paymentAmountSnapshot({ ...due, amount_cents: 501 }), /cannot be converted/)
// Compatible snapshots that leave zero USD remainder must not create free payments.
assert.throws(() => paymentAmountSnapshot(due, [{ ...prior, amount_cents: 73 }]), /cannot be converted/)
assert.equal(singleCurrencyTotal({ KRW: 1000, USD: 73 }).amount, null)
assert.equal(singleCurrencyTotal({ USD: 73 }).amount, 73)
assert.equal(deposit.rate_version, PAYMENT_RATE_VERSION)
console.log('PASS pure legacy USD, base mismatch, charge validation, zero/tiny conversion, duplicate settlement and rounding cases')

const root = await mkdtemp(`${tmpdir()}/payment-api-check-`)
await mkdir(`${root}/api`)
await mkdir(`${root}/data`)
await writeFile(`${root}/data/store.json`, JSON.stringify({
  products: [{ id: 'test', slug: 'isolated-test', title: 'Test', category_id: 'test-cat', currency: 'USD', base_price_cents: 73, deposit_percent: 50, options: [{ id: 'test-option', name: 'Test', price_cents: 73 }] }],
  categories: [{ id: 'test-cat', slug: 'isolated-category', title: 'Test' }], orders: [], payments: [],
  site: { paypal: { enabled: true, mode: 'sandbox', currency: 'USD', client_id: '', secret: '', webhook_id: '' } },
}))
// A clean environment and temporary API_ROOT_DIR prevent loading the real .env.
// No inherited database, SMTP, credentials, logging or filesystem destinations.
const child = spawn(process.execPath, [fileURLToPath(new URL('../api-node/server.mjs', import.meta.url))], {
  env: { PATH: process.env.PATH, API_ROOT_DIR: `${root}/api`, DATA_DIR: `${root}/data`, UPLOAD_DIR: `${root}/uploads`, LOG_DIR: `${root}/logs`, LOG_TO_FILE: 'false', STORE_BACKEND: 'json', NODE_ENV: 'test', PAYPAL_MOCK: 'true', HOST: '127.0.0.1', PORT: '19873', SERVE_FRONTEND: 'false', SMTP_HOST: '', ADMIN_EMAIL: 'test@example.invalid', ADMIN_PASSWORD_HASH: createHash('sha256').update('isolated-password').digest('hex') },
})
let output = ''
child.stdout.on('data', (data) => { output += data })
child.stderr.on('data', (data) => { output += data })
// orderSecret carries x-order-secret. A guest order has no user token, so
// opening its first payment is authorized by the order's own client_request_id.
// Without this header every guest PayPal call would be refused, which is exactly
// what the payment-ownership fix intended.
async function request(route, body, method = 'POST', token = '', orderSecret = '', paymentSecret = '') {
  const response = await fetch(`http://127.0.0.1:19873/api${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(orderSecret ? { 'x-order-secret': orderSecret } : {}), ...(paymentSecret ? { 'x-payment-secret': paymentSecret } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  assert.ok(response.ok, `${method} ${route}: HTTP ${response.status} ${JSON.stringify(data)}\n${output}`)
  return data
}
try {
  let ready = false
  for (let i = 0; i < 80; i++) {
    assert.equal(child.exitCode, null, `API startup failed\n${output}`)
    // Require this child's startup log before touching its localhost listener.
    if (output.includes('service.started')) { ready = true; break }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(ready, `API startup timeout\n${output}`)
  const clientRequestId = 'verify-payment-amounts-fixed-secret'
  const order = await request('/orders', { product_id: 'test', option_id: 'test-option', customer_name: 'Test', email: 'test@example.invalid', phone: '123', country: 'KR', pet_name: 'Test', pet_type: 'cat', photo_urls: ['/uploads/123-abcdef.png'], payment_type: 'deposit', client_request_id: clientRequestId })
  assert.equal(order.currency, 'KRW')
  assert.equal(order.amount_cents, 1000)
  assert.equal(order.initial_payment_cents, 500)
  console.log('PASS USD 0.73 product -> KRW 1000 order, KRW 500 deposit')
  const intent = await request('/paypal/create-order', { order_id: order.id }, 'POST', '', clientRequestId)
  assert.equal(intent.payment.currency, 'USD')
  assert.equal(intent.payment.amount_cents, 36)
  assert.equal(intent.payment.base_amount_cents, 500)
  const first = await request('/paypal/capture-order', { paypal_order_id: intent.id }, 'POST', '', '', intent.payment.capture_secret)
  assert.ok(intent.payment.capture_secret, 'create-order must hand back a capture secret')
  assert.equal(first.order.paid_amount_cents, 500)
  assert.equal(first.order.payment_status, 'deposit_paid')
  console.log('DBG secret len:', String(intent.payment.capture_secret || '').length, '| orderSecret len:', clientRequestId.length)
  const duplicate = await request('/paypal/capture-order', { paypal_order_id: intent.id }, 'POST', '', clientRequestId, intent.payment.capture_secret)
  assert.equal(duplicate.order.paid_amount_cents, 500)
  console.log('PASS USD 0.36 deposit capture and repeated capture -> KRW 500 paid')
  const login = await request('/admin/login', { email: 'test@example.invalid', password: 'isolated-password' })
  await request(`/admin/orders/${order.id}/status`, { order_status: 'balance_due' }, 'PUT', login.token)
  const balance = await request('/paypal/create-order', { order_id: order.id }, 'POST', '', clientRequestId)
  assert.equal(balance.payment.amount_cents, 37)
  assert.equal(balance.payment.base_amount_cents, 500)
  const final = await request('/paypal/capture-order', { paypal_order_id: balance.id }, 'POST', '', clientRequestId, balance.payment.capture_secret)
  assert.equal(final.order.paid_amount_cents, 1000)
  assert.equal(final.order.payment_status, 'paid')
  const repeated = await request('/paypal/capture-order', { paypal_order_id: balance.id }, 'POST', '', clientRequestId, balance.payment.capture_secret)
  assert.equal(repeated.order.paid_amount_cents, 1000)
  assert.equal(intent.payment.amount_cents + balance.payment.amount_cents, 73)
  console.log('PASS USD 0.37 balance + USD 0.36 deposit = USD 0.73; repeated balance -> KRW 1000 paid')
} finally {
  if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
  await rm(root, { recursive: true, force: true })
}
