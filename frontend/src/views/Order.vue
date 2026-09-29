<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import vueFilePond from 'vue-filepond'
import FilePondPluginFileValidateSize from 'filepond-plugin-file-validate-size'
import FilePondPluginFileValidateType from 'filepond-plugin-file-validate-type'
import 'filepond/dist/filepond.min.css'
import { api, currentUser, primarySupportContact, safeGetLocalStorage, safeRemoveLocalStorage, safeSetLocalStorage, upload, type Product, type SiteSettings } from '../api'
import { chargeMoney, displayCurrencyForLang, displayMoney, displayMoneyBreakdown, formatMinorAmount } from '../currency'
import { productFallbackImage } from '../contentImages'
import { setHead } from '../head'
import { clearPaypalContainer, loadPaypalSdk, renderPaypalCardFields } from '../paypal'

const { locale, t } = useI18n()
const FilePond = vueFilePond(FilePondPluginFileValidateType, FilePondPluginFileValidateSize)
const route = useRoute()
const router = useRouter()

// Order is a stateful workflow rather than a simple form. The local draft,
// upload queue, order creation request, and PayPal approval flow all share the
// same selected product and client request id.
const products = ref<Product[]>([])
const message = ref('')
const messageTone = ref<'error' | 'success'>('error')
const loading = ref(false)
const productsLoading = ref(true)
const loadError = ref('')
const uploadingCount = ref(0)
const uploading = computed(() => uploadingCount.value > 0)
const order = ref<any>(null)
const paypalOrder = ref<any>(null)
const paypalButtonContainer = ref<HTMLElement | null>(null)
const paypalCardNameContainer = ref<HTMLElement | null>(null)
const paypalCardNumberContainer = ref<HTMLElement | null>(null)
const paypalCardExpiryContainer = ref<HTMLElement | null>(null)
const paypalCardCvvContainer = ref<HTMLElement | null>(null)
const paypalButtonLoading = ref(false)
const paypalButtonError = ref('')
const paypalCardFields = ref<any>(null)
const paypalCardEligible = ref(false)
const paypalCardLoading = ref(false)
const paypalCardError = ref('')
const paypalEnabled = ref(true)
const paypalCurrency = ref('')
const site = ref<SiteSettings>({})
const uploadError = ref('')
const brokenPhotoUrls = ref(new Set<string>())
const pond = ref<any>(null)
let submitSeq = 0
let paypalRenderSeq = 0
const draftEnabled = ref(true)
const maxUploadBytes = 8 * 1024 * 1024
const maxPhotoCount = 12
const acceptedPhotoTypes = ['image/jpeg', 'image/png', 'image/webp']
const draftKey = 'pet-wool-order-draft-v1'
const publicPaymentTypes = ['deposit', 'full']
const newClientRequestId = () => `order-${Date.now()}-${Math.random().toString(16).slice(2)}`
const form = reactive({
  client_request_id: newClientRequestId(),
  product_id: '',
  option_id: '',
  customer_name: '',
  email: '',
  phone: '',
  country: '',
  shipping_address: '',
  pet_name: '',
  pet_type: '',
  payment_type: 'deposit',
  notes: '',
  photo_urls: [] as string[]
})
const draftFields = ['client_request_id', 'product_id', 'option_id', 'customer_name', 'email', 'phone', 'country', 'shipping_address', 'pet_name', 'pet_type', 'notes', 'photo_urls'] as const
const draftPaymentFields = ['payment_type'] as const
const draftTextLimits: Partial<Record<typeof draftFields[number], number>> = {
  client_request_id: 120,
  product_id: 120,
  option_id: 120,
  customer_name: 120,
  email: 160,
  phone: 80,
  country: 120,
  shipping_address: 500,
  pet_name: 120,
  pet_type: 80,
  notes: 2000,
}

function isValidDraftPhotoUrl(value: unknown) {
  return typeof value === 'string' && /^\/uploads\/[0-9]+-[a-f0-9-]+\.(png|jpe?g|webp)$/i.test(value)
}

// Only server-shaped upload URLs are restored from local storage. This avoids
// turning an old or tampered draft into arbitrary image requests.
function validOptions(product?: Product | null) {
  return (product?.options || []).filter(option => option?.id && Number(option.price_cents || 0) > 0)
}

function isOrderableProduct(product?: Product | null) {
  return Boolean(product?.id && Number(product.deposit_percent || 0) > 0 && Number(product.deposit_percent || 0) <= 100 && validOptions(product).length)
}

