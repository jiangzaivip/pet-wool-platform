import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = await mkdtemp(`${tmpdir()}/webhook-api-check-`)
let child
let output = ''
try {
  await mkdir(`${root}/api`)
  await mkdir(`${root}/data`)
  // Stub only provider HTTP inside the isolated child, not production verification.
  await writeFile(`${root}/provider-stub.mjs`, `
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(url)
      if (parsed.origin !== 'https://api-m.sandbox.paypal.com') throw new Error('Unexpected external request: ' + url)
      if (parsed.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'isolated-token', expires_in: 3600 })
      if (parsed.pathname === '/v1/notifications/verify-webhook-signature') {
        const request = JSON.parse(options.body)
        return Response.json({ verification_status: request.transmission_sig === 'isolated-valid' ? 'SUCCESS' : 'FAILURE' })
      }
      throw new Error('Unexpected provider endpoint: ' + url)
    }
  `)
  await writeFile(`${root}/data/store.json`, JSON.stringify({
    categories: [{ id: 'test-category', title: 'Test', slug: 'test-category' }],
    products: [{ id: 'test', slug: 'test-product', title: 'Test', category_id: 'test-category', currency: 'KRW', base_price_cents: 1000, deposit_percent: 50, options: [{ id: 'size', name: 'Test', price_cents: 1000 }] }],
    orders: [], payments: [],
    site: { paypal: { enabled: true, mode: 'sandbox', currency: 'USD', client_id: 'isolated-client', secret: 'isolated-secret', webhook_id: 'isolated-webhook' } },
  }))
  child = spawn(process.execPath, ['--import', `${root}/provider-stub.mjs`, fileURLToPath(new URL('../api-node/server.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, API_ROOT_DIR: `${root}/api`, DATA_DIR: `${root}/data`, UPLOAD_DIR: `${root}/uploads`, LOG_DIR: `${root}/logs`, LOG_TO_FILE: 'false', STORE_BACKEND: 'json', NODE_ENV: 'test', PAYPAL_MOCK: 'true', HOST: '127.0.0.1', PORT: '19874', SERVE_FRONTEND: 'false' },
  })
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  for (let i = 0; i < 80 && !output.includes('service.started'); i++) {
    assert.equal(child.exitCode, null, `API startup failed\n${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(output.includes('service.started'), `API startup timeout\n${output}`)
  async function request(route, body, headers = {}, expected = 200) {
    const response = await fetch(`http://127.0.0.1:19874/api${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const data = await response.json()
    assert.equal(response.status, expected, `${route}: HTTP ${response.status} ${JSON.stringify(data)}\n${output}`)
    return data
  }
  const order = await request('/orders', { product_id: 'test', option_id: 'size', customer_name: 'Test', email: 'test@example.invalid', phone: '123', country: 'KR', pet_name: 'Test', pet_type: 'cat', photo_urls: ['/uploads/123-abcdef.png'], payment_type: 'full' })
  const intent = await request('/paypal/create-order', { order_id: order.id })
  assert.equal(intent.payment.amount_cents, 73)
  assert.equal(intent.payment.currency, 'USD')
  const event = { id: 'isolated-event', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'isolated-capture', status: 'COMPLETED', supplementary_data: { related_ids: { order_id: intent.id } }, amount: { value: '0.73', currency_code: 'USD' } } }
  const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/isolated-cert', 'paypal-transmission-id': 'isolated-transmission', 'paypal-transmission-sig': 'isolated-valid', 'paypal-transmission-time': '2026-09-17T00:00:00Z' }
  await request('/paypal/webhook', event, { ...headers, 'paypal-transmission-sig': 'invalid' }, 400)
  const rejected = JSON.parse(await readFile(`${root}/data/store.json`, 'utf8'))
  assert.equal(rejected.orders[0].paid_amount_cents, 0)
  const first = await request('/paypal/webhook', event, headers)
  assert.equal(first.handled, true)
  const afterFirst = JSON.parse(await readFile(`${root}/data/store.json`, 'utf8'))
  const second = await request('/paypal/webhook', event, headers)
  assert.equal(second.handled, false)
  const afterSecond = JSON.parse(await readFile(`${root}/data/store.json`, 'utf8'))
  assert.equal(afterSecond.orders.length, 1)
  assert.equal(afterSecond.payments.length, 1)
  assert.equal(afterSecond.payments[0].status, 'captured')
  assert.equal(afterSecond.payments[0].paypal_capture_status, 'COMPLETED')
  assert.equal(afterSecond.payments[0].paypal_capture_id, 'isolated-capture')
  assert.equal(afterSecond.orders[0].payment_status, 'paid')
  assert.equal(afterSecond.orders[0].paid_amount_cents, 1000)
  assert.deepEqual(afterSecond.orders, afterFirst.orders)
  assert.deepEqual(afterSecond.payments, afterFirst.payments)
  console.log('PASS invalid webhook verification rejected without settlement')
  console.log('PASS repeated webhook: 1 order, 1 captured payment, USD 0.73 charged, KRW 1000 paid once; duplicate handled=false')
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  await rm(root, { recursive: true, force: true })
}
