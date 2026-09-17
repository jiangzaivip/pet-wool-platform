import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import * as currency from '../frontend/src/currency.ts'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { computed, ref } = require('vue')
const source = await readFile(new URL('../frontend/src/views/Order.vue', import.meta.url), 'utf8')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'checkout-test' })
for (const name of ['displayMoney', 'formatMinorAmount', 'summaryBreakdown', 'paypalSnapshotChargeText']) {
  assert.ok(compiled.bindings[name], `Missing checkout binding: ${name}`)
}
for (const name of ['summaryBreakdown.current', 'summaryBreakdown.total', 'summaryBreakdown.remaining', 'paypalSnapshotChargeText']) {
  assert.ok(descriptor.template.content.includes(name), `Unwired checkout output: ${name}`)
}
const begin = source.indexOf('const selected = computed(')
const end = source.indexOf('const accountLink = computed(', begin)
assert.ok(begin > 0 && end > begin)
const context = vm.createContext({
  ...currency, computed, ref,
  products: ref([{ id: 'product', currency: 'KRW', base_price_cents: 1000, deposit_percent: 50, options: [{ id: 'size', price_cents: 1000 }] }]),
  form: { product_id: 'product', option_id: 'size', payment_type: 'deposit' },
  isOrderableProduct: () => true,
  validOptions: (product) => product?.options || [],
  paypalEnabled: ref(true), site: ref({ paypal: { currency: 'USD' } }), locale: ref('en'), order: ref(null),
})
vm.runInContext(stripTypeScriptTypes(source.slice(begin, end)), context)
const evaluate = (expression) => vm.runInContext(expression, context)
assert.equal(evaluate('summaryBreakdown.value.total'), '$0.73')
assert.equal(evaluate('summaryBreakdown.value.current'), '$0.36')
assert.equal(evaluate('summaryBreakdown.value.remaining'), '$0.37')
evaluate("order.value = {id:'order', amount_cents:1000, initial_payment_cents:500, currency:'KRW', payment_status:'unpaid'}; orderTotalMinor.value=1000; orderCurrency.value='KRW'; products.value=[]; lastPaymentSnapshot.value={amount_cents:36,currency:'USD'}")
assert.equal(evaluate('summaryBreakdown.value.current'), '$0.36', 'Created deposit must not display full amount after form reset')
for (const lang of ['ko', 'zh', 'en']) {
  evaluate(`locale.value='${lang}'`)
  assert.equal(evaluate('paypalSnapshotChargeText.value'), currency.formatMinorAmount(36, 'USD', lang), 'Payment snapshot must never be converted into display currency')
}
evaluate("locale.value='zh'")
assert.equal(evaluate('summaryBreakdown.value.total'), currency.formatMinorAmount(491, 'CNY', 'zh'))
console.log('PASS checkout computed bindings: rounded total/deposit/balance, authoritative order after form reset, unchanged USD payment snapshot across ko/zh/en')