const selected = computed(() => products.value.find(p => p.id === form.product_id && isOrderableProduct(p)))
const selectedOptions = computed(() => validOptions(selected.value))
const selectedOption = computed(() => selectedOptions.value.find(o => o.id === form.option_id) || selectedOptions.value[0])
const paypalAvailableForSelected = computed(() => {
  // Product prices are stored in the KRW base; PayPal charges the site charge
  // currency at the fixed converted rate, so the currencies no longer need to
  // match for PayPal to be available.
  return paypalEnabled.value
})
const paypalChargeCurrency = computed(() => String(site.value?.paypal?.currency || 'USD').trim().toUpperCase() || 'USD')
// Amount the customer sees in their display currency versus the exact amount
// PayPal will capture. Before an order exists the preview is computed from the
// selected form with the same fixed rate table. Once the server has created an
// order (or payment), the server snapshot is authoritative and shown verbatim.
const displayCurrencyMatchesCharge = computed(() => displayCurrencyForLang(locale.value) === paypalChargeCurrency.value)
const paypalChargeText = computed(() => selected.value ? chargeMoney(amount.value, selected.value.currency, paypalChargeCurrency.value, locale.value) : '')
// Latest server payment snapshot ({ amount_cents, currency, base_amount_cents,
// base_currency }). Shown exactly as returned; never recomputed client-side.
const lastPaymentSnapshot = ref<any>(null)
// Authoritative post-create amounts (order.currency base minor units).
const orderTotalMinor = ref(0)
const orderPaidMinor = ref(0)
const orderCurrency = ref('')
const orderSummaryActive = computed(() => Boolean(order.value && orderCurrency.value))
const summaryBreakdown = computed(() => {
  const currency = orderSummaryActive.value ? orderCurrency.value : selected.value?.currency || ''
  const total = orderSummaryActive.value ? orderTotalMinor.value : fullAmount.value
  const current = orderSummaryActive.value
    ? Number(order.value.initial_payment_cents || total)
    : amount.value
  const parts = displayMoneyBreakdown(total, current, currency, locale.value)
  return { total: parts.total, current: parts.paid, remaining: parts.remaining }
})
// Exact charge line for an actual server payment snapshot. Always rendered
// while a snapshot exists (even when the display currency equals the charge
// currency) so the customer sees the number PayPal will actually capture.
const paypalSnapshotChargeText = computed(() => {
  const payment = lastPaymentSnapshot.value
  if (!payment) return ''
  const chargeCurrency = String(payment.currency || paypalChargeCurrency.value || 'USD').trim().toUpperCase()
  return formatMinorAmount(Number(payment.amount_cents || 0), chargeCurrency, locale.value)
})
const fullAmount = computed(() => selectedOption.value?.price_cents || selected.value?.base_price_cents || 0)
const amount = computed(() => {
  const product = selected.value
  const base = fullAmount.value
  if (!product) return 0
  if (form.payment_type === 'deposit') return Math.round(base * product.deposit_percent / 100)
  return base
})
const remainingAfterPayment = computed(() => Math.max(0, fullAmount.value - amount.value))
const accountLink = computed(() => ({
  path: '/account',
  query: order.value && form.email ? { email: form.email.trim().toLowerCase() } : {}
}))
const supportContact = computed(() => primarySupportContact(site.value, t('support.emailLabel')))
const orderSupportRoute = computed(() => {
  if (!order.value) return { path: '/support' }
  return {
    path: '/support',
    query: {
      order: order.value.order_no || order.value.id || '',
      email: form.email.trim().toLowerCase(),
    }
  }
})
const preSubmitChecks = computed(() => [
  {
    key: 'contact',
    label: t('order.checkContact'),
    ready: Boolean(form.customer_name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) && form.phone.trim()),
    value: form.customer_name.trim() && form.email.trim()
      ? `${form.customer_name.trim()} / ${form.email.trim()}`
      : t('order.checkMissing')
  },
  {
    key: 'pet',
    label: t('order.checkPet'),
    ready: Boolean(form.pet_name.trim() && form.pet_type.trim()),
    value: form.pet_name.trim() || form.pet_type.trim()
      ? `${form.pet_name.trim() || '-'} ${form.pet_type.trim() || ''}`.trim()
      : t('order.checkMissing')
  },
  {
    key: 'photos',
    label: t('order.checkPhotos'),
    ready: form.photo_urls.length > 0,
    value: t('order.checkPhotoCount', { count: form.photo_urls.length })
  },
  {
    key: 'shipping',
    label: t('order.checkShipping'),
    ready: Boolean(form.country.trim() || form.shipping_address.trim()),
    value: form.shipping_address.trim() || form.country.trim() || t('order.checkOptional')
  },
])
const missingRequiredChecks = computed(() => preSubmitChecks.value.filter(item => item.key !== 'shipping' && !item.ready))

function supportTextValue(value: unknown, limit = 500) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!text) return '-'
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function supportLinkValue(value: unknown, limit = 1200) {
  const text = supportTextValue(value, limit)
  return text === '-' ? '' : text
}

async function loadProducts() {
  setHead(t('order.title'), t('order.desc'), { canonical: `${window.location.origin}/order`, image: productFallbackImage })
  productsLoading.value = true
  loadError.value = ''
  try {
    const [siteConfig, productList] = await Promise.all([
      api<any>('/site').catch(() => ({})),
      api<Product[]>(`/products?lang=${locale.value}`),
    ])
    site.value = siteConfig || {}
    paypalEnabled.value = siteConfig?.paypal?.enabled !== false
    paypalCurrency.value = String(siteConfig?.paypal?.currency || '').trim().toUpperCase()
    products.value = productList.filter(isOrderableProduct)
    const requestedProductId = String(route.query.product || form.product_id || '')
    const fallbackProduct = products.value.find(isOrderableProduct)
    const hasRequestedProduct = products.value.some(product => product.id === requestedProductId && isOrderableProduct(product))
    form.product_id = hasRequestedProduct
      ? requestedProductId
      : String(fallbackProduct?.id || '')
    if (requestedProductId && !hasRequestedProduct) showOrderMessage(t('order.productUnavailable'))
    const hasCurrentOption = selectedOptions.value.some(option => option.id === form.option_id)
    const requestedOptionId = String(route.query.option || '')
    const hasRequestedOption = selectedOptions.value.some(option => option.id === requestedOptionId)
    form.option_id = hasRequestedOption
      ? requestedOptionId
      : String(hasCurrentOption && form.option_id ? form.option_id : selectedOptions.value[0]?.id || '')
    if (requestedOptionId && !hasRequestedOption) showOrderMessage(t('order.optionUnavailable'))
    const requestedPaymentType = String(route.query.payment || form.payment_type)
    const hasRequestedPaymentType = publicPaymentTypes.includes(requestedPaymentType)
    form.payment_type = hasRequestedPaymentType
      ? requestedPaymentType
      : 'deposit'
    if (route.query.payment && !hasRequestedPaymentType) showOrderMessage(t('order.paymentInvalid'))
  } catch {
    loadError.value = t('common.loadFailed')
  } finally {
    productsLoading.value = false
  }
}

