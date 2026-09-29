import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import * as currency from '../frontend/src/currency.ts'
import * as adminState from '../frontend/src/adminState.ts'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const vue = require('vue')
const { createRouter, createMemoryHistory } = require('vue-router')
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')
const source = await readFile(new URL('../frontend/src/views/AdminDashboard.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'admin-test' })
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'AdminDashboard.vue', id: 'admin-test', compilerOptions: { bindingMetadata: compiled.bindings } }).errors, [])
const script = stripTypeScriptTypes(descriptor.scriptSetup.content.replace(/^import .*$/gm, ''))
const messages = []
const requests = []
const responses = {
  '/admin/overview': { orders: 2, revenue_by_currency: { KRW: 1000 } },
  '/admin/orders': [{ id: 'a', internal_note: 'server a', revision: 2 }, { id: 'b', internal_note: 'server b', revision: 2 }],
  '/admin/users': [{ id: 'u', tags: ['vip'] }],
  '/admin/categories': [{ id: 'c', status: 'published' }],
  '/admin/products': [],
  '/admin/audit-logs': [],
  '/admin/site': { brand: { name: 'Saved brand' }, paypal: { currency: 'USD', client_id: 'saved-client' }, contact: {} },
}
const failures = new Set()
let pendingMutation
let mutateDuringRequest = () => {}
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/dashboard', component: {} }, { path: '/admin', component: {} }] })
await router.push('/admin/dashboard?tab=orders&keep=1')
const watchers = []
const context = vm.createContext({
  ...currency, ...adminState,
  computed: vue.computed, ref: vue.ref, reactive: vue.reactive,
  watch: (...args) => { watchers.push(args) }, onMounted: () => {}, onUnmounted: () => {},
  useRoute: () => vue.reactive({ get query() { return router.currentRoute.value.query } }), useRouter: () => router,
  useI18n: () => ({ t: (key) => key }),
  money: currency.formatMinorAmount,
  safeGetLocalStorage: () => 'test-token', safeRemoveLocalStorage: () => {},
  window: { location: { origin: 'http://localhost' }, setTimeout: () => {} },
  api: async (path, options) => {
    requests.push(path)
    if (failures.has(path)) throw new Error('test unavailable')
    if (options?.method === 'PUT') {
      pendingMutation = JSON.parse(options.body)
      mutateDuringRequest()
      return { id: 'a', internal_note: 'server note', revision: 3, ...pendingMutation, updated_at: 'latest' }
    }
    // Match on the path only. Endpoints that are now paginated or filtered are
    // called with a query string, and an exact-key lookup would report a valid
    // request as unexpected.
    const route = path.split('?')[0]
    assert.ok(route in responses, `Unexpected API call: ${path}`)
    return structuredClone(responses[route])
  },
})
vm.runInContext(script, context)
const evaluate = expression => vm.runInContext(expression, context)
// Use the actual dashboard functions, without mounting or contacting a server.
evaluate('showAdminMessage = (message) => testMessages.push(message)')
context.testMessages = messages
assert.equal(evaluate('tab.value'), 'orders')
assert.equal(await evaluate('loadTab()'), true)
// Orders are now server-paginated, so the request carries page params. The
// matching matters as much as the path: it is what proves the dashboard is not
// silently falling back to pulling every order and slicing client-side.
assert.equal(requests.length, 1)
assert.match(requests[0], /^\/admin\/orders\?page=\d+&page_size=\d+$/)
assert.equal(evaluate('initialLoading.value'), false)
assert.ok(watchers.some(([target]) => target === evaluate('tab')))

// Route query is authoritative, including deep links, reload state and browser back.
evaluate("tab.value = 'users'")
await new Promise(resolve => setImmediate(resolve))
assert.equal(router.currentRoute.value.query.tab, 'users')
assert.equal(router.currentRoute.value.query.keep, '1')
router.back()
await new Promise(resolve => setImmediate(resolve))
assert.equal(evaluate('tab.value'), 'orders')
await router.push('/admin/dashboard?tab=invalid')
assert.equal(evaluate('tab.value'), 'overview')
assert.equal(adminState.normalizeAdminTab(['orders']), 'overview')

// One failed tab does not block other tabs; failed resources are retryable.
failures.add('/admin/audit-logs')
await router.push('/admin/dashboard?tab=audit')
assert.equal(await evaluate('loadTab()'), false)
assert.ok(evaluate('loadError.value').includes('test unavailable'))
await router.push('/admin/dashboard?tab=orders')
assert.equal(evaluate('loadError.value'), '')
assert.equal(await evaluate('loadTab()'), true)
failures.clear()
assert.equal(await evaluate("loadTab('audit', true)"), true)
const start = requests.length
await Promise.all([evaluate("loadTab('products', true)"), evaluate("loadTab('readiness', true)")])
for (const path of ['/admin/products', '/admin/categories', '/admin/site']) {
  assert.equal(requests.slice(start).filter(value => value === path).length, 1, `Deduplicate ${path}`)
}

