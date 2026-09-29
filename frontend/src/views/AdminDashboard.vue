<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { adminDependencies, normalizeAdminTab, preserveOrderNote, type AdminResource, type AdminTab } from '../adminState'
import { ChevronLeft, ChevronRight, ImagePlus, Languages, Trash2, Upload, X, ZoomIn } from '@lucide/vue'
import { api, money, safeGetLocalStorage, safeRemoveLocalStorage, upload, type Category, type Product, type SiteSettings, type Order } from '../api'
import { CURRENCY_BASE, convertMinorAmount } from '../currency'
import { resolveContentImage } from '../contentImages'

const { t } = useI18n()
const router = useRouter()

// The admin view deliberately keeps all operator workflows in one screen so
// tabs can share the same freshly loaded site/catalog/order data. API-level
// permissions and transition validation remain authoritative on the server.
type AdminLang = 'zh' | 'en' | 'ko'
type BlogTranslationFields = { title: string; excerpt: string; content: string }
type ReviewTranslationFields = { title: string; content: string }
type ProductTranslationFields = { title: string; subtitle: string; description: string; alt_text: string; seo_title: string; seo_description: string; options_text: string }
const adminLangs: AdminLang[] = ['zh', 'en', 'ko']
const route = useRoute()
const tab = computed<AdminTab>({
  get: () => normalizeAdminTab(route.query.tab),
  set: (value) => { void router.push({ query: { ...route.query, tab: value } }) },
})
type AdminOverview = { [key: string]: number | Record<string, number>; revenue_by_currency: Record<string, number>; revenue_cents: number }
const overview = ref<Partial<AdminOverview>>({})
const users = ref<any[]>([])
const userSearch = ref('')
const userStatusFilter = ref('')
const productSearch = ref('')
const productCategoryFilter = ref('')
const productStatusFilter = ref('')
const orderSearch = ref('')
const orderStatusFilter = ref('')
const paymentStatusFilter = ref('')
const orderFlagFilter = ref('')
const orderSort = ref('latest')
const blogSearch = ref('')
const reviewSearch = ref('')
const userCopyText = ref('')
const contactCopyText = ref('')
const orderCopyOutputTitle = ref('')
const adminMessage = ref('')
const savingAction = ref('')
const resourceErrors = reactive<Partial<Record<AdminResource, string>>>({})
const loadedResources = reactive(new Set<AdminResource>())
const resourceRequests = new Map<AdminResource, Promise<void>>()
const loadingResources = reactive(new Set<AdminResource>())
const initialLoading = computed(() => adminDependencies[tab.value].some(part => loadingResources.has(part) || (!loadedResources.has(part) && !resourceErrors[part])))
const loadError = computed(() => adminDependencies[tab.value].filter(part => resourceErrors[part]).map(part => `${resourceLabel(part)}: ${resourceErrors[part]}`).join(' · '))
const brokenPhotoKeys = ref(new Set<string>())
const siteRestoreInput = ref<HTMLInputElement | null>(null)
const reviewAvatarInput = ref<HTMLInputElement | null>(null)
const reviewImageInput = ref<HTMLInputElement | null>(null)
const reviewUploadBusy = ref<'avatar' | 'images' | ''>('')
const siteTranslationGenerating = ref(false)
const productTranslationGenerating = ref(false)
const paymentSecretsVisible = ref(false)
const paypalHelpOpen = ref(false)
const paypalTestResult = ref<any>(null)
const paypalTestError = ref('')
const fullBackupConfirmOpen = ref(false)
const siteRestoreUnsavedConfirmOpen = ref(false)
const dirtyOrderNoteIds = ref(new Set<string>())
const orderNoteDrafts = new Map<string, string>()
const pageSize = 12
const maxSiteRestoreBytes = 2 * 1024 * 1024
const userPage = ref(1)
const productPage = ref(1)
const orderPage = ref(1)
const blogPage = ref(1)
const categories = ref<Category[]>([])
const products = ref<Product[]>([])
const orders = ref<Order[]>([])
const site = ref<SiteSettings>({})
const auditLogs = ref<any[]>([])
const orderStatuses = ['new', 'confirmed', 'crafting', 'preview', 'balance_due', 'ready_ship', 'shipped', 'completed', 'cancelled']
const paymentStatuses = ['unpaid', 'deposit_paid', 'paid', 'balance_due', 'refunded']
const userStatuses = ['active', 'vip', 'blocked']
const publishStatuses = ['published', 'hidden']
const contactReady = computed(() => (
  Boolean(contactForm.kakao_enabled && (contactForm.kakao_id.trim() || validHttpUrl(contactForm.kakao_url)))
  || Boolean(contactForm.whatsapp_enabled && (contactForm.whatsapp_id.trim() || validHttpUrl(contactForm.whatsapp_url)))
))
const selectedProductCategory = computed(() => categories.value.find((category) => category.id === productForm.category_id))
const productCategoryHidden = computed(() => selectedProductCategory.value?.status === 'hidden')
const categoryHasPublishedProducts = computed(() => {
  if (!categoryForm.id) return false
  return products.value.some((product) => product.category_id === categoryForm.id && product.status === 'published')
})
const publicCatalogReady = computed(() => {
  const publicCategoryIds = new Set(categories.value.filter((category) => category.status !== 'hidden').map((category) => category.id))
  return products.value.some((product) => product.status === 'published' && publicCategoryIds.has(product.category_id || '') && Array.isArray(product.options) && product.options.length > 0)
})
const readinessItems = computed(() => {
  // Readiness is a deployment checklist, not an authorization mechanism. It
  // surfaces missing configuration while the API still validates every save.
  const paypalLiveReady = paymentForm.paypal_mode === 'live'
    && Boolean(paymentForm.paypal_client_id.trim())
    && (
      Boolean(paymentForm.paypal_secret.trim())
      || Boolean(site.value.paypal?.secret_configured)
      || Boolean(String(site.value.paypal?.secret || '').trim())
    )
  return [
    { key: 'admin', label: t('admin.readinessAdmin'), status: t('admin.readinessActionRequired'), tone: 'warn', target: 'site' },
    {
      key: 'paypal',
      label: paypalLiveReady ? t('admin.readinessPaypalLive') : t('admin.readinessPaypalSandbox'),
      status: paypalLiveReady ? t('admin.readinessReady') : t('admin.readinessActionRequired'),
      tone: paypalLiveReady ? 'ok' : 'warn',
      target: 'paypal',
    },
    {
      key: 'contact',
      label: contactReady.value ? t('admin.readinessContactReady') : t('admin.readinessContactMissing'),
      status: contactReady.value ? t('admin.readinessReady') : t('admin.readinessActionRequired'),
      tone: contactReady.value ? 'ok' : 'warn',
      target: 'site',
    },
    {
      key: 'catalog',
      label: publicCatalogReady.value ? t('admin.readinessCatalogReady') : t('admin.readinessCatalogMissing'),
      status: publicCatalogReady.value ? t('admin.readinessReady') : t('admin.readinessActionRequired'),
      tone: publicCatalogReady.value ? 'ok' : 'warn',
      target: 'products',
    },
    {
      key: 'content',
      label: site.value.faq?.length && site.value.reviews?.length ? t('admin.readinessTrustReady') : t('admin.readinessTrustMissing'),
      status: site.value.faq?.length && site.value.reviews?.length ? t('admin.readinessReady') : t('admin.readinessActionRequired'),
      tone: site.value.faq?.length && site.value.reviews?.length ? 'ok' : 'warn',
      target: 'site',
    },
    {
      key: 'blog',
      label: site.value.blog?.length ? t('admin.readinessBlogReady') : t('admin.readinessBlogMissing'),
      status: site.value.blog?.length ? t('admin.readinessReady') : t('admin.readinessActionRequired'),
      tone: site.value.blog?.length ? 'ok' : 'warn',
      target: 'blog',
    },
    { key: 'backup', label: t('admin.readinessBackup'), status: t('admin.readinessManual'), tone: 'info', target: 'site' },
    { key: 'data', label: t('admin.readinessData'), status: t('admin.readinessManual'), tone: 'info', target: 'site' },
  ]
})
function moneyByCurrency(summary: Record<string, any> | undefined, fallbackCents = 0) {
  if ((!summary || typeof summary !== 'object') && fallbackCents > 0) return t('admin.currencySummaryUnavailable')
  const source = summary && typeof summary === 'object' ? summary : {}
  const parts = Object.entries(source)
    .filter(([, cents]) => Number(cents || 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => money(Number(cents || 0), currency))
  return parts.length ? parts.join(' / ') : money(0, CURRENCY_BASE)
}
const overviewItems = computed(() => [
  { key: 'users', label: t('admin.metricUsers'), value: overview.value.users || 0 },
  { key: 'orders', label: t('admin.metricOrders'), value: overview.value.orders || 0 },
  { key: 'paid', label: t('admin.metricPaidOrders'), value: overview.value.paid || 0 },
  { key: 'unpaid', label: t('admin.metricUnpaidOrders'), value: overview.value.unpaid || 0 },
  { key: 'crafting', label: t('admin.metricCrafting'), value: overview.value.crafting || 0 },
  { key: 'ready_ship', label: t('admin.metricReadyShip'), value: overview.value.ready_ship || 0 },
  { key: 'products', label: t('admin.metricProducts'), value: overview.value.products || 0 },
  { key: 'public_products', label: t('admin.metricPublicProducts'), value: overview.value.public_products || 0 },
  { key: 'categories', label: t('admin.metricCategories'), value: overview.value.categories || 0 },
  { key: 'revenue_cents', label: t('admin.metricRevenue'), value: moneyByCurrency(overview.value.revenue_by_currency as Record<string, any>, overview.value.revenue_cents || 0) },
])
function markOrderNoteDirty(order: any) {
  if (!order?.id) return
  orderNoteDrafts.set(order.id, String(order.internal_note || ''))
  dirtyOrderNoteIds.value = new Set([...dirtyOrderNoteIds.value, order.id])
}

function clearOrderNoteDirty(orderId: string) {
  orderNoteDrafts.delete(orderId)
  if (!dirtyOrderNoteIds.value.has(orderId)) return
  const next = new Set(dirtyOrderNoteIds.value)
  next.delete(orderId)
  dirtyOrderNoteIds.value = next
}

function isOrderNoteDirty(order: any) {
  return Boolean(order?.id && dirtyOrderNoteIds.value.has(order.id))
}

const actionQueueItems = computed(() => [
  {
    key: 'flagged',
    label: t('admin.queueFlagged'),
    desc: t('admin.queueFlaggedDesc'),
    value: orders.value.filter((order: any) => order.flagged).length,
    tone: 'danger',
    filter: () => {
      orderFlagFilter.value = 'flagged'
      orderStatusFilter.value = ''
      paymentStatusFilter.value = ''
      orderSort.value = 'flagged_first'
    },
  },
  {
    key: 'unpaid',
    label: t('admin.queueUnpaid'),
    desc: t('admin.queueUnpaidDesc'),
    value: orders.value.filter((order: any) => order.payment_status === 'unpaid').length,
    tone: 'warn',
    filter: () => {
      orderFlagFilter.value = ''
      orderStatusFilter.value = ''
      paymentStatusFilter.value = 'unpaid'
      orderSort.value = 'action_required'
    },
  },
  {
    key: 'balance',
    label: t('admin.queueBalanceDue'),
    desc: t('admin.queueBalanceDueDesc'),
    value: orders.value.filter((order: any) => order.payment_status === 'balance_due' || order.order_status === 'balance_due').length,
    tone: 'warn',
    filter: () => {
      orderFlagFilter.value = ''
      orderStatusFilter.value = ''
      paymentStatusFilter.value = 'balance_due'
      orderSort.value = 'action_required'
    },
  },
  {
    key: 'preview',
    label: t('admin.queuePreview'),
    desc: t('admin.queuePreviewDesc'),
    value: orders.value.filter((order: any) => order.order_status === 'preview').length,
    tone: 'info',
    filter: () => {
      orderFlagFilter.value = ''
      orderStatusFilter.value = 'preview'
      paymentStatusFilter.value = ''
      orderSort.value = 'action_required'
    },
  },
  {
    key: 'ship',
    label: t('admin.queueReadyShip'),
    desc: t('admin.queueReadyShipDesc'),
    value: orders.value.filter((order: any) => order.order_status === 'ready_ship').length,
    tone: 'ok',
    filter: () => {
      orderFlagFilter.value = ''
      orderStatusFilter.value = 'ready_ship'
      paymentStatusFilter.value = ''
      orderSort.value = 'action_required'
    },
  },
])
function openActionQueue(item: any) {
  item.filter()
  orderSearch.value = ''
  orderPage.value = 1
  tab.value = 'orders'
}
function openReadinessItem(item: any) {
  tab.value = item.target || 'site'
}
const filteredUsers = computed(() => {
  const keyword = userSearch.value.trim().toLowerCase()
  return users.value.filter((user) => {
    const matchesKeyword = !keyword || [user.name, user.email, user.country, user.tags_text, user.internal_note]
      .some((value) => String(value || '').toLowerCase().includes(keyword))
    const matchesStatus = !userStatusFilter.value || user.status === userStatusFilter.value
    return matchesKeyword && matchesStatus
  })
})
const pagedUsers = computed(() => filteredUsers.value.slice((userPage.value - 1) * pageSize, userPage.value * pageSize))
const userPageCount = computed(() => Math.max(1, Math.ceil(filteredUsers.value.length / pageSize)))
const filteredProducts = computed(() => {
  const keyword = productSearch.value.trim().toLowerCase()
  return products.value.filter((product) => {
    const matchesKeyword = !keyword || [
      translatedValue(product, 'title'),
      product.slug,
      product.status,
      product.tags?.join(', '),
    ].some((value) => String(value || '').toLowerCase().includes(keyword))
    const matchesCategory = !productCategoryFilter.value || product.category_id === productCategoryFilter.value
    const matchesStatus = !productStatusFilter.value || product.status === productStatusFilter.value
    return matchesKeyword && matchesCategory && matchesStatus
  })
})
const pagedProducts = computed(() => filteredProducts.value.slice((productPage.value - 1) * pageSize, productPage.value * pageSize))
const productPageCount = computed(() => Math.max(1, Math.ceil(filteredProducts.value.length / pageSize)))
const filteredOrders = computed(() => {
  const keyword = orderSearch.value.trim().toLowerCase()
  const actionPriority = (order: any) => {
    if (order.flagged) return 0
    if (order.order_status === 'new') return 1
    if (order.payment_status === 'unpaid') return 2
    if (order.payment_status === 'balance_due' || order.order_status === 'balance_due') return 3
    if (order.order_status === 'preview') return 4
    if (order.order_status === 'ready_ship') return 5
    return 9
  }
  const result = orders.value.filter((order: any) => {
    const matchesKeyword = !keyword || [
      order.order_no,
      order.customer_name,
      order.email,
      order.phone,
      order.country,
      order.shipping_address,
      order.shipping_carrier,
      order.tracking_no,
      order.product_title,
      order.option_name,
      order.pet_name,
      order.pet_type,
      order.internal_note,
    ].some((value) => String(value || '').toLowerCase().includes(keyword))
    const matchesOrderStatus = !orderStatusFilter.value || order.order_status === orderStatusFilter.value
    const matchesPaymentStatus = !paymentStatusFilter.value || order.payment_status === paymentStatusFilter.value
    const matchesFlag = !orderFlagFilter.value || (orderFlagFilter.value === 'flagged' ? order.flagged : !order.flagged)
    return matchesKeyword && matchesOrderStatus && matchesPaymentStatus && matchesFlag
  })
  return [...result].sort((a: any, b: any) => {
    if (orderSort.value === 'oldest') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    if (orderSort.value === 'amount_desc') return Number(b.amount_cents || 0) - Number(a.amount_cents || 0)
    if (orderSort.value === 'amount_asc') return Number(a.amount_cents || 0) - Number(b.amount_cents || 0)
    if (orderSort.value === 'flagged_first') return Number(Boolean(b.flagged)) - Number(Boolean(a.flagged)) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (orderSort.value === 'action_required') return actionPriority(a) - actionPriority(b) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
})
const pagedOrders = computed(() => filteredOrders.value.slice((orderPage.value - 1) * pageSize, orderPage.value * pageSize))
const orderPageCount = computed(() => Math.max(1, Math.ceil(filteredOrders.value.length / pageSize)))
const filteredBlogs = computed(() => {
  const keyword = blogSearch.value.trim().toLowerCase()
  const blogs = Array.isArray(site.value.blog) ? site.value.blog : []
  return [...blogs]
    .sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')))
    .filter((post: any) => {
      const haystack = [
        post.slug,
        post.date,
        blogField(post, 'title'),
        blogField(post, 'excerpt'),
        stripBlogHtml(blogField(post, 'content')),
        ...(Array.isArray(post.tags) ? post.tags : []),
      ].join(' ').toLowerCase()
      return !keyword || haystack.includes(keyword)
    })
})
const pagedBlogs = computed(() => filteredBlogs.value.slice((blogPage.value - 1) * pageSize, blogPage.value * pageSize))
const blogPageCount = computed(() => Math.max(1, Math.ceil(filteredBlogs.value.length / pageSize)))
const filteredReviews = computed(() => {
  const keyword = reviewSearch.value.trim().toLowerCase()
  const reviews = Array.isArray(site.value.reviews) ? site.value.reviews : []
  return reviews.filter((review: any) => {
    const haystack = [
      review.name,
      review.country,
      review.status,
      review.product_slug,
      reviewField(review, 'title', 'zh'),
      reviewField(review, 'content', 'zh'),
      reviewField(review, 'title', 'en'),
      reviewField(review, 'title', 'ko'),
    ].join(' ').toLowerCase()
    return !keyword || haystack.includes(keyword)
  })
})
function pageSummary(current: number, total: number) {
  if (!total) return t('admin.paginationSummary', { start: 0, end: 0, total: 0 })
  const start = (current - 1) * pageSize + 1
  const end = Math.min(current * pageSize, total)
  return t('admin.paginationSummary', { start, end, total })
}
const userPageSummary = computed(() => pageSummary(userPage.value, filteredUsers.value.length))
const productPageSummary = computed(() => pageSummary(productPage.value, filteredProducts.value.length))
const orderPageSummary = computed(() => pageSummary(orderPage.value, filteredOrders.value.length))
const blogPageSummary = computed(() => pageSummary(blogPage.value, filteredBlogs.value.length))
const siteConfigStatusItems = computed(() => {
  const paypalLiveReady = paymentForm.paypal_mode === 'live'
    && Boolean(paymentForm.paypal_client_id.trim())
    && (
      Boolean(paymentForm.paypal_secret.trim())
      || Boolean(site.value.paypal?.secret_configured)
      || Boolean(String(site.value.paypal?.secret || '').trim())
    )
  return [
    {
      key: 'payment',
      label: t('admin.siteStatusPayment'),
      status: paymentForm.paypal_enabled
        ? (paypalLiveReady ? t('admin.siteStatusReady') : t('admin.siteStatusSandbox'))
        : t('admin.siteStatusDisabled'),
      tone: paymentForm.paypal_enabled && paypalLiveReady ? 'ok' : 'warn',
    },
    {
      key: 'contact',
      label: t('admin.siteStatusContact'),
      status: contactReady.value ? t('admin.siteStatusReady') : t('admin.siteStatusMissing'),
      tone: contactReady.value ? 'ok' : 'warn',
    },
    {
      key: 'email',
      label: t('admin.siteStatusEmail'),
      status: siteForm.email ? t('admin.siteStatusReady') : t('admin.siteStatusMissing'),
      tone: siteForm.email ? 'ok' : 'warn',
    },
    {
      key: 'tracking',
      label: t('admin.siteStatusTracking'),
      status: siteForm.tracking_url_template ? t('admin.siteStatusReady') : t('admin.siteStatusOptional'),
      tone: siteForm.tracking_url_template ? 'ok' : 'info',
    },
  ]
})
const selectedOrderEvents = computed(() => {
  const events = Array.isArray(selectedOrder.value?.events) ? selectedOrder.value.events : []
  return [...events].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()).slice(0, 8)
})

const categoryForm = reactive({ id: '', slug: '', title: '', description: '', sort_order: 0, status: 'published' })
const categoryI18n = reactive<Record<'zh' | 'en' | 'ko', { title: string; description: string }>>({
  zh: { title: '', description: '' },
  en: { title: '', description: '' },
  ko: { title: '', description: '' },
})
const productForm = reactive({
  id: '', category_id: '', slug: '', title: '', subtitle: '', description: '', base_price_cents: 0, currency: CURRENCY_BASE,
  deposit_percent: 50, image_url: '', images_text: '', alt_text: '', seo_title: '', seo_description: '', use_cases_text: '', tags: '', options_text: t('admin.defaultOptionsText'), status: 'published'
})
const productI18n = reactive<Record<'zh' | 'en' | 'ko', { title: string; subtitle: string; description: string; alt_text: string; seo_title: string; seo_description: string; options_text: string }>>({
  zh: { title: '', subtitle: '', description: '', alt_text: '', seo_title: '', seo_description: '', options_text: '' },
  en: { title: '', subtitle: '', description: '', alt_text: '', seo_title: '', seo_description: '', options_text: '' },
  ko: { title: '', subtitle: '', description: '', alt_text: '', seo_title: '', seo_description: '', options_text: '' },
})
const blogForm = reactive({ id: '', slug: '', date: '', image_url: '', tags_text: '' })
const blogI18n = reactive<Record<AdminLang, BlogTranslationFields>>({
  zh: { title: '', excerpt: '', content: '' },
  en: { title: '', excerpt: '', content: '' },
  ko: { title: '', excerpt: '', content: '' },
})
const reviewForm = reactive({
  id: '',
  name: '',
  country: 'Korea',
  rating: 5,
  status: 'published',
  product_slug: '',
  avatar_url: '',
  images_text: '',
  video_url: '',
})
const reviewI18n = reactive<Record<AdminLang, ReviewTranslationFields>>({
  zh: { title: '', content: '' },
  en: { title: '', content: '' },
  ko: { title: '', content: '' },
})
const siteForm = reactive({ brand_name: '', email: '', instagram: '', tracking_url_template: '', care: '', shipping: '', refund: '', faq_text: '', reviews_text: '', blog_text: '' })
const policyI18n = reactive<Record<'zh' | 'en' | 'ko', { care: string; shipping: string; refund: string }>>({
  zh: { care: '', shipping: '', refund: '' },
  en: { care: '', shipping: '', refund: '' },
  ko: { care: '', shipping: '', refund: '' },
})
const faqI18n = reactive<Record<AdminLang, string>>({
  zh: '',
  en: '',
  ko: '',
})
const paymentForm = reactive({ paypal_enabled: true, paypal_mode: 'sandbox', paypal_client_id: '', paypal_secret: '', paypal_webhook_id: '', currency: 'USD' })
const contactForm = reactive({
  kakao_enabled: true,
  kakao_label: 'KakaoTalk',
  kakao_id: 'WoolBuddyShop',
  kakao_url: '',
  whatsapp_enabled: true,
  whatsapp_label: 'WhatsApp',
  whatsapp_id: 'WoolBuddy',
  whatsapp_url: '',
})
const paypalSupportedCurrencies = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF',
  'ILS', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD',
  'THB', 'TWD', 'USD',
])
const paypalSecretSaved = computed(() => Boolean(site.value.paypal?.secret_configured) && !paymentForm.paypal_secret.trim())
const paypalWebhookSaved = computed(() => Boolean(site.value.paypal?.webhook_configured) && !paymentForm.paypal_webhook_id.trim())
const paypalWebhookUrl = computed(() => `${window.location.origin}/api/paypal/webhook`)
const siteFormSnapshot = ref('')
const siteFormDirty = computed(() => stableSiteFormState() !== siteFormSnapshot.value)
const selectedOrder = ref<any>(null)
const orderLightbox = ref<{ order: any; index: number } | null>(null)
const orderLightboxImages = computed(() => (
  Array.isArray(orderLightbox.value?.order?.photo_urls)
    ? orderLightbox.value.order.photo_urls.filter((url: unknown): url is string => Boolean(String(url || '').trim()))
    : []
))
const orderLightboxImage = computed(() => orderLightboxImages.value[orderLightbox.value?.index || 0] || '')
const orderLightboxIndex = computed(() => Math.min(orderLightbox.value?.index || 0, Math.max(0, orderLightboxImages.value.length - 1)))
const categoryModalOpen = ref(false)
const productModalOpen = ref(false)
const userModalOpen = ref(false)
const userUnsavedConfirmOpen = ref(false)
const userFormSnapshot = ref('')
const productUnsavedConfirmOpen = ref(false)
const productFormSnapshot = ref('')
const categoryUnsavedConfirmOpen = ref(false)
const categoryFormSnapshot = ref('')
const blogModalOpen = ref(false)
const blogUnsavedConfirmOpen = ref(false)
const blogFormSnapshot = ref('')
const blogEditorKey = ref(0)
const reviewModalOpen = ref(false)
const reviewUnsavedConfirmOpen = ref(false)
const reviewFormSnapshot = ref('')
const deleteCategoryTarget = ref<Category | null>(null)
const deleteProductTarget = ref<Product | null>(null)
const deleteBlogTarget = ref<any | null>(null)
const deleteReviewTarget = ref<any | null>(null)
const deleteUserTarget = ref<any | null>(null)
const orderChangeConfirm = ref<{ order: any; field: 'status' | 'payment'; previous: string; next: string } | null>(null)
const modalOpen = computed(() => Boolean(
  selectedOrder.value
  || categoryModalOpen.value
  || productModalOpen.value
  || blogModalOpen.value
  || reviewModalOpen.value
  || userModalOpen.value
  || deleteCategoryTarget.value
  || deleteProductTarget.value
  || deleteBlogTarget.value
  || deleteReviewTarget.value
  || deleteUserTarget.value
  || orderChangeConfirm.value
  || fullBackupConfirmOpen.value
  || paypalHelpOpen.value
  || orderLightbox.value
))
const userForm = reactive({
  id: '',
  email: '',
  name: '',
  country: '',
  status: 'active',
  tags_text: '',
  internal_note: '',
  followup_text: '',
  followup_next_at: '',
  followups: [] as any[],
})

const zhNameFallbacks: Record<string, string> = {
  '3d-pet-frame-portraits': '3D 宠物相框类肖像',
  '3d-full-body-pet-portraits': '3D 宠物全身类肖像',
  'pet-memorial-gifts': '宠物纪念礼品',
  'dog-frame-portrait': '狗狗相框',
  'cat-frame-portrait': '猫咪相框',
  'rabbit-frame-portrait': '兔子相框',
  'dog-full-body-portrait': '狗狗全身肖像',
  'cat-full-body-portrait': '猫猫全身肖像',
  'multi-pet-group-portrait': '多宠物合照肖像',
  'memorial-frame': '纪念相框',
  'memorial-full-body-portrait': '纪念全身肖像',
  'full-body-pet-replica': '全身羊毛毡宠物定制',
  'mini-pet-portrait': '迷你宠物肖像',
  'felted-photo-frame-portrait': '羊毛毡相框肖像',
  'pet-memorial-ornament': '宠物纪念挂件',
}