function orderSupportUrl() {
  const contact = supportContact.value
  if (!contact || !order.value) return contact?.url || ''
  const orderNo = supportTextValue(order.value.order_no || order.value.id, 80)
  const email = supportTextValue(form.email.trim().toLowerCase(), 160)
  const body = [
    `${t('account.detailOrder')} ${orderNo}`,
    `${t('account.detailContact')} ${email}`,
    `${t('account.detailAmount')} ${selected.value ? displayMoney(amount.value, selected.value.currency, locale.value) : '-'}`,
    `${t('account.supportPage')} ${window.location.href}`,
  ].join('\n')
  if (contact.url.startsWith('mailto:')) {
    const [baseUrl, queryText = ''] = contact.url.split('?')
    const params = new URLSearchParams(queryText)
    if (!params.has('subject')) params.set('subject', supportLinkValue(`${t('account.supportSubject')} ${orderNo}`, 160))
    if (!params.has('body')) params.set('body', supportLinkValue(body, 1200))
    return `${baseUrl}?${params.toString()}`
  }
  try {
    const url = new URL(contact.url)
    if (!url.searchParams.has('text') && !url.searchParams.has('message')) url.searchParams.set('text', supportLinkValue(body, 900))
    return url.toString()
  } catch {
    return contact.url
  }
}

function restoreDraft() {
  try {
    const draft = JSON.parse(safeGetLocalStorage(draftKey) || '{}')
    draftFields.forEach((field) => {
      if (field === 'photo_urls' && Array.isArray(draft[field])) {
        form.photo_urls = draft[field]
          .filter(isValidDraftPhotoUrl)
          .slice(0, maxPhotoCount)
      }
      else if (field !== 'photo_urls' && typeof draft[field] === 'string') {
        form[field] = draft[field].slice(0, draftTextLimits[field] || 500)
      }
    })
    draftPaymentFields.forEach((field) => {
      if (typeof draft[field] === 'string') form[field] = draft[field]
    })
    if (!/^order-\d+-[a-f0-9]+$/i.test(form.client_request_id)) form.client_request_id = newClientRequestId()
    if (!publicPaymentTypes.includes(form.payment_type)) form.payment_type = 'deposit'
  } catch {
    safeRemoveLocalStorage(draftKey)
  }
}

function saveDraft() {
  if (!draftEnabled.value) return
  const draft = Object.fromEntries(draftFields.map((field) => {
    if (field === 'photo_urls') return [field, form.photo_urls.filter(isValidDraftPhotoUrl).slice(0, maxPhotoCount)]
    return [field, String(form[field] || '').slice(0, draftTextLimits[field] || 500)]
  }))
  draft.payment_type = publicPaymentTypes.includes(form.payment_type) ? form.payment_type : 'deposit'
  safeSetLocalStorage(draftKey, JSON.stringify(draft))
}

function clearDraft() {
  safeRemoveLocalStorage(draftKey)
}

function applyCurrentUserToForm() {
  const user = currentUser()
  if (!user?.email) return
  form.email = user.email
  if (user.name) form.customer_name = user.name
}

function resetOrderFormAfterSuccess(email: string, customerName: string) {
  const currentProduct = form.product_id
  form.product_id = currentProduct || products.value.find(isOrderableProduct)?.id || ''
  const nextProduct = products.value.find(product => product.id === form.product_id && isOrderableProduct(product))
  form.client_request_id = newClientRequestId()
  form.option_id = validOptions(nextProduct)[0]?.id || ''
  form.customer_name = customerName
  form.email = email
  form.phone = ''
  form.country = ''
  form.shipping_address = ''
  form.pet_name = ''
  form.pet_type = ''
  form.payment_type = 'deposit'
  form.notes = ''
  form.photo_urls = []
  pondApi()?.removeFiles?.({ revert: false, remove: false })
}

function clearPondInput() {
  window.setTimeout(() => {
    const root = pond.value?.$el as HTMLElement | undefined
    const input = root?.querySelector('input[type="file"]') as HTMLInputElement | null
    if (input) input.value = ''
  }, 0)
}

function pondApi() {
  return pond.value?._pond || pond.value
}

function removePondItem(file: any, delay = 350) {
  if (!file?.id) return
  window.setTimeout(() => pondApi()?.removeFile?.(file.id, { revert: false, remove: false }), delay)
}

function clearPondItems(delay = 650) {
  const files = pondApi()?.getFiles?.() || []
  const ids = files.map((file: any) => file.id).filter(Boolean)
  if (!ids.length) return
  window.setTimeout(() => {
    const api = pondApi()
    ids.forEach((id: string) => api?.removeFile?.(id, { revert: false, remove: false }))
  }, delay)
}

function pondErrorMessage(error: any) {
  const text = String(error?.body || error?.message || error?.type || error || '').toLowerCase()
  if (text.includes('max files') || text.includes('maximum')) return t('order.uploadTooMany', { max: maxPhotoCount })
  if (text.includes('type') || text.includes('invalid')) return t('order.uploadTypeInvalid')
  if (text.includes('size') || text.includes('large')) return t('order.uploadTooLarge')
  return t('order.uploadFailed')
}

function validatePondFile(item: any) {
  const file = item?.file as File | undefined
  const activePondFiles = Number(pondApi()?.getFiles?.()?.length || 0)
  if (form.photo_urls.length + activePondFiles >= maxPhotoCount) {
    uploadError.value = t('order.uploadTooMany', { max: maxPhotoCount })
    clearPondInput()
    return false
  }
  if (file && !/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) {
    uploadError.value = t('order.uploadTypeInvalid')
    clearPondInput()
    return false
  }
  if (file && file.size > maxUploadBytes) {
    uploadError.value = t('order.uploadTooLarge')
    clearPondInput()
    return false
  }
  uploadError.value = ''
  return true
}