// Site deep links initialize every shared form; refresh preserves dirty drafts.
assert.equal(evaluate('siteForm.brand_name'), 'Saved brand')
assert.equal(evaluate('paymentForm.paypal_client_id'), 'saved-client')
evaluate("siteForm.brand_name = 'Unsaved brand'; paymentForm.paypal_client_id = 'draft-client'")
await evaluate('refreshSite()')
assert.equal(evaluate('siteForm.brand_name'), 'Unsaved brand')
assert.equal(evaluate('paymentForm.paypal_client_id'), 'draft-client')

// Protect ALL note drafts, including an intentionally cleared note, and refresh other fields.
evaluate("orders.value[0].internal_note = 'draft a'; markOrderNoteDirty(orders.value[0]); orders.value[1].internal_note = ''; markOrderNoteDirty(orders.value[1]); selectedOrder.value = orders.value[0]")
await evaluate('refreshOrders()')
assert.equal(evaluate('orders.value[0].internal_note'), 'draft a')
assert.equal(evaluate('orders.value[1].internal_note'), '')
assert.equal(evaluate('selectedOrder.value.internal_note'), 'draft a')
assert.equal(evaluate('orders.value[0].revision'), 2)
await evaluate("updateOrder(orders.value[0], 'status')")
assert.equal(evaluate('orders.value[0].internal_note'), 'draft a')
await evaluate('toggleOrderFlag(orders.value[0])')
assert.equal(evaluate('orders.value[0].internal_note'), 'draft a')
assert.equal(evaluate('orders.value[1].internal_note'), '')

// Editing again while save is in flight must not clear the newer draft.
mutateDuringRequest = () => evaluate("orders.value[0].internal_note = 'newer draft'; markOrderNoteDirty(orders.value[0])")
await evaluate("updateOrder(orders.value[0], 'note')")
assert.equal(pendingMutation.internal_note, 'draft a')
assert.equal(evaluate('orders.value[0].internal_note'), 'newer draft')
assert.equal(evaluate("dirtyOrderNoteIds.value.has('a')"), true)
mutateDuringRequest = () => {}
await evaluate("updateOrder(orders.value[0], 'note')")
assert.equal(evaluate("dirtyOrderNoteIds.value.has('a')"), false)
assert.equal(evaluate("dirtyOrderNoteIds.value.has('b')"), true)
failures.add('/admin/orders/a/note')
evaluate("orders.value[0].internal_note = 'retry draft'; markOrderNoteDirty(orders.value[0])")
await evaluate("updateOrder(orders.value[0], 'note')")
assert.equal(evaluate('orders.value[0].internal_note'), 'retry draft')
assert.equal(evaluate('savingAction.value'), '')
failures.clear()

// KRW-only editor rejects relabeling and invalid amounts before any API mutation.
const beforeValidation = requests.length
evaluate("productForm.currency = 'USD'")
await evaluate('saveProduct()')
assert.equal(requests.length, beforeValidation)
assert.equal(messages.at(-1), 'admin.krwCurrencyRequired')
evaluate("productForm.currency = 'KRW'; productForm.slug = 'test'; productForm.category_id = 'c'; productForm.status = 'hidden'; productI18n.zh.title = 'Test'; productForm.base_price_cents = 1.5")
await evaluate('saveProduct()')
assert.equal(requests.length, beforeValidation)
assert.equal(messages.at(-1), 'admin.priceRequired')
assert.equal(evaluate('savingAction.value'), '')
assert.equal(evaluate('moneyByCurrency(undefined, 0)'), currency.formatMinorAmount(0, 'KRW'))
assert.equal(evaluate('moneyByCurrency(undefined, 100)'), 'admin.currencySummaryUnavailable')
assert.ok(evaluate('moneyByCurrency({ USD: 100, KRW: 1000 })').includes(currency.formatMinorAmount(100, 'USD')))
assert.ok(descriptor.template.content.includes('<input :value="productForm.currency" readonly'))
assert.ok(descriptor.template.content.includes('data-testid="product-price-preview"'))
assert.ok(descriptor.template.content.indexOf('<nav class="tabs"') < descriptor.template.content.indexOf('v-if="initialLoading"'))
const entry = await readFile(new URL('../frontend/src/main.ts', import.meta.url), 'utf8')
assert.ok(entry.includes("component: () => import('./views/AdminDashboard.vue')"))
console.log('PASS admin console: template compilation, deep links/back navigation, per-tab loads/retry/deduplication, shared form initialization/drafts, all note drafts across refresh/status/flag/save/failure, KRW validation and summaries')