function looksEnglish(value: string) {
  return /^[A-Za-z0-9\s&+,'-]+$/.test(String(value || '').trim())
}

function translatedValue(item: any, field: string) {
  const fallback = zhNameFallbacks[item?.slug] || zhNameFallbacks[item?.subcategory_slug]
  const direct = item?.[field]
  const translated = item?.translations?.zh?.[field]
  if (field === 'title' && fallback && (!translated || looksEnglish(translated))) return fallback
  if (translated && !looksEnglish(translated)) return translated
  if (direct) return direct
  return translated || fallback || ''
}
function productReadinessIssues(product: any) {
  const issues: string[] = []
  const category = categories.value.find((item) => item.id === product.category_id)
  const paypalCurrency = String(site.value.paypal?.currency || '').trim().toUpperCase()
  const productCurrency = String(product.currency || '').trim().toUpperCase()
  if (product.status === 'published' && category?.status === 'hidden') issues.push(t('admin.productIssueHiddenCategory'))
  // Products are priced in the KRW base and PayPal charges the converted site
  // charge currency, so either currency is fine; anything else cannot be
  // converted reliably and would block correct checkout amounts.
  if (product.status === 'published' && site.value.paypal?.enabled !== false && productCurrency && productCurrency !== CURRENCY_BASE && productCurrency !== paypalCurrency) {
    issues.push(t('admin.productIssuePaypalCurrencyMismatch', { currency: CURRENCY_BASE }))
  }
  if (!Array.isArray(product.options) || !product.options.length) issues.push(t('admin.productIssueMissingOptions'))
  if (!String(product.image_url || '').trim() && !product.images?.length) issues.push(t('admin.productIssueMissingImage'))
  if (!String(product.seo_title || product.translations?.zh?.seo_title || '').trim()) issues.push(t('admin.productIssueMissingSeoTitle'))
  if (!String(product.seo_description || product.translations?.zh?.seo_description || '').trim()) issues.push(t('admin.productIssueMissingSeoDesc'))
  return issues
}
function orderFulfillmentChecks(order: any) {
  if (!order) return []
  const fullyPaid = remainingAmount(order) <= 0 || order.payment_status === 'paid'
  return [
    { key: 'contact', label: t('admin.fulfillmentContact'), ready: Boolean(order.email && order.phone), value: order.phone || order.email || '-' },
    { key: 'photos', label: t('admin.fulfillmentPhotos'), ready: Number(order.photo_urls?.length || 0) > 0, value: t('admin.photoCountValue', { count: order.photo_urls?.length || 0 }) },
    { key: 'payment', label: t('admin.fulfillmentPayment'), ready: fullyPaid, value: fullyPaid ? t('admin.fulfillmentReady') : money(remainingAmount(order), order.currency) },
    { key: 'address', label: t('admin.fulfillmentAddress'), ready: Boolean(order.shipping_address), value: order.shipping_address || t('admin.fulfillmentMissing') },
    { key: 'tracking', label: t('admin.fulfillmentTracking'), ready: Boolean(order.shipping_carrier && order.tracking_no), value: order.shipping_carrier || order.tracking_no ? `${order.shipping_carrier || '-'} ${order.tracking_no || ''}` : t('admin.fulfillmentOptional') },
  ]
}

function statusText(value: string | undefined) {
  const key = String(value || '').trim()
  if (!key) return ''
  return t(`status.${key}`)
}

function openOrderImage(order: any, index: string | number) {
  const images = Array.isArray(order?.photo_urls) ? order.photo_urls : []
  const position = Number(index)
  if (!images[position]) return
  orderLightbox.value = { order, index: position }
}

function closeOrderLightbox() {
  orderLightbox.value = null
}

function moveOrderImage(direction: number) {
  if (!orderLightbox.value || orderLightboxImages.value.length < 2) return
  const nextIndex = (orderLightboxIndex.value + direction + orderLightboxImages.value.length) % orderLightboxImages.value.length
  orderLightbox.value = { ...orderLightbox.value, index: nextIndex }
}

function handleOrderLightboxKeydown(event: KeyboardEvent) {
  if (!orderLightbox.value) return
  if (event.key === 'Escape') closeOrderLightbox()
  if (event.key === 'ArrowLeft') moveOrderImage(-1)
  if (event.key === 'ArrowRight') moveOrderImage(1)
}

function productCategoryTitle(product: any) {
  const category = categories.value.find((item) => item.id === product?.category_id)
  return category ? translatedValue(category, 'title') : '-'
}

function formatDate(value: string) {
  return value ? new Date(value).toLocaleDateString() : '-'
}

function formatDateTime(value: string) {
  return value ? new Date(value).toLocaleString() : '-'
}

function showAdminMessage(text: string) {
  adminMessage.value = text
  window.setTimeout(() => {
    if (adminMessage.value === text) adminMessage.value = ''
  }, 2400)
}

function adminErrorMessage(error: any) {
  const text = String(error?.message || error || '')
  const map: Record<string, string> = {
    'category has products': t('admin.categoryHasProducts'),
    'category has published products': t('admin.categoryHasPublishedProducts'),
    'product has orders, hide it instead': t('admin.productHasOrders'),
    'user has orders, block it instead': t('admin.userHasOrders'),
    'protected user cannot change email': t('admin.protectedUserCannotChangeEmail'),
    'protected user cannot be changed': t('admin.protectedUserCannotChange'),
    'protected user must stay active': t('admin.protectedUserMustStayActive'),
    'protected user cannot be deleted': t('admin.protectedUserCannotDelete'),
    'protected user cannot be created': t('admin.protectedUserCannotCreate'),
    'delete confirmation required': t('admin.deleteConfirmRequired'),
    'secret backup confirmation required': t('admin.secretBackupConfirmRequired'),
    'category slug exists': t('admin.categorySlugExists'),
    'product slug exists': t('admin.productSlugExists'),
    'invalid slug': t('admin.slugInvalid'),
    'invalid publish status': t('admin.publishStatusInvalid'),
    'category title required': t('admin.categoryTitleRequired'),
    'category required': t('admin.productCategoryRequired'),
    'product title required': t('admin.productTitleRequired'),
    'price required': t('admin.priceRequired'),
    'invalid deposit percent': t('admin.depositInvalid'),
    'invalid image url': t('admin.imageUrlInvalid'),
    'published product requires image': t('admin.productPublishedImageRequired'),
    'published product requires seo title': t('admin.productPublishedSeoTitleRequired'),
    'published product requires seo description': t('admin.productPublishedSeoDescriptionRequired'),
    'options required': t('admin.optionsInvalid'),
    'invalid options': t('admin.optionsInvalid'),
    'duplicate options': t('admin.duplicateOptionsInvalid'),
    'user email exists': t('admin.userEmailExists'),
    'valid email required': t('admin.userEmailInvalid'),
    'invalid user status': t('admin.userStatusInvalid'),
    'invalid user name': t('admin.userNameTooLong'),
    'invalid user country': t('admin.userCountryTooLong'),
    'invalid user tags': t('admin.userTagsInvalid'),
    'invalid internal note': t('admin.userNoteInvalid'),
    'invalid followups': t('admin.userFollowupInvalid'),
    'invalid followup content': t('admin.userFollowupInvalid'),
    'invalid followup date': t('admin.userFollowupDateInvalid'),
    'invalid order status': t('admin.orderStatusInvalid'),
    'invalid payment status': t('admin.paymentStatusInvalid'),
    'cancelled order cannot be changed': t('admin.cancelledOrderLocked'),
    'completed order cannot be reopened': t('admin.completedOrderLocked'),
    'refunded order cannot be changed': t('admin.refundedOrderLocked'),
    'refunded order cannot be advanced': t('admin.refundedOrderLocked'),
    'unpaid order cannot be advanced': t('admin.unpaidOrderCannotAdvance'),
    'balance due requires deposit payment': t('admin.balanceDueRequiresDeposit'),
    'shipping or completion requires full payment': t('admin.shippingRequiresFullPayment'),
    'shipped or completed order payment cannot be downgraded': t('admin.shippedPaymentLocked'),
    'paid order cannot be cancelled before refund': t('admin.paidOrderCancelRequiresRefund'),
    'missing token': t('admin.adminSessionExpired'),
    'invalid site backup': t('admin.restoreMissingSite'),
    'invalid paypal mode': t('admin.paypalModeInvalid'),
    'invalid currency': t('admin.currencyInvalid'),
    'invalid paypal currency': t('admin.paypalCurrencyInvalid'),
    'paypal webhook id must not be url': t('admin.paypalWebhookIdInvalid'),
    'invalid boolean config': t('admin.booleanConfigInvalid'),
    'paypal live credentials required': t('admin.paypalLiveCredentialsRequired'),
    'paypal credentials missing': t('admin.paypalCredentialsMissing'),
    'paypal credentials invalid': t('admin.paypalCredentialsInvalid'),
    'paypal credentials verification failed': t('admin.paypalCredentialsVerificationFailed'),
    'paypal mock enabled': t('admin.paypalMockEnabled'),
    'invalid contact': t('admin.contactInvalid'),
    'KakaoTalk contact required': t('admin.kakaoContactRequired'),
    'WhatsApp contact required': t('admin.whatsappContactRequired'),
    'invalid kakao url': t('admin.kakaoUrlInvalid'),
    'valid KakaoTalk URL required': t('admin.kakaoUrlInvalid'),
    'invalid whatsapp url': t('admin.whatsappUrlInvalid'),
    'valid WhatsApp URL required': t('admin.whatsappUrlInvalid'),
    'faq required': t('admin.faqRequired'),
    'invalid faq': t('admin.faqInvalid'),
    'duplicate faq': t('admin.faqDuplicate'),
    'reviews required': t('admin.reviewsRequired'),
    'invalid reviews': t('admin.reviewsInvalid'),
    'duplicate reviews': t('admin.reviewsDuplicate'),
    'blog required': t('admin.blogRequired'),
    'invalid blog': t('admin.blogInvalid'),
    'duplicate blog': t('admin.blogDuplicate'),
    'invalid theme': t('admin.restoreInvalid'),
  }
  return map[text] || text || t('common.loadFailed')
}

async function runAdminAction(key: string, action: () => Promise<void>) {
  if (savingAction.value) return
  savingAction.value = key
  try {
    await action()
  } catch (e: any) {
    showAdminMessage(adminErrorMessage(e))
  } finally {
    savingAction.value = ''
  }
}

function actionBusy(key: string) {
  return savingAction.value === key
}

function userPaidSummary(user: any) {
  return moneyByCurrency(user?.paid_by_currency, user?.total_paid_cents || 0)
}

function userTagsText(user: any) {
  if (Array.isArray(user?.tags) && user.tags.length) return user.tags.join(', ')
  return String(user?.tags_text || '').trim()
}

function latestFollowupDate(user: any) {
  const followups = Array.isArray(user?.followups) ? user.followups : []
  const item = [...followups].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0]
  return item?.created_at ? formatDate(item.created_at) : '-'
}

function latestFollowupContent(user: any) {
  const followups = Array.isArray(user?.followups) ? user.followups : []
  const item = [...followups].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0]
  return String(item?.content || '').trim() || '-'
}

function copyTextValue(value: any, limit = 500) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!text) return '-'
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function copyLineValue(value: any, limit = 500) {
  const text = copyTextValue(value, limit)
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function nextFollowupDate(user: any) {
  const followups = Array.isArray(user?.followups) ? user.followups : []
  const dates = followups
    .map((item: any) => String(item.next_at || '').trim())
    .filter(Boolean)
    .sort()
  return dates[0] || '-'
}

function orderSummary(order: any) {
  return [
    `${t('admin.order')} ${copyTextValue(order.order_no, 80)}`,
    `${t('admin.customer')} ${copyTextValue(order.customer_name, 120)} / ${copyTextValue(order.email, 160)} / ${copyTextValue(order.phone, 80)} / ${copyTextValue(order.country, 80)}`,
    `${t('admin.shippingAddress')} ${copyTextValue(order.shipping_address, 260)}`,
    `${t('admin.products')} ${copyTextValue(order.product_title, 160)} / ${copyTextValue(order.option_name, 120)}`,
    `${t('admin.petInfo')} ${copyTextValue(order.pet_name, 120)} ${copyTextValue(order.pet_type, 80)}`,
    `${t('admin.amount')} ${money(order.amount_cents, order.currency)} / ${statusText(order.payment_status)} / ${t(`order.${order.payment_type}`)}`,
    `${t('admin.paidAmount')} ${money(order.paid_amount_cents || 0, order.currency)}`,
    `${t('admin.remainingAmount')} ${money(remainingAmount(order), order.currency)}`,
    `${t('admin.paymentRecords')} ${paymentRecordSummary(order)}`,
    `${t('admin.status')} ${statusText(order.order_status)}`,
    `${t('admin.tracking')} ${copyTextValue(order.shipping_carrier, 120)} ${copyTextValue(order.tracking_no, 120)}`.trim(),
    `${t('admin.photoCount')} ${order.photo_urls?.length || 0}`,
    `${t('admin.referencePhotos')} ${referencePhotoSummary(order)}`,
    `${t('admin.customerNote')} ${copyTextValue(order.notes, 500)}`,
    `${t('admin.note')} ${copyTextValue(order.internal_note, 500)}`
  ].join('\n')
}

function customerMailto(order: any) {
  const email = String(order.email || '').trim()
  if (!email) return ''
  const safeOrderNo = copyTextValue(order.order_no, 80)
  const safeCustomerName = copyTextValue(order.customer_name, 120)
  const subject = encodeURIComponent(`${t('admin.mailSubject')} ${safeOrderNo}`.trim())
  const summary = orderSummary(order).slice(0, 3000)
  const body = encodeURIComponent(`${t('admin.mailBodyGreeting')} ${safeCustomerName}\n\n${summary}`)
  return `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`
}

async function copyOrder(order: any) {
  const text = orderSummary(order)
  try {
    await navigator.clipboard?.writeText(text)
    showAdminMessage(t('admin.copied'))
  } catch {
    showAdminMessage(`${t('admin.copyFallback')} ${text}`)
  }
}

function remainingAmount(order: any) {
  return Math.max(0, Number(order.amount_cents || 0) - Number(order.paid_amount_cents || 0))
}

function referencePhotoSummary(order: any) {
  const photos = Array.isArray(order.photo_urls) ? order.photo_urls.filter(Boolean) : []
  if (!photos.length) return '-'
  const shown = photos.slice(0, 5).map((photo: any) => copyTextValue(photo, 240)).join(' ')
  const hiddenCount = photos.length - 5
  return hiddenCount > 0 ? `${shown} +${hiddenCount}` : shown
}

function paymentRecordSummary(order: any) {
  const payments = Array.isArray(order.payments) ? order.payments : []
  if (!payments.length) return '-'
  return payments.map((payment: any) => [
    copyTextValue(payment.provider, 80),
    copyTextValue(payment.status, 80),
    copyTextValue(payment.payment_type, 80),
    money(payment.amount_cents || 0, payment.currency || order.currency),
    copyTextValue(payment.paypal_order_id, 160),
    copyTextValue(payment.paypal_capture_id, 160),
  ].filter(item => item && item !== '-').join(' ')).join(' | ')
}

function latestOrderEvent(order: any) {
  const events = Array.isArray(order?.events) ? order.events : []
  return [...events].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0] || null
}

function csvCell(value: any) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ')
  const safeText = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text
  return /[",\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText
}

function exportTimestamp() {
  return new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '-')
}

function exportOrdersCsv() {
  if (!filteredOrders.value.length) {
    showAdminMessage(t('admin.noExportRows'))
    return
  }
  const headers = [
    t('admin.order'),
    t('admin.customer'),
    'Email',
    t('admin.phone'),
    t('order.country'),
    t('admin.shippingAddress'),
    t('admin.products'),
    t('admin.petInfo'),
    t('admin.photoCount'),
    t('admin.amount'),
    t('admin.paidAmount'),
    t('admin.remainingAmount'),
    t('admin.paymentType'),
    t('admin.paypalOrderId'),
    t('admin.paypalCaptureId'),
    t('admin.paymentRecords'),
    t('admin.shippingCarrier'),
    t('admin.trackingNo'),
    t('admin.status'),
    t('admin.payment'),
    t('admin.flaggedStatus'),
    t('admin.orderCreatedAt'),
    t('admin.latestEventTime'),
    t('admin.latestEventType'),
    t('admin.latestEventMessage'),
    t('admin.eventCount'),
    t('admin.note'),
    t('admin.customerNote'),
    t('admin.referencePhotos'),
  ]
  const rows = filteredOrders.value.map((order: any) => {
    const latestEvent = latestOrderEvent(order)
    return [
      order.order_no,
      order.customer_name,
      order.email,
      order.phone || '',
      order.country || '',
      order.shipping_address || '',
      `${order.product_title || ''} ${order.option_name || ''}`.trim(),
      `${order.pet_name || ''} ${order.pet_type || ''}`.trim(),
      order.photo_urls?.length || 0,
      money(order.amount_cents, order.currency),
      money(order.paid_amount_cents || 0, order.currency),
      money(remainingAmount(order), order.currency),
      t(`order.${order.payment_type}`),
      order.paypal_order_id || '',
      (order.payments || []).find((payment: any) => payment.paypal_capture_id)?.paypal_capture_id || '',
      paymentRecordSummary(order),
      order.shipping_carrier || '',
      order.tracking_no || '',
      statusText(order.order_status),
      statusText(order.payment_status),
      order.flagged ? t('admin.flaggedBadge') : '',
      order.created_at ? new Date(order.created_at).toLocaleString() : '',
      latestEvent?.created_at ? new Date(latestEvent.created_at).toLocaleString() : '',
      latestEvent?.type || '',
      latestEvent?.message || '',
      Array.isArray(order.events) ? order.events.length : 0,
      order.internal_note || '',
      order.notes || '',
      referencePhotoSummary(order),
    ]
  })
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = exportTimestamp()
  link.href = url
  link.download = `orders-${stamp}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  showAdminMessage(t('admin.exportedOrders'))
}

function exportProductsCsv() {
  if (!filteredProducts.value.length) {
    showAdminMessage(t('admin.noExportRows'))
    return
  }
  const headers = [
    t('admin.productTitle'),
    'slug',
    t('admin.categories'),
    t('admin.basePrice'),
    t('admin.currency'),
    t('admin.depositPercent'),
    t('admin.status'),
    t('admin.optionCount'),
    t('admin.imageCount'),
    t('admin.productReadinessIssues'),
    t('admin.tags'),
    t('admin.altText'),
    t('admin.seoTitle'),
    t('admin.seoDescription'),
  ]
  const rows = filteredProducts.value.map((product: any) => {
    const category = categories.value.find((item) => item.id === product.category_id)
    return [
      translatedValue(product, 'title'),
      product.slug,
      category ? translatedValue(category, 'title') : '',
      money(product.base_price_cents || 0, product.currency),
      product.currency || '',
      `${product.deposit_percent || 0}%`,
      statusText(product.status),
      Array.isArray(product.options) ? product.options.length : 0,
      Array.isArray(product.images) ? product.images.length : (String(product.image_url || '').trim() ? 1 : 0),
      productReadinessIssues(product).join(' / ') || t('admin.readinessReady'),
      product.tags?.join(', ') || '',
      product.alt_text || product.translations?.zh?.alt_text || '',
      product.seo_title || product.translations?.zh?.seo_title || '',
      product.seo_description || product.translations?.zh?.seo_description || '',
    ]
  })
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = exportTimestamp()
  link.href = url
  link.download = `products-${stamp}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  showAdminMessage(t('admin.exportedProducts'))
}