const pondServer = {
  process: async (_fieldName: string, file: File, _metadata: any, load: (id: string) => void, error: (message: string) => void) => {
    uploadError.value = ''
    if (form.photo_urls.length >= maxPhotoCount) {
      const message = t('order.uploadTooMany', { max: maxPhotoCount })
      uploadError.value = message
      error(message)
      clearPondInput()
      return
    }
    uploadingCount.value += 1
    try {
      const result = await upload(file)
      form.photo_urls.push(result.url)
      load(result.url)
    } catch {
      const message = t('order.uploadFailed')
      uploadError.value = message
      error(message)
    } finally {
      uploadingCount.value = Math.max(0, uploadingCount.value - 1)
      clearPondInput()
    }
  },
  revert: (_uniqueFileId: string, load: () => void) => {
    load()
  },
}

function onPondWarning(error: any) {
  uploadError.value = pondErrorMessage(error)
  clearPondInput()
}

function onPondError(error: any, file?: any) {
  uploadError.value = pondErrorMessage(error)
  clearPondInput()
  removePondItem(file, 900)
}

function onPondProcessFile(error: any, file: any) {
  if (error) {
    uploadError.value = pondErrorMessage(error)
    removePondItem(file, 900)
    return
  }
  uploadError.value = ''
  removePondItem(file, 420)
}

function onPondProcessFiles() {
  clearPondItems(650)
}

function removePhoto(url: string) {
  form.photo_urls = form.photo_urls.filter(item => item !== url)
  brokenPhotoUrls.value.delete(url)
  uploadError.value = ''
}

function markPhotoMissing(url: string) {
  brokenPhotoUrls.value.add(url)
}

function showOrderMessage(text: string, tone: 'error' | 'success' = 'error') {
  message.value = text
  messageTone.value = tone
}

function onProductChange() {
  form.option_id = selectedOptions.value[0]?.id || ''
  form.payment_type = 'deposit'
}

function submitErrorMessage(error: any) {
  const text = String(error?.message || '')
  if (text === 'product not found') return t('order.productUnavailable')
  if (text === 'photo required') return t('order.photoRequired')
  if (text === 'too many photos') return t('order.uploadTooMany', { max: maxPhotoCount })
  if (text === 'valid email required') return t('order.customerRequired')
  if (text === 'customer name required') return t('order.customerRequired')
  if (text === 'invalid customer name') return t('order.customerNameTooLong')
  if (text === 'phone required' || text === 'invalid phone') return t('order.phoneRequired')
  if (text === 'invalid country') return t('order.countryTooLong')
  if (text === 'invalid shipping address') return t('order.shippingAddressTooLong')
  if (text === 'pet name required' || text === 'pet type required') return t('order.petRequired')
  if (text === 'invalid pet name' || text === 'invalid pet type') return t('order.petInfoTooLong')
  if (text === 'invalid photo url') return t('order.photoUrlInvalid')
  if (text === 'invalid option') return t('order.optionUnavailable')
  if (text === 'invalid payment type' || text === 'balance payment requires an existing order') return t('order.paymentInvalid')
  if (text === 'user blocked') return t('order.accountBlocked')
  return t('order.submitFailed')
}

// After the server returns an order (and optionally a payment snapshot), the
// local form preview no longer decides what the customer sees: order
// amount_cents/currency and the payment record are authoritative.
function adoptServerOrderSummary(result: any) {
  if (!result?.id) return
  order.value = result
  orderCurrency.value = String(result.currency || '').trim().toUpperCase() || orderCurrency.value
  orderTotalMinor.value = Number(result.amount_cents || 0)
  const initial = Number(result.initial_payment_cents || 0)
  orderPaidMinor.value = Number(result.paid_amount_cents || 0) || (result.payment_status === 'unpaid' ? 0 : initial)
  if (result.payment) lastPaymentSnapshot.value = result.payment
}

// Prefetch the PayPal payment intent so the SDK renders with the server's
// exact charge amount/currency already known, and the createOrder callback can
// reuse the intent instead of racing a fresh request during button click.
async function prefetchPaypalIntent(orderId: string) {
  const seq = paypalRenderSeq
  try {
    const result = await requestPaypalOrder(orderId)
    if (seq !== paypalRenderSeq || order.value?.id !== orderId) return null
    paypalOrder.value = result
    if (result.payment) lastPaymentSnapshot.value = result.payment
    if (result.order) adoptServerOrderSummary(result.order)
    return result
  } catch {
    // Rendering will surface the error through createOrder/retry.
    return null
  }
}

function resetOrderSummary() {
  lastPaymentSnapshot.value = null
  orderTotalMinor.value = 0
  orderPaidMinor.value = 0
  orderCurrency.value = ''
}

