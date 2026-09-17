#!/usr/bin/env node
// Fails when the frontend and server currency tables drift apart. The
// storefront display and the PayPal charge amount must always derive from the
// same fixed rates, so both copies of the table are compared directly.
//
// Usage: node --experimental-strip-types scripts/verify-multicurrency.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(new URL('..', import.meta.url).pathname)
const server = await import(path.join(rootDir, 'api-node', 'currency.mjs'))
const client = await import(path.join(rootDir, 'frontend', 'src', 'currency.ts'))

assert.equal(client.CURRENCY_RATE_VERSION, server.CURRENCY_RATE_VERSION, 'CURRENCY_RATE_VERSION differs')
assert.equal(client.CURRENCY_BASE, server.CURRENCY_BASE, 'CURRENCY_BASE differs')
assert.deepEqual(client.CURRENCY_RATES, server.CURRENCY_RATES, 'CURRENCY_RATES differ')
assert.deepEqual(client.CURRENCY_DECIMALS, server.CURRENCY_DECIMALS, 'CURRENCY_DECIMALS differ')
assert.deepEqual(client.LANG_CURRENCY, server.LANG_CURRENCY, 'LANG_CURRENCY differ')

const cases = [
  // [amount, from, to]
  [2192000, 'KRW', 'KRW'],
  [2192000, 'KRW', 'USD'],
  [2192000, 'KRW', 'CNY'],
  [160000, 'USD', 'KRW'],
  [160000, 'USD', 'CNY'],
  [1077150, 'CNY', 'KRW'],
  [1096000, 'KRW', 'USD'],
  [1, 'KRW', 'USD'],
  [99, 'CNY', 'USD'],
  [123456789, 'KRW', 'USD'],
]
for (const [minor, from, to] of cases) {
  const serverResult = server.convertMinorAmount(minor, from, to)
  const clientResult = client.convertMinorAmount(minor, from, to)
  assert.equal(
    clientResult,
    serverResult,
    `conversion differs for ${minor} ${from}->${to}: client ${clientResult} vs server ${serverResult}`,
  )
}

// Same-currency charges must be identity, and unsupported currencies must
// return 0 so callers can reject them instead of charging a wrong amount.
assert.equal(server.convertMinorAmount(160000, 'USD', 'USD'), 160000)
assert.equal(server.convertMinorAmount(160000, 'USD', 'EUR'), 0)
assert.equal(client.convertMinorAmount(160000, 'USD', 'EUR'), 0)

// Rounding contract spot checks (half up at the target minor unit):
// ₩2,192,000 == $1,600.00 exactly, deposit ₩1,096,000 == $800.00 exactly.
assert.equal(server.convertMinorAmount(2192000, 'KRW', 'USD'), 160000)
assert.equal(server.convertMinorAmount(1096000, 'KRW', 'USD'), 80000)

assert.equal(server.convertMinorAmount(407, 'CNY', 'KRW'), 828) // 828.245 won
assert.equal(server.convertMinorAmount(100, 'CNY', 'KRW'), 204) // 203.5 won
assert.equal(server.convertMinorAmount(1.2, 'KRW', 'USD'), 0)
assert.equal(server.convertMinorAmount(Number.MAX_SAFE_INTEGER, 'USD', 'KRW'), 0)
assert.equal(client.displayCurrencyForLang('zh-CN'), 'CNY')
assert.equal(client.majorAmountString(1370, 'KRW'), '1370')
assert.equal(client.majorAmountString(12345, 'EUR'), '123.45')
assert.match(client.formatMinorAmount(12345, 'EUR', 'en'), /123.45/)
for (let amount = 1; amount < 10000; amount++) {
  for (const target of ['KRW', 'USD', 'CNY']) {
    assert.equal(client.convertMinorAmount(amount, 'KRW', target), server.convertMinorAmount(amount, 'KRW', target))
  }
}
assert.deepEqual(client.displayMoneyBreakdown(137, 69, 'KRW', 'en'), { total: '$0.10', paid: '$0.05', remaining: '$0.05' })
console.log(`PASS: currency tables/version, rounding, formatting, regional locales, invalid inputs and 29,997 conversion parity assertions (${cases.length} additional cases)`)