function exportUsersCsv() {
  if (!filteredUsers.value.length) {
    showAdminMessage(t('admin.noExportRows'))
    return
  }
  const headers = [
    t('admin.customer'),
    'Email',
    t('order.country'),
    t('admin.status'),
    t('admin.tags'),
    t('admin.orders'),
    t('admin.amount'),
    t('admin.lastOrder'),
    t('admin.latestFollowupDate'),
    t('admin.latestFollowupContent'),
    t('admin.nextFollowupDate'),
    t('admin.note'),
  ]
  const rows = filteredUsers.value.map((user: any) => [
    user.name || '',
    user.email || '',
    user.country || '',
    statusText(user.status || 'active'),
    user.tags?.join(', ') || '',
    user.order_count || 0,
    userPaidSummary(user),
    user.last_order_at ? formatDate(user.last_order_at) : '',
    latestFollowupDate(user),
    latestFollowupContent(user),
    nextFollowupDate(user),
    user.internal_note || '',
  ])
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = exportTimestamp()
  link.href = url
  link.download = `users-${stamp}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  showAdminMessage(t('admin.exportedUsers'))
}

function parseBlogRow(row: string) {
  const cells = row.split('|')
  const [slug = '', date = '', title = '', excerpt = ''] = cells
  const tail = cells.slice(4)
  const imageIndex = tail.findLastIndex((cell) => validSiteImageReference(cell.trim()))
  const fallbackImageIndex = imageIndex >= 0 ? imageIndex : (tail.length > 1 ? tail.length - 2 : -1)
  const imageUrl = fallbackImageIndex >= 0 ? tail[fallbackImageIndex] : ''
  const tagsText = fallbackImageIndex >= 0 ? tail.slice(fallbackImageIndex + 1).join('|') : ''
  const content = fallbackImageIndex >= 0 ? tail.slice(0, fallbackImageIndex).join('|') : tail.join('|')
  return { slug, date, title, excerpt, content, imageUrl, tagsText }
}

function parseReviewRow(row: string) {
  const cells = row.split('|')
  const [name = '', country = '', ratingText = '', title = ''] = cells
  const tail = cells.slice(4)
  if (tail.length >= 6) {
    const [productSlug = '', avatarUrl = '', petImage = '', workImage = '', videoUrl = ''] = tail.slice(-5)
    const mediaFieldsValid = (!productSlug.trim() || validSlug(productSlug.trim()))
      && [avatarUrl, petImage, workImage].every(value => !value.trim() || validSiteImageReference(value.trim()))
      && (!videoUrl.trim() || validHttpUrl(videoUrl.trim()))
    if (mediaFieldsValid) {
      return {
        name,
        country,
        ratingText,
        title,
        content: tail.slice(0, -5).join('|'),
        productSlug,
        avatarUrl,
        petImage,
        workImage,
        videoUrl,
      }
    }
  }
  const last = tail[tail.length - 1] || ''
  const hasProductSlug = tail.length > 1 && (!last.trim() || validSlug(last.trim()))
  return {
    name,
    country,
    ratingText,
    title,
    content: hasProductSlug ? tail.slice(0, -1).join('|') : tail.join('|'),
    productSlug: hasProductSlug ? last : '',
    avatarUrl: '',
    petImage: '',
    workImage: '',
    videoUrl: '',
  }
}

function blogField(post: any, field: keyof BlogTranslationFields, lang: AdminLang = 'zh') {
  return readTranslation(post, lang, field) || post?.[field] || ''
}

function escapeBlogText(value: string) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function textToBlogHtml(value: string) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  return text.split(/\n{2,}/)
    .map((part) => `<p>${escapeBlogText(part.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function sanitizeBlogHtml(input: string) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (!/<[a-z][\s\S]*>/i.test(raw)) return textToBlogHtml(raw)
  const allowedTags = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'UL', 'OL', 'LI', 'H2', 'H3', 'BLOCKQUOTE', 'A', 'DIV'])
  const dangerousTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK'])
  const doc = new DOMParser().parseFromString(`<div>${raw}</div>`, 'text/html')
  const root = doc.body.firstElementChild as HTMLElement | null
  if (!root) return ''
  const cleanNode = (node: Node) => {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.parentNode?.removeChild(node)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as HTMLElement
    const tag = element.tagName.toUpperCase()
    if (dangerousTags.has(tag)) {
      element.remove()
      return
    }
    for (const child of Array.from(element.childNodes)) cleanNode(child)
    if (!allowedTags.has(tag)) {
      const parent = element.parentNode
      if (!parent) return
      while (element.firstChild) parent.insertBefore(element.firstChild, element)
      parent.removeChild(element)
      return
    }
    const href = tag === 'A' ? String(element.getAttribute('href') || '').trim() : ''
    for (const attr of Array.from(element.attributes)) element.removeAttribute(attr.name)
    if (tag === 'A' && /^(https?:|mailto:)/i.test(href)) {
      element.setAttribute('href', href)
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
  }
  for (const child of Array.from(root.childNodes)) cleanNode(child)
  root.querySelectorAll('div').forEach((div) => {
    const p = doc.createElement('p')
    while (div.firstChild) p.appendChild(div.firstChild)
    div.replaceWith(p)
  })
  return root.innerHTML.trim()
}

function stripBlogHtml(value: string) {
  const html = String(value || '')
  try {
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent || ''
    return text.replace(/\s+/g, ' ').trim()
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
}

function blogPreviewText(post: any, field: keyof BlogTranslationFields = 'content', limit = 180) {
  const text = stripBlogHtml(blogField(post, field))
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function blogTranslationCount(post: any) {
  return adminLangs.filter((lang) => blogField(post, 'title', lang) && blogField(post, 'excerpt', lang) && blogField(post, 'content', lang)).length
}

function resetBlogForm() {
  Object.assign(blogForm, {
    id: '',
    slug: '',
    date: new Date().toISOString().slice(0, 10),
    image_url: '',
    tags_text: '',
  })
  for (const lang of adminLangs) Object.assign(blogI18n[lang], { title: '', excerpt: '', content: '' })
  blogEditorKey.value += 1
}

function stableBlogFormState() {
  return JSON.stringify({
    form: blogForm,
    translations: blogI18n,
  })
}

function openBlogModal(post?: any) {
  resetBlogForm()
  blogUnsavedConfirmOpen.value = false
  if (post) {
    Object.assign(blogForm, {
      id: post.id || '',
      slug: post.slug || '',
      date: post.date || new Date().toISOString().slice(0, 10),
      image_url: post.image_url || '',
      tags_text: Array.isArray(post.tags) ? post.tags.join(', ') : '',
    })
    for (const lang of adminLangs) {
      blogI18n[lang].title = blogField(post, 'title', lang)
      blogI18n[lang].excerpt = blogField(post, 'excerpt', lang)
      blogI18n[lang].content = sanitizeBlogHtml(blogField(post, 'content', lang))
    }
  }
  blogFormSnapshot.value = stableBlogFormState()
  blogEditorKey.value += 1
  blogModalOpen.value = true
}

function closeBlogModal() {
  if (savingAction.value === 'blog-form') return
  if (stableBlogFormState() !== blogFormSnapshot.value) {
    blogUnsavedConfirmOpen.value = true
    return
  }
  discardBlogFormChanges()
}

function discardBlogFormChanges() {
  blogUnsavedConfirmOpen.value = false
  blogModalOpen.value = false
  resetBlogForm()
  blogFormSnapshot.value = ''
}

function keepEditingBlogForm() {
  blogUnsavedConfirmOpen.value = false
}

function onBlogEditorInput(event: Event) {
  blogI18n.zh.content = sanitizeBlogHtml((event.currentTarget as HTMLElement).innerHTML)
}

function syncBlogEditorContent() {
  const editor = document.querySelector<HTMLElement>('[data-blog-editor="zh"]')
  if (editor) blogI18n.zh.content = sanitizeBlogHtml(editor.innerHTML)
}

function formatBlogContent(command: string, value = '') {
  document.execCommand(command, false, value)
  syncBlogEditorContent()
}

const blogPhraseTranslations: Array<[string, string, string]> = [
  ['3D 宠物全身类肖像', '3D Full-Body Pet Portraits', '3D 반려동물 전신 초상'],
  ['3D 宠物全身肖像', '3D Full-Body Pet Portrait', '3D 반려동물 전신 초상'],
  ['全身羊毛毡宠物定制', 'Custom Full-Body Wool Felt Pet', '맞춤 전신 양모펠트 반려동물 작품'],
  ['根据照片还原宠物体态、毛色与神情', 'Recreate your pet’s posture, coat color and expression from photos', '사진을 바탕으로 반려동물의 자세, 털색과 표정을 재현합니다'],
  ['从一张照片细致还原宠物的姿态、表情和毛发纹理。', 'A detailed recreation of your pet’s pose, expression and coat from one photo.', '사진 한 장으로 반려동물의 자세와 표정, 털결까지 정교하게 재현합니다.'],
  ['发送照片后，由手作师逐一还原宠物的表情、毛发纹理和独特特征。', 'Send your photos and our artisan will recreate your pet’s expression, coat texture and defining features by hand.', '사진을 보내주시면 장인의 수작업으로 반려동물의 표정과 털결, 특징까지 하나하나 재현합니다.'],
  ['我们提供制作前照片确认、发货前成品预览和局部修改服务。', 'Photo confirmation, a final preview and minor revisions are included.', '제작 전 사진 확인, 출고 전 미리보기와 부분 수정 서비스를 제공합니다.'],
  ['上传宠物照片后，工匠会先确认细节，再开始制作。支持预览确认、局部修改和定金/尾款模式。', 'After you upload pet photos, our artisan confirms the details before production. Preview approval, minor revisions and deposit or full-payment options are supported.', '사진을 업로드하면 장인이 세부 사항을 확인한 뒤 제작을 시작합니다. 미리보기 확인, 부분 수정과 계약금 또는 전액 결제를 지원합니다.'],
  ['厘米', 'cm', 'cm'],
  ['宠物全身肖像', 'full-body pet portrait', '반려동물 전신 초상'],
  ['多宠物合照', 'multi-pet group portrait', '다중 반려동물 단체 초상'],
  ['支持定金、预览确认和全球配送', 'Deposit payment, preview approval and worldwide shipping are supported', '계약금, 미리보기 확인과 해외 배송을 지원합니다'],
  ['6 英寸头部', '6-inch head', '6인치 머리'],
  ['7 英寸头部', '7-inch head', '7인치 머리'],
  ['3D 羊毛毡', '3D wool felt', '3D 양모펠트'],
  ['羊毛毡', 'wool felt', '양모펠트'],
  ['宠物相框', 'pet frame', '반려동물 액자'],
  ['纪念相框', 'memorial frame', '추모 액자'],
  ['头像相框', 'head portrait frame', '두상 액자'],
  ['全身肖像', 'full-body portrait', '전신 초상'],
  ['• 本作品为 100% 手工羊毛毡作品，仅供装饰和纪念。', '• This is a 100% handmade wool felt work for display and remembrance.', '• 본 작품은 100% 수작업 양모펠트 작품으로 장식 및 기념용입니다.'],
  ['• 请勿作为玩具使用。', '• Do not use it as a toy.', '• 장난감으로 사용하지 마십시오.'],
  ['• 避免阳光直射、水、潮湿和强烈碰撞。', '• Avoid direct sunlight, water, humidity and impact.', '• 직사광선, 물, 습기 및 강한 충격을 피해주세요.'],
  ['• 建议放在玻璃展示盒或少尘处保存。', '• Store it in a glass case or low-dust area when possible.', '• 유리 케이스 또는 먼지가 적은 곳에 보관하는 것을 권장합니다.'],
  ['• 表面浮毛可用小剪刀轻轻修整，请勿使用普通梳子或刷子。', '• Trim loose fibers gently with small scissors; do not use a regular comb or brush.', '• 표면에 잔털이 생기면 작은 가위로 살짝 정리해 주세요. 일반 빗이나 브러시는 사용하지 마십시오.'],
  ['• 触摸作品前请清洁双手，并尽量减少触碰细节部位。', '• Clean your hands before touching and avoid frequent contact with fine details.', '• 작품을 만지기 전에는 손을 깨끗이 씻고 세부 부위는 자주 만지지 않는 것을 권장합니다.'],
  ['• 确认最终作品和配送信息后发货。', '• We ship after final work and delivery details are approved.', '• 최종 작품 확인 및 배송 정보를 확인한 후 발송됩니다.'],
  ['• 一般制作周期约 4-8 周。', '• Typical production takes about 4-8 weeks.', '• 일반 제작 기간은 약 4-8주입니다.'],
  ['• 复杂姿势、多宠物、大型作品或旺季订单可能延长。', '• Complex poses, multiple pets, large pieces and peak seasons may take longer.', '• 복잡한 자세, 여러 마리, 대형 작품 및 성수기에는 제작 기간이 연장될 수 있습니다.'],
  ['• 发货后通过邮件提供物流单号。', '• Tracking is provided by email after dispatch.', '• 발송 후 이메일로 운송장 번호를 안내해드립니다.'],
  ['• 配送时长、关税及进口税按目的地国家政策执行。', '• Transit time, customs duties and import taxes follow destination-country rules.', '• 배송 기간, 관세 및 수입세는 목적지 국가의 정책에 따릅니다.'],
  ['1. 制作开始前可取消订单。', '1. Orders may be cancelled before production starts.', '1. 제작 시작 전에는 주문을 취소할 수 있습니다.'],
  ['2. 客户确认开始制作后，定制商品不接受无理由退款。', '2. Change-of-mind refunds are unavailable after custom production is approved.', '2. 고객 확인 후 제작이 시작되면 맞춤 제작 상품은 단순 변심으로 환불할 수 없습니다.'],
  ['3. 制作过程中会充分进行照片确认和沟通。', '3. We confirm photos and communicate throughout production.', '3. 제작 중 고객과 충분히 사진을 확인하고 소통합니다.'],
  ['4. 最终确认完成的作品不属于退款范围。', '4. A finally approved work is not refundable.', '4. 최종 확인이 완료된 작품은 환불 대상이 아닙니다.'],
  ['5. 如作品与确认要求明显不符，优先提供免费修改或重制。', '5. If the work clearly differs from approved requirements, free revision or remake is prioritized.', '5. 작품이 확인된 요구사항과 명확히 다른 경우 무료 수정 또는 재제작을 우선 제공합니다.'],
  ['6. 手工作品的细微差异属于正常范围。', '6. Minor handmade variations are normal.', '6. 수작업 특성상 미세한 차이는 정상 범위입니다.'],
  ['7. 因客户提供照片质量导致的差异不构成退款理由。', '7. Differences caused by low-quality customer photos are not grounds for refund.', '7. 고객이 제공한 사진 품질로 인한 차이는 환불 사유가 아닙니다.'],
  ['8. 运输破损请在收货后 48 小时内附照片联系。', '8. Report shipping damage with photos within 48 hours.', '8. 배송 중 파손은 수령 후 48시간 이내 사진과 함께 알려주세요.'],
  ['9. 地址错误或拒收产生的费用由客户承担。', '9. Costs caused by address errors or refusal are the customer’s responsibility.', '9. 주소 오류 또는 수취 거부로 발생한 비용은 고객 부담입니다.'],
  ['10. 海外清关延误不构成退款理由。', '10. Customs delays are not grounds for refund.', '10. 해외 통관 지연은 환불 사유가 아닙니다.'],
  ['11. 发起 PayPal 争议前请先联系客服。', '11. Contact support before opening a PayPal dispute.', '11. PayPal 분쟁을 제기하기 전에 먼저 고객센터로 문의해 주세요.'],
  ['12. 本政策与 PayPal 买家保护政策共同适用。', '12. This policy applies together with PayPal Buyer Protection.', '12. 본 정책은 PayPal 구매자 보호 정책과 함께 적용됩니다.'],
  ['• 本作品为 100% 手工羊毛毡作品，仅供装饰和纪念', '• This is a 100% handmade wool felt work for display and remembrance', '• 본 작품은 100% 수작업 양모펠트 작품으로 장식 및 기념용입니다'],
  ['需要上传多少张、什么样的照片？', 'How many and what kind of photos should I upload?', '어떤 사진을 몇 장 보내야 하나요?'],
  ['可以只先支付定金吗？', 'Can I pay a deposit first?', '계약금만 먼저 결제할 수 있나요?'],
  ['可以使用 PayPal 吗？', 'Can I pay with PayPal?', 'PayPal 결제가 가능한가요?'],
  ['发货前可以确认作品吗？', 'Can I review the work before shipping?', '제작 전에 작품을 확인할 수 있나요?'],
  ['制作中可以修改吗？', 'Can I request revisions?', '제작 중 수정이 가능한가요?'],
  ['可以制作多只宠物吗？', 'Can you make multiple pets?', '여러 마리도 제작 가능한가요?'],
  ['猫咪也可以制作吗？', 'Can you make cats?', '고양이도 가능한가요?'],
  ['制作周期多久？', 'How long does production take?', '제작 기간은 얼마나 걸리나요?'],
  ['100% 手工羊毛毡作品', '100% handmade wool felt work', '100% 수작업 양모펠트 작품'],
  ['仅供装饰和纪念', 'for display and remembrance only', '장식 및 기념용'],
  ['请勿作为玩具使用', 'Do not use it as a toy', '장난감으로 사용하지 마십시오'],
  ['避免阳光直射、水、潮湿和强烈碰撞', 'Avoid direct sunlight, water, humidity and impact', '직사광선, 물, 습기 및 강한 충격을 피해주세요'],
  ['确认最终作品和配送信息后发货', 'We ship after final work and delivery details are approved', '최종 작품 확인 및 배송 정보를 확인한 후 발송됩니다'],
  ['一般制作周期约 4-8 周', 'Typical production takes about 4-8 weeks', '일반 제작 기간은 약 4-8주입니다'],
  ['复杂姿势、多宠物、大型作品或旺季订单可能延长', 'Complex poses, multiple pets, large pieces and peak seasons may take longer', '복잡한 자세, 여러 마리, 대형 작품 및 성수기에는 제작 기간이 연장될 수 있습니다'],
  ['发货后通过邮件提供物流单号', 'Tracking is provided by email after dispatch', '발송 후 이메일로 운송장 번호를 안내해드립니다'],
  ['支持全球大多数国家和地区', 'We ship to most countries', '전 세계 대부분 국가로 배송 가능합니다'],
  ['请联系客服', 'Please contact support', '고객센터로 문의해 주세요'],
  ['羊毛毡宠物肖像', 'wool felt pet portrait', '양모 펠트 반려동물 초상'],
  ['宠物纪念礼物', 'pet memorial gift', '반려동물 추모 선물'],
  ['定制宠物肖像', 'custom pet portrait', '맞춤 반려동물 초상'],
  ['参考照片', 'reference photos', '참고 사진'],
  ['制作周期', 'lead time', '제작 기간'],
  ['正面', 'front view', '정면'],
  ['侧面', 'side view', '측면'],
  ['背面', 'back view', '뒷모습'],
  ['全身', 'full body', '전신'],
  ['毛色', 'coat color', '털색'],
  ['细节', 'details', '디테일'],
  ['表情', 'expression', '표정'],
  ['纪念', 'memorial', '추모'],
  ['礼物', 'gift', '선물'],
  ['照片', 'photos', '사진'],
  ['宠物', 'pet', '반려동물'],
  ['猫咪', 'cat', '고양이'],
  ['猫', 'cat', '고양이'],
  ['狗狗', 'dog', '강아지'],
  ['狗', 'dog', '강아지'],
  ['兔子', 'rabbit', '토끼'],
  ['家人', 'family', '가족'],
  ['定制', 'custom', '맞춤'],
  ['手工', 'handmade', '수작업'],
  ['护理', 'care', '관리'],
  ['指南', 'guide', '가이드'],
  ['相框', 'frame', '액자'],
  ['肖像', 'portrait', '초상'],
  ['作品', 'piece', '작품'],
  ['保存', 'keep', '보관'],
  ['避免', 'avoid', '피하세요'],
  ['水洗', 'washing', '세탁'],
  ['暴晒', 'direct sunlight', '직사광선'],
  ['潮湿', 'moisture', '습기'],
  ['选择', 'choose', '선택'],
  ['上传', 'upload', '업로드'],
  ['确认', 'confirm', '확인'],
  ['预览', 'preview', '미리보기'],
  ['发货', 'shipping', '배송'],
]

const productTranslationPresets: Record<string, Record<'en' | 'ko', Partial<ProductTranslationFields>>> = {
  'full-body-pet-replica': {
    en: {
      title: '3D Full-Body Pet Portrait',
      subtitle: 'A detailed recreation of your pet’s pose, expression and coat from one photo.',
      description: 'Send your photos and our artisan will recreate your pet’s expression, coat texture and defining features by hand.\n\nPhoto confirmation, a final preview and minor revisions are included.',
      alt_text: 'WoolBuddy handmade 3D full-body wool felt pet portrait',
      seo_title: '3D Full-Body Wool Felt Pet Portrait | WoolBuddy',
      seo_description: 'Handmade 3D full-body wool felt pet portrait with deposit payment, preview approval and worldwide shipping.',
    },
    ko: {
      title: '3D 반려동물 전신 초상',
      subtitle: '사진 한 장으로 반려동물의 자세와 표정, 털결까지 정교하게 재현합니다.',
      description: '사진을 보내주시면 장인의 수작업으로 반려동물의 표정과 털결, 특징까지 하나하나 재현합니다.\n\n제작 전 사진 확인, 출고 전 미리보기와 부분 수정 서비스를 제공합니다.',
      alt_text: 'WoolBuddy 수제 3D 반려동물 전신 양모펠트 초상',
      seo_title: '3D 반려동물 전신 양모펠트 초상 | WoolBuddy',
      seo_description: '사진으로 제작하는 맞춤 3D 반려동물 전신 양모펠트 초상. 계약금, 미리보기 확인과 해외 배송을 지원합니다.',
    },
  },
  'felted-photo-frame': {
    en: {
      title: '3D Pet Frame Portrait',
      subtitle: 'Keep your beloved pet close in a warm, handmade framed work.',
      description: 'Send your photos and our artisan will recreate your pet’s expression, coat texture and defining features by hand.\n\nPhoto confirmation, a final preview and minor revisions are included.',
      alt_text: 'WoolBuddy handmade 3D wool felt pet frame portrait',
      seo_title: '3D Wool Felt Pet Frame Portrait | WoolBuddy',
      seo_description: 'Handmade 3D wool felt pet frame portrait with preview approval and worldwide shipping.',
    },
    ko: {
      title: '3D 반려동물 액자 초상',
      subtitle: '소중한 반려동물의 모습을 따뜻한 액자 작품으로 오래 간직하세요.',
      description: '사진을 보내주시면 장인의 수작업으로 반려동물의 표정과 털결, 특징까지 하나하나 재현합니다.\n\n제작 전 사진 확인, 출고 전 미리보기와 부분 수정 서비스를 제공합니다.',
      alt_text: 'WoolBuddy 수제 3D 반려동물 양모펠트 액자 초상',
      seo_title: '3D 반려동물 양모펠트 액자 초상 | WoolBuddy',
      seo_description: '사진으로 제작하는 맞춤 3D 반려동물 양모펠트 액자 초상. 미리보기 확인과 해외 배송을 지원합니다.',
    },
  },
  'pet-memorial-ornament': {
    en: {
      title: '3D Pet Memorial Keepsake',
      subtitle: 'A small pet memorial keepsake made to last.',
      description: 'Send your photos and our artisan will recreate your pet’s expression, coat texture and defining features by hand.\n\nPhoto confirmation, a final preview and minor revisions are included.',
      alt_text: 'WoolBuddy handmade 3D wool felt pet memorial keepsake',
      seo_title: '3D Wool Felt Pet Memorial Keepsake | WoolBuddy',
      seo_description: 'A small handmade wool felt pet memorial keepsake with preview approval and worldwide shipping.',
    },
    ko: {
      title: '3D 반려동물 메모리얼 기념품',
      subtitle: '작지만 오래 간직할 수 있는 반려동물 추억 기념품입니다.',
      description: '사진을 보내주시면 장인의 수작업으로 반려동물의 표정과 털결, 특징까지 하나하나 재현합니다.\n\n제작 전 사진 확인, 출고 전 미리보기와 부분 수정 서비스를 제공합니다.',
      alt_text: 'WoolBuddy 수제 3D 반려동물 양모펠트 메모리얼 작품',
      seo_title: '3D 반려동물 양모펠트 메모리얼 | WoolBuddy',
      seo_description: '사진으로 제작하는 맞춤 반려동물 양모펠트 메모리얼 기념품. 미리보기와 해외 배송을 지원합니다.',
    },
  },
}

function draftTranslateText(value: string, lang: Exclude<AdminLang, 'zh'>) {
  let output = String(value || '')
  const index = lang === 'en' ? 1 : 2
  for (const item of [...blogPhraseTranslations].sort((a, b) => b[0].length - a[0].length)) {
    output = output.replaceAll(item[0], item[index])
  }
  return output
}

function draftTranslateHtml(value: string, lang: Exclude<AdminLang, 'zh'>) {
  const html = sanitizeBlogHtml(value)
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild as HTMLElement | null
  if (!root) return ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent = draftTranslateText(node.textContent || '', lang)
      return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  walk(root)
  return sanitizeBlogHtml(root.innerHTML)
}

function draftTranslateFaq(value: string, lang: Exclude<AdminLang, 'zh'>) {
  return String(value || '').split(/\r?\n/).map((row) => {
    if (!row.trim()) return ''
    const separatorIndex = row.indexOf('|')
    if (separatorIndex < 0) return draftTranslateText(row, lang)
    const question = row.slice(0, separatorIndex)
    const answer = row.slice(separatorIndex + 1)
    return `${draftTranslateText(question, lang)}|${draftTranslateText(answer, lang)}`
  }).join('\n')
}

function draftTranslateOptions(value: string, lang: Exclude<AdminLang, 'zh'>) {
  return String(value || '').split(/\r?\n/).map((row) => {
    if (!row.trim()) return ''
    const [name = '', ...priceParts] = row.replace('，', ',').split(',')
    const translatedName = draftTranslateText(name, lang)
    return priceParts.length ? `${translatedName},${priceParts.join(',')}` : translatedName
  }).join('\n')
}

type TranslationTarget = Exclude<AdminLang, 'zh'>

async function translateAdminTexts(texts: string[], target: TranslationTarget) {
  const response = await api<{ translations?: unknown }>('/admin/translate', {
    method: 'POST',
    body: JSON.stringify({ texts, target }),
  })
  if (!Array.isArray(response.translations) || response.translations.length !== texts.length) {
    throw new Error(t('admin.translationResponseInvalid'))
  }
  return response.translations.map((value) => String(value ?? ''))
}

function translationFailureMessage(error: unknown) {
  const detail = error instanceof Error ? error.message.trim() : ''
  return t('admin.translationFailed', { detail: detail ? ` ${detail}` : '' })
}

async function translateProductTarget(source: ProductTranslationFields, target: TranslationTarget) {
  const fields = ['title', 'subtitle', 'description', 'alt_text', 'seo_title', 'seo_description'] as const
  const entries: Array<{ key: string; value: string }> = fields
    .filter((field) => Boolean(source[field]))
    .map((field) => ({ key: field, value: source[field] }))
  const sourceRows = String(source.options_text || '').split(/\r?\n/)
  sourceRows.forEach((row, index) => {
    const [name = ''] = row.replace('，', ',').split(',')
    if (name.trim()) entries.push({ key: `option:${index}`, value: name.trim() })
  })
  const translated = await translateAdminTexts(entries.map((entry) => entry.value), target)
  const translatedByKey = new Map(entries.map((entry, index) => [entry.key, translated[index]]))
  const result = { ...productI18n[target] }
  for (const field of fields) {
    if (source[field]) result[field] = translatedByKey.get(field) || ''
  }
  if (sourceRows.some((row) => row.trim())) {
    result.options_text = sourceRows.map((row, index) => {
      if (!row.trim()) return ''
      const normalized = row.replace('，', ',')
      const separatorIndex = normalized.indexOf(',')
      const name = separatorIndex < 0 ? normalized : normalized.slice(0, separatorIndex)
      if (!name.trim()) return row
      const translatedName = translatedByKey.get(`option:${index}`) || name.trim()
      return separatorIndex < 0 ? translatedName : `${translatedName},${normalized.slice(separatorIndex + 1).trim()}`
    }).join('\n')
  }
  return result
}

async function autoTranslateProduct() {
  const source = {
    title: productI18n.zh.title.trim(),
    subtitle: productI18n.zh.subtitle.trim(),
    description: productI18n.zh.description.trim(),
    alt_text: productI18n.zh.alt_text.trim(),
    seo_title: productI18n.zh.seo_title.trim(),
    seo_description: productI18n.zh.seo_description.trim(),
    options_text: productI18n.zh.options_text.trim(),
  }
  if (!Object.values(source).some(Boolean)) {
    showAdminMessage(t('admin.productTranslationSourceRequired'))
    return
  }
  productTranslationGenerating.value = true
  try {
    const generated: Record<TranslationTarget, ProductTranslationFields> = {} as Record<TranslationTarget, ProductTranslationFields>
    for (const lang of ['en', 'ko'] as const) {
      generated[lang] = await translateProductTarget(source, lang)
    }
    Object.assign(productI18n.en, generated.en)
    Object.assign(productI18n.ko, generated.ko)
    showAdminMessage(t('admin.productAutoTranslated'))
  } catch (error) {
    showAdminMessage(translationFailureMessage(error))
  } finally {
    productTranslationGenerating.value = false
  }
}

async function translateSiteTarget(source: { care: string; shipping: string; refund: string; faq: string }, target: TranslationTarget) {
  const entries: Array<{ key: string; value: string }> = []
  for (const field of ['care', 'shipping', 'refund'] as const) {
    if (source[field]) entries.push({ key: field, value: source[field] })
  }
  const faqRows = source.faq.split(/\r?\n/)
  faqRows.forEach((row, index) => {
    if (!row.trim()) return
    const separatorIndex = row.indexOf('|')
    if (separatorIndex < 0) {
      entries.push({ key: `faq:${index}:row`, value: row })
      return
    }
    entries.push({ key: `faq:${index}:question`, value: row.slice(0, separatorIndex).trim() })
    entries.push({ key: `faq:${index}:answer`, value: row.slice(separatorIndex + 1).trim() })
  })
  const translated = await translateAdminTexts(entries.map((entry) => entry.value), target)
  const translatedByKey = new Map(entries.map((entry, index) => [entry.key, translated[index]]))
  const result = {
    care: policyI18n[target].care,
    shipping: policyI18n[target].shipping,
    refund: policyI18n[target].refund,
    faq: faqI18n[target],
  }
  for (const field of ['care', 'shipping', 'refund'] as const) {
    if (source[field]) result[field] = translatedByKey.get(field) || ''
  }
  if (source.faq) {
    result.faq = faqRows.map((row, index) => {
      if (!row.trim()) return ''
      const separatorIndex = row.indexOf('|')
      if (separatorIndex < 0) return translatedByKey.get(`faq:${index}:row`) || row
      const question = translatedByKey.get(`faq:${index}:question`) || row.slice(0, separatorIndex).trim()
      const answer = translatedByKey.get(`faq:${index}:answer`) || row.slice(separatorIndex + 1).trim()
      return `${question}|${answer}`
    }).join('\n')
  }
  return result
}

async function autoTranslateSiteContent() {
  const source = {
    care: policyI18n.zh.care.trim(),
    shipping: policyI18n.zh.shipping.trim(),
    refund: policyI18n.zh.refund.trim(),
    faq: faqI18n.zh.trim(),
  }
  if (!source.care && !source.shipping && !source.refund && !source.faq) {
    showAdminMessage(t('admin.siteTranslationSourceRequired'))
    return
  }
  siteTranslationGenerating.value = true
  try {
    const generated: Record<TranslationTarget, { care: string; shipping: string; refund: string; faq: string }> = {} as Record<TranslationTarget, { care: string; shipping: string; refund: string; faq: string }>
    for (const lang of ['en', 'ko'] as const) {
      generated[lang] = await translateSiteTarget(source, lang)
    }
    Object.assign(policyI18n.en, { care: generated.en.care, shipping: generated.en.shipping, refund: generated.en.refund })
    Object.assign(policyI18n.ko, { care: generated.ko.care, shipping: generated.ko.shipping, refund: generated.ko.refund })
    faqI18n.en = generated.en.faq
    faqI18n.ko = generated.ko.faq
    showAdminMessage(t('admin.siteAutoTranslated'))
  } catch (error) {
    showAdminMessage(translationFailureMessage(error))
  } finally {
    siteTranslationGenerating.value = false
  }
}

function autoTranslateBlog() {
  const zhTitle = blogI18n.zh.title.trim()
  const zhExcerpt = blogI18n.zh.excerpt.trim()
  const zhContent = sanitizeBlogHtml(blogI18n.zh.content)
  if (!zhTitle || !zhExcerpt || !stripBlogHtml(zhContent)) {
    showAdminMessage(t('admin.blogTranslationSourceRequired'))
    return
  }
  for (const lang of ['en', 'ko'] as const) {
    blogI18n[lang].title = draftTranslateText(zhTitle, lang)
    blogI18n[lang].excerpt = draftTranslateText(zhExcerpt, lang)
    blogI18n[lang].content = draftTranslateHtml(zhContent, lang)
  }
  blogI18n.zh.content = zhContent
  showAdminMessage(t('admin.blogAutoTranslated'))
}

function blogPayloadFromForm() {
  const slug = blogForm.slug.trim()
  const date = blogForm.date.trim()
  const imageUrl = blogForm.image_url.trim()
  const zhTitle = blogI18n.zh.title.trim()
  const zhExcerpt = blogI18n.zh.excerpt.trim()
  const zhContent = sanitizeBlogHtml(blogI18n.zh.content)
  const tags = blogForm.tags_text.split(',').map((tag) => tag.trim()).filter(Boolean)
  if (!validSlug(slug)) {
    showAdminMessage(t('admin.slugInvalid'))
    return null
  }
  if (!validIsoDate(date)) {
    showAdminMessage(t('admin.blogDateInvalid'))
    return null
  }
  if (!zhTitle) {
    showAdminMessage(t('admin.blogTitleRequired'))
    return null
  }
  if (!zhExcerpt) {
    showAdminMessage(t('admin.blogExcerptRequired'))
    return null
  }
  if (!stripBlogHtml(zhContent)) {
    showAdminMessage(t('admin.blogContentRequired'))
    return null
  }
  if (zhContent.length > 6000) {
    showAdminMessage(t('admin.blogContentTooLong'))
    return null
  }
  if (!validSiteImageReference(imageUrl)) {
    showAdminMessage(t('admin.blogImageInvalid'))
    return null
  }
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) {
    showAdminMessage(t('admin.blogTagsInvalid'))
    return null
  }
  const existing = (site.value.blog || []).find((post: any) => post.id === blogForm.id || post.slug === slug)
  const translations: Record<AdminLang, BlogTranslationFields> = {
    zh: { title: zhTitle, excerpt: zhExcerpt, content: zhContent },
    en: {
      title: blogI18n.en.title.trim() || draftTranslateText(zhTitle, 'en'),
      excerpt: blogI18n.en.excerpt.trim() || draftTranslateText(zhExcerpt, 'en'),
      content: sanitizeBlogHtml(blogI18n.en.content || draftTranslateHtml(zhContent, 'en')),
    },
    ko: {
      title: blogI18n.ko.title.trim() || draftTranslateText(zhTitle, 'ko'),
      excerpt: blogI18n.ko.excerpt.trim() || draftTranslateText(zhExcerpt, 'ko'),
      content: sanitizeBlogHtml(blogI18n.ko.content || draftTranslateHtml(zhContent, 'ko')),
    },
  }
  return {
    id: blogForm.id || existing?.id || slug || crypto.randomUUID(),
    slug,
    date,
    title: zhTitle,
    excerpt: zhExcerpt,
    content: zhContent,
    image_url: imageUrl,
    tags,
    translations: {
      ...(existing?.translations || {}),
      zh: { ...(existing?.translations?.zh || {}), ...translations.zh },
      en: { ...(existing?.translations?.en || {}), ...translations.en },
      ko: { ...(existing?.translations?.ko || {}), ...translations.ko },
    },
  }
}

async function saveBlog() {
  if (savingAction.value) return
  const payload = blogPayloadFromForm()
  if (!payload) return
  const blogs = Array.isArray(site.value.blog) ? [...site.value.blog] : []
  const index = blogs.findIndex((post: any) => post.id === payload.id || (blogForm.id && post.id === blogForm.id))
  if (blogs.some((post: any, itemIndex: number) => itemIndex !== index && String(post.slug || '').trim().toLowerCase() === payload.slug.toLowerCase())) {
    showAdminMessage(t('admin.blogDuplicate'))
    return
  }
  const nextBlog = index >= 0 ? blogs.map((post: any, itemIndex: number) => (itemIndex === index ? payload : post)) : [payload, ...blogs]
  await runAdminAction('blog-form', async () => {
    const savedSite = await api<SiteSettings>('/admin/site', {
      method: 'PUT',
      body: JSON.stringify({ blog: nextBlog }),
    })
    site.value = savedSite
    syncSiteForms(savedSite)
    discardBlogFormChanges()
    showAdminMessage(t('admin.blogPublished'))
  })
}

function deleteBlog(post: any) {
  deleteBlogTarget.value = post
}

function closeDeleteBlogModal() {
  if (savingAction.value.startsWith('blog-delete-')) return
  deleteBlogTarget.value = null
}

async function confirmDeleteBlog() {
  const post = deleteBlogTarget.value
  if (!post) return
  const blogs = Array.isArray(site.value.blog) ? site.value.blog : []
  const nextBlog = blogs.filter((item: any) => item.id !== post.id && item.slug !== post.slug)
  if (!nextBlog.length) {
    showAdminMessage(t('admin.blogRequired'))
    return
  }
  await runAdminAction(`blog-delete-${post.id || post.slug}`, async () => {
    const savedSite = await api<SiteSettings>('/admin/site', {
      method: 'PUT',
      body: JSON.stringify({ blog: nextBlog }),
    })
    deleteBlogTarget.value = null
    site.value = savedSite
    syncSiteForms(savedSite)
    showAdminMessage(t('admin.blogDeleted'))
  })
}

function reviewField(review: any, field: keyof ReviewTranslationFields, lang: AdminLang = 'zh') {
  return readTranslation(review, lang, field) || review?.[field] || ''
}

function reviewMediaUrls(review: any) {
  if (Array.isArray(review?.images) && review.images.length) return review.images.filter(Boolean)
  return [review?.pet_image, review?.work_image].filter(Boolean)
}

function reviewDraftImages() {
  return String(reviewForm.images_text || '')
    .split(/\r?\n/)
    .map((image) => image.trim())
    .filter(Boolean)
}

function reviewTranslationCount(review: any) {
  return adminLangs.filter((lang) => reviewField(review, 'title', lang).trim() && reviewField(review, 'content', lang).trim()).length
}

function resetReviewForm() {
  Object.assign(reviewForm, {
    id: '',
    name: '',
    country: 'Korea',
    rating: 5,
    status: 'published',
    product_slug: '',
    avatar_url: '',
    images_text: '',
    video_url: '',
  })
  for (const lang of adminLangs) Object.assign(reviewI18n[lang], { title: '', content: '' })
}

function stableReviewFormState() {
  return JSON.stringify({
    form: reviewForm,
    translations: reviewI18n,
  })
}

function openReviewModal(review?: any) {
  resetReviewForm()
  reviewUnsavedConfirmOpen.value = false
  if (review) {
    Object.assign(reviewForm, {
      id: review.id || '',
      name: review.name || '',
      country: review.country || '',
      rating: Number(review.rating || 5),
      status: review.status || 'published',
      product_slug: review.product_slug || '',
      avatar_url: review.avatar_url || '',
      images_text: reviewMediaUrls(review).join('\n'),
      video_url: review.video_url || '',
    })
    for (const lang of adminLangs) {
      reviewI18n[lang].title = reviewField(review, 'title', lang)
      reviewI18n[lang].content = reviewField(review, 'content', lang)
    }
  }
  reviewFormSnapshot.value = stableReviewFormState()
  reviewModalOpen.value = true
}

function closeReviewModal() {
  if (savingAction.value === 'review-form' || reviewUploadBusy.value) return
  if (stableReviewFormState() !== reviewFormSnapshot.value) {
    reviewUnsavedConfirmOpen.value = true
    return
  }
  discardReviewFormChanges()
}

function discardReviewFormChanges() {
  reviewUnsavedConfirmOpen.value = false
  reviewModalOpen.value = false
  resetReviewForm()
  reviewFormSnapshot.value = ''
}

function keepEditingReviewForm() {
  reviewUnsavedConfirmOpen.value = false
}

async function uploadReviewFiles(event: Event, kind: 'avatar' | 'images') {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length) return
  reviewUploadBusy.value = kind
  try {
    const uploadedUrls: string[] = []
    for (const file of files) {
      const result = await upload(file)
      if (result?.url) uploadedUrls.push(result.url)
    }
    if (kind === 'avatar') {
      reviewForm.avatar_url = uploadedUrls[0] || reviewForm.avatar_url
    } else {
      reviewForm.images_text = [...new Set([...reviewDraftImages(), ...uploadedUrls])].join('\n')
    }
    showAdminMessage(t('admin.reviewUploadDone'))
  } catch (error: any) {
    showAdminMessage(String(error?.message || t('admin.reviewUploadFailed')))
  } finally {
    reviewUploadBusy.value = ''
  }
}

function removeReviewImage(index: number) {
  const images = reviewDraftImages()
  images.splice(index, 1)
  reviewForm.images_text = images.join('\n')
}

function reviewPayloadFromForm() {
  const name = reviewForm.name.trim()
  const country = reviewForm.country.trim()
  const zhTitle = reviewI18n.zh.title.trim()
  const zhContent = reviewI18n.zh.content.trim()
  const avatarUrl = reviewForm.avatar_url.trim()
  const images = reviewDraftImages()
  const productSlug = reviewForm.product_slug.trim()
  const videoUrl = reviewForm.video_url.trim()
  const rating = Number(reviewForm.rating)
  if (!name || !country || !zhTitle || !zhContent) {
    showAdminMessage(t('admin.reviewRequired'))
    return null
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    showAdminMessage(t('admin.reviewRatingInvalid'))
    return null
  }
  if (!publishStatuses.includes(reviewForm.status)) {
    showAdminMessage(t('admin.reviewStatusInvalid'))
    return null
  }
  if (productSlug && !validSlug(productSlug)) {
    showAdminMessage(t('admin.slugInvalid'))
    return null
  }
  if (images.length > 24) {
    showAdminMessage(t('admin.reviewImagesTooMany'))
    return null
  }
  if (images.some((image) => !validSiteImageReference(image))
    || (avatarUrl && !validSiteImageReference(avatarUrl))
    || (videoUrl && !validHttpUrl(videoUrl))) {
    showAdminMessage(t('admin.reviewMediaInvalid'))
    return null
  }
  const existing = (site.value.reviews || []).find((review: any) => review.id === reviewForm.id)
  const translations: Record<AdminLang, ReviewTranslationFields> = {
    zh: { title: zhTitle, content: zhContent },
    en: {
      title: reviewI18n.en.title.trim() || zhTitle,
      content: reviewI18n.en.content.trim() || zhContent,
    },
    ko: {
      title: reviewI18n.ko.title.trim() || zhTitle,
      content: reviewI18n.ko.content.trim() || zhContent,
    },
  }
  return {
    id: reviewForm.id || existing?.id || crypto.randomUUID(),
    name,
    country,
    rating,
    status: reviewForm.status,
    title: zhTitle,
    content: zhContent,
    product_slug: productSlug,
    avatar_url: avatarUrl,
    images,
    pet_image: images[0] || '',
    work_image: images[1] || '',
    video_url: videoUrl,
    translations: {
      ...(existing?.translations || {}),
      zh: { ...(existing?.translations?.zh || {}), ...translations.zh },
      en: { ...(existing?.translations?.en || {}), ...translations.en },
      ko: { ...(existing?.translations?.ko || {}), ...translations.ko },
    },
  }
}

async function saveReview() {
  if (savingAction.value) return
  const payload = reviewPayloadFromForm()
  if (!payload) return
  const reviews = Array.isArray(site.value.reviews) ? [...site.value.reviews] : []
  const index = reviews.findIndex((review: any) => review.id === payload.id)
  if (reviews.some((review: any, itemIndex: number) => itemIndex !== index
    && String(review.name || '').trim().toLowerCase() === payload.name.toLowerCase()
    && reviewField(review, 'title', 'zh').trim().toLowerCase() === payload.title.toLowerCase())) {
    showAdminMessage(t('admin.reviewsDuplicate'))
    return
  }
  const nextReviews = index >= 0
    ? reviews.map((review: any, itemIndex: number) => itemIndex === index ? payload : review)
    : [payload, ...reviews]
  await runAdminAction('review-form', async () => {
    const savedSite = await api<SiteSettings>('/admin/site', {
      method: 'PUT',
      body: JSON.stringify({ reviews: nextReviews }),
    })
    site.value = savedSite
    syncSiteForms(savedSite)
    discardReviewFormChanges()
    showAdminMessage(t('admin.reviewSaved'))
  })
}

function deleteReview(review: any) {
  deleteReviewTarget.value = review
}

function closeDeleteReviewModal() {
  if (savingAction.value.startsWith('review-delete-')) return
  deleteReviewTarget.value = null
}

async function confirmDeleteReview() {
  const review = deleteReviewTarget.value
  if (!review) return
  const reviews = Array.isArray(site.value.reviews) ? site.value.reviews : []
  const nextReviews = reviews.filter((item: any) => item.id !== review.id)
  if (!nextReviews.length) {
    showAdminMessage(t('admin.reviewsRequired'))
    return
  }
  await runAdminAction(`review-delete-${review.id}`, async () => {
    const savedSite = await api<SiteSettings>('/admin/site', {
      method: 'PUT',
      body: JSON.stringify({ reviews: nextReviews }),
    })
    deleteReviewTarget.value = null
    site.value = savedSite
    syncSiteForms(savedSite)
    showAdminMessage(t('admin.reviewDeleted'))
  })
}

function resetReviewFilters() {
  reviewSearch.value = ''
}

function resetBlogFilters() {
  blogSearch.value = ''
  blogPage.value = 1
}

async function copyFilteredUserFollowups() {
  if (!filteredUsers.value.length) {
    userCopyText.value = ''
    showAdminMessage(t('admin.noCopyUsers'))
    return
  }
  const text = filteredUsers.value.map((user: any, index: number) => [
    `#${index + 1} ${copyLineValue(user.name, 120)}`,
    `Email ${copyLineValue(user.email, 160)}`,
    `${t('admin.status')} ${statusText(user.status || 'active')}`,
    `${t('admin.orders')} ${user.order_count || 0} / ${t('admin.amount')} ${userPaidSummary(user)}`,
    `${t('admin.lastOrder')} ${user.last_order_at ? formatDate(user.last_order_at) : '-'}`,
    `${t('admin.latestFollowupDate')} ${latestFollowupDate(user)}`,
    `${t('admin.latestFollowupContent')} ${copyLineValue(latestFollowupContent(user), 500)}`,
    `${t('admin.nextFollowupDate')} ${nextFollowupDate(user)}`,
    `${t('admin.note')} ${copyLineValue(user.internal_note, 500)}`,
  ].join('\n')).join('\n\n')
  userCopyText.value = text
  try {
    await navigator.clipboard?.writeText(text)
    showAdminMessage(t('admin.copiedUserFollowups'))
  } catch {
    showAdminMessage(t('admin.copyUserFollowupsFallback'))
  }
}

async function copyFilteredOrderContacts() {
  if (!filteredOrders.value.length) {
    contactCopyText.value = ''
    showAdminMessage(t('admin.noCopyContacts'))
    return
  }
  const text = filteredOrders.value.map((order: any) => [
    copyTextValue(order.order_no, 80),
    copyTextValue(order.customer_name, 120),
    copyTextValue(order.email, 160),
    copyTextValue(order.phone, 80),
    copyTextValue(order.country, 80),
    copyTextValue(order.shipping_address, 260),
    `${copyTextValue(order.product_title, 160)} ${copyTextValue(order.option_name, 120)}`.trim(),
    `${statusText(order.payment_status)} ${money(order.paid_amount_cents || 0, order.currency)} / ${t('admin.remainingAmount')} ${money(remainingAmount(order), order.currency)}`,
  ].join(' / ')).join('\n')
  contactCopyText.value = text
  orderCopyOutputTitle.value = t('admin.copyContactsOutput')
  try {
    await navigator.clipboard?.writeText(text)
    showAdminMessage(t('admin.copiedContacts'))
  } catch {
    showAdminMessage(t('admin.copyContactsFallback'))
  }
}

async function copyFilteredOrderHandoff() {
  if (!filteredOrders.value.length) {
    contactCopyText.value = ''
    orderCopyOutputTitle.value = ''
    showAdminMessage(t('admin.noCopyContacts'))
    return
  }
  const text = filteredOrders.value.map((order: any, index: number) => [
    `#${index + 1} ${copyTextValue(order.order_no, 80)}`,
    `${t('admin.customer')} ${copyTextValue(order.customer_name, 120)} / ${copyTextValue(order.email, 160)} / ${copyTextValue(order.phone, 80)}`,
    `${t('admin.products')} ${copyTextValue(order.product_title, 160)} / ${copyTextValue(order.option_name, 120)}`,
    `${t('admin.petInfo')} ${copyTextValue(order.pet_name, 120)} ${copyTextValue(order.pet_type, 80)}`.trim(),
    `${t('admin.photos')} ${order.photo_urls?.length || 0}`,
    `${t('admin.referencePhotos')} ${referencePhotoSummary(order)}`,
    `${t('admin.paymentRecords')} ${paymentRecordSummary(order)}`,
    `${t('admin.status')} ${statusText(order.order_status)} / ${t('admin.payment')} ${statusText(order.payment_status)} / ${t('admin.remainingAmount')} ${money(remainingAmount(order), order.currency)}`,
    `${t('admin.shippingAddress')} ${copyTextValue(order.country, 80)} ${copyTextValue(order.shipping_address, 260)}`,
    `${t('admin.tracking')} ${copyTextValue(order.shipping_carrier, 120)} ${copyTextValue(order.tracking_no, 120)}`,
    `${t('admin.note')} ${copyTextValue(order.internal_note || order.notes, 500)}`,
  ].join('\n')).join('\n\n')
  contactCopyText.value = text
  orderCopyOutputTitle.value = t('admin.copyHandoffOutput')
  try {
    await navigator.clipboard?.writeText(text)
    showAdminMessage(t('admin.copiedHandoffList'))
  } catch {
    showAdminMessage(t('admin.copyHandoffFallback'))
  }
}

function resetOrderFilters() {
  orderSearch.value = ''
  orderStatusFilter.value = ''
  paymentStatusFilter.value = ''
  orderFlagFilter.value = ''
  orderSort.value = 'latest'
  orderPage.value = 1
  contactCopyText.value = ''
  orderCopyOutputTitle.value = ''
}

function resetUserFilters() {
  userSearch.value = ''
  userStatusFilter.value = ''
  userPage.value = 1
  userCopyText.value = ''
}

function resetProductFilters() {
  productSearch.value = ''
  productCategoryFilter.value = ''
  productStatusFilter.value = ''
  productPage.value = 1
}

async function downloadBackup(includeSecrets = false) {
  const actionKey = includeSecrets ? 'backup-full' : 'backup'
  await runAdminAction(actionKey, async () => {
    const backup = await api<any>(includeSecrets ? '/admin/backup?secrets=1' : '/admin/backup', includeSecrets
      ? { headers: { 'x-confirm-secret-backup': 'true' } }
      : undefined)
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    link.href = url
    link.download = includeSecrets ? `pet-wool-backup-full-${stamp}.json` : `pet-wool-backup-redacted-${stamp}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    showAdminMessage(t('admin.backupDownloaded'))
  })
}

function requestFullBackup() {
  fullBackupConfirmOpen.value = true
}

function closeFullBackupConfirm() {
  if (savingAction.value) return
  fullBackupConfirmOpen.value = false
}

async function confirmFullBackupDownload() {
  fullBackupConfirmOpen.value = false
  await downloadBackup(true)
}

function openSiteRestorePicker() {
  if (siteFormDirty.value) {
    siteRestoreUnsavedConfirmOpen.value = true
    return
  }
  siteRestoreUnsavedConfirmOpen.value = false
  siteRestoreInput.value?.click()
}

function keepEditingSiteConfig() {
  siteRestoreUnsavedConfirmOpen.value = false
}

function discardSiteChangesAndRestore() {
  siteRestoreUnsavedConfirmOpen.value = false
  siteRestoreInput.value?.click()
}

async function restoreSiteConfig(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const looksLikeJson = file.name.toLowerCase().endsWith('.json') || ['application/json', 'text/json', ''].includes(file.type)
  if (!looksLikeJson) {
    showAdminMessage(t('admin.restoreInvalidFileType'))
    return
  }
  if (file.size > maxSiteRestoreBytes) {
    showAdminMessage(t('admin.restoreFileTooLarge'))
    return
  }
  await runAdminAction('site-restore', async () => {
    let payload: any
    try {
      payload = JSON.parse(await file.text())
    } catch {
      showAdminMessage(t('admin.restoreInvalid'))
      return
    }
    const sitePayload = payload?.data?.site || payload?.site
    if (!sitePayload || typeof sitePayload !== 'object' || Array.isArray(sitePayload)) {
      showAdminMessage(t('admin.restoreMissingSite'))
      return
    }
    try {
      const restoredSite = await api<SiteSettings>('/admin/site/restore', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      site.value = restoredSite
      syncSiteForms(restoredSite)
      showAdminMessage(t('admin.restoreDone'))
    } catch (e: any) {
      const text = String(e?.message || '')
      showAdminMessage([
        'KakaoTalk contact required',
        'WhatsApp contact required',
        'valid KakaoTalk URL required',
        'valid WhatsApp URL required',
      ].includes(text) ? adminErrorMessage(e) : t('admin.restoreInvalid'))
    }
  })
}

function nextPage(kind: 'users' | 'products' | 'orders' | 'blog') {
  if (kind === 'users') userPage.value = Math.min(userPageCount.value, userPage.value + 1)
  if (kind === 'products') productPage.value = Math.min(productPageCount.value, productPage.value + 1)
  if (kind === 'orders') orderPage.value = Math.min(orderPageCount.value, orderPage.value + 1)
  if (kind === 'blog') blogPage.value = Math.min(blogPageCount.value, blogPage.value + 1)
}

function prevPage(kind: 'users' | 'products' | 'orders' | 'blog') {
  if (kind === 'users') userPage.value = Math.max(1, userPage.value - 1)
  if (kind === 'products') productPage.value = Math.max(1, productPage.value - 1)
  if (kind === 'orders') orderPage.value = Math.max(1, orderPage.value - 1)
  if (kind === 'blog') blogPage.value = Math.max(1, blogPage.value - 1)
}

function clampPage(current: number, total: number) {
  return Math.min(Math.max(1, current), Math.max(1, total))
}

function addFollowup(user: any) {
  const content = String(user.followup_text || '').trim()
  const next_at = String(user.followup_next_at || '').trim()
  if (!content) {
    showAdminMessage(t('admin.followupRequired'))
    return
  }
  user.followups = Array.isArray(user.followups) ? user.followups : []
  user.followups.unshift({ id: crypto.randomUUID(), content, next_at, created_at: new Date().toISOString() })
  user.followup_text = ''
  user.followup_next_at = ''
}

function resetUserForm() {
  Object.assign(userForm, {
    id: '',
    email: '',
    name: '',
    country: '',
    status: 'active',
    tags_text: '',
    internal_note: '',
    followup_text: '',
    followup_next_at: '',
    followups: [],
  })
}

function stableUserFormState() {
  return JSON.stringify({
    id: userForm.id,
    email: userForm.email,
    name: userForm.name,
    country: userForm.country,
    status: userForm.status,
    tags_text: userForm.tags_text,
    internal_note: userForm.internal_note,
    followups: userForm.followups,
  })
}

function openUserModal(user?: any) {
  resetUserForm()
  userUnsavedConfirmOpen.value = false
  if (user) {
    Object.assign(userForm, {
      id: user.id || '',
      email: user.email || '',
      name: user.name || '',
      country: user.country || '',
      status: user.status || 'active',
      tags_text: user.tags_text ?? (user.tags || []).join(', '),
      internal_note: user.internal_note || '',
      followup_text: '',
      followup_next_at: '',
      followups: Array.isArray(user.followups) ? [...user.followups] : [],
    })
  }
  userFormSnapshot.value = stableUserFormState()
  userModalOpen.value = true
}

function closeUserModal() {
  if (savingAction.value === 'user-form') return
  if (stableUserFormState() !== userFormSnapshot.value) {
    userUnsavedConfirmOpen.value = true
    return
  }
  discardUserFormChanges()
}

function discardUserFormChanges() {
  userUnsavedConfirmOpen.value = false
  userModalOpen.value = false
  resetUserForm()
  userFormSnapshot.value = ''
}

function keepEditingUserForm() {
  userUnsavedConfirmOpen.value = false
}

function deleteUser(user: any) {
  deleteUserTarget.value = user
}

function closeDeleteUserModal() {
  if (savingAction.value) return
  deleteUserTarget.value = null
}

async function confirmDeleteUser() {
  if (!deleteUserTarget.value?.id) return
  const user = deleteUserTarget.value
  await runAdminAction(`user-delete-${user.id}`, async () => {
    await api(`/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: { 'x-confirm-delete': 'true' },
    })
    deleteUserTarget.value = null
    await refreshAdminTables('overview', 'users', 'audit')
    showAdminMessage(t('admin.deleted'))
  })
}