async function submit() {
  if (!form.option_id && selectedOptions.value[0]?.id) {
    form.option_id = selectedOptions.value[0].id
  }
  if (!form.product_id || !form.option_id) {
    showOrderMessage(t('order.productRequired'))
    return
  }
  if (!form.customer_name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    showOrderMessage(t('order.customerRequired'))
    return
  }
  if (form.customer_name.trim().length > 120) {
    showOrderMessage(t('order.customerNameTooLong'))
    return
  }
  if (!form.phone.trim()) {
    showOrderMessage(t('order.phoneRequired'))
    return
  }
  if (form.phone.length > 80) {
    showOrderMessage(t('order.phoneTooLong'))
    return
  }
  if (form.country.trim().length > 120) {
    showOrderMessage(t('order.countryTooLong'))
    return
  }
  if (form.shipping_address.length > 500) {
    showOrderMessage(t('order.shippingAddressTooLong'))
    return
  }
  if (!form.pet_name.trim() || !form.pet_type.trim()) {
    showOrderMessage(t('order.petRequired'))
    return
  }
  if (form.pet_name.trim().length > 120 || form.pet_type.trim().length > 80) {
    showOrderMessage(t('order.petInfoTooLong'))
    return
  }
  if (!form.photo_urls.length) {
    showOrderMessage(t('order.photoRequired'))
    return
  }
  if (form.photo_urls.length > maxPhotoCount) {
    showOrderMessage(t('order.uploadTooMany', { max: maxPhotoCount }))
    return
  }
  if (!publicPaymentTypes.includes(form.payment_type)) {
    form.payment_type = 'deposit'
    showOrderMessage(t('order.paymentInvalid'))
    return
  }
  loading.value = true
  const seq = ++submitSeq
  message.value = ''
  order.value = null
  paypalOrder.value = null
  resetOrderSummary()
  resetPaypalButtons()
  const payload = {
    ...form,
    customer_name: form.customer_name.trim(),
    email: form.email.trim().toLowerCase(),
    phone: form.phone.trim(),
    country: form.country.trim(),
    shipping_address: form.shipping_address.trim(),
    pet_name: form.pet_name.trim(),
    pet_type: form.pet_type.trim(),
    notes: form.notes.trim(),
    lang: locale.value,
    size_option: selectedOption.value?.name || ''
  }
  try {
    const result = await api<any>('/orders', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    if (seq !== submitSeq) return
    adoptServerOrderSummary(result)
    draftEnabled.value = false
    clearDraft()
    resetOrderFormAfterSuccess(payload.email, payload.customer_name)
    draftEnabled.value = true
    // Reuse any prefetched intent: if the server already created a matching
    // payment for this order, rendering starts from it instead of guessing.
    await renderOrderPaypalButtons()
    if (seq !== submitSeq) return
    // When PayPal is disabled the customer cannot continue to PayPal; point
    // them to the pay-later path instead of asking them to keep paying.
    if (site.value.paypal?.enabled === false) {
      showOrderMessage(t('order.createdPayLater', { orderNo: result.order_no }), 'error')
    } else {
      showOrderMessage(t('order.created', { orderNo: result.order_no }), 'success')
    }
  } catch (e: any) {
    if (seq !== submitSeq) return
    showOrderMessage(submitErrorMessage(e))
  } finally {
    if (seq === submitSeq) loading.value = false
  }
}

function resetPaypalButtons() {
  paypalRenderSeq += 1
  paypalButtonLoading.value = false
  paypalButtonError.value = ''
  paypalCardFields.value = null
  paypalCardEligible.value = false
  paypalCardLoading.value = false
  paypalCardError.value = ''
  clearPaypalContainer(paypalButtonContainer.value)
  clearPaypalContainer(paypalCardNameContainer.value)
  clearPaypalContainer(paypalCardNumberContainer.value)
  clearPaypalContainer(paypalCardExpiryContainer.value)
  clearPaypalContainer(paypalCardCvvContainer.value)
}

async function captureApprovedPaypalOrder(paypalOrderId = paypalOrder.value?.id) {
  const result = await api<any>('/paypal/capture-order', {
    method: 'POST',
    body: JSON.stringify({ paypal_order_id: paypalOrderId })
  })
  adoptServerOrderSummary(result.order)
  paypalOrder.value = null
  resetPaypalButtons()
  showOrderMessage(t('order.paid', { orderNo: order.value.order_no }), 'success')
}

async function requestPaypalOrder(orderId: string) {
  return api<any>('/paypal/create-order', {
    method: 'POST',
    body: JSON.stringify({
      order_id: orderId,
      return_path: '/order?paypal_return=1',
      cancel_path: '/order?paypal_cancel=1',
    })
  })
}

async function retryPaypalPayment() {
  if (!order.value || loading.value) return
  loading.value = true
  message.value = ''
  paypalButtonError.value = ''
  try {
    await renderOrderPaypalButtons()
    showOrderMessage(t('order.created', { orderNo: order.value.order_no }), 'success')
  } catch {
    showOrderMessage(t('order.createdPayLater', { orderNo: order.value.order_no }), 'error')
  } finally {
    loading.value = false
  }
}

async function renderOrderPaypalButtons() {
  resetPaypalButtons()
  if (!order.value || ['paid', 'deposit_paid'].includes(order.value.payment_status)) return
  const orderId = order.value.id
  const clientId = String(site.value.paypal?.client_id || '').trim()
  if (!clientId) {
    paypalButtonError.value = t('order.paypalButtonError')
    return
  }
  const seq = paypalRenderSeq
  paypalButtonLoading.value = true
  await nextTick()
  const target = paypalButtonContainer.value
  if (!target || seq !== paypalRenderSeq) {
    paypalButtonLoading.value = false
    return
  }
  try {
    // Prefetch the payment intent before loading the SDK so the exact charge
    // amount/currency from the server snapshot is known before any button is
    // drawn, and createOrder can reuse the same intent.
    if (!paypalOrder.value || paypalOrder.value?.order?.id !== orderId) {
      const prefetched = await prefetchPaypalIntent(orderId)
      if (seq !== paypalRenderSeq || order.value?.id !== orderId) return
      if (prefetched?.mock) {
        // Mock mode cannot render SDK buttons; fall back to the confirm button.
        paypalButtonLoading.value = false
        return
      }
    }
    const snapshotCurrency = String(paypalOrder.value?.payment?.currency || '').trim().toUpperCase()
    if (!snapshotCurrency || !paypalOrder.value?.id) throw new Error('paypal payment snapshot missing')
    const paypal = await loadPaypalSdk({ clientId, currency: snapshotCurrency })
    if (seq !== paypalRenderSeq || order.value?.id !== orderId) return
    clearPaypalContainer(target)
    const createPaypalOrder = async () => {
      if (order.value?.id !== orderId) throw new Error('stale paypal render')
      // Reuse the prefetched/reused intent whenever it still belongs to this
      // order; otherwise request one and adopt the returned snapshot.
      if (paypalOrder.value?.order?.id === order.value?.id && paypalOrder.value?.id) {
        return paypalOrder.value.id
      }
      try {
        const result = await requestPaypalOrder(order.value.id)
        paypalOrder.value = result
        if (result.payment) lastPaymentSnapshot.value = result.payment
        if (result.order) adoptServerOrderSummary(result.order)
        if (result.mock) throw new Error('paypal mock cannot render SDK buttons')
        return result.id
      } catch (error) {
        paypalButtonError.value = t('order.paypalButtonError')
        throw error
      }
    }
    const buttons = paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 44 },
      createOrder: createPaypalOrder,
      onApprove: async (data: any) => {
        loading.value = true
        try {
          await captureApprovedPaypalOrder(data?.orderID || paypalOrder.value?.id)
        } catch {
          showOrderMessage(t('order.payFailed'))
        } finally {
          loading.value = false
        }
      },
      onCancel: () => {
        showOrderMessage(t('order.payCancelled'))
      },
      onError: () => {
        paypalButtonError.value = t('order.paypalButtonError')
      },
    })
    if (buttons.isEligible && !buttons.isEligible()) {
      paypalButtonError.value = t('order.paypalButtonError')
      return
    }
    await buttons.render(target)
    await nextTick()
    const cardTargets = {
      name: paypalCardNameContainer.value,
      number: paypalCardNumberContainer.value,
      expiry: paypalCardExpiryContainer.value,
      cvv: paypalCardCvvContainer.value,
    }
    if (cardTargets.name && cardTargets.number && cardTargets.expiry && cardTargets.cvv && seq === paypalRenderSeq) {
      const fields = await renderPaypalCardFields({
        paypal,
        targets: cardTargets as any,
        createOrder: createPaypalOrder,
        onApprove: async (data: any) => {
          loading.value = true
          try {
            await captureApprovedPaypalOrder(data?.orderID || paypalOrder.value?.id)
          } catch {
            showOrderMessage(t('order.payFailed'))
          } finally {
            loading.value = false
          }
        },
      })
      if (seq !== paypalRenderSeq) return
      paypalCardFields.value = fields
      paypalCardEligible.value = Boolean(fields)
    }
  } catch {
    paypalButtonError.value = t('order.paypalButtonError')
  } finally {
    if (seq === paypalRenderSeq) paypalButtonLoading.value = false
  }
}

async function submitPaypalCardFields() {
  if (!paypalCardFields.value || loading.value || paypalCardLoading.value) return
  paypalCardLoading.value = true
  paypalCardError.value = ''
  try {
    await paypalCardFields.value.submit()
  } catch {
    paypalCardError.value = t('order.paypalButtonError')
  } finally {
    paypalCardLoading.value = false
  }
}

async function capturePaypal() {
  if (!paypalOrder.value || paypalOrder.value.order?.id !== order.value?.id) return
  loading.value = true
  try {
    const result = await api<any>('/paypal/capture-order', {
      method: 'POST',
      body: JSON.stringify({ paypal_order_id: paypalOrder.value.id })
    })
    adoptServerOrderSummary(result.order)
    showOrderMessage(t('order.paid', { orderNo: order.value.order_no }), 'success')
  } catch (e: any) {
    showOrderMessage(t('order.payFailed'))
  } finally {
    loading.value = false
  }
}

function paypalReturnOrderId() {
  return String(route.query.token || route.query.paypal_order_id || '').trim()
}

async function capturePaypalReturn() {
  if (!route.query.paypal_return) return
  const paypalOrderId = paypalReturnOrderId()
  if (!paypalOrderId) return
  loading.value = true
  try {
    const result = await api<any>('/paypal/capture-order', {
      method: 'POST',
      body: JSON.stringify({ paypal_order_id: paypalOrderId })
    })
    order.value = result.order
    paypalOrder.value = null
    showOrderMessage(t('order.paid', { orderNo: order.value.order_no }), 'success')
    await router.replace({ path: '/order' })
  } catch {
    showOrderMessage(t('order.payFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  restoreDraft()
  applyCurrentUserToForm()
  await loadProducts()
  await capturePaypalReturn()
})
onBeforeUnmount(resetPaypalButtons)
watch(locale, loadProducts)
watch(() => route.query, loadProducts)
watch(() => draftFields.filter((field) => field !== 'photo_urls').map((field) => form[field]), saveDraft)
watch(() => form.photo_urls, saveDraft, { deep: true })
</script>

<template>
  <main class="section order-page">
    <section class="page-hero compact-hero">
      <p class="eyebrow">{{ t('order.eyebrow') }}</p>
      <h1>{{ t('order.title') }}</h1>
      <p class="lead">{{ t('order.desc') }}</p>
    </section>
    <p v-if="productsLoading" class="muted">{{ t('common.loading') }}</p>
    <section v-else-if="loadError" class="panel empty-state">
      <h2>{{ t('order.loadFailedTitle') }}</h2>
      <p class="muted">{{ t('order.loadFailedDesc') }}</p>
      <div class="actions">
        <button class="button ghost" type="button" @click="loadProducts">{{ t('order.retry') }}</button>
        <RouterLink class="button primary" to="/collections">{{ t('common.collections') }}</RouterLink>
        <RouterLink class="button ghost" to="/support">{{ t('account.contactSupport') }}</RouterLink>
      </div>
    </section>
    <section v-if="!productsLoading && !loadError && !products.length" class="panel empty-state">
      <h2>{{ t('order.emptyTitle') }}</h2>
      <p class="muted">{{ t('order.emptyDesc') }}</p>
      <div class="actions">
        <RouterLink class="button primary" to="/collections">{{ t('common.collections') }}</RouterLink>
        <RouterLink class="button ghost" to="/support">{{ t('account.contactSupport') }}</RouterLink>
      </div>
    </section>
    <div v-else-if="products.length" class="checkout-layout">
      <form class="order-form premium-form" novalidate @submit.prevent="submit">
        <label>{{ t('order.product') }}
          <select v-model="form.product_id" required @change="onProductChange">
            <option v-for="product in products" :key="product.id" :value="product.id">
              {{ product.title }} — {{ t('common.from') }} {{ displayMoney(validOptions(product)[0]?.price_cents || product.base_price_cents, product.currency, locale) }}
            </option>
          </select>
        </label>
        <label>{{ t('order.size') }}
          <select v-model="form.option_id" required>
            <option v-for="option in selectedOptions" :key="option.id" :value="option.id">
              {{ option.name }} — {{ displayMoney(option.price_cents, selected?.currency, locale) }}
            </option>
          </select>
        </label>
        <div class="form-grid">
          <label>{{ t('order.name') }}<input v-model="form.customer_name" autocomplete="name" maxlength="120" required /></label>
          <label>{{ t('order.email') }}<input v-model="form.email" type="email" autocomplete="email" maxlength="160" required /></label>
          <label>{{ t('order.phone') }}<input v-model="form.phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="80" :placeholder="t('order.phonePlaceholder')" required /></label>
          <label>{{ t('order.country') }}<input v-model="form.country" autocomplete="country-name" maxlength="120" /></label>
          <label>{{ t('order.shippingAddress') }}<input v-model="form.shipping_address" autocomplete="street-address" maxlength="500" :placeholder="t('order.shippingAddressPlaceholder')" /></label>
          <label>{{ t('order.petName') }}<input v-model="form.pet_name" maxlength="120" required /></label>
          <label>{{ t('order.petType') }}<input v-model="form.pet_type" maxlength="80" :placeholder="t('order.petTypePlaceholder')" required /></label>
        </div>
        <div class="upload-box premium-upload">
          <div class="upload-intro">
            <div>
              <strong>{{ t('order.photoTitle') }}</strong>
              <p>{{ t('order.photoHelp') }}</p>
            </div>
            <span class="upload-count-pill">{{ form.photo_urls.length }} / {{ maxPhotoCount }}</span>
          </div>
          <FilePond
            ref="pond"
            name="photos"
            class-name="order-filepond"
            :accepted-file-types="acceptedPhotoTypes"
            :allow-multiple="true"
            :allow-reorder="false"
            :allow-revert="false"
            :allow-remove="true"
            :before-add-file="validatePondFile"
            :credits="false"
            :disabled="form.photo_urls.length >= maxPhotoCount"
            :instant-upload="true"
            max-file-size="8MB"
            :max-files="Math.max(1, maxPhotoCount - form.photo_urls.length)"
            :server="pondServer"
            :label-idle="t('order.uploadIdle')"
            :label-file-waiting-for-size="t('order.uploadWaitingSize')"
            :label-file-size-not-available="t('order.uploadSizeUnknown')"
            :label-file-added="t('order.uploadAdded')"
            :label-file-removed="t('order.uploadRemoved')"
            :label-file-processing="t('order.uploading')"
            :label-file-processing-complete="t('order.uploadComplete')"
            :label-file-processing-error="t('order.uploadFailed')"
            :label-tap-to-cancel="t('order.uploadCancel')"
            :label-tap-to-retry="t('order.uploadRetry')"
            :label-tap-to-undo="t('order.uploadUndo')"
            :label-button-remove-item="t('order.uploadRemove')"
            :label-button-abort-item-processing="t('order.uploadCancel')"
            :label-button-retry-item-processing="t('order.uploadRetry')"
            :label-button-undo-item-processing="t('order.uploadUndo')"
            :label-file-type-not-allowed="t('order.uploadTypeInvalid')"
            :file-validate-type-label-expected-types="t('order.uploadExpectedTypes')"
            :label-max-file-size-exceeded="t('order.uploadTooLarge')"
            :label-max-file-size="t('order.uploadMaxSizeLabel')"
            @warning="onPondWarning"
            @error="onPondError"
            @processfile="onPondProcessFile"
            @processfiles="onPondProcessFiles"
          />
          <div class="upload-meta">
            <span>{{ t('order.uploadMetaTypes') }}</span>
            <span>{{ t('order.uploadMetaSize', { max: maxPhotoCount }) }}</span>
          </div>
          <div v-if="uploading" class="upload-status" role="status" aria-live="polite">
            <span class="loading-spinner" aria-hidden="true"></span>
            <span>
              <strong>{{ t('order.uploading') }}</strong>
              <small>{{ t('order.uploadWaitingHint') }}</small>
            </span>
          </div>
          <span v-if="uploadError" class="form-message error">{{ uploadError }}</span>
          <div v-if="form.photo_urls.length" class="photo-preview enhanced">
            <figure v-for="url in form.photo_urls" :key="url" class="photo-tile">
              <img v-if="!brokenPhotoUrls.has(url)" :src="url" alt="uploaded pet" @error="markPhotoMissing(url)" />
              <figcaption v-else class="missing-photo">{{ t('admin.photoMissing') }}</figcaption>
              <button type="button" @click="removePhoto(url)">{{ t('common.remove') }}</button>
            </figure>
          </div>
        </div>
        <label>{{ t('order.notes') }}<textarea v-model="form.notes" rows="5" maxlength="2000" :placeholder="t('order.notesPlaceholder')" /></label>
        <button type="submit" class="button primary" :disabled="loading || uploading || productsLoading || !products.length">{{ loading ? t('common.loading') : t('order.submit') }}</button>
        <p v-if="missingRequiredChecks.length" class="form-message warning order-submit-hint">
          {{ t('order.submitMissing', { items: missingRequiredChecks.map(item => item.label).join('、') }) }}
        </p>
        <p v-if="message && messageTone === 'error'" class="form-message error">{{ message }}</p>
      </form>
      <aside class="checkout-summary">
        <p class="eyebrow">{{ t('order.summary') }}</p>
        <h2>{{ selected?.title || t('common.customOrder') }}</h2>
        <p class="muted">{{ selectedOption?.name }}</p>
        <label>{{ t('order.payment') }}
          <select v-model="form.payment_type">
            <option value="deposit">{{ t('order.deposit') }}</option>
            <option value="full">{{ t('order.full') }}</option>
          </select>
        </label>
        <p v-if="!paypalAvailableForSelected" class="form-message warning">{{ t('order.paypalUnavailable') }}</p>
        <div v-if="selected || orderSummaryActive" class="total-card">
          <span>{{ paypalAvailableForSelected ? t('order.paypalDue') : t('order.paymentDue') }}</span>
          <strong>{{ summaryBreakdown.current }}</strong>
          <p v-if="paypalSnapshotChargeText" class="muted order-charge-note">
            {{ t('order.paypalChargeNote', { amount: paypalSnapshotChargeText }) }}
          </p>
          <p v-else-if="!order && paypalAvailableForSelected && !displayCurrencyMatchesCharge" class="muted order-charge-note">
            {{ t('order.paypalChargeNote', { amount: paypalChargeText }) }}
          </p>
          <div class="checkout-breakdown">
            <p><span>{{ t('order.fullPrice') }}</span><strong>{{ summaryBreakdown.total }}</strong></p>
            <p><span>{{ t('order.currentPayment') }}</span><strong>{{ summaryBreakdown.current }}</strong></p>
            <p><span>{{ t('order.remainingBalance') }}</span><strong>{{ summaryBreakdown.remaining }}</strong></p>
          </div>
        </div>
        <div v-if="!order" class="pre-submit-checklist">
          <h3>{{ t('order.preSubmitTitle') }}</h3>
          <p class="muted">{{ t('order.preSubmitDesc') }}</p>
          <div v-for="item in preSubmitChecks" :key="item.key" :class="['pre-submit-item', { ready: item.ready }]">
            <span>{{ item.ready ? t('order.checkReady') : t('order.checkTodo') }}</span>
            <div>
              <strong>{{ item.label }}</strong>
              <small>{{ item.value }}</small>
            </div>
          </div>
        </div>
        <section v-if="order && !['paid', 'deposit_paid'].includes(order.payment_status) && paypalAvailableForSelected" class="paypal-inline-panel">
          <div>
            <strong>{{ t('order.paypalInlineTitle') }}</strong>
            <span>{{ t('order.paypalInlineDesc') }}</span>
          </div>
          <div ref="paypalButtonContainer" class="paypal-button-host"></div>
          <div v-show="paypalCardEligible" class="paypal-card-fields">
            <div ref="paypalCardNameContainer" class="paypal-card-field"></div>
            <div ref="paypalCardNumberContainer" class="paypal-card-field"></div>
            <div class="paypal-card-field-row">
              <div ref="paypalCardExpiryContainer" class="paypal-card-field"></div>
              <div ref="paypalCardCvvContainer" class="paypal-card-field"></div>
            </div>
            <button class="button primary" type="button" :disabled="loading || paypalCardLoading" @click="submitPaypalCardFields">
              {{ paypalCardLoading ? t('common.loading') : t('order.currentPayment') }}
            </button>
            <p v-if="paypalCardError" class="form-message error">{{ paypalCardError }}</p>
          </div>
          <p v-if="paypalButtonLoading" class="muted">{{ t('order.paypalButtonLoading') }}</p>
          <p v-if="paypalButtonError" class="form-message error">{{ paypalButtonError }}</p>
          <button v-if="paypalButtonError && !paypalOrder" class="button ghost" type="button" :disabled="loading" @click="retryPaypalPayment">
            {{ loading ? t('common.loading') : t('account.continuePay') }}
          </button>
        </section>
        <button v-if="paypalOrder?.order?.id === order?.id && paypalOrder?.mock" class="button ghost paypal-confirm-button" type="button" :disabled="loading" @click="capturePaypal">{{ loading ? t('common.loading') : t('order.paypalMock') }}</button>
        <p v-if="message && messageTone === 'success'" class="form-message success">{{ message }}</p>
        <p v-if="message && messageTone === 'error' && order" class="form-message error">{{ message }}</p>
        <div v-if="order" class="summary-actions">
          <div class="order-success-next">
            <strong>{{ t('order.successNextTitle') }}</strong>
            <span>{{ t('order.successNextDesc') }}</span>
          </div>
          <button
            v-if="!paypalOrder && paypalButtonError && paypalAvailableForSelected && !['paid', 'deposit_paid'].includes(order.payment_status)"
            class="button primary"
            type="button"
            :disabled="loading"
            @click="retryPaypalPayment"
          >{{ loading ? t('common.loading') : t('account.continuePay') }}</button>
          <RouterLink class="button primary" :to="accountLink">{{ t('order.viewAccount') }}</RouterLink>
          <a
            v-if="order && !paypalOrder && supportContact"
            class="button ghost"
            :href="orderSupportUrl()"
            :target="supportContact.external ? '_blank' : undefined"
            :rel="supportContact.external ? 'noopener noreferrer' : undefined"
          >{{ t('account.contactSupport') }}</a>
          <RouterLink v-else-if="order && !paypalOrder" class="button ghost" :to="orderSupportRoute">{{ t('account.contactSupport') }}</RouterLink>
          <RouterLink class="button ghost" to="/collections">{{ t('order.continueShopping') }}</RouterLink>
        </div>
      </aside>
    </div>
  </main>
</template>