async function saveUserForm() {
  if (savingAction.value) return
  const email = userForm.email.trim()
  const name = userForm.name.trim()
  const country = userForm.country.trim()
  const tags = String(userForm.tags_text || '').split(',').map((item) => item.trim()).filter(Boolean)
  const followups = Array.isArray(userForm.followups) ? userForm.followups : []
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAdminMessage(t('admin.userEmailInvalid'))
    return
  }
  if (!name) {
    showAdminMessage(t('admin.userNameRequired'))
    return
  }
  if (name.length > 120) {
    showAdminMessage(t('admin.userNameTooLong'))
    return
  }
  if (country.length > 120) {
    showAdminMessage(t('admin.userCountryTooLong'))
    return
  }
  if (!userStatuses.includes(userForm.status)) {
    showAdminMessage(t('admin.userStatusInvalid'))
    return
  }
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) {
    showAdminMessage(t('admin.userTagsInvalid'))
    return
  }
  if (String(userForm.internal_note || '').length > 2000) {
    showAdminMessage(t('admin.userNoteInvalid'))
    return
  }
  if (followups.length > 50 || followups.some((item) => !String(item.content || '').trim() || String(item.content || '').length > 500)) {
    showAdminMessage(t('admin.userFollowupInvalid'))
    return
  }
  if (followups.some((item) => item.next_at && !/^\d{4}-\d{2}-\d{2}$/.test(String(item.next_at)))) {
    showAdminMessage(t('admin.userFollowupDateInvalid'))
    return
  }
  await runAdminAction('user-form', async () => {
    await api(`/admin/users/${userForm.id || crypto.randomUUID()}`, {
      method: 'PUT',
      body: JSON.stringify({
        email,
        name,
        country,
        status: userForm.status,
        tags,
        internal_note: userForm.internal_note || '',
        followups,
      })
    })
    userModalOpen.value = false
    userUnsavedConfirmOpen.value = false
    userFormSnapshot.value = ''
    resetUserForm()
    await refreshAdminTables('overview', 'users', 'audit')
    showAdminMessage(t('admin.saved'))
  })
}

function readTranslation(item: any, lang: 'zh' | 'en' | 'ko', field: string) {
  return item?.translations?.[lang]?.[field] ?? (lang === 'zh' ? item?.[field] : '') ?? ''
}

function mergeTranslationFields(existing: any, lang: AdminLang, values: Record<string, string>) {
  return {
    ...(existing?.translations?.[lang] || {}),
    ...Object.fromEntries(Object.entries(values).map(([field, value]) => [field, String(value || '').trim()])),
  }
}

function optionRows(product: any, lang: 'zh' | 'en' | 'ko') {
  return (product?.options || []).map((option: any) => {
    const name = readTranslation(option, lang, 'name') || (lang === 'zh' ? option.name || '' : '')
    return name ? `${name},${option.price_cents || 0}` : ''
  }).join('\n')
}

function parseOptions(text: string, existing: any[] = []) {
  return String(text || '').split('\n').map((row, index) => {
    const [name, price] = row.replace('，', ',').split(',')
    const trimmed = name?.trim()
    return {
      id: existing[index]?.id || crypto.randomUUID(),
      name: trimmed,
      price_cents: Number(String(price ?? existing[index]?.price_cents ?? 0).trim()),
      translations: existing[index]?.translations || {},
    }
  }).filter(option => option.name)
}

function optionNameRows(text: string) {
  return String(text || '').split(/\r?\n/).map((row) => row.replace('，', ',').split(',')[0]?.trim() || '')
}

function validSlug(value: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || '').trim())
}

function validIsoDate(value: string) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const parsed = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

function validHttpUrl(value: string) {
  try {
    const url = new URL(String(value || '').trim())
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

function looksLikeHttpUrl(value: string) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function validUploadUrl(value: string) {
  return /^\/uploads\/\d{13}-[0-9a-f-]{36}\.[a-z0-9]+$/i.test(String(value || '').trim())
}

function validProductImageReference(value: string) {
  const text = String(value || '').trim()
  if (!text) return true
  return validHttpUrl(text) || validUploadUrl(text) || (text.startsWith('/assets/') && !text.includes('..') && !text.includes('\\'))
}

function validSiteImageReference(value: string) {
  const text = String(value || '').trim()
  if (!text) return false
  return validHttpUrl(text) || validUploadUrl(text) || (text.startsWith('/assets/') && !text.includes('..') && !text.includes('\\'))
}

// v-for indices arrive as `string | number` in templates, so accept both here;
// the value is only interpolated into a cache key.
function photoKey(order: any, url: string, index: string | number) {
  return `${order.id || order.order_no || 'order'}:${index}:${url}`
}

function markPhotoMissing(order: any, url: string, index: string | number) {
  brokenPhotoKeys.value = new Set([...brokenPhotoKeys.value, photoKey(order, url, index)])
}

function resetSitePolicyForm() {
  for (const lang of adminLangs) {
    policyI18n[lang].care = readTranslation(site.value.policies || {}, lang, 'care')
    policyI18n[lang].shipping = readTranslation(site.value.policies || {}, lang, 'shipping')
    policyI18n[lang].refund = readTranslation(site.value.policies || {}, lang, 'refund')
  }
  siteForm.care = policyI18n.zh.care
  siteForm.shipping = policyI18n.zh.shipping
  siteForm.refund = policyI18n.zh.refund
  for (const lang of adminLangs) {
    faqI18n[lang] = (site.value.faq || []).map((faq: any) => `${readTranslation(faq, lang, 'question') || (lang === 'zh' ? faq.question : '') || ''}|${readTranslation(faq, lang, 'answer') || (lang === 'zh' ? faq.answer : '') || ''}`).join('\n')
  }
  siteForm.faq_text = faqI18n.zh
  siteForm.reviews_text = (site.value.reviews || []).map((review: any) => {
    const title = readTranslation(review, 'zh', 'title') || review.title || ''
    const content = readTranslation(review, 'zh', 'content') || review.content || ''
    return `${review.name || ''}|${review.country || ''}|${review.rating || 5}|${title}|${content}|${review.product_slug || ''}|${review.avatar_url || ''}|${review.pet_image || ''}|${review.work_image || ''}|${review.video_url || ''}`
  }).join('\n')
  siteForm.blog_text = (site.value.blog || []).map((post: any) => {
    const title = readTranslation(post, 'zh', 'title') || post.title || ''
    const excerpt = readTranslation(post, 'zh', 'excerpt') || post.excerpt || ''
    const content = readTranslation(post, 'zh', 'content') || post.content || ''
    return `${post.slug || ''}|${post.date || ''}|${title}|${excerpt}|${content}|${post.image_url || ''}|${(post.tags || []).join(',')}`
  }).join('\n')
}

function stableSiteFormState() {
  return JSON.stringify({
    site: siteForm,
    policies: policyI18n,
    faq: faqI18n,
    payment: paymentForm,
    contact: contactForm,
  })
}

function markSiteFormClean() {
  siteFormSnapshot.value = stableSiteFormState()
}

function syncSiteForms(siteData: SiteSettings) {
  Object.assign(siteForm, {
    brand_name: siteData.brand?.name || '',
    email: siteData.brand?.email || '',
    instagram: siteData.brand?.instagram || '',
    tracking_url_template: siteData.shipping?.tracking_url_template || '',
    care: '',
    shipping: '',
    refund: '',
    faq_text: '',
    reviews_text: '',
    blog_text: ''
  })
  Object.assign(paymentForm, {
    paypal_enabled: siteData.paypal?.enabled ?? true,
    paypal_mode: siteData.paypal?.mode || 'sandbox',
    paypal_client_id: siteData.paypal?.client_id || '',
    paypal_secret: siteData.paypal?.secret || '',
    paypal_webhook_id: siteData.paypal?.webhook_id || '',
    currency: siteData.paypal?.currency || 'USD'
  })
  resetSitePolicyForm()
  Object.assign(contactForm, {
    kakao_enabled: siteData.contact?.kakao_enabled ?? true,
    kakao_label: siteData.contact?.kakao_label || 'KakaoTalk',
    kakao_id: siteData.contact?.kakao_id || '',
    kakao_url: siteData.contact?.kakao_url || '',
    whatsapp_enabled: siteData.contact?.whatsapp_enabled ?? true,
    whatsapp_label: siteData.contact?.whatsapp_label || 'WhatsApp',
    whatsapp_id: siteData.contact?.whatsapp_id || '',
    whatsapp_url: siteData.contact?.whatsapp_url || ''
  })
  markSiteFormClean()
}

function assertAuth() {
  if (!safeGetLocalStorage('admin_token')) {
    router.replace('/admin')
    return false
  }
  return true
}

function normalizeUsers(data: any[]) {
  return data.map(user => ({ ...user, tags_text: (user.tags || []).join(', ') }))
}

async function refreshOverview() {
  overview.value = await api<AdminOverview>('/admin/overview')
}

async function refreshAuditLogs() {
  auditLogs.value = await api<any[]>('/admin/audit-logs')
}

async function refreshUsers() {
  users.value = normalizeUsers(await api<any[]>('/admin/users'))
}

async function refreshCategories() {
  const categoryData = await api<Category[]>('/admin/categories')
  categories.value = categoryData
  if (!productForm.category_id && categoryData[0]) productForm.category_id = categoryData[0].id
}

async function refreshProducts() {
  products.value = await api<Product[]>('/admin/products')
}

async function refreshOrders() {
  const orderData = await api<Order[]>('/admin/orders')
  orders.value = orderData.map(order => preserveOrderNote(order, orderNoteDrafts))
  if (selectedOrder.value) {
    selectedOrder.value = orders.value.find(order => order.id === selectedOrder.value?.id) || selectedOrder.value
  }
}

async function refreshAdminTables(...parts: Array<'overview' | 'users' | 'categories' | 'products' | 'orders' | 'audit'>) {
  await Promise.all(parts.map((part) => {
    if (part === 'overview') return refreshOverview()
    if (part === 'users') return refreshUsers()
    if (part === 'categories') return refreshCategories()
    if (part === 'products') return refreshProducts()
    if (part === 'orders') return refreshOrders()
    return refreshAuditLogs()
  }))
}

function resourceLabel(part: AdminResource) {
  const labels = { overview: 'overview', users: 'usersManage', categories: 'categories', products: 'productsManage', orders: 'ordersManage', site: 'siteConfig', audit: 'auditLogs' }
  return t(`admin.${labels[part]}`)
}

async function refreshSite() {
  const siteData = await api<SiteSettings>('/admin/site')
  const shouldSync = !siteFormSnapshot.value || !siteFormDirty.value
  site.value = siteData
  if (shouldSync) syncSiteForms(siteData)
}

function loadResource(part: AdminResource, force = false): Promise<void> {
  const pending = resourceRequests.get(part)
  if (pending) return pending
  if (!force && loadedResources.has(part) && !resourceErrors[part]) return Promise.resolve()
  loadingResources.add(part)
  delete resourceErrors[part]
  const loaders = { overview: refreshOverview, users: refreshUsers, categories: refreshCategories, products: refreshProducts, orders: refreshOrders, site: refreshSite, audit: refreshAuditLogs }
  const request = Promise.resolve().then(loaders[part]).then(() => {
    loadedResources.add(part)
  }).catch((e: any) => {
    resourceErrors[part] = adminErrorMessage(e)
    if (String(e.message || '') === 'missing token' || !safeGetLocalStorage('admin_token')) {
      safeRemoveLocalStorage('admin_token')
      void router.replace('/admin')
    }
  }).finally(() => {
    loadingResources.delete(part)
    resourceRequests.delete(part)
  })
  resourceRequests.set(part, request)
  return request
}

async function loadTab(target: AdminTab = tab.value, force = false) {
  if (!assertAuth()) return false
  const parts = adminDependencies[target]
  await Promise.all(parts.map(part => loadResource(part, force)))
  return parts.every(part => loadedResources.has(part) && !resourceErrors[part])
}

async function refreshAll() {
  await runAdminAction('refresh', async () => {
    if (await loadTab(tab.value, true)) showAdminMessage(t('admin.refreshed'))
  })
}

async function logout() {
  try {
    await api('/admin/logout', { method: 'POST' })
  } catch {
    // Local logout must still complete if the session has already expired.
  }
  safeRemoveLocalStorage('admin_token')
  router.replace('/admin')
}

function resetCategoryForm() {
  Object.assign(categoryForm, { id: '', slug: '', title: '', description: '', sort_order: 0, status: 'published' })
  Object.assign(categoryI18n.zh, { title: '', description: '' })
}

function stableCategoryFormState() {
  return JSON.stringify({
    form: categoryForm,
    zh: categoryI18n.zh,
  })
}

function openCategoryModal(category?: Category) {
  resetCategoryForm()
  categoryUnsavedConfirmOpen.value = false
  if (category) editCategory(category)
  categoryFormSnapshot.value = stableCategoryFormState()
  categoryModalOpen.value = true
}

function closeCategoryModal() {
  if (savingAction.value === 'category') return
  if (stableCategoryFormState() !== categoryFormSnapshot.value) {
    categoryUnsavedConfirmOpen.value = true
    return
  }
  discardCategoryFormChanges()
}

function discardCategoryFormChanges() {
  categoryUnsavedConfirmOpen.value = false
  categoryModalOpen.value = false
  resetCategoryForm()
  categoryFormSnapshot.value = ''
}

function keepEditingCategoryForm() {
  categoryUnsavedConfirmOpen.value = false
}

function editCategory(category: Category) {
  Object.assign(categoryForm, {
    ...category,
    title: readTranslation(category, 'zh', 'title'),
    description: readTranslation(category, 'zh', 'description'),
  })
  categoryI18n.zh.title = readTranslation(category, 'zh', 'title')
  categoryI18n.zh.description = readTranslation(category, 'zh', 'description')
}

async function saveCategory() {
  if (savingAction.value) return
  if (!validSlug(categoryForm.slug)) {
    showAdminMessage(t('admin.slugInvalid'))
    return
  }
  if (!categoryI18n.zh.title.trim()) {
    showAdminMessage(t('admin.categoryTitleRequired'))
    return
  }
  if (categoryForm.status === 'hidden' && categoryHasPublishedProducts.value) {
    showAdminMessage(t('admin.categoryHasPublishedProducts'))
    return
  }
  const existing = categories.value.find(category => category.id === categoryForm.id)
  const translations = {
    ...(existing?.translations || {}),
    zh: { ...(existing?.translations?.zh || {}), ...categoryI18n.zh },
  }
  const body = JSON.stringify({
    ...categoryForm,
    title: categoryI18n.zh.title,
    description: categoryI18n.zh.description,
    translations,
  })
  await runAdminAction('category', async () => {
    if (categoryForm.id) await api(`/admin/categories/${categoryForm.id}`, { method: 'PUT', body })
    else await api('/admin/categories', { method: 'POST', body })
    discardCategoryFormChanges()
    await refreshAdminTables('overview', 'categories', 'products', 'audit')
    showAdminMessage(t('admin.saved'))
  })
}

async function deleteCategory(category: Category) {
  deleteCategoryTarget.value = category
}

function closeDeleteCategoryModal() {
  if (savingAction.value.startsWith('category-delete-')) return
  deleteCategoryTarget.value = null
}

async function confirmDeleteCategory() {
  const category = deleteCategoryTarget.value
  if (!category) return
  await runAdminAction(`category-delete-${category.id}`, async () => {
    await api(`/admin/categories/${category.id}`, {
      method: 'DELETE',
      headers: { 'x-confirm-delete': 'true' }
    })
    deleteCategoryTarget.value = null
    await refreshAdminTables('overview', 'categories', 'products', 'audit')
    showAdminMessage(t('admin.deleted'))
  })
}

function resetProductForm() {
  Object.assign(productForm, { id: '', category_id: categories.value[0]?.id || '', slug: '', title: '', subtitle: '', description: '', base_price_cents: 0, currency: CURRENCY_BASE, deposit_percent: 50, image_url: '', images_text: '', alt_text: '', seo_title: '', seo_description: '', use_cases_text: '', tags: '', options_text: t('admin.defaultOptionsText'), status: 'published' })
  for (const lang of adminLangs) {
    Object.assign(productI18n[lang], { title: '', subtitle: '', description: '', alt_text: '', seo_title: '', seo_description: '', options_text: '' })
  }
  productI18n.zh.options_text = t('admin.defaultOptionsText')
}

function stableProductFormState() {
  return JSON.stringify({
    form: productForm,
    translations: productI18n,
  })
}

function openProductModal(product?: Product) {
  resetProductForm()
  productUnsavedConfirmOpen.value = false
  if (product) editProduct(product)
  productFormSnapshot.value = stableProductFormState()
  productModalOpen.value = true
}

function closeProductModal() {
  if (savingAction.value === 'product') return
  discardProductFormChanges()
}

function discardProductFormChanges() {
  productUnsavedConfirmOpen.value = false
  productModalOpen.value = false
  resetProductForm()
  productFormSnapshot.value = ''
}

function keepEditingProductForm() {
  productUnsavedConfirmOpen.value = false
}

function editProduct(product: Product) {
  Object.assign(productForm, {
    ...product,
    title: readTranslation(product, 'zh', 'title'),
    subtitle: readTranslation(product, 'zh', 'subtitle'),
    description: readTranslation(product, 'zh', 'description'),
    alt_text: readTranslation(product, 'zh', 'alt_text'),
    seo_title: readTranslation(product, 'zh', 'seo_title'),
    seo_description: readTranslation(product, 'zh', 'seo_description'),
    images_text: (product.images || []).join('\n'),
    use_cases_text: product.use_cases?.join(', ') || '',
    tags: product.tags?.join(', ') || '',
    options_text: optionRows(product, 'zh') || ''
  })
  for (const lang of adminLangs) {
    productI18n[lang].title = readTranslation(product, lang, 'title')
    productI18n[lang].subtitle = readTranslation(product, lang, 'subtitle')
    productI18n[lang].description = readTranslation(product, lang, 'description')
    productI18n[lang].alt_text = readTranslation(product, lang, 'alt_text')
    productI18n[lang].seo_title = readTranslation(product, lang, 'seo_title')
    productI18n[lang].seo_description = readTranslation(product, lang, 'seo_description')
    productI18n[lang].options_text = optionRows(product, lang)
  }
}

async function saveProduct() {
  if (savingAction.value) return
  if (productForm.currency !== CURRENCY_BASE) {
    showAdminMessage(t('admin.krwCurrencyRequired'))
    return
  }
  if (!validSlug(productForm.slug)) {
    showAdminMessage(t('admin.slugInvalid'))
    return
  }
  if (!productForm.category_id) {
    showAdminMessage(t('admin.productCategoryRequired'))
    return
  }
  if (productForm.status === 'published' && productCategoryHidden.value) {
    showAdminMessage(t('admin.productPublishedHiddenCategoryInvalid'))
    return
  }
  if (!productI18n.zh.title.trim()) {
    showAdminMessage(t('admin.productTitleRequired'))
    return
  }
  if (!Number.isSafeInteger(Number(productForm.base_price_cents)) || Number(productForm.base_price_cents) <= 0) {
    showAdminMessage(t('admin.priceRequired'))
    return
  }
  if (!Number.isSafeInteger(Number(productForm.deposit_percent)) || Number(productForm.deposit_percent) < 1 || Number(productForm.deposit_percent) > 100) {
    showAdminMessage(t('admin.depositInvalid'))
    return
  }
  if (String(productForm.image_url || '').trim() && !validProductImageReference(productForm.image_url)) {
    showAdminMessage(t('admin.imageUrlInvalid'))
    return
  }
  const galleryImages = String(productForm.images_text || '').split('\n').map(image => image.trim()).filter(Boolean)
  if (galleryImages.some(image => !validProductImageReference(image))) {
    showAdminMessage(t('admin.imageUrlInvalid'))
    return
  }
  const existing = products.value.find(product => product.id === productForm.id)
  const zhOptions = parseOptions(productI18n.zh.options_text || productForm.options_text, existing?.options || [])
  if (!zhOptions.length || zhOptions.some(option => !option.name || !Number.isSafeInteger(Number(option.price_cents)) || Number(option.price_cents) <= 0)) {
    showAdminMessage(t('admin.optionsInvalid'))
    return
  }
  const optionNames = zhOptions.map(option => option.name.trim().toLowerCase())
  if (new Set(optionNames).size !== optionNames.length) {
    showAdminMessage(t('admin.optionsInvalid'))
    return
  }
  const optionNamesByLang = Object.fromEntries(adminLangs.map((lang) => [lang, optionNameRows(productI18n[lang].options_text)])) as Record<AdminLang, string[]>
  const options = zhOptions.map((option, index) => ({
    ...option,
    name: option.name,
    translations: adminLangs.reduce((translations, lang) => {
      const translatedName = optionNamesByLang[lang][index]
      if (!translatedName) return translations
      translations[lang] = { ...(translations[lang] || {}), name: translatedName }
      return translations
    }, { ...(existing?.options?.[index]?.translations || {}) } as Record<AdminLang, Record<string, string>>),
  }))
  const primaryImage = String(productForm.image_url || '').trim()
  const images = [...new Set(primaryImage
    ? [primaryImage, ...galleryImages.filter((image) => image !== primaryImage)]
    : galleryImages)]
  if (productForm.status === 'published' && !images.length) {
    showAdminMessage(t('admin.productPublishedImageRequired'))
    return
  }
  if (productForm.status === 'published' && !productI18n.zh.seo_title.trim()) {
    showAdminMessage(t('admin.productPublishedSeoTitleRequired'))
    return
  }
  if (productForm.status === 'published' && !productI18n.zh.seo_description.trim()) {
    showAdminMessage(t('admin.productPublishedSeoDescriptionRequired'))
    return
  }
  const productTranslations = { ...(existing?.translations || {}) } as Record<AdminLang, Record<string, string>>
  for (const lang of adminLangs) {
    const values = {
      title: productI18n[lang].title,
      subtitle: productI18n[lang].subtitle,
      description: productI18n[lang].description,
      alt_text: productI18n[lang].alt_text,
      seo_title: productI18n[lang].seo_title,
      seo_description: productI18n[lang].seo_description,
    }
    const enteredValues = Object.fromEntries(
      Object.entries(values)
        .map(([field, value]) => [field, String(value || '').trim()])
        .filter(([, value]) => Boolean(value))
    ) as Record<string, string>
    if (lang === 'zh' || Object.keys(enteredValues).length) {
      productTranslations[lang] = {
        ...(existing?.translations?.[lang] || {}),
        ...enteredValues,
      }
    }
  }
  const payload = {
    ...productForm,
    currency: CURRENCY_BASE,
    title: productI18n.zh.title,
    subtitle: productI18n.zh.subtitle,
    description: productI18n.zh.description,
    alt_text: productI18n.zh.alt_text,
    seo_title: productI18n.zh.seo_title,
    seo_description: productI18n.zh.seo_description,
    base_price_cents: Number(productForm.base_price_cents),
    deposit_percent: Number(productForm.deposit_percent),
    images,
    tags: productForm.tags.split(',').map(v => v.trim()).filter(Boolean),
    use_cases: productForm.use_cases_text.split(',').map(v => v.trim()).filter(Boolean),
    options,
    translations: {
      ...productTranslations,
    },
  }
  const body = JSON.stringify(payload)
  await runAdminAction('product', async () => {
    if (productForm.id) await api(`/admin/products/${productForm.id}`, { method: 'PUT', body })
    else await api('/admin/products', { method: 'POST', body })
    discardProductFormChanges()
    await refreshAdminTables('overview', 'products', 'audit')
    showAdminMessage(t('admin.saved'))
  })
}

async function deleteProduct(product: Product) {
  deleteProductTarget.value = product
}

function closeDeleteProductModal() {
  if (savingAction.value.startsWith('product-delete-')) return
  deleteProductTarget.value = null
}

async function confirmDeleteProduct() {
  const product = deleteProductTarget.value
  if (!product) return
  await runAdminAction(`product-delete-${product.id}`, async () => {
    await api(`/admin/products/${product.id}`, {
      method: 'DELETE',
      headers: { 'x-confirm-delete': 'true' }
    })
    deleteProductTarget.value = null
    await refreshAdminTables('overview', 'products', 'audit')
    showAdminMessage(t('admin.deleted'))
  })
}

async function updateOrder(order: any, field: 'status' | 'payment' | 'note') {
  const submitted = field === 'status'
    ? { order_status: order.order_status, revision: order.revision || 0, updated_at: order.updated_at || '' }
    : field === 'payment'
      ? { payment_status: order.payment_status, revision: order.revision || 0, updated_at: order.updated_at || '' }
      : { internal_note: order.internal_note, shipping_carrier: order.shipping_carrier || '', tracking_no: order.tracking_no || '', revision: order.revision || 0, updated_at: order.updated_at || '' }
  const body = field === 'status'
    ? JSON.stringify(submitted)
    : field === 'payment'
      ? JSON.stringify(submitted)
      : JSON.stringify(submitted)
  const key = `order-${order.id}-${field}`
  if (savingAction.value) return
  savingAction.value = key
  try {
    const updatedOrder = await api<Order>(`/admin/orders/${order.id}/${field}`, { method: 'PUT', body })
    if (field === 'note' && orderNoteDrafts.get(updatedOrder.id) === submitted.internal_note) clearOrderNoteDirty(updatedOrder.id)
    const latestOrder = preserveOrderNote(updatedOrder, orderNoteDrafts)
    const index = orders.value.findIndex((item: any) => item.id === latestOrder.id)
    if (index >= 0) orders.value[index] = latestOrder
    if (selectedOrder.value?.id === latestOrder.id) selectedOrder.value = latestOrder
    await refreshOverview()
    showAdminMessage(t('admin.saved'))
  } catch (e: any) {
    await refreshOrders().catch(() => {})
    showAdminMessage(adminErrorMessage(e))
  } finally {
    savingAction.value = ''
  }
}

function isRiskyOrderChange(field: 'status' | 'payment', next: string) {
  if (field === 'status') return ['cancelled', 'completed', 'shipped'].includes(next)
  return ['paid', 'refunded', 'unpaid'].includes(next)
}

function onOrderSelectChange(order: any, field: 'status' | 'payment', event: Event) {
  const select = event.target as HTMLSelectElement
  const previous = field === 'status' ? String(order.order_status || '') : String(order.payment_status || '')
  const next = select.value
  if (next === previous) return
  if (isRiskyOrderChange(field, next)) {
    orderChangeConfirm.value = { order, field, previous, next }
    select.value = previous
    return
  }
  if (field === 'status') order.order_status = next
  else order.payment_status = next
  updateOrder(order, field)
}

function closeOrderChangeConfirm() {
  if (savingAction.value.startsWith('order-')) return
  orderChangeConfirm.value = null
}

async function confirmOrderChange() {
  const change = orderChangeConfirm.value
  if (!change) return
  if (change.field === 'status') change.order.order_status = change.next
  else change.order.payment_status = change.next
  orderChangeConfirm.value = null
  await updateOrder(change.order, change.field)
}

async function toggleOrderFlag(order: any) {
  const next = !order.flagged
  order.flagged = next
  const key = `order-${order.id}-flag`
  if (savingAction.value) return
  savingAction.value = key
  try {
    const updatedOrder = await api<Order>(`/admin/orders/${order.id}/flag`, { method: 'PUT', body: JSON.stringify({ flagged: next, revision: order.revision || 0, updated_at: order.updated_at || '' }) })
    const mergedOrder = preserveOrderNote(updatedOrder, orderNoteDrafts)
    const index = orders.value.findIndex((item: any) => item.id === updatedOrder.id)
    if (index >= 0) orders.value[index] = mergedOrder
    if (selectedOrder.value?.id === updatedOrder.id) selectedOrder.value = mergedOrder
    await refreshOverview()
    showAdminMessage(next ? t('admin.flagged') : t('admin.unflagged'))
  } catch (e: any) {
    order.flagged = !next
    await refreshOrders().catch(() => {})
    showAdminMessage(adminErrorMessage(e))
  } finally {
    savingAction.value = ''
  }
}

async function updateUser(user: any) {
  await runAdminAction(`user-${user.id}`, async () => {
    await api(`/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        email: user.email,
        name: user.name,
        status: user.status,
        tags: String(user.tags_text || '').split(',').map((item) => item.trim()).filter(Boolean),
        internal_note: user.internal_note || '',
        followups: Array.isArray(user.followups) ? user.followups : [],
      })
    })
    await refreshAdminTables('overview', 'users', 'audit')
    showAdminMessage(t('admin.saved'))
  })
}

async function saveSite() {
  if (savingAction.value) return
  siteForm.brand_name = siteForm.brand_name.trim()
  paymentForm.currency = paymentForm.currency.trim().toUpperCase()
  siteForm.email = siteForm.email.trim()
  siteForm.instagram = siteForm.instagram.trim()
  siteForm.tracking_url_template = siteForm.tracking_url_template.trim()
  if (!siteForm.brand_name) {
    showAdminMessage(t('admin.brandNameRequired'))
    return
  }
  if (siteForm.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(siteForm.email)) {
    showAdminMessage(t('admin.contactEmailInvalid'))
    return
  }
  if (siteForm.instagram && !validHttpUrl(siteForm.instagram)) {
    showAdminMessage(t('admin.instagramInvalid'))
    return
  }
  if (siteForm.tracking_url_template && !validHttpUrl(siteForm.tracking_url_template)) {
    showAdminMessage(t('admin.trackingUrlInvalid'))
    return
  }
  if (siteForm.tracking_url_template && !siteForm.tracking_url_template.includes('{tracking}')) {
    showAdminMessage(t('admin.trackingUrlPlaceholderRequired'))
    return
  }
  if (!['sandbox', 'live'].includes(paymentForm.paypal_mode)) {
    showAdminMessage(t('admin.paypalModeInvalid'))
    return
  }
  if (!paypalSupportedCurrencies.has(paymentForm.currency)) {
    showAdminMessage(t('admin.paypalCurrencyInvalid'))
    return
  }
  const existingPaypalSecret = String(site.value.paypal?.secret || '').trim()
  const savedPaypalSecretConfigured = Boolean(site.value.paypal?.secret_configured)
  const paypalSecretInput = paymentForm.paypal_secret.trim()
  const paypalWebhookInput = paymentForm.paypal_webhook_id.trim()
  const paypalSecretForValidation = paypalSecretInput || existingPaypalSecret || (savedPaypalSecretConfigured ? '__configured__' : '')
  if (paymentForm.paypal_mode === 'live' && (!paymentForm.paypal_client_id.trim() || !paypalSecretForValidation)) {
    showAdminMessage(t('admin.paypalLiveCredentialsRequired'))
    return
  }
  if (looksLikeHttpUrl(paypalWebhookInput)) {
    showAdminMessage(t('admin.paypalWebhookIdInvalid'))
    return
  }
  if (contactForm.kakao_enabled && !contactForm.kakao_id.trim() && !contactForm.kakao_url.trim()) {
    showAdminMessage(t('admin.kakaoContactRequired'))
    return
  }
  if (contactForm.whatsapp_enabled && !contactForm.whatsapp_id.trim() && !contactForm.whatsapp_url.trim()) {
    showAdminMessage(t('admin.whatsappContactRequired'))
    return
  }
  if (contactForm.kakao_url && !validHttpUrl(contactForm.kakao_url)) {
    showAdminMessage(t('admin.kakaoUrlInvalid'))
    return
  }
  if (contactForm.whatsapp_url && !validHttpUrl(contactForm.whatsapp_url)) {
    showAdminMessage(t('admin.whatsappUrlInvalid'))
    return
  }
  const policyTranslations = { ...(site.value.policies?.translations || {}) } as Record<AdminLang, Record<string, string>>
  for (const lang of adminLangs) {
    policyTranslations[lang] = mergeTranslationFields(site.value.policies || {}, lang, policyI18n[lang])
  }
  const faqRowsByLang = Object.fromEntries(adminLangs.map((lang) => [lang, String(faqI18n[lang] || '').split(/\r?\n/)])) as Record<AdminLang, string[]>
  const invalidFaqEntry = adminLangs.flatMap((lang) => faqRowsByLang[lang].map((row, index) => ({ lang, row, index }))).find(({ row }) => {
    if (!row.trim()) return false
    const [question = '', ...answerParts] = row.split('|')
    return !question.trim() || !answerParts.join('|').trim()
  })
  if (invalidFaqEntry) {
    showAdminMessage(t('admin.faqRowInvalid', { row: invalidFaqEntry.index + 1 }))
    return
  }
  const faqRows = faqRowsByLang.zh
  const faq = faqRows.map((row, index) => {
    const [question = '', ...answerParts] = row.split('|')
    const answer = answerParts.join('|')
    const trimmedQuestion = question.trim()
    const trimmedAnswer = answer.trim()
    const existing = site.value.faq?.[index] || {}
    const translations = { ...(existing.translations || {}) } as Record<AdminLang, Record<string, string>>
    for (const lang of adminLangs) {
      const translatedRow = faqRowsByLang[lang][index] || ''
      if (!translatedRow.trim()) continue
      const [translatedQuestion = '', ...translatedAnswerParts] = translatedRow.split('|')
      translations[lang] = mergeTranslationFields(
        { translations },
        lang,
        { question: translatedQuestion, answer: translatedAnswerParts.join('|') },
      )
    }
    return {
      id: existing.id || crypto.randomUUID(),
      question: trimmedQuestion,
      answer: trimmedAnswer,
      translations,
    }
  }).filter((faq) => faq.question && faq.answer)
  if (!faq.length) {
    showAdminMessage(t('admin.faqRequired'))
    return
  }
  if (new Set(faq.map((item) => item.question.trim().toLowerCase())).size !== faq.length) {
    showAdminMessage(t('admin.faqDuplicate'))
    return
  }
  const reviewRows = String(siteForm.reviews_text || '').split('\n')
  const invalidReviewIndex = reviewRows.findIndex((row) => {
    if (!row.trim()) return false
    const { name, country, ratingText, title, content, avatarUrl, petImage, workImage, videoUrl } = parseReviewRow(row)
    const rating = Number.parseInt(ratingText.trim(), 10)
    return !name.trim() || !country.trim() || !title.trim() || !content.trim() || !Number.isInteger(rating) || rating < 1 || rating > 5
      || [avatarUrl, petImage, workImage].some(value => value.trim() && !validSiteImageReference(value.trim()))
      || Boolean(videoUrl.trim() && !validHttpUrl(videoUrl.trim()))
  })
  if (invalidReviewIndex >= 0) {
    showAdminMessage(t('admin.reviewRowInvalid', { row: invalidReviewIndex + 1 }))
    return
  }
  const reviews = reviewRows.map((row, index) => {
    const { name, country, ratingText, title, content, productSlug, avatarUrl, petImage, workImage, videoUrl } = parseReviewRow(row)
    const trimmedName = name.trim()
    const trimmedCountry = country.trim()
    const trimmedTitle = title.trim()
    const trimmedContent = content.trim()
    const rating = Math.min(5, Math.max(1, Number.parseInt(ratingText.trim(), 10) || 5))
    const existing = site.value.reviews?.[index] || {}
    const existingImages = reviewMediaUrls(existing)
    return {
      ...(existing.source === 'customer' ? {
        source: existing.source,
        verified: Boolean(existing.verified),
        order_id: existing.order_id || '',
        user_email: existing.user_email || '',
        created_at: existing.created_at || '',
      } : {}),
      id: existing.id || crypto.randomUUID(),
      name: trimmedName,
      country: trimmedCountry,
      rating,
      status: existing.status || 'published',
      title: trimmedTitle,
      content: trimmedContent,
      product_slug: productSlug.trim() || existing.product_slug || '',
      avatar_url: avatarUrl.trim() || existing.avatar_url || '',
      images: existingImages.length
        ? existingImages
        : [petImage.trim(), workImage.trim()].filter(Boolean),
      pet_image: existingImages[0] || petImage.trim(),
      work_image: existingImages[1] || workImage.trim(),
      video_url: videoUrl.trim(),
      translations: {
        ...(existing.translations || {}),
        zh: { ...(existing.translations?.zh || {}), title: trimmedTitle, content: trimmedContent },
      }
    }
  }).filter((review) => review.name && review.country && review.title && review.content)
  if (!reviews.length) {
    showAdminMessage(t('admin.reviewsRequired'))
    return
  }
  const reviewKeys = reviews.map((item) => `${item.name.trim().toLowerCase()}|${item.title.trim().toLowerCase()}`)
  if (new Set(reviewKeys).size !== reviews.length) {
    showAdminMessage(t('admin.reviewsDuplicate'))
    return
  }
  const blogRows = String(siteForm.blog_text || '').split('\n')
  const invalidBlogIndex = blogRows.findIndex((row) => {
    if (!row.trim()) return false
    const { slug, date, title, excerpt, content } = parseBlogRow(row)
    const trimmedSlug = slug.trim()
    const trimmedDate = date.trim()
    const parsedDate = new Date(`${trimmedDate}T00:00:00Z`)
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmedDate) && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === trimmedDate
    return !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmedSlug) || !validDate || !title.trim() || !excerpt.trim() || !content.trim()
  })
  if (invalidBlogIndex >= 0) {
    showAdminMessage(t('admin.blogRowInvalid', { row: invalidBlogIndex + 1 }))
    return
  }
  const blogSlugs = blogRows
    .map((row) => row.trim() ? parseBlogRow(row).slug.trim().toLowerCase() : '')
    .filter(Boolean)
  if (new Set(blogSlugs).size !== blogSlugs.length) {
    showAdminMessage(t('admin.blogDuplicate'))
    return
  }
  const invalidBlogImageIndex = blogRows.findIndex((row) => {
    if (!row.trim()) return false
    const { imageUrl } = parseBlogRow(row)
    return !validSiteImageReference(imageUrl)
  })
  if (invalidBlogImageIndex >= 0) {
    showAdminMessage(t('admin.blogImageUrlInvalid', { row: invalidBlogImageIndex + 1 }))
    return
  }
  const blog = blogRows.map((row, index) => {
    const { slug, date, title, excerpt, content, imageUrl, tagsText } = parseBlogRow(row)
    const trimmedSlug = slug.trim()
    const trimmedDate = date.trim()
    const trimmedTitle = title.trim()
    const trimmedExcerpt = excerpt.trim()
    const trimmedContent = content.trim()
    const trimmedImageUrl = imageUrl.trim()
    const existing = site.value.blog?.[index] || {}
    return {
      id: existing.id || trimmedSlug || crypto.randomUUID(),
      slug: trimmedSlug,
      date: trimmedDate,
      title: trimmedTitle,
      excerpt: trimmedExcerpt,
      content: trimmedContent,
      image_url: trimmedImageUrl,
      tags: tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
      translations: {
        ...(existing.translations || {}),
        zh: { ...(existing.translations?.zh || {}), title: trimmedTitle, excerpt: trimmedExcerpt, content: trimmedContent },
      }
    }
  }).filter((post) => post.slug && post.date && post.title && post.excerpt && post.content)
  if (!blog.length) {
    showAdminMessage(t('admin.blogRequired'))
    return
  }
  if (new Set(blog.map((post) => post.slug.trim().toLowerCase())).size !== blog.length) {
    showAdminMessage(t('admin.blogDuplicate'))
    return
  }
  await runAdminAction('site', async () => {
    const savedSite = await api<SiteSettings>('/admin/site', {
      method: 'PUT',
      body: JSON.stringify({
        brand: { name: siteForm.brand_name, email: siteForm.email, instagram: siteForm.instagram },
        paypal: {
          enabled: paymentForm.paypal_enabled,
          mode: paymentForm.paypal_mode,
          client_id: paymentForm.paypal_client_id,
          ...(paypalSecretInput ? { secret: paypalSecretInput } : {}),
          ...(paypalWebhookInput ? { webhook_id: paypalWebhookInput } : {}),
          currency: paymentForm.currency,
        },
        shipping: { ...(site.value.shipping || {}), tracking_url_template: siteForm.tracking_url_template },
        contact: { ...contactForm },
        policies: { ...(site.value.policies || {}), care: policyI18n.zh.care, shipping: policyI18n.zh.shipping, refund: policyI18n.zh.refund, translations: policyTranslations },
        faq,
        reviews,
        blog,
      })
    })
    const secretDraft = paypalSecretInput
    const webhookDraft = paypalWebhookInput
    site.value = savedSite
    syncSiteForms(savedSite)
    if (secretDraft) paymentForm.paypal_secret = secretDraft
    if (webhookDraft) paymentForm.paypal_webhook_id = webhookDraft
    markSiteFormClean()
    showAdminMessage(t('admin.saved'))
  })
}

async function testPaypalConnection() {
  await runAdminAction('paypal-check', async () => {
    const paypal = {
      enabled: paymentForm.paypal_enabled,
      mode: paymentForm.paypal_mode,
      client_id: paymentForm.paypal_client_id.trim(),
      ...(paymentForm.paypal_secret.trim() ? { secret: paymentForm.paypal_secret.trim() } : {}),
      ...(paymentForm.paypal_webhook_id.trim() ? { webhook_id: paymentForm.paypal_webhook_id.trim() } : {}),
      currency: paymentForm.currency.trim().toUpperCase(),
    }
    const result = await api<{ mode: string; currency: string }>('/admin/paypal/check', {
      method: 'POST',
      body: JSON.stringify({ paypal }),
    })
    showAdminMessage(t('admin.paypalConnectionSuccess', { mode: result.mode, currency: result.currency }))
  })
}

function paypalFormPayload() {
  return {
    enabled: paymentForm.paypal_enabled,
    mode: paymentForm.paypal_mode,
    client_id: paymentForm.paypal_client_id.trim(),
    ...(paymentForm.paypal_secret.trim() ? { secret: paymentForm.paypal_secret.trim() } : {}),
    ...(paymentForm.paypal_webhook_id.trim() ? { webhook_id: paymentForm.paypal_webhook_id.trim() } : {}),
    currency: paymentForm.currency.trim().toUpperCase(),
  }
}

function paypalTestFailureMessage(error: any) {
  const data = error?.data || {}
  const lines = [
    `${t('admin.paypalTestHttpStatus')}: ${data.paypal_http_status || error?.status || '-'}`,
    `${t('admin.paypalTestPath')}: ${data.paypal_path || '-'}`,
  ]
  if (data.paypal_method) lines.push(`${t('admin.paypalTestMethod')}: ${data.paypal_method}`)
  if (data.paypal_name) lines.push(`${t('admin.paypalTestName')}: ${data.paypal_name}`)
  if (data.paypal_error) lines.push(`${t('admin.paypalTestError')}: ${data.paypal_error}`)
  if (data.paypal_error_description) lines.push(`${t('admin.paypalTestDescription')}: ${data.paypal_error_description}`)
  if (data.paypal_message) lines.push(`${t('admin.paypalTestMessage')}: ${data.paypal_message}`)
  if (data.paypal_debug_id) lines.push(`${t('admin.paypalTestDebugId')}: ${data.paypal_debug_id}`)
  if (Array.isArray(data.paypal_issues) && data.paypal_issues.length) {
    lines.push(`${t('admin.paypalTestIssues')}:`)
    data.paypal_issues.forEach((item: any) => {
      lines.push(`- ${item.issue || '-'}: ${item.description || '-'}`)
    })
  }
  if (data.paypal_response && typeof data.paypal_response === 'object' && Object.keys(data.paypal_response).length) {
    lines.push(`${t('admin.paypalTestResponse')}: ${JSON.stringify(data.paypal_response)}`)
  }
  if (lines.length === 2 && error?.message) lines.push(`${t('admin.paypalTestMessage')}: ${error.message}`)
  return lines.join('\n')
}

async function testPaypalOrder() {
  if (savingAction.value) return
  savingAction.value = 'paypal-order-test'
  paypalTestResult.value = null
  paypalTestError.value = ''
  try {
    const result = await api<any>('/admin/paypal/test-order', {
      method: 'POST',
      body: JSON.stringify({ paypal: paypalFormPayload() }),
    })
    paypalTestResult.value = result
    showAdminMessage(t('admin.paypalOrderTestSuccess', { id: result.paypal_order_id, mode: result.mode }))
  } catch (error: any) {
    paypalTestError.value = paypalTestFailureMessage(error)
    showAdminMessage(t('admin.paypalOrderTestFailed'))
  } finally {
    savingAction.value = ''
  }
}

onMounted(() => { void loadTab() })
watch(tab, (nextTab) => {
  closeOrderLightbox()
  void loadTab(nextTab)
})
watch(modalOpen, (open) => {
  document.body.classList.toggle('modal-open', open)
}, { immediate: true })
watch(orderLightbox, (lightbox) => {
  if (lightbox) window.addEventListener('keydown', handleOrderLightboxKeydown)
  else window.removeEventListener('keydown', handleOrderLightboxKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleOrderLightboxKeydown)
  document.body.classList.remove('modal-open')
})
watch([userSearch, userStatusFilter], () => { userPage.value = 1 })
watch([productSearch, productCategoryFilter, productStatusFilter], () => { productPage.value = 1 })
watch([orderSearch, orderStatusFilter, paymentStatusFilter, orderFlagFilter, orderSort], () => { orderPage.value = 1 })
watch(blogSearch, () => { blogPage.value = 1 })
watch([filteredUsers, userPageCount], () => { userPage.value = clampPage(userPage.value, userPageCount.value) })
watch([filteredProducts, productPageCount], () => { productPage.value = clampPage(productPage.value, productPageCount.value) })
watch([filteredOrders, orderPageCount], () => { orderPage.value = clampPage(orderPage.value, orderPageCount.value) })
watch([filteredBlogs, blogPageCount], () => { blogPage.value = clampPage(blogPage.value, blogPageCount.value) })
</script>

<template>
  <main class="section admin-dashboard">
    <div class="dashboard-head">
      <div>
        <p class="eyebrow">{{ t('admin.eyebrow') }}</p>
        <h1>{{ t('admin.title') }}</h1>
      </div>
      <div class="selectors">
        <button class="button ghost" :disabled="!!savingAction" @click="refreshAll">
          {{ actionBusy('refresh') ? t('common.loading') : t('admin.refreshData') }}
        </button>
        <button class="button ghost" @click="logout">{{ t('admin.logoutFull') }}</button>
      </div>
    </div>
    <Transition name="admin-toast">
      <div v-if="adminMessage" class="admin-toast" role="status" aria-live="polite">
        <span class="admin-toast-mark" aria-hidden="true"></span>
        <p>{{ adminMessage }}</p>
      </div>
    </Transition>
    <nav class="tabs" :aria-label="t('admin.title')">
      <button type="button" :aria-current="tab === 'overview' ? 'page' : undefined" :class="{active: tab === 'overview'}" @click="tab = 'overview'">{{ t('admin.overview') }}</button>
      <button type="button" :aria-current="tab === 'users' ? 'page' : undefined" :class="{active: tab === 'users'}" @click="tab = 'users'">{{ t('admin.usersManage') }}</button>
      <button type="button" :aria-current="tab === 'categories' ? 'page' : undefined" :class="{active: tab === 'categories'}" @click="tab = 'categories'">{{ t('admin.categories') }}</button>
      <button type="button" :aria-current="tab === 'products' ? 'page' : undefined" :class="{active: tab === 'products'}" @click="tab = 'products'">{{ t('admin.productsManage') }}</button>
      <button type="button" :aria-current="tab === 'orders' ? 'page' : undefined" :class="{active: tab === 'orders'}" @click="tab = 'orders'">{{ t('admin.ordersManage') }}</button>
      <button type="button" :aria-current="tab === 'reviews' ? 'page' : undefined" :class="{active: tab === 'reviews'}" @click="tab = 'reviews'">{{ t('admin.reviewsManage') }}</button>
      <button type="button" :aria-current="tab === 'blog' ? 'page' : undefined" :class="{active: tab === 'blog'}" @click="tab = 'blog'">{{ t('admin.blogManage') }}</button>
      <button type="button" :aria-current="tab === 'paypal' ? 'page' : undefined" :class="{active: tab === 'paypal'}" @click="tab = 'paypal'">{{ t('admin.paypalPage') }}</button>
      <button type="button" :aria-current="tab === 'site' ? 'page' : undefined" :class="{active: tab === 'site'}" @click="tab = 'site'">{{ t('admin.siteConfig') }}</button>
      <button type="button" :aria-current="tab === 'audit' ? 'page' : undefined" :class="{active: tab === 'audit'}" @click="tab = 'audit'">{{ t('admin.auditLogs') }}</button>
      <button type="button" :aria-current="tab === 'readiness' ? 'page' : undefined" :class="{active: tab === 'readiness'}" @click="tab = 'readiness'">{{ t('admin.readinessTitle') }}</button>
    </nav>
    <section v-if="initialLoading" class="panel empty-state">
      <h2>{{ t('admin.loadingDashboard') }}</h2>
      <p class="muted">{{ t('admin.loadingDashboardDesc') }}</p>
    </section>
    <section v-else-if="loadError" class="panel empty-state">
      <h2>{{ t('admin.loadFailedTitle') }}</h2>
      <p class="muted" role="alert">{{ loadError }}</p>
      <button class="button primary" type="button" :disabled="!!savingAction" @click="refreshAll">
        {{ actionBusy('refresh') ? t('common.loading') : t('admin.retryLoad') }}
      </button>
    </section>
    <template v-else>


    <section v-if="tab === 'overview'" class="overview-stack">
      <div class="panel action-queue-panel">
        <div class="admin-panel-head">
          <div>
            <h2>{{ t('admin.actionQueueTitle') }}</h2>
            <p class="muted">{{ t('admin.actionQueueDesc') }}</p>
          </div>
          <button class="button ghost" type="button" @click="tab = 'orders'; orderSort = 'action_required'">{{ t('admin.openOrderQueue') }}</button>
        </div>
        <div class="action-queue-grid">
          <button
            v-for="item in actionQueueItems"
            :key="item.key"
            type="button"
            :class="['action-queue-card', `queue-${item.tone}`]"
            @click="openActionQueue(item)"
          >
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <small>{{ item.desc }}</small>
          </button>
        </div>
      </div>
      <div class="admin-stats">
        <div class="stat-card" v-for="item in overviewItems" :key="item.key"><span>{{ item.label }}</span><strong>{{ item.value }}</strong></div>
      </div>
    </section>

	    <section v-if="tab === 'readiness'" class="panel readiness-panel">
      <div class="admin-panel-head">
        <h2>{{ t('admin.readinessTitle') }}</h2>
        <button class="button ghost" type="button" @click="tab = 'site'">{{ t('admin.readinessOpenConfig') }}</button>
      </div>
      <div class="readiness-list">
        <p v-for="item in readinessItems" :key="item.key" :class="`readiness-${item.tone}`">
          <span>{{ item.label }}</span>
          <span class="readiness-actions">
            <strong>{{ item.status }}</strong>
            <button class="button ghost mini-button" type="button" @click="openReadinessItem(item)">{{ t('admin.readinessFix') }}</button>
          </span>
        </p>
      </div>
	    </section>

	    <section v-if="tab === 'audit'" class="panel">
	      <div class="admin-panel-head">
	        <div>
	          <h2>{{ t('admin.auditLogs') }}</h2>
	          <p class="muted">{{ t('admin.auditLogsHelp') }}</p>
	        </div>
	        <button class="button ghost" type="button" :disabled="!!savingAction" @click="refreshAll">
	          {{ actionBusy('refresh') ? t('common.loading') : t('admin.refreshData') }}
	        </button>
	      </div>
	      <div class="mini-list audit-list">
	        <p v-for="item in auditLogs" :key="item.id">
	          <span>
	            <strong>{{ item.action || '-' }}</strong>
	            <small class="product-admin-meta">
	              <span>{{ item.actor_email || '-' }}</span>
	              <span>{{ item.actor_role || '-' }}</span>
	              <span>{{ formatDateTime(item.created_at) }}</span>
	            </small>
	            <code v-if="Object.keys(item.details || {}).length" class="audit-details">{{ JSON.stringify(item.details) }}</code>
	          </span>
	        </p>
	      </div>
	      <p v-if="!auditLogs.length" class="muted">{{ t('admin.auditLogsEmpty') }}</p>
	    </section>

	    <section v-if="tab === 'users'" class="panel user-panel">
      <div class="admin-panel-head user-panel-head">
        <div>
          <h2>{{ t('admin.usersManage') }}</h2>
          <p class="muted user-panel-summary">{{ userPageSummary }}</p>
        </div>
        <button class="button primary" type="button" @click="openUserModal()">{{ t('admin.addUser') }}</button>
      </div>
      <div class="admin-filters user-filters">
        <input v-model="userSearch" :placeholder="t('admin.searchUsers')" />
        <select v-model="userStatusFilter">
          <option value="">{{ t('admin.allStatuses') }}</option>
          <option v-for="s in userStatuses" :key="s" :value="s">{{ statusText(s) }}</option>
        </select>
        <button class="button ghost" type="button" @click="copyFilteredUserFollowups">{{ t('admin.copyUserFollowups') }}</button>
        <button class="button ghost" type="button" @click="exportUsersCsv">{{ t('admin.exportUsers') }}</button>
        <button class="button ghost" type="button" @click="resetUserFilters">{{ t('admin.resetUserFilters') }}</button>
      </div>
      <div v-if="userCopyText" class="copy-output user-copy-output">
        <label>{{ t('admin.copyUserFollowupsOutput') }}
          <textarea :value="userCopyText" readonly @focus="($event.target as HTMLTextAreaElement).select()" />
        </label>
      </div>
      <div class="user-card-list">
        <article v-for="user in pagedUsers" :key="user.id" class="user-admin-card">
          <div class="user-row-main">
            <div class="user-identity">
              <div class="user-title-line">
                <strong>{{ user.name || t('admin.userName') }}</strong>
                <span class="status-pill">{{ statusText(user.status || 'active') }}</span>
              </div>
              <small class="user-email-line">{{ user.email }} · {{ user.country || '-' }}</small>
              <p v-if="userTagsText(user)" class="user-tags-line">{{ t('admin.tagsShort') }} {{ userTagsText(user) }}</p>
            </div>
            <div class="user-row-stat">
              <span>{{ t('admin.orders') }}</span>
              <strong>{{ user.order_count || 0 }}</strong>
            </div>
            <div class="user-row-stat">
              <span>{{ t('admin.paidAmount') }}</span>
              <strong>{{ userPaidSummary(user) }}</strong>
            </div>
            <div class="user-row-stat">
              <span>{{ t('admin.lastOrder') }}</span>
              <strong>{{ user.last_order_at ? formatDate(user.last_order_at) : '-' }}</strong>
            </div>
            <div class="user-row-followup">
              <span>{{ t('admin.latestFollowupDate') }}</span>
              <strong>{{ latestFollowupDate(user) }}</strong>
              <small>{{ latestFollowupContent(user) }}</small>
            </div>
            <div class="user-row-followup">
              <span>{{ t('admin.nextFollowupDate') }}</span>
              <strong>{{ nextFollowupDate(user) }}</strong>
            </div>
            <footer class="user-row-actions">
              <button class="button ghost" type="button" @click="openUserModal(user)">{{ t('common.edit') }}</button>
              <button class="button ghost danger" type="button" :disabled="!!savingAction" @click="deleteUser(user)">
                {{ actionBusy(`user-delete-${user.id}`) ? t('common.loading') : t('common.delete') }}
              </button>
            </footer>
          </div>
          <p v-if="user.internal_note" class="user-note-preview">{{ t('admin.note') }} {{ copyTextValue(user.internal_note, 180) }}</p>
        </article>
      </div>
      <div v-if="filteredUsers.length > pageSize" class="pager">
        <button class="button ghost" :disabled="userPage <= 1" @click="prevPage('users')">{{ t('common.prev') }}</button>
        <span>{{ userPage }} / {{ userPageCount }}</span>
        <button class="button ghost" :disabled="userPage >= userPageCount" @click="nextPage('users')">{{ t('common.next') }}</button>
      </div>
      <div v-if="!filteredUsers.length" class="empty-state admin-empty-state">
        <h3>{{ t('admin.noUsers') }}</h3>
        <p>{{ t('admin.noUsersHelp') }}</p>
        <div class="empty-actions">
          <button class="button ghost" type="button" @click="resetUserFilters">{{ t('admin.resetUserFilters') }}</button>
          <button class="button primary" type="button" @click="openUserModal()">{{ t('admin.addUser') }}</button>
        </div>
      </div>
    </section>

    <section v-if="tab === 'categories'" class="panel">
      <div class="admin-panel-head">
        <h2>{{ t('admin.categories') }}</h2>
        <button class="button primary" @click="openCategoryModal()">{{ t('admin.addCategory') }}</button>
      </div>
      <div class="mini-list">
        <p v-for="category in categories" :key="category.id">
          <span>
            <strong>{{ translatedValue(category, 'title') }}</strong>
            <small class="product-admin-meta">
              <span>{{ category.slug }}</span>
              <span>{{ statusText(category.status) }}</span>
              <span>{{ t('admin.sort') }} {{ category.sort_order || 0 }}</span>
            </small>
          </span>
          <span class="row-actions">
            <button class="button ghost" @click="openCategoryModal(category)">{{ t('common.edit') }}</button>
            <button class="button ghost danger" :disabled="!!savingAction" @click="deleteCategory(category)">{{ t('common.delete') }}</button>
          </span>
        </p>
      </div>
      <p v-if="!categories.length" class="muted">{{ t('admin.noCategories') }}</p>
    </section>

    <section v-if="tab === 'products'" class="panel">
      <div class="admin-panel-head">
        <h2>{{ t('admin.productsManage') }}</h2>
        <div class="admin-filters">
          <input v-model="productSearch" :placeholder="t('admin.searchProducts')" />
          <select v-model="productCategoryFilter" :aria-label="t('admin.productCategoryFilter')">
            <option value="">{{ t('admin.allCategories') }}</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ translatedValue(c, 'title') }}</option>
          </select>
          <select v-model="productStatusFilter" :aria-label="t('admin.productStatusFilter')">
            <option value="">{{ t('admin.allProductStatuses') }}</option>
            <option v-for="s in publishStatuses" :key="s" :value="s">{{ statusText(s) }}</option>
          </select>
          <button class="button ghost" type="button" @click="exportProductsCsv">{{ t('admin.exportProducts') }}</button>
          <button class="button ghost" type="button" @click="resetProductFilters">{{ t('admin.resetProductFilters') }}</button>
          <button class="button primary" @click="openProductModal()">{{ t('admin.addProduct') }}</button>
        </div>
      </div>
      <div class="mini-list">
        <p v-for="product in pagedProducts" :key="product.id">
          <span>
            <strong>{{ translatedValue(product, 'title') }}</strong>
            <small class="product-admin-meta">
              <span>{{ product.slug }}</span>
              <span>{{ productCategoryTitle(product) }}</span>
              <span>{{ statusText(product.status) }}</span>
              <span>{{ money(product.options?.[0]?.price_cents || product.base_price_cents, product.currency) }}</span>
              <span>{{ t('admin.depositPercent') }} {{ product.deposit_percent || 0 }}%</span>
            </small>
            <small v-if="productReadinessIssues(product).length" class="product-readiness-warnings">
              <span>{{ t('admin.productReadinessWarning') }}</span>
              <em v-for="issue in productReadinessIssues(product)" :key="issue">{{ issue }}</em>
            </small>
          </span>
          <span class="row-actions compact-actions">
            <button class="button ghost" @click="openProductModal(product)">{{ t('common.edit') }}</button>
            <button class="button ghost danger" :disabled="!!savingAction" @click="deleteProduct(product)">
              {{ actionBusy(`product-delete-${product.id}`) ? t('common.loading') : t('common.delete') }}
            </button>
          </span>
        </p>
      </div>
      <div v-if="filteredProducts.length" class="list-summary">{{ productPageSummary }}</div>
      <div v-if="filteredProducts.length > pageSize" class="pager">
        <button class="button ghost" :disabled="productPage <= 1" @click="prevPage('products')">{{ t('common.prev') }}</button>
        <span>{{ productPage }} / {{ productPageCount }}</span>
        <button class="button ghost" :disabled="productPage >= productPageCount" @click="nextPage('products')">{{ t('common.next') }}</button>
      </div>
      <div v-if="!filteredProducts.length" class="empty-state admin-empty-state">
        <h3>{{ t('admin.noProducts') }}</h3>
        <p>{{ t('admin.noProductsHelp') }}</p>
        <div class="empty-actions">
          <button class="button ghost" type="button" @click="resetProductFilters">{{ t('admin.resetProductFilters') }}</button>
          <button class="button primary" type="button" @click="openProductModal()">{{ t('admin.addProduct') }}</button>
        </div>
      </div>
    </section>

    <section v-if="tab === 'orders'" class="panel table-wrap order-panel">
      <div v-if="selectedOrder" class="modal-backdrop" @click.self="selectedOrder = null">
        <section class="admin-modal wide order-detail-modal" role="dialog" aria-modal="true" :aria-label="t('admin.orderDetail')">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.orderDetail') }}</p>
            <h2>{{ selectedOrder.order_no }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" @click="selectedOrder = null">×</button>
        </header>
        <div class="order-detail-actions">
          <a v-if="customerMailto(selectedOrder)" class="button ghost" :href="customerMailto(selectedOrder)">{{ t('admin.emailCustomer') }}</a>
          <button class="button ghost" @click="copyOrder(selectedOrder)">{{ t('admin.copyOrder') }}</button>
          <button class="button ghost" :class="{ danger: selectedOrder.flagged }" :disabled="!!savingAction" @click="toggleOrderFlag(selectedOrder)">
            {{ actionBusy(`order-${selectedOrder.id}-flag`) ? t('common.loading') : (selectedOrder.flagged ? t('admin.unflagOrder') : t('admin.flagOrder')) }}
          </button>
        </div>
        <div class="order-detail-edit">
          <label>{{ t('admin.detailOrderStatus') }}
            <select :value="selectedOrder.order_status" :disabled="!!savingAction" @change="onOrderSelectChange(selectedOrder, 'status', $event)">
              <option v-for="s in orderStatuses" :key="s" :value="s">{{ statusText(s) }}</option>
            </select>
          </label>
          <label>{{ t('admin.detailPaymentStatus') }}
            <select :value="selectedOrder.payment_status" :disabled="!!savingAction" @change="onOrderSelectChange(selectedOrder, 'payment', $event)">
              <option v-for="s in paymentStatuses" :key="s" :value="s">{{ statusText(s) }}</option>
            </select>
          </label>
          <label>{{ t('admin.detailInternalNote') }}
            <textarea v-model="selectedOrder.internal_note" :placeholder="t('admin.note')" maxlength="2000" :disabled="!!savingAction" @input="markOrderNoteDirty(selectedOrder)" />
          </label>
          <div v-if="isOrderNoteDirty(selectedOrder)" class="inline-save-row">
            <span>{{ t('admin.orderNoteUnsaved') }}</span>
            <button class="button primary" type="button" :disabled="!!savingAction" @click="updateOrder(selectedOrder, 'note')">
              {{ actionBusy(`order-${selectedOrder.id}-note`) ? t('common.loading') : t('admin.saveOrderNote') }}
            </button>
          </div>
          <label>{{ t('admin.shippingCarrier') }}
            <input v-model="selectedOrder.shipping_carrier" :placeholder="t('admin.shippingCarrier')" maxlength="120" :disabled="!!savingAction" @change="updateOrder(selectedOrder, 'note')" />
          </label>
          <label>{{ t('admin.trackingNo') }}
            <input v-model="selectedOrder.tracking_no" :placeholder="t('admin.trackingNo')" maxlength="120" :disabled="!!savingAction" @change="updateOrder(selectedOrder, 'note')" />
          </label>
          <p v-if="selectedOrder.shipping_carrier || selectedOrder.tracking_no" class="tracking-preview">
            {{ t('admin.tracking') }} {{ selectedOrder.shipping_carrier || '-' }} {{ selectedOrder.tracking_no || '' }}
          </p>
        </div>
        <div class="order-flow">
          <div v-for="status in orderStatuses" :key="status" :class="{ done: orderStatuses.indexOf(status) <= orderStatuses.indexOf(selectedOrder.order_status) }">
            <span>{{ statusText(status) }}</span>
          </div>
        </div>
        <section class="fulfillment-check-panel">
          <h3>{{ t('admin.fulfillmentCheckTitle') }}</h3>
          <div>
            <p v-for="item in orderFulfillmentChecks(selectedOrder)" :key="item.key" :class="{ ready: item.ready }">
              <span>{{ item.ready ? t('admin.fulfillmentReady') : t('admin.fulfillmentTodo') }}</span>
              <strong>{{ item.label }}</strong>
              <small>{{ item.value }}</small>
            </p>
          </div>
        </section>
        <div class="grid two order-detail-grid">
          <article>
            <h3>{{ t('admin.customerInfo') }}</h3>
            <p>{{ selectedOrder.customer_name }} / {{ selectedOrder.email }}</p>
            <p v-if="selectedOrder.phone" class="detail-line"><span>{{ t('admin.phone') }}</span><strong>{{ selectedOrder.phone }}</strong></p>
            <p>{{ selectedOrder.country }} / {{ selectedOrder.pet_name }} {{ selectedOrder.pet_type }}</p>
            <p v-if="selectedOrder.shipping_address" class="detail-line"><span>{{ t('admin.shippingAddress') }}</span><strong>{{ selectedOrder.shipping_address }}</strong></p>
            <p v-if="selectedOrder.shipping_carrier || selectedOrder.tracking_no" class="detail-line"><span>{{ t('admin.tracking') }}</span><strong>{{ selectedOrder.shipping_carrier || '-' }} {{ selectedOrder.tracking_no || '' }}</strong></p>
            <p class="detail-line"><span>{{ t('admin.orderCreatedAt') }}</span><strong>{{ new Date(selectedOrder.created_at).toLocaleString() }}</strong></p>
            <p class="detail-line"><span>{{ t('admin.photoCount') }}</span><strong>{{ selectedOrder.photo_urls?.length || 0 }}</strong></p>
            <p>{{ selectedOrder.notes }}</p>
          </article>
          <article>
            <h3>{{ t('admin.orderPayment') }}</h3>
            <p>{{ selectedOrder.product_title }} / {{ selectedOrder.option_name }}</p>
            <p>{{ money(selectedOrder.amount_cents, selectedOrder.currency) }} / {{ statusText(selectedOrder.payment_status) }}</p>
            <p class="detail-line"><span>{{ t('admin.paidAmount') }}</span><strong>{{ money(selectedOrder.paid_amount_cents || 0, selectedOrder.currency) }}</strong></p>
            <p class="detail-line"><span>{{ t('admin.remainingAmount') }}</span><strong>{{ money(remainingAmount(selectedOrder), selectedOrder.currency) }}</strong></p>
            <p class="detail-line"><span>{{ t('admin.paymentType') }}</span><strong>{{ t(`order.${selectedOrder.payment_type}`) }}</strong></p>
            <p class="detail-line"><span>{{ t('admin.paypalOrderId') }}</span><strong>{{ selectedOrder.paypal_order_id || '-' }}</strong></p>
            <div class="payment-records">
              <h4>{{ t('admin.paymentRecords') }}</h4>
              <div v-if="selectedOrder.payments?.length" class="payment-record-list">
                <p v-for="payment in selectedOrder.payments" :key="payment.id">
                  <span>{{ payment.provider }} / {{ statusText(payment.status) }} / {{ t(`order.${payment.payment_type}`) }}</span>
                  <strong>{{ money(payment.amount_cents, payment.currency) }}</strong>
                  <small>{{ t('admin.paypalOrderId') }} {{ payment.paypal_order_id || '-' }}</small>
                  <small>{{ t('admin.paypalCaptureId') }} {{ payment.paypal_capture_id || '-' }}</small>
                  <small>{{ t('admin.paymentCreatedAt') }} {{ payment.created_at ? formatDate(payment.created_at) : '-' }}</small>
                  <small>{{ t('admin.paymentPaidAt') }} {{ payment.paid_at ? formatDate(payment.paid_at) : '-' }}</small>
                </p>
              </div>
              <p v-else class="muted">{{ t('admin.noPaymentRecords') }}</p>
            </div>
          </article>
        </div>
        <section class="order-event-panel">
          <h3>{{ t('admin.orderEvents') }}</h3>
          <div v-if="selectedOrder.events?.length" class="order-event-list">
            <p v-for="event in selectedOrderEvents" :key="event.id">
              <strong>{{ formatDate(event.created_at) }}</strong>
              <span>{{ event.message }}</span>
            </p>
          </div>
          <p v-else class="muted">{{ t('admin.noOrderEvents') }}</p>
        </section>
        <div class="photo-preview large">
          <p v-if="!selectedOrder.photo_urls?.length" class="empty-photo-state">{{ t('admin.noOrderPhotos') }}</p>
          <figure v-for="(url, index) in selectedOrder.photo_urls" :key="`${url}-${index}`" class="admin-photo-tile">
            <button
              v-if="!brokenPhotoKeys.has(photoKey(selectedOrder, url, index))"
              class="admin-photo-button"
              type="button"
              :aria-label="t('detail.zoomImage')"
              @click="openOrderImage(selectedOrder, index)"
            >
              <img :src="url" alt="pet" @error="markPhotoMissing(selectedOrder, url, index)" />
              <span class="admin-photo-zoom-mark" aria-hidden="true"><ZoomIn :size="14" /></span>
            </button>
            <figcaption v-else class="missing-photo">{{ t('admin.photoMissing') }}</figcaption>
          </figure>
        </div>
        </section>
      </div>
      <div
        v-if="orderLightbox && orderLightboxImage"
        class="image-lightbox admin-order-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="t('detail.zoomImage')"
        @click.self="closeOrderLightbox"
      >
        <button class="icon-button lightbox-close" type="button" :aria-label="t('detail.closeImage')" @click="closeOrderLightbox">
          <X :size="24" />
        </button>
        <button v-if="orderLightboxImages.length > 1" class="gallery-nav previous" type="button" :aria-label="t('detail.previousImage')" @click="moveOrderImage(-1)">
          <ChevronLeft :size="28" />
        </button>
        <figure>
          <img :src="orderLightboxImage" alt="pet" />
          <figcaption>{{ orderLightboxIndex + 1 }} / {{ orderLightboxImages.length }}</figcaption>
        </figure>
        <button v-if="orderLightboxImages.length > 1" class="gallery-nav next" type="button" :aria-label="t('detail.nextImage')" @click="moveOrderImage(1)">
          <ChevronRight :size="28" />
        </button>
      </div>
      <div class="admin-panel-head order-panel-head">
        <div>
          <h2>{{ t('admin.ordersManage') }}</h2>
          <p class="muted order-panel-summary">{{ orderPageSummary }}</p>
        </div>
      </div>
      <div class="admin-filters order-filters">
        <input v-model="orderSearch" :placeholder="t('admin.searchOrders')" />
        <select v-model="orderStatusFilter">
          <option value="">{{ t('admin.allOrderStatuses') }}</option>
          <option v-for="s in orderStatuses" :key="s" :value="s">{{ statusText(s) }}</option>
        </select>
        <select v-model="paymentStatusFilter">
          <option value="">{{ t('admin.allPaymentStatuses') }}</option>
          <option v-for="s in paymentStatuses" :key="s" :value="s">{{ statusText(s) }}</option>
        </select>
        <select v-model="orderFlagFilter">
          <option value="">{{ t('admin.allFlagStatuses') }}</option>
          <option value="flagged">{{ t('admin.flaggedOnly') }}</option>
          <option value="normal">{{ t('admin.normalOnly') }}</option>
        </select>
        <select v-model="orderSort" :aria-label="t('admin.orderSort')">
          <option value="latest">{{ t('admin.sortLatest') }}</option>
          <option value="oldest">{{ t('admin.sortOldest') }}</option>
          <option value="action_required">{{ t('admin.sortActionRequired') }}</option>
          <option value="amount_desc">{{ t('admin.sortAmountDesc') }}</option>
          <option value="amount_asc">{{ t('admin.sortAmountAsc') }}</option>
          <option value="flagged_first">{{ t('admin.sortFlaggedFirst') }}</option>
        </select>
        <button class="button ghost" type="button" @click="exportOrdersCsv">{{ t('admin.exportOrders') }}</button>
        <button class="button ghost" type="button" @click="copyFilteredOrderContacts">{{ t('admin.copyFilteredContacts') }}</button>
        <button class="button ghost" type="button" @click="copyFilteredOrderHandoff">{{ t('admin.copyHandoffList') }}</button>
        <button class="button ghost" type="button" @click="resetOrderFilters">{{ t('admin.resetOrderFilters') }}</button>
      </div>
      <div v-if="contactCopyText" class="copy-output">
        <label>{{ orderCopyOutputTitle || t('admin.copyContactsOutput') }}
          <textarea :value="contactCopyText" readonly @focus="($event.target as HTMLTextAreaElement).select()" />
        </label>
      </div>
      <p v-if="orderSort === 'action_required'" class="order-sort-hint">{{ t('admin.actionRequiredSortHelp') }}</p>
      <div class="mobile-order-list">
        <article v-for="order in pagedOrders" :key="`mobile-${order.id}`" class="mobile-order-card">
          <header>
            <div>
              <strong>{{ order.order_no }}</strong>
              <span v-if="order.flagged" class="risk-badge">{{ t('admin.flaggedBadge') }}</span>
              <small>{{ new Date(order.created_at).toLocaleString() }}</small>
            </div>
            <strong>{{ money(order.amount_cents, order.currency) }}</strong>
          </header>
          <div class="order-amount-breakdown">
            <p><span>{{ t('admin.paidAmount') }}</span><strong>{{ money(order.paid_amount_cents || 0, order.currency) }}</strong></p>
            <p><span>{{ t('admin.remainingAmount') }}</span><strong>{{ money(remainingAmount(order), order.currency) }}</strong></p>
          </div>
          <div class="mobile-order-meta">
            <p><span>{{ t('admin.customer') }}</span>{{ order.customer_name }} / {{ order.email }}</p>
            <p v-if="order.phone"><span>{{ t('admin.phone') }}</span>{{ order.phone }}</p>
            <p><span>{{ t('admin.products') }}</span>{{ order.product_title }} / {{ order.option_name }}</p>
            <p><span>{{ t('admin.petInfo') }}</span>{{ order.pet_name }} {{ order.pet_type }}</p>
            <p><span>{{ t('admin.photos') }}</span>{{ order.photo_urls?.length || 0 }}</p>
          </div>
          <div v-if="order.photo_urls?.length" class="mobile-order-photos">
            <figure v-for="(url, index) in order.photo_urls" :key="`${url}-${index}`" class="admin-photo-tile">
              <button
                v-if="!brokenPhotoKeys.has(photoKey(order, url, index))"
                class="admin-photo-button"
                type="button"
                :aria-label="t('detail.zoomImage')"
                @click="openOrderImage(order, index)"
              >
                <img :src="url" alt="pet" @error="markPhotoMissing(order, url, index)" />
                <span class="admin-photo-zoom-mark" aria-hidden="true"><ZoomIn :size="14" /></span>
              </button>
              <figcaption v-else class="missing-photo">{{ t('admin.photoMissing') }}</figcaption>
            </figure>
          </div>
          <div class="mobile-order-controls">
            <label>{{ t('admin.status') }}<select :value="order.order_status" :disabled="!!savingAction" @change="onOrderSelectChange(order, 'status', $event)"><option v-for="s in orderStatuses" :key="s" :value="s">{{ statusText(s) }}</option></select></label>
            <label>{{ t('admin.payment') }}<select :value="order.payment_status" :disabled="!!savingAction" @change="onOrderSelectChange(order, 'payment', $event)"><option v-for="s in paymentStatuses" :key="s" :value="s">{{ statusText(s) }}</option></select></label>
            <label>{{ t('admin.shippingCarrier') }}<input v-model="order.shipping_carrier" :placeholder="t('admin.shippingCarrier')" maxlength="120" :disabled="!!savingAction" @change="updateOrder(order, 'note')" /></label>
            <label>{{ t('admin.trackingNo') }}<input v-model="order.tracking_no" :placeholder="t('admin.trackingNo')" maxlength="120" :disabled="!!savingAction" @change="updateOrder(order, 'note')" /></label>
          </div>
          <textarea v-model="order.internal_note" :placeholder="t('admin.note')" maxlength="2000" :disabled="!!savingAction" @input="markOrderNoteDirty(order)" />
          <div v-if="isOrderNoteDirty(order)" class="inline-save-row mobile-note-save">
            <span>{{ t('admin.orderNoteUnsaved') }}</span>
            <button class="button primary" type="button" :disabled="!!savingAction" @click="updateOrder(order, 'note')">
              {{ actionBusy(`order-${order.id}-note`) ? t('common.loading') : t('admin.saveOrderNote') }}
            </button>
          </div>
          <div class="row-actions">
            <a v-if="customerMailto(order)" class="button ghost" :href="customerMailto(order)">{{ t('admin.emailCustomerShort') }}</a>
            <button class="button ghost" @click="selectedOrder = order">{{ t('admin.detailFlow') }}</button>
            <button class="button ghost" @click="copyOrder(order)">{{ t('admin.copyOrder') }}</button>
            <button class="button ghost" :class="{ danger: order.flagged }" :disabled="!!savingAction" @click="toggleOrderFlag(order)">
              {{ actionBusy(`order-${order.id}-flag`) ? t('common.loading') : (order.flagged ? t('admin.unflagShort') : t('admin.flagShort')) }}
            </button>
          </div>
        </article>
      </div>
      <table class="desktop-order-table">
        <colgroup>
          <col class="order-col-order" />
          <col class="order-col-customer" />
          <col class="order-col-product" />
          <col class="order-col-photos" />
          <col class="order-col-amount" />
          <col class="order-col-status" />
          <col class="order-col-payment" />
          <col class="order-col-note" />
        </colgroup>
        <thead><tr><th>{{ t('admin.order') }}</th><th>{{ t('admin.customer') }}</th><th>{{ t('admin.products') }}</th><th>{{ t('admin.photos') }}</th><th>{{ t('admin.amount') }}</th><th>{{ t('admin.status') }}</th><th>{{ t('admin.payment') }}</th><th>{{ t('admin.note') }}</th></tr></thead>
        <tbody>
          <tr v-for="order in pagedOrders" :key="order.id">
            <td>
              <strong>{{ order.order_no }}</strong>
              <span v-if="order.flagged" class="risk-badge">{{ t('admin.flaggedBadge') }}</span><br>
              <small>{{ new Date(order.created_at).toLocaleString() }}</small><br>
              <div class="row-actions">
                <a v-if="customerMailto(order)" class="button ghost" :href="customerMailto(order)">{{ t('admin.emailCustomerShort') }}</a>
                <button class="button ghost" @click="selectedOrder = order">{{ t('admin.detailFlow') }}</button>
                <button class="button ghost" @click="copyOrder(order)">{{ t('admin.copyOrder') }}</button>
                <button class="button ghost" :class="{ danger: order.flagged }" :disabled="!!savingAction" @click="toggleOrderFlag(order)">
                  {{ actionBusy(`order-${order.id}-flag`) ? t('common.loading') : (order.flagged ? t('admin.unflagShort') : t('admin.flagShort')) }}
                </button>
              </div>
            </td>
            <td>{{ order.customer_name }}<br><small>{{ order.email }} / {{ order.country }}</small><br><small v-if="order.phone">{{ order.phone }}</small></td>
            <td>{{ order.product_title }}<br><small>{{ order.option_name }} / {{ order.pet_name }} {{ order.pet_type }}</small></td>
            <td>
              <div class="photo-preview">
                <p v-if="!order.photo_urls?.length" class="empty-photo-state">{{ t('admin.noOrderPhotos') }}</p>
                <figure v-for="(url, index) in order.photo_urls" :key="`${url}-${index}`" class="admin-photo-tile">
                  <button
                    v-if="!brokenPhotoKeys.has(photoKey(order, url, index))"
                    class="admin-photo-button"
                    type="button"
                    :aria-label="t('detail.zoomImage')"
                    @click="openOrderImage(order, index)"
                  >
                    <img :src="url" alt="pet" @error="markPhotoMissing(order, url, index)" />
                    <span class="admin-photo-zoom-mark" aria-hidden="true"><ZoomIn :size="14" /></span>
                  </button>
                  <figcaption v-else class="missing-photo">{{ t('admin.photoMissing') }}</figcaption>
                </figure>
              </div>
            </td>
            <td>
              <div class="order-amount-cell">
                <strong>{{ money(order.amount_cents, order.currency) }}</strong>
                <small>{{ t(`order.${order.payment_type}`) }}</small>
                <span>{{ t('admin.paidAmount') }} {{ money(order.paid_amount_cents || 0, order.currency) }}</span>
                <span>{{ t('admin.remainingAmount') }} {{ money(remainingAmount(order), order.currency) }}</span>
              </div>
            </td>
            <td><select :value="order.order_status" :disabled="!!savingAction" @change="onOrderSelectChange(order, 'status', $event)"><option v-for="s in orderStatuses" :key="s" :value="s">{{ statusText(s) }}</option></select></td>
            <td><select :value="order.payment_status" :disabled="!!savingAction" @change="onOrderSelectChange(order, 'payment', $event)"><option v-for="s in paymentStatuses" :key="s" :value="s">{{ statusText(s) }}</option></select></td>
            <td>
              <textarea v-model="order.internal_note" maxlength="2000" :disabled="!!savingAction" @input="markOrderNoteDirty(order)" />
              <div v-if="isOrderNoteDirty(order)" class="inline-save-row table-note-save">
                <span>{{ t('admin.orderNoteUnsaved') }}</span>
                <button class="button primary" type="button" :disabled="!!savingAction" @click="updateOrder(order, 'note')">
                  {{ actionBusy(`order-${order.id}-note`) ? t('common.loading') : t('admin.saveOrderNote') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="filteredOrders.length > pageSize" class="pager">
        <button class="button ghost" :disabled="orderPage <= 1" @click="prevPage('orders')">{{ t('common.prev') }}</button>
        <span>{{ orderPage }} / {{ orderPageCount }}</span>
        <button class="button ghost" :disabled="orderPage >= orderPageCount" @click="nextPage('orders')">{{ t('common.next') }}</button>
      </div>
      <div v-if="!filteredOrders.length" class="empty-state admin-empty-state">
        <h3>{{ t('admin.noOrders') }}</h3>
        <p>{{ t('admin.noOrdersHelp') }}</p>
        <div class="empty-actions">
          <button class="button ghost" type="button" @click="resetOrderFilters">{{ t('admin.resetOrderFilters') }}</button>
          <button class="button primary" type="button" @click="refreshAll">{{ t('admin.refreshData') }}</button>
        </div>
      </div>
    </section>

    <section v-if="tab === 'reviews'" class="panel review-admin-panel">
      <div class="admin-panel-head">
        <div>
          <h2>{{ t('admin.reviewsManage') }}</h2>
          <p class="muted">{{ t('admin.reviewsManageHelp') }}</p>
        </div>
        <div class="admin-filters review-admin-filters">
          <input v-model="reviewSearch" :placeholder="t('admin.searchReviews')" />
          <button class="button ghost" type="button" @click="resetReviewFilters">{{ t('admin.resetReviewFilters') }}</button>
          <button class="button primary" type="button" @click="openReviewModal()"><ImagePlus :size="16" />{{ t('admin.addReview') }}</button>
        </div>
      </div>
      <div v-if="filteredReviews.length" class="review-admin-grid">
        <article v-for="review in filteredReviews" :key="review.id" class="review-admin-card">
          <div class="review-admin-card-media">
            <img
              v-for="(image, index) in reviewMediaUrls(review)"
              :key="`${review.id}-image-${index}`"
              :src="resolveContentImage(image)"
              :alt="`${review.name} review image ${Number(index) + 1}`"
              loading="lazy"
              decoding="async"
            />
            <span v-if="!reviewMediaUrls(review).length">{{ t('admin.reviewNoImage') }}</span>
          </div>
          <div class="review-admin-body">
            <div class="review-admin-meta">
              <span>{{ statusText(review.status || 'published') }}</span>
              <span>{{ t('admin.reviewTranslationCount', { count: reviewTranslationCount(review) }) }}</span>
              <span>{{ t('admin.reviewImageCount', { count: reviewMediaUrls(review).length }) }}</span>
            </div>
            <div class="review-admin-identity">
              <img v-if="review.avatar_url" class="review-admin-avatar" :src="resolveContentImage(review.avatar_url)" :alt="review.name" loading="lazy" decoding="async" />
              <span>{{ review.name }} · {{ review.country }}</span>
            </div>
            <div class="rating" :aria-label="`${review.rating} stars`">★★★★★</div>
            <h3>{{ reviewField(review, 'title', 'zh') }}</h3>
            <p class="preserve-lines">{{ reviewField(review, 'content', 'zh') }}</p>
            <div class="row-actions compact-actions">
              <button class="button ghost" type="button" @click="openReviewModal(review)">{{ t('common.edit') }}</button>
              <button class="button ghost danger" type="button" :disabled="!!savingAction" @click="deleteReview(review)">
                <Trash2 :size="15" />{{ actionBusy(`review-delete-${review.id}`) ? t('common.loading') : t('common.delete') }}
              </button>
            </div>
          </div>
        </article>
      </div>
      <div v-if="!filteredReviews.length" class="empty-state admin-empty-state">
        <h3>{{ t('admin.noReviews') }}</h3>
        <p>{{ t('admin.noReviewsHelp') }}</p>
        <div class="empty-actions">
          <button class="button ghost" type="button" @click="resetReviewFilters">{{ t('admin.resetReviewFilters') }}</button>
          <button class="button primary" type="button" @click="openReviewModal()"><ImagePlus :size="16" />{{ t('admin.addReview') }}</button>
        </div>
      </div>
    </section>

    <section v-if="tab === 'blog'" class="panel blog-admin-panel">
      <div class="admin-panel-head">
        <div>
          <h2>{{ t('admin.blogManage') }}</h2>
          <p class="muted">{{ t('admin.blogManageHelp') }}</p>
        </div>
        <div class="admin-filters blog-admin-filters">
          <input v-model="blogSearch" :placeholder="t('admin.searchBlogs')" />
          <button class="button ghost" type="button" @click="resetBlogFilters">{{ t('admin.resetBlogFilters') }}</button>
          <button class="button primary" type="button" @click="openBlogModal()">{{ t('admin.addBlog') }}</button>
        </div>
      </div>
      <div v-if="pagedBlogs.length" class="blog-admin-grid">
        <article v-for="post in pagedBlogs" :key="post.id || post.slug" class="blog-admin-card">
          <div class="blog-card-media">
            <img v-if="post.image_url" :src="resolveContentImage(post.image_url)" :alt="blogField(post, 'title')" />
            <span v-else>{{ t('admin.blogImageEmpty') }}</span>
          </div>
          <div class="blog-admin-body">
            <div class="blog-admin-meta">
              <span>{{ post.date || '-' }}</span>
              <span>{{ post.slug }}</span>
              <span>{{ t('admin.blogTranslationCount', { count: blogTranslationCount(post) }) }}</span>
            </div>
            <h3>{{ blogField(post, 'title') }}</h3>
            <p>{{ blogPreviewText(post, 'excerpt', 120) }}</p>
            <div class="tag-row compact">
              <span v-for="tag in post.tags || []" :key="tag">{{ tag }}</span>
            </div>
            <p class="blog-admin-preview">{{ blogPreviewText(post, 'content') }}</p>
            <div class="row-actions compact-actions">
              <button class="button ghost" type="button" @click="openBlogModal(post)">{{ t('common.edit') }}</button>
              <a class="button ghost" :href="`/blog/${post.slug}`" target="_blank" rel="noopener noreferrer">{{ t('admin.blogOpenPublic') }}</a>
              <button class="button ghost danger" type="button" :disabled="!!savingAction" @click="deleteBlog(post)">
                {{ actionBusy(`blog-delete-${post.id || post.slug}`) ? t('common.loading') : t('common.delete') }}
              </button>
            </div>
          </div>
        </article>
      </div>
      <div v-if="filteredBlogs.length" class="list-summary">{{ blogPageSummary }}</div>
      <div v-if="filteredBlogs.length > pageSize" class="pager">
        <button class="button ghost" :disabled="blogPage <= 1" @click="prevPage('blog')">{{ t('common.prev') }}</button>
        <span>{{ blogPage }} / {{ blogPageCount }}</span>
        <button class="button ghost" :disabled="blogPage >= blogPageCount" @click="nextPage('blog')">{{ t('common.next') }}</button>
      </div>
      <div v-if="!filteredBlogs.length" class="empty-state admin-empty-state">
        <h3>{{ t('admin.noBlogs') }}</h3>
        <p>{{ t('admin.noBlogsHelp') }}</p>
        <div class="empty-actions">
          <button class="button ghost" type="button" @click="resetBlogFilters">{{ t('admin.resetBlogFilters') }}</button>
          <button class="button primary" type="button" @click="openBlogModal()">{{ t('admin.addBlog') }}</button>
        </div>
      </div>
    </section>

    <section v-if="tab === 'paypal'" class="panel paypal-admin-page">
      <div class="paypal-page-head">
        <div>
          <p class="eyebrow">{{ t('admin.paypalEyebrow') }}</p>
          <h2>{{ t('admin.paypalPage') }}</h2>
          <p class="muted paypal-page-lead">{{ t('admin.paypalPageDesc') }}</p>
        </div>
        <div class="paypal-logo-mark" aria-hidden="true">P</div>
      </div>

      <div class="paypal-help-banner">
        <div>
          <strong>{{ t('admin.paypalHelpBannerTitle') }}</strong>
          <span>{{ t('admin.paypalHelpBannerDesc') }}</span>
        </div>
        <button class="button primary" type="button" @click="paypalHelpOpen = true">{{ t('admin.openPaypalGuide') }}</button>
      </div>

      <div class="paypal-setup-steps">
        <article>
          <span class="paypal-step-number">01</span>
          <div><strong>{{ t('admin.paypalStepAccount') }}</strong><p>{{ t('admin.paypalStepAccountDesc') }}</p></div>
        </article>
        <article>
          <span class="paypal-step-number">02</span>
          <div><strong>{{ t('admin.paypalStepApp') }}</strong><p>{{ t('admin.paypalStepAppDesc') }}</p></div>
        </article>
        <article>
          <span class="paypal-step-number">03</span>
          <div><strong>{{ t('admin.paypalStepCredentials') }}</strong><p>{{ t('admin.paypalStepCredentialsDesc') }}</p></div>
        </article>
        <article>
          <span class="paypal-step-number">04</span>
          <div><strong>{{ t('admin.paypalStepWebhook') }}</strong><p>{{ t('admin.paypalStepWebhookDesc') }}</p></div>
        </article>
      </div>

      <form class="admin-form paypal-config-form" @submit.prevent="saveSite">
        <div class="admin-panel-head paypal-config-head">
          <div>
            <h3>{{ t('admin.paypalCredentialsTitle') }}</h3>
            <p class="muted">{{ t('admin.paypalCredentialsDesc') }}</p>
          </div>
          <span :class="['paypal-mode-badge', paymentForm.paypal_mode === 'live' ? 'is-live' : 'is-sandbox']">
            {{ paymentForm.paypal_mode === 'live' ? t('admin.paypalLiveBadge') : t('admin.paypalSandboxBadge') }}
          </span>
        </div>
        <div class="form-grid paypal-config-grid">
          <label><input type="checkbox" v-model="paymentForm.paypal_enabled" :aria-label="t('admin.enablePaypal')" /> {{ t('admin.enablePaypal') }}</label>
          <label>{{ t('admin.paypalModeLabel') }}<select v-model="paymentForm.paypal_mode"><option value="sandbox">{{ statusText('sandbox') }}</option><option value="live">{{ statusText('live') }}</option></select></label>
          <label>{{ t('admin.paypalClientIdLabel') }}<input v-model="paymentForm.paypal_client_id" placeholder="PayPal Client ID" maxlength="300" autocomplete="off" /></label>
          <div class="secret-field">
            <label>{{ t('admin.paypalSecretLabel') }}<input v-model="paymentForm.paypal_secret" :type="paymentSecretsVisible ? 'text' : 'password'" :placeholder="paypalSecretSaved ? t('admin.paypalSecretSavedPlaceholder') : 'PayPal Secret'" maxlength="500" autocomplete="new-password" /></label>
            <button class="button ghost" type="button" @click="paymentSecretsVisible = !paymentSecretsVisible">{{ paymentSecretsVisible ? t('admin.hidePaymentSecrets') : t('admin.showPaymentSecrets') }}</button>
            <small v-if="paypalSecretSaved" class="secret-saved-note">{{ t('admin.paypalSecretSavedHelp') }}</small>
          </div>
          <div class="secret-field">
            <label>{{ t('admin.paypalWebhookIdLabel') }}<input v-model="paymentForm.paypal_webhook_id" :type="paymentSecretsVisible ? 'text' : 'password'" :placeholder="paypalWebhookSaved ? t('admin.paypalWebhookSavedPlaceholder') : 'PayPal Webhook ID'" maxlength="300" autocomplete="new-password" /></label>
            <small v-if="paypalWebhookSaved" class="secret-saved-note">{{ t('admin.paypalWebhookSavedHelp') }}</small>
            <small class="secret-saved-note">{{ t('admin.paypalWebhookIdHelp') }}</small>
          </div>
          <label>{{ t('admin.currency') }}<input v-model="paymentForm.currency" placeholder="USD" maxlength="3" autocapitalize="characters" inputmode="text" /></label>
        </div>
        <div class="paypal-webhook-note">
          <span>{{ t('admin.paypalWebhookUrl') }}</span>
          <code>{{ paypalWebhookUrl }}</code>
        </div>
        <p class="form-message warning">{{ t('admin.paypalLiveWarning') }}</p>
        <div class="row-actions compact-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="testPaypalConnection">
            {{ actionBusy('paypal-check') ? t('common.loading') : t('admin.paypalTestConnection') }}
          </button>
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="testPaypalOrder">
            {{ actionBusy('paypal-order-test') ? t('common.loading') : t('admin.paypalTestOrder') }}
          </button>
          <button class="button primary" type="submit" :disabled="!!savingAction">
            {{ actionBusy('site') ? t('common.loading') : t('admin.savePaypalConfig') }}
          </button>
        </div>
        <div v-if="paypalTestResult" class="paypal-test-result success">
          <strong>{{ t('admin.paypalOrderTestSuccessTitle') }}</strong>
          <span>{{ t('admin.paypalTestOrderId') }}: {{ paypalTestResult.paypal_order_id }}</span>
          <span>{{ t('admin.paypalTestStatus') }}: {{ paypalTestResult.paypal_status || '-' }}</span>
          <a v-if="paypalTestResult.approve_url" :href="paypalTestResult.approve_url" target="_blank" rel="noopener noreferrer">{{ t('admin.paypalOpenTestOrder') }}</a>
        </div>
        <pre v-if="paypalTestError" class="paypal-test-result error">{{ paypalTestError }}</pre>
      </form>
    </section>

    <section v-if="tab === 'site'" class="panel">
      <div class="admin-panel-head">
        <h2>{{ t('admin.siteConfig') }}</h2>
        <div class="row-actions compact-actions">
          <input ref="siteRestoreInput" class="sr-only" type="file" accept="application/json,.json" @change="restoreSiteConfig" />
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="openSiteRestorePicker">
            {{ actionBusy('site-restore') ? t('common.loading') : t('admin.restoreSiteConfig') }}
          </button>
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="downloadBackup()">
            {{ actionBusy('backup') ? t('common.loading') : t('admin.downloadBackup') }}
          </button>
          <button class="button ghost danger" type="button" :disabled="!!savingAction" @click="requestFullBackup">
            {{ actionBusy('backup-full') ? t('common.loading') : t('admin.downloadFullBackup') }}
          </button>
        </div>
      </div>
      <p class="form-message warning site-backup-warning">{{ t('admin.siteBackupRiskHelp') }}</p>
      <div v-if="siteRestoreUnsavedConfirmOpen" class="form-message warning unsaved-warning site-restore-unsaved">
        <span>{{ t('admin.restoreUnsavedSiteChanges') }}</span>
        <button class="button ghost" type="button" @click="keepEditingSiteConfig">{{ t('admin.keepEditing') }}</button>
        <button class="button danger" type="button" @click="discardSiteChangesAndRestore">{{ t('admin.discardAndRestore') }}</button>
      </div>
      <form class="admin-form" @submit.prevent="saveSite">
        <p v-if="siteFormDirty" class="form-message warning site-unsaved-warning">{{ t('admin.unsavedSiteChanges') }}</p>
        <div class="site-status-grid" data-testid="site-config-status">
          <p v-for="item in siteConfigStatusItems" :key="item.key" :class="`site-status-${item.tone}`">
            <span>{{ item.label }}</span>
            <strong>{{ item.status }}</strong>
          </p>
        </div>
        <div class="form-grid">
          <input v-model="siteForm.brand_name" :placeholder="t('admin.brandName')" maxlength="120" autocomplete="organization" />
          <input v-model="siteForm.email" type="email" :placeholder="t('admin.contactEmail')" maxlength="160" autocomplete="email" inputmode="email" />
          <input v-model="siteForm.instagram" type="url" placeholder="Instagram" maxlength="300" autocomplete="url" inputmode="url" />
          <input v-model="siteForm.tracking_url_template" type="url" :placeholder="t('admin.trackingUrlTemplate')" maxlength="500" autocomplete="url" inputmode="url" />
        </div>
        <h3>{{ t('admin.contact') }}</h3>
        <div class="form-grid">
          <label><input type="checkbox" v-model="contactForm.kakao_enabled" :aria-label="t('admin.enableKakao')" /> {{ t('admin.enableKakao') }}</label>
          <input v-model="contactForm.kakao_label" :placeholder="t('admin.kakaoLabel')" maxlength="40" />
          <input v-model="contactForm.kakao_id" :placeholder="t('admin.kakaoId')" maxlength="120" autocomplete="off" />
          <input v-model="contactForm.kakao_url" type="url" :placeholder="t('admin.kakaoUrl')" maxlength="300" autocomplete="url" inputmode="url" />
          <label><input type="checkbox" v-model="contactForm.whatsapp_enabled" :aria-label="t('admin.enableWhatsapp')" /> {{ t('admin.enableWhatsapp') }}</label>
          <input v-model="contactForm.whatsapp_label" :placeholder="t('admin.whatsappLabel')" maxlength="40" />
          <input v-model="contactForm.whatsapp_id" :placeholder="t('admin.whatsappId')" maxlength="120" autocomplete="off" />
          <input v-model="contactForm.whatsapp_url" type="url" :placeholder="t('admin.whatsappUrl')" maxlength="300" autocomplete="url" inputmode="url" />
        </div>
        <div class="section-head compact-admin-head">
          <h3>{{ t('admin.multilingualContent') }}</h3>
          <button class="button ghost site-translation-button" type="button" :disabled="!!savingAction || siteTranslationGenerating" @click="autoTranslateSiteContent">
            <Languages :size="15" />
            <span>{{ siteTranslationGenerating ? t('common.loading') : t('admin.siteAutoTranslate') }}</span>
          </button>
        </div>
        <p class="format-help">{{ t('admin.translationServiceNote') }}</p>
        <div class="translation-grid">
          <article v-for="lang in adminLangs" :key="lang" class="translation-panel">
            <h3>{{ lang === 'zh' ? t('admin.reviewZh') : lang === 'en' ? t('admin.reviewEnglish') : t('admin.reviewKorean') }}</h3>
            <label>
              <span>{{ t('admin.care') }}</span>
              <textarea v-model="policyI18n[lang].care" :placeholder="t('admin.care')" maxlength="2000" />
            </label>
            <label>
              <span>{{ t('admin.shipping') }}</span>
              <textarea v-model="policyI18n[lang].shipping" :placeholder="t('admin.shipping')" maxlength="2000" />
            </label>
            <label>
              <span>{{ t('admin.refund') }}</span>
              <textarea v-model="policyI18n[lang].refund" :placeholder="t('admin.refund')" maxlength="2000" />
            </label>
            <div class="content-editor-block">
              <div class="content-editor-head">
                <strong>{{ t('admin.faqEditorTitle') }}</strong>
                <span>{{ t('admin.faqEditorHelp') }}</span>
              </div>
              <code>问题|答案</code>
              <textarea v-model="faqI18n[lang]" class="tall-textarea" :aria-label="t('admin.faqText')" :placeholder="t('admin.faqText')" maxlength="120000" />
            </div>
          </article>
        </div>
        <div class="translation-grid single">
          <article class="translation-panel">
            <p class="format-help" data-testid="site-content-format-help">
              {{ t('admin.contentFormatHelp') }}
              客户评价格式 <code>姓名|国家|评分1-5|标题|内容|商品slug|头像URL|宠物照片URL|作品照片URL|视频URL</code>
              博客格式 <code>slug|日期|标题|摘要|正文|图片URL|标签</code>
            </p>
            <div class="content-editor-block">
              <div class="content-editor-head">
                <strong>{{ t('admin.reviewsEditorTitle') }}</strong>
                <span>{{ t('admin.reviewsEditorHelp') }}</span>
              </div>
              <code>例：王女士|中国|5|很像我家猫|细节和神态都很像|cat-portrait|头像URL|宠物照片URL|作品照片URL|视频URL</code>
              <textarea v-model="siteForm.reviews_text" class="tall-textarea" :aria-label="t('admin.reviewsText')" :placeholder="t('admin.reviewsText')" maxlength="200000" />
            </div>
            <div class="content-editor-block">
              <div class="content-editor-head">
                <strong>{{ t('admin.blogEditorTitle') }}</strong>
                <span>{{ t('admin.blogEditorHelp') }}</span>
              </div>
              <code>例：gift-guide|2026-01-01|宠物纪念礼物指南|摘要|正文内容|/images/blog.jpg|礼物,纪念</code>
              <textarea v-model="siteForm.blog_text" class="tall-textarea" :aria-label="t('admin.blogText')" :placeholder="t('admin.blogText')" maxlength="700000" />
            </div>
          </article>
        </div>
        <button class="button primary" :disabled="!!savingAction">{{ actionBusy('site') ? t('common.loading') : t('admin.saveConfig') }}</button>
      </form>
    </section>

    <div v-if="paypalHelpOpen" class="modal-backdrop" @click.self="paypalHelpOpen = false">
      <section class="admin-modal wide paypal-guide-modal" role="dialog" aria-modal="true" :aria-labelledby="'paypal-guide-title'">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.paypalEyebrow') }}</p>
            <h2 id="paypal-guide-title">{{ t('admin.paypalGuideTitle') }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" @click="paypalHelpOpen = false">×</button>
        </header>
        <p class="paypal-guide-intro">{{ t('admin.paypalGuideIntro') }}</p>
        <ol class="paypal-guide-list">
          <li>
            <div><strong>{{ t('admin.paypalGuideStep1Title') }}</strong><p>{{ t('admin.paypalGuideStep1Desc') }}</p></div>
            <a href="https://www.paypal.com/business" target="_blank" rel="noreferrer">{{ t('admin.paypalOpenBusiness') }} ↗</a>
          </li>
          <li><div><strong>{{ t('admin.paypalGuideStep2Title') }}</strong><p>{{ t('admin.paypalGuideStep2Desc') }}</p></div></li>
          <li><div><strong>{{ t('admin.paypalGuideStep3Title') }}</strong><p>{{ t('admin.paypalGuideStep3Desc') }}</p></div></li>
          <li><div><strong>{{ t('admin.paypalGuideStep4Title') }}</strong><p>{{ t('admin.paypalGuideStep4Desc') }}</p></div></li>
          <li><div><strong>{{ t('admin.paypalGuideStep5Title') }}</strong><p>{{ t('admin.paypalGuideStep5Desc') }}</p></div></li>
        </ol>
        <div class="paypal-guide-check">
          <strong>{{ t('admin.paypalGuideCheckTitle') }}</strong>
          <p>{{ t('admin.paypalGuideCheckDesc') }}</p>
          <code>{{ paypalWebhookUrl }}</code>
        </div>
        <p class="form-message warning">{{ t('admin.paypalGuideSecurity') }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" @click="paypalHelpOpen = false">{{ t('common.close') }}</button>
          <button class="button primary" type="button" @click="paypalHelpOpen = false">{{ t('admin.paypalGuideStartConfig') }}</button>
        </div>
      </section>
    </div>

    <div v-if="categoryModalOpen" class="modal-backdrop" @click.self="closeCategoryModal">
      <section class="admin-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.categories') }}</p>
            <h2>{{ categoryForm.id ? t('common.edit') : t('admin.addCategory') }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" @click="closeCategoryModal">×</button>
        </header>
        <form class="admin-form" @submit.prevent="saveCategory">
          <div v-if="categoryUnsavedConfirmOpen" class="form-message warning unsaved-warning">
            <span>{{ t('admin.unsavedCategoryChanges') }}</span>
            <button class="button ghost" type="button" @click="keepEditingCategoryForm">{{ t('admin.keepEditing') }}</button>
            <button class="button danger" type="button" @click="discardCategoryFormChanges">{{ t('admin.discardChanges') }}</button>
          </div>
          <div class="form-grid">
            <input v-model="categoryForm.slug" placeholder="slug" maxlength="80" required />
            <input v-model.number="categoryForm.sort_order" type="number" :placeholder="t('admin.sort')" min="0" max="9999" step="1" />
            <select v-model="categoryForm.status"><option v-for="s in publishStatuses" :key="s" :value="s">{{ statusText(s) }}</option></select>
          </div>
          <p v-if="categoryForm.status === 'hidden' && categoryHasPublishedProducts" class="form-message warning">{{ t('admin.categoryHasPublishedProducts') }}</p>
          <div class="section-head compact-admin-head">
            <h3>{{ t('admin.contentZh') }}</h3>
          </div>
          <div class="translation-grid single">
            <article class="translation-panel">
              <input v-model="categoryI18n.zh.title" :placeholder="t('admin.categoryName')" maxlength="120" required />
              <textarea v-model="categoryI18n.zh.description" :placeholder="t('admin.categoryDesc')" maxlength="1000" />
            </article>
          </div>
          <div class="modal-actions">
            <button class="button ghost" type="button" @click="closeCategoryModal">{{ t('common.close') }}</button>
            <button class="button primary" :disabled="!!savingAction">{{ actionBusy('category') ? t('common.loading') : t('admin.saveCategory') }}</button>
          </div>
        </form>
      </section>
    </div>

    <div v-if="productModalOpen" class="modal-backdrop" @click.self="closeProductModal">
      <section class="admin-modal wide" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.productsManage') }}</p>
            <h2>{{ productForm.id ? t('common.edit') : t('admin.addProduct') }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" @click="closeProductModal">×</button>
        </header>
        <form class="admin-form" @submit.prevent="saveProduct">
          <div v-if="productUnsavedConfirmOpen" class="form-message warning unsaved-warning">
            <span>{{ t('admin.unsavedProductChanges') }}</span>
            <button class="button ghost" type="button" @click="keepEditingProductForm">{{ t('admin.keepEditing') }}</button>
            <button class="button danger" type="button" @click="discardProductFormChanges">{{ t('admin.discardChanges') }}</button>
          </div>
          <div class="form-grid">
            <select v-model="productForm.category_id"><option v-for="c in categories" :key="c.id" :value="c.id">{{ translatedValue(c, 'title') }}</option></select>
            <input v-model="productForm.slug" placeholder="slug" maxlength="80" required />
            <label class="field">{{ t('admin.basePrice') }}
              <input v-model.number="productForm.base_price_cents" type="number" min="1" max="999999999" step="1" required />
            </label>
            <label class="field">{{ t('admin.currency') }}
              <input :value="productForm.currency" readonly />
            </label>
            <input v-model.number="productForm.deposit_percent" type="number" :placeholder="t('admin.depositPercent')" max="100" step="1" />
            <input v-model="productForm.image_url" type="text" :placeholder="t('admin.imageUrl')" maxlength="500" autocomplete="url" inputmode="url" />
            <select v-model="productForm.status"><option v-for="s in publishStatuses" :key="s" :value="s">{{ statusText(s) }}</option></select>
          </div>
          <p v-if="productForm.currency !== CURRENCY_BASE" class="form-message warning">{{ t('admin.krwCurrencyRequired') }}</p>
          <p v-else class="format-help" data-testid="product-price-preview">
            {{ t('admin.pricePreview') }}:
            {{ money(convertMinorAmount(productForm.base_price_cents, CURRENCY_BASE, 'USD'), 'USD') }} /
            {{ money(convertMinorAmount(productForm.base_price_cents, CURRENCY_BASE, 'CNY'), 'CNY') }}
          </p>
          <div class="content-editor-block compact-content-editor">
            <div class="content-editor-head">
              <strong>{{ t('admin.imagesText') }}</strong>
              <span>{{ t('admin.imagesHelp') }}</span>
            </div>
            <textarea v-model="productForm.images_text" :placeholder="t('admin.imagesText')" maxlength="5000" />
          </div>
          <p v-if="productCategoryHidden" class="form-message warning">{{ t('admin.productHiddenCategoryHelp') }}</p>
          <p class="format-help product-config-help" data-testid="product-config-help">
            {{ t('admin.productConfigHelp') }}
            示例 <code>6 英寸头部,160000</code>
          </p>
          <input v-model="productForm.tags" :placeholder="t('admin.tags')" maxlength="819" />
          <input v-model="productForm.use_cases_text" :placeholder="t('admin.useCasesText')" maxlength="1200" />
          <div class="section-head compact-admin-head">
            <h3>{{ t('admin.multilingualContent') }}</h3>
            <button class="button ghost site-translation-button" type="button" :disabled="!!savingAction || productTranslationGenerating" @click="autoTranslateProduct">
              <Languages :size="15" />
              <span>{{ productTranslationGenerating ? t('common.loading') : t('admin.productAutoTranslate') }}</span>
            </button>
          </div>
          <p class="format-help product-translation-help">{{ t('admin.productTranslationHelp') }}</p>
          <p class="format-help">{{ t('admin.translationServiceNote') }}</p>
          <div class="translation-grid">
            <article v-for="lang in adminLangs" :key="lang" class="translation-panel">
              <h3>{{ lang === 'zh' ? t('admin.reviewZh') : lang === 'en' ? t('admin.reviewEnglish') : t('admin.reviewKorean') }}</h3>
              <input v-model="productI18n[lang].title" :placeholder="t('admin.productTitle')" maxlength="160" :required="lang === 'zh'" />
              <input v-model="productI18n[lang].subtitle" :placeholder="t('admin.subtitle')" maxlength="240" />
              <input v-model="productI18n[lang].alt_text" :placeholder="t('admin.altText')" maxlength="180" />
              <input v-model="productI18n[lang].seo_title" :placeholder="t('admin.seoTitle')" maxlength="120" />
              <textarea v-model="productI18n[lang].description" :placeholder="t('admin.productDesc')" maxlength="5000" />
              <textarea v-model="productI18n[lang].seo_description" :placeholder="t('admin.seoDescription')" maxlength="300" />
              <p class="format-help compact-format-help">
                {{ t('admin.optionsText') }}
                <code>6 英寸头部,160000</code>
              </p>
              <textarea v-model="productI18n[lang].options_text" :placeholder="t('admin.optionsText')" maxlength="5000" />
            </article>
          </div>
          <div class="modal-actions">
            <button class="button ghost" type="button" @click="closeProductModal">{{ t('common.close') }}</button>
            <button class="button primary" :disabled="!!savingAction">{{ actionBusy('product') ? t('common.loading') : t('admin.saveProduct') }}</button>
          </div>
        </form>
      </section>
    </div>

    <div v-if="blogModalOpen" class="modal-backdrop" @click.self="closeBlogModal">
      <section class="admin-modal wide blog-editor-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.blogManage') }}</p>
            <h2>{{ blogForm.id ? t('admin.editBlog') : t('admin.addBlog') }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" :disabled="!!savingAction" @click="closeBlogModal">×</button>
        </header>
        <form class="admin-form" @submit.prevent="saveBlog">
          <div v-if="blogUnsavedConfirmOpen" class="form-message warning unsaved-warning">
            <span>{{ t('admin.unsavedBlogChanges') }}</span>
            <button class="button ghost" type="button" @click="keepEditingBlogForm">{{ t('admin.keepEditing') }}</button>
            <button class="button danger" type="button" @click="discardBlogFormChanges">{{ t('admin.discardChanges') }}</button>
          </div>
          <div class="form-grid">
            <input v-model="blogForm.slug" placeholder="slug" maxlength="100" required />
            <input v-model="blogForm.date" type="date" :aria-label="t('admin.blogDate')" required />
            <input v-model="blogForm.image_url" :placeholder="t('admin.blogImageUrl')" maxlength="500" />
            <input v-model="blogForm.tags_text" :placeholder="t('admin.blogTags')" maxlength="819" />
          </div>
          <div class="content-editor-block blog-rich-block">
            <div class="content-editor-head">
              <strong>{{ t('admin.blogZhEditorTitle') }}</strong>
              <span>{{ t('admin.blogRichTextHelp') }}</span>
            </div>
            <input v-model="blogI18n.zh.title" :placeholder="t('admin.blogTitle')" maxlength="200" required />
            <textarea v-model="blogI18n.zh.excerpt" :placeholder="t('admin.blogExcerpt')" maxlength="500" required />
            <div class="rich-editor-toolbar" :aria-label="t('admin.blogToolbar')">
              <button type="button" title="H2" @click="formatBlogContent('formatBlock', 'h2')">H2</button>
              <button type="button" title="H3" @click="formatBlogContent('formatBlock', 'h3')">H3</button>
              <button type="button" title="B" @click="formatBlogContent('bold')">B</button>
              <button type="button" title="I" @click="formatBlogContent('italic')">I</button>
              <button type="button" title="UL" @click="formatBlogContent('insertUnorderedList')">•</button>
              <button type="button" title="OL" @click="formatBlogContent('insertOrderedList')">1.</button>
              <button type="button" title="Quote" @click="formatBlogContent('formatBlock', 'blockquote')">“”</button>
              <button type="button" title="P" @click="formatBlogContent('formatBlock', 'p')">P</button>
            </div>
            <div
              :key="blogEditorKey"
              data-blog-editor="zh"
              class="rich-editor"
              contenteditable="true"
              role="textbox"
              aria-multiline="true"
              :aria-label="t('admin.blogContent')"
              v-html="blogI18n.zh.content"
              @input="onBlogEditorInput"
            ></div>
          </div>
          <div class="blog-translation-actions">
            <button class="button ghost" type="button" @click="autoTranslateBlog">{{ t('admin.blogAutoTranslate') }}</button>
            <span>{{ t('admin.blogTranslationDraft') }}</span>
          </div>
          <div class="translation-grid blog-translation-grid">
            <article class="translation-panel compact">
              <h3>{{ t('admin.blogEnglish') }}</h3>
              <input v-model="blogI18n.en.title" :placeholder="t('admin.blogTitle')" maxlength="200" />
              <textarea v-model="blogI18n.en.excerpt" :placeholder="t('admin.blogExcerpt')" maxlength="500" />
              <textarea v-model="blogI18n.en.content" class="tall-textarea" :placeholder="t('admin.blogContentHtml')" maxlength="6000" />
            </article>
            <article class="translation-panel compact">
              <h3>{{ t('admin.blogKorean') }}</h3>
              <input v-model="blogI18n.ko.title" :placeholder="t('admin.blogTitle')" maxlength="200" />
              <textarea v-model="blogI18n.ko.excerpt" :placeholder="t('admin.blogExcerpt')" maxlength="500" />
              <textarea v-model="blogI18n.ko.content" class="tall-textarea" :placeholder="t('admin.blogContentHtml')" maxlength="6000" />
            </article>
          </div>
          <div class="modal-actions">
            <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeBlogModal">{{ t('admin.cancel') }}</button>
            <button class="button primary" :disabled="!!savingAction">{{ actionBusy('blog-form') ? t('common.loading') : t('admin.saveBlog') }}</button>
          </div>
        </form>
      </section>
    </div>

    <div v-if="reviewModalOpen" class="modal-backdrop" @click.self="closeReviewModal">
      <section class="admin-modal wide review-editor-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.reviewsManage') }}</p>
            <h2>{{ reviewForm.id ? t('admin.editReview') : t('admin.addReview') }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" :disabled="!!savingAction || !!reviewUploadBusy" @click="closeReviewModal">×</button>
        </header>
        <form class="admin-form" @submit.prevent="saveReview">
          <div v-if="reviewUnsavedConfirmOpen" class="form-message warning unsaved-warning">
            <span>{{ t('admin.unsavedReviewChanges') }}</span>
            <button class="button ghost" type="button" @click="keepEditingReviewForm">{{ t('admin.keepEditing') }}</button>
            <button class="button danger" type="button" @click="discardReviewFormChanges">{{ t('admin.discardChanges') }}</button>
          </div>
          <div class="form-grid">
            <label>{{ t('admin.reviewName') }}<input v-model="reviewForm.name" maxlength="120" required /></label>
            <label>{{ t('admin.reviewCountry') }}<input v-model="reviewForm.country" maxlength="80" required /></label>
            <label>{{ t('admin.reviewRating') }}<input v-model.number="reviewForm.rating" type="number" min="1" max="5" step="1" required /></label>
            <label>{{ t('admin.reviewStatus') }}<select v-model="reviewForm.status"><option v-for="status in publishStatuses" :key="status" :value="status">{{ statusText(status) }}</option></select></label>
            <label>{{ t('admin.reviewProductSlug') }}<input v-model="reviewForm.product_slug" maxlength="100" /></label>
            <label>{{ t('admin.reviewVideoUrl') }}<input v-model="reviewForm.video_url" type="url" maxlength="500" inputmode="url" /></label>
          </div>
          <div class="review-media-editor">
            <div class="content-editor-head">
              <strong>{{ t('admin.reviewAvatar') }}</strong>
              <span>{{ t('admin.reviewImagesHelp') }}</span>
            </div>
            <div class="review-upload-row">
              <input ref="reviewAvatarInput" class="sr-only" type="file" accept="image/*" @change="uploadReviewFiles($event, 'avatar')" />
              <button class="button ghost" type="button" :disabled="!!reviewUploadBusy" @click="reviewAvatarInput?.click()">
                <Upload :size="15" />{{ reviewUploadBusy === 'avatar' ? t('common.loading') : t('admin.reviewUploadAvatar') }}
              </button>
              <input v-model="reviewForm.avatar_url" :placeholder="t('admin.reviewAvatarUrl')" maxlength="500" />
            </div>
            <div class="review-upload-row">
              <input ref="reviewImageInput" class="sr-only" type="file" accept="image/*" multiple @change="uploadReviewFiles($event, 'images')" />
              <button class="button ghost" type="button" :disabled="!!reviewUploadBusy" @click="reviewImageInput?.click()">
                <ImagePlus :size="15" />{{ reviewUploadBusy === 'images' ? t('common.loading') : t('admin.reviewUploadImages') }}
              </button>
              <span class="muted">{{ t('admin.reviewImagesHelp') }}</span>
            </div>
            <textarea v-model="reviewForm.images_text" :placeholder="t('admin.reviewImageUrl')" maxlength="12000" />
            <div v-if="reviewDraftImages().length" class="review-media-preview-grid">
              <div v-for="(image, index) in reviewDraftImages()" :key="`${image}-${index}`" class="review-media-preview">
                <img :src="resolveContentImage(image)" :alt="`${t('admin.reviewImages')} ${index + 1}`" loading="lazy" />
                <button class="icon-button" type="button" :aria-label="t('admin.reviewRemoveImage')" :title="t('admin.reviewRemoveImage')" @click="removeReviewImage(index)"><X :size="15" /></button>
              </div>
            </div>
          </div>
          <p class="format-help">{{ t('admin.reviewTranslationHelp') }}</p>
          <div class="translation-grid review-translation-grid">
            <article v-for="lang in adminLangs" :key="lang" class="translation-panel compact">
              <h3>{{ lang === 'zh' ? t('admin.reviewZh') : lang === 'en' ? t('admin.reviewEnglish') : t('admin.reviewKorean') }}</h3>
              <input v-model="reviewI18n[lang].title" :placeholder="t('admin.reviewTitle')" maxlength="200" :required="lang === 'zh'" />
              <textarea v-model="reviewI18n[lang].content" :placeholder="t('admin.reviewContent')" class="tall-textarea" maxlength="2000" :required="lang === 'zh'" />
            </article>
          </div>
          <div class="modal-actions">
            <button class="button ghost" type="button" :disabled="!!savingAction || !!reviewUploadBusy" @click="closeReviewModal">{{ t('admin.cancel') }}</button>
            <button class="button primary" :disabled="!!savingAction || !!reviewUploadBusy">{{ actionBusy('review-form') ? t('common.loading') : t('admin.saveReview') }}</button>
          </div>
        </form>
      </section>
    </div>

    <div v-if="deleteBlogTarget" class="modal-backdrop" @click.self="closeDeleteBlogModal">
      <section class="admin-modal confirm-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.blogManage') }}</p>
            <h2>{{ t('admin.deleteBlogTitle') }}</h2>
          </div>
          <button class="drawer-close" :disabled="!!savingAction" @click="closeDeleteBlogModal">×</button>
        </header>
        <p class="muted">{{ t('admin.deleteBlogConfirm', { title: blogField(deleteBlogTarget, 'title') || deleteBlogTarget.slug }) }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeDeleteBlogModal">{{ t('admin.cancel') }}</button>
          <button class="button danger" type="button" :disabled="!!savingAction" @click="confirmDeleteBlog">
            {{ actionBusy(`blog-delete-${deleteBlogTarget.id || deleteBlogTarget.slug}`) ? t('common.loading') : t('admin.confirmDelete') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="deleteReviewTarget" class="modal-backdrop" @click.self="closeDeleteReviewModal">
      <section class="admin-modal confirm-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.reviewsManage') }}</p>
            <h2>{{ t('admin.deleteReviewTitle') }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" :disabled="!!savingAction" @click="closeDeleteReviewModal">×</button>
        </header>
        <p class="muted">{{ t('admin.deleteReviewConfirm', { title: reviewField(deleteReviewTarget, 'title', 'zh') || deleteReviewTarget.name }) }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeDeleteReviewModal">{{ t('admin.cancel') }}</button>
          <button class="button danger" type="button" :disabled="!!savingAction" @click="confirmDeleteReview">
            <Trash2 :size="15" />{{ actionBusy(`review-delete-${deleteReviewTarget.id}`) ? t('common.loading') : t('admin.confirmDelete') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="deleteProductTarget" class="modal-backdrop" @click.self="closeDeleteProductModal">
      <section class="admin-modal confirm-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.productsManage') }}</p>
            <h2>{{ t('admin.deleteProductTitle') }}</h2>
          </div>
          <button class="drawer-close" :disabled="!!savingAction" @click="closeDeleteProductModal">×</button>
        </header>
        <p class="muted">{{ t('admin.deleteProductConfirm', { title: translatedValue(deleteProductTarget, 'title') }) }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeDeleteProductModal">{{ t('admin.cancel') }}</button>
          <button class="button danger" type="button" :disabled="!!savingAction" @click="confirmDeleteProduct">
            {{ actionBusy(`product-delete-${deleteProductTarget.id}`) ? t('common.loading') : t('admin.confirmDelete') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="deleteCategoryTarget" class="modal-backdrop" @click.self="closeDeleteCategoryModal">
      <section class="admin-modal confirm-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.categories') }}</p>
            <h2>{{ t('admin.deleteCategoryTitle') }}</h2>
          </div>
          <button class="drawer-close" :disabled="!!savingAction" @click="closeDeleteCategoryModal">×</button>
        </header>
        <p class="muted">{{ t('admin.deleteCategoryConfirm', { title: translatedValue(deleteCategoryTarget, 'title') }) }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeDeleteCategoryModal">{{ t('admin.cancel') }}</button>
          <button class="button danger" type="button" :disabled="!!savingAction" @click="confirmDeleteCategory">
            {{ actionBusy(`category-delete-${deleteCategoryTarget.id}`) ? t('common.loading') : t('admin.confirmDelete') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="deleteUserTarget" class="modal-backdrop" @click.self="closeDeleteUserModal">
      <section class="admin-modal confirm-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.usersManage') }}</p>
            <h2>{{ t('admin.deleteUserTitle') }}</h2>
          </div>
          <button class="drawer-close" :disabled="!!savingAction" @click="closeDeleteUserModal">×</button>
        </header>
        <p class="muted">{{ t('admin.deleteUserConfirm', { name: deleteUserTarget.name || deleteUserTarget.email }) }}</p>
        <p v-if="deleteUserTarget.order_count" class="form-message warning">{{ t('admin.deleteUserOrderWarning') }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeDeleteUserModal">{{ t('admin.cancel') }}</button>
          <button class="button danger" type="button" :disabled="!!savingAction" @click="confirmDeleteUser">
            {{ actionBusy(`user-delete-${deleteUserTarget.id}`) ? t('common.loading') : t('admin.confirmDelete') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="orderChangeConfirm" class="modal-backdrop" @click.self="closeOrderChangeConfirm">
      <section class="admin-modal confirm-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.ordersManage') }}</p>
            <h2>{{ t('admin.confirmOrderChangeTitle') }}</h2>
          </div>
          <button class="drawer-close" :disabled="!!savingAction" @click="closeOrderChangeConfirm">×</button>
        </header>
        <p class="muted">{{ t('admin.confirmOrderChangeDesc') }}</p>
        <div class="confirm-lines">
          <p><span>{{ t('admin.order') }}</span><strong>{{ orderChangeConfirm.order.order_no }}</strong></p>
          <p><span>{{ t('admin.customer') }}</span><strong>{{ orderChangeConfirm.order.customer_name || orderChangeConfirm.order.email }}</strong></p>
          <p>
            <span>{{ orderChangeConfirm.field === 'status' ? t('admin.status') : t('admin.payment') }}</span>
            <strong>{{ statusText(orderChangeConfirm.previous) }} => {{ statusText(orderChangeConfirm.next) }}</strong>
          </p>
        </div>
        <div class="modal-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeOrderChangeConfirm">{{ t('admin.cancel') }}</button>
          <button class="button danger" type="button" :disabled="!!savingAction" @click="confirmOrderChange">
            {{ savingAction.startsWith(`order-${orderChangeConfirm.order.id}`) ? t('common.loading') : t('admin.confirmOrderChange') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="fullBackupConfirmOpen" class="modal-backdrop" @click.self="closeFullBackupConfirm">
      <section class="admin-modal confirm-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.siteConfig') }}</p>
            <h2>{{ t('admin.fullBackupConfirmTitle') }}</h2>
          </div>
          <button class="drawer-close" :disabled="!!savingAction" @click="closeFullBackupConfirm">×</button>
        </header>
        <p class="muted">{{ t('admin.fullBackupConfirmDesc') }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeFullBackupConfirm">{{ t('admin.cancel') }}</button>
          <button class="button danger" type="button" :disabled="!!savingAction" @click="confirmFullBackupDownload">
            {{ actionBusy('backup-full') ? t('common.loading') : t('admin.confirmFullBackup') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="userModalOpen" class="modal-backdrop" @click.self="closeUserModal">
      <section class="admin-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p class="eyebrow">{{ t('admin.usersManage') }}</p>
            <h2>{{ userForm.id ? t('admin.editUser') : t('admin.addUser') }}</h2>
          </div>
          <button class="drawer-close" type="button" :aria-label="t('common.close')" :disabled="!!savingAction" @click="closeUserModal">×</button>
        </header>
        <form class="admin-form" @submit.prevent="saveUserForm">
          <div v-if="userUnsavedConfirmOpen" class="form-message warning unsaved-warning">
            <span>{{ t('admin.unsavedUserChanges') }}</span>
            <button class="button ghost" type="button" @click="keepEditingUserForm">{{ t('admin.keepEditing') }}</button>
            <button class="button danger" type="button" @click="discardUserFormChanges">{{ t('admin.discardChanges') }}</button>
          </div>
          <div class="form-grid">
            <input v-model="userForm.name" :placeholder="t('admin.userName')" maxlength="120" required />
            <input v-model="userForm.email" type="email" :placeholder="t('admin.email')" maxlength="160" required />
            <input v-model="userForm.country" :placeholder="t('order.country')" maxlength="120" />
            <select v-model="userForm.status"><option v-for="s in userStatuses" :key="s" :value="s">{{ statusText(s) }}</option></select>
          </div>
          <input v-model="userForm.tags_text" :placeholder="t('admin.tags')" maxlength="819" />
          <textarea v-model="userForm.internal_note" :placeholder="t('admin.note')" maxlength="2000" />
          <div class="followup-box">
            <div class="form-grid compact-fields">
              <input v-model="userForm.followup_text" :placeholder="t('admin.followupPlaceholder')" maxlength="500" />
              <input v-model="userForm.followup_next_at" type="date" :aria-label="t('admin.nextFollowupDate')" />
            </div>
            <button class="button ghost" type="button" @click="addFollowup(userForm)">{{ t('admin.addFollowup') }}</button>
            <div v-if="userForm.followups?.length" class="followup-list">
              <p v-for="item in userForm.followups.slice(0, 5)" :key="item.id">
                <strong>{{ formatDate(item.created_at) }}</strong>
                <span>{{ item.content }}</span>
                <small v-if="item.next_at">{{ t('admin.nextFollowupDate') }} {{ item.next_at }}</small>
              </p>
            </div>
          </div>
          <div class="modal-actions">
            <button class="button ghost" type="button" :disabled="!!savingAction" @click="closeUserModal">{{ t('admin.cancel') }}</button>
            <button class="button primary" :disabled="!!savingAction">{{ actionBusy('user-form') ? t('common.loading') : t('admin.saveUser') }}</button>
          </div>
        </form>
      </section>
    </div>
    </template>
  </main>
</template>
