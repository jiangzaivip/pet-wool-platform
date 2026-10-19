<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ChevronLeft, ChevronRight, Check, X, ZoomIn } from '@lucide/vue'
import { api, supportContacts, type Product, type SiteSettings, type ProductOption } from '../api'
import { displayMoney, majorAmountString } from '../currency'
import { productGallery, productImage, useProductImageFallback } from '../contentImages'
import { setHead, setJsonLd } from '../head'

const { locale, t, tm } = useI18n()
const route = useRoute()
const router = useRouter()
const product = ref<Product | null>(null)
const relatedProducts = ref<Product[]>([])
const site = ref<SiteSettings>({})
const selectedOptionId = ref('')
const paymentType = ref('deposit')
const loading = ref(true)
const loadError = ref('')
const selectedImageIndex = ref(0)
const lightboxOpen = ref(false)
const touchStartX = ref(0)

const selectedOption = computed<ProductOption | undefined>(() => product.value?.options?.find(o => o.id === selectedOptionId.value) || product.value?.options?.[0])
const canOrder = computed(() => Boolean(product.value?.id && selectedOption.value?.id))
const supportContact = computed(() => {
  const contacts = supportContacts(site.value, t('support.emailLabel'))
  return contacts.find(contact => contact.key === 'kakao') || contacts.find(contact => contact.key === 'whatsapp') || contacts.find(contact => contact.key === 'email') || null
})
const detailFaqs = computed(() => {
  const seen = new Set<string>()
  return [...(product.value?.faqs || []), ...(site.value.faq || [])]
    .filter((faq: any) => {
      const key = String(faq.question || '').trim().toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
})
const gallery = computed(() => product.value ? productGallery(product.value) : [])
const selectedImage = computed(() => gallery.value[selectedImageIndex.value] || gallery.value[0] || '')
const baseAmount = computed(() => selectedOption.value?.price_cents || product.value?.base_price_cents || 0)
const amount = computed(() => {
  const p = product.value
  if (!p) return 0
  return paymentType.value === 'full' ? baseAmount.value : Math.round(baseAmount.value * p.deposit_percent / 100)
})

function absoluteUrl(value = '') {
  try {
    return new URL(value, window.location.origin).href
  } catch {
    return value
  }
}

function updateProductStructuredData() {
  const current = product.value
  if (!current) {
    setJsonLd('product-detail', null)
    setJsonLd('product-breadcrumb', null)
    return
  }
  const option = current.options?.[0]
  const productUrl = `${window.location.origin}/products/${current.slug || route.params.slug}`
  setJsonLd('product-detail', {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: current.title,
    description: current.seo_description || current.description,
    image: productGallery(current).map((image) => absoluteUrl(image)),
    sku: current.slug || current.id,
    brand: {
      '@type': 'Brand',
      name: site.value.brand?.name || 'WoolBuddy',
    },
    offers: {
      '@type': 'Offer',
      url: productUrl,
      priceCurrency: current.currency || 'KRW',
      price: majorAmountString(option?.price_cents || current.base_price_cents || 0, current.currency || 'KRW'),
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
    },
  })
  setJsonLd('product-breadcrumb', {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('nav.shop'), item: `${window.location.origin}/collections` },
      { '@type': 'ListItem', position: 2, name: current.category?.title || current.title, item: `${window.location.origin}/collections/${current.subcategory_slug || current.category?.slug || ''}` },
      { '@type': 'ListItem', position: 3, name: current.title, item: productUrl },
    ],
  })
  setJsonLd('product-faq', detailFaqs.value.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: detailFaqs.value.map((faq: any) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer }
    }))
  } : null)
}

async function load() {
  loading.value = true
  loadError.value = ''
  const previousOptionId = selectedOptionId.value
  product.value = null
  relatedProducts.value = []
  try {
    product.value = await api<Product>(`/products/${route.params.slug}?lang=${locale.value}`)
    site.value = await api<SiteSettings>(`/site?lang=${locale.value}`).catch(() => ({} as SiteSettings))
    try {
      const products = await api<Product[]>(`/products?lang=${locale.value}`)
      relatedProducts.value = products
        .filter(item => item.id !== product.value?.id)
        .sort((a, b) => Number(b.category_id === product.value?.category_id) - Number(a.category_id === product.value?.category_id))
        .slice(0, 3)
    } catch {
      relatedProducts.value = []
    }
    selectedOptionId.value = product.value.options?.some(option => option.id === previousOptionId)
      ? previousOptionId
      : product.value.options?.[0]?.id || ''
    selectedImageIndex.value = 0
    setHead(product.value.seo_title || product.value.title, product.value.seo_description || product.value.description, {
      canonical: `${window.location.origin}/products/${product.value.slug || route.params.slug}`,
      image: productImage(product.value),
    })
    updateProductStructuredData()
  } catch {
    loadError.value = t('common.loadFailed')
    setHead(t('detail.notFoundTitle'), t('common.loadFailed'), {
      canonical: `${window.location.origin}/products/${route.params.slug}`,
      robots: 'noindex,follow',
    })
    setJsonLd('product-detail', null)
    setJsonLd('product-breadcrumb', null)
    setJsonLd('product-faq', null)
  } finally {
    loading.value = false
  }
}

function selectImage(index: number) {
  if (!gallery.value.length) return
  selectedImageIndex.value = (index + gallery.value.length) % gallery.value.length
}

function moveImage(direction: number) {
  selectImage(selectedImageIndex.value + direction)
}

function onGalleryTouchStart(event: TouchEvent) {
  touchStartX.value = event.changedTouches[0]?.clientX || 0
}

function onGalleryTouchEnd(event: TouchEvent) {
  const distance = (event.changedTouches[0]?.clientX || 0) - touchStartX.value
  if (Math.abs(distance) < 45) return
  moveImage(distance > 0 ? -1 : 1)
}

function orderNow() {
  if (!canOrder.value) return
  router.push({ path: '/order', query: { product: product.value?.id, option: selectedOptionId.value, payment: paymentType.value } })
}

function productSupportSummary(compact = false) {
  const current = product.value
  if (!current) return ''
  const lines = [
    `${t('detail.supportProduct')} ${current.title || '-'}`,
    `${t('detail.supportOption')} ${selectedOption.value?.name || '-'}`,
    `${t('detail.supportPayment')} ${paymentType.value === 'full' ? t('detail.payFull') : t('detail.payDeposit')}`,
    `${t('detail.supportAmount')} ${displayMoney(amount.value, current.currency, locale.value)}`,
    `${t('detail.supportPage')} ${window.location.href}`,
  ]
  if (!compact) {
    lines.push(t('detail.supportPrompt'))
  }
  return lines.join('\n')
}

function supportUrlForProduct() {
  const contact = supportContact.value
  if (!contact || !product.value) return contact?.url || ''
  const subject = `${t('detail.supportSubject')} ${product.value.title || ''}`.trim()
  if (contact.url.startsWith('mailto:')) {
    const [baseUrl, queryText = ''] = contact.url.split('?')
    const params = new URLSearchParams(queryText)
    if (!params.has('subject')) params.set('subject', subject)
    if (!params.has('body')) params.set('body', productSupportSummary(false))
    return `${baseUrl}?${params.toString()}`
  }
  try {
    const url = new URL(contact.url)
    const messageKey = url.searchParams.has('text') ? 'message' : 'text'
    if (!url.searchParams.has('text') && !url.searchParams.has('message')) {
      url.searchParams.set(messageKey, productSupportSummary(true))
    }
    return url.toString()
  } catch {
    return contact.url
  }
}

function policyText(key: 'care' | 'shipping' | 'refund') {
  return site.value.policies?.[key] || t(`detail.${key}Fallback`)
}

onMounted(load)
watch(locale, load)
watch(() => route.params.slug, load)
</script>

<template>
  <main class="section detail-page">
    <section v-if="loading" class="panel">
      <p class="muted">{{ t('common.loading') }}</p>
    </section>
    <section v-else-if="loadError" class="panel">
      <h1>{{ t('detail.notFoundTitle') }}</h1>
      <p class="muted">{{ t('detail.notFoundDesc') }}</p>
      <div class="actions">
        <RouterLink class="button primary" to="/collections">{{ t('detail.backToCollections') }}</RouterLink>
        <RouterLink class="button ghost" to="/order">{{ t('detail.uploadAndOrder') }}</RouterLink>
        <RouterLink class="button ghost" to="/support">{{ t('detail.consult') }}</RouterLink>
        <button class="button ghost" @click="load">{{ t('detail.retry') }}</button>
      </div>
    </section>
    <template v-else-if="product">
    <div class="product-detail-shell">
      <div class="detail-gallery">
        <div class="detail-main-media" @touchstart.passive="onGalleryTouchStart" @touchend.passive="onGalleryTouchEnd">
          <button v-if="gallery.length > 1" class="gallery-nav previous" type="button" :aria-label="t('detail.previousImage')" @click="moveImage(-1)"><ChevronLeft :size="22" /></button>
          <button class="detail-image-zoom" type="button" :aria-label="t('detail.zoomImage')" @click="lightboxOpen = true">
            <img class="detail-main-img" :src="selectedImage" :alt="product.alt_text || product.title" @error="useProductImageFallback" />
            <span><ZoomIn :size="18" />{{ t('detail.zoomImage') }}</span>
          </button>
          <button v-if="gallery.length > 1" class="gallery-nav next" type="button" :aria-label="t('detail.nextImage')" @click="moveImage(1)"><ChevronRight :size="22" /></button>
        </div>
        <div class="detail-thumbs">
          <button v-for="(img, index) in gallery" :key="`${img}-${index}`" type="button" :class="{ active: selectedImageIndex === index }" @click="selectImage(index)">
            <img :src="img" :alt="`${product.alt_text || product.title} detail ${index + 1}`" loading="lazy" decoding="async" @error="useProductImageFallback" />
          </button>
        </div>
      </div>
      <div class="detail-info">
        <p class="eyebrow">{{ product.category?.title || t('detail.fallbackCategory') }}</p>
        <h1>{{ product.title }}</h1>
        <p class="lead preserve-lines">{{ product.subtitle }}</p>
        <div class="detail-selectors">
          <label>{{ t('detail.option') }}
            <select v-model="selectedOptionId">
              <option v-for="option in product.options" :key="option.id" :value="option.id">{{ option.name }} - {{ displayMoney(option.price_cents, product.currency, locale) }}</option>
            </select>
          </label>
          <label>{{ t('detail.payment') }}
            <select v-model="paymentType">
              <option value="deposit">{{ t('detail.payDeposit') }}</option>
              <option value="full">{{ t('detail.payFull') }}</option>
            </select>
          </label>
        </div>
        <div class="price-box-detail">
          <span>{{ t('detail.amountDue') }}</span>
          <strong>{{ displayMoney(amount, product.currency, locale) }}</strong>
          <div class="price-breakdown">
            <p><span>{{ t('detail.optionPrice') }}</span><strong>{{ displayMoney(baseAmount, product.currency, locale) }}</strong></p>
            <p><span>{{ t('detail.depositPercent') }}</span><strong>{{ product.deposit_percent }}%</strong></p>
          </div>
          <small>{{ t('detail.paymentHint') }}</small>
        </div>
        <div class="detail-prep-card">
          <strong>{{ t('detail.prepTitle') }}</strong>
          <ul>
            <li v-for="item in tm('detail.prepItems')" :key="item">{{ item }}</li>
          </ul>
        </div>
        <div class="included-service-card">
          <strong>{{ t('detail.includedTitle') }}</strong>
          <div><span v-for="item in tm('detail.includedItems')" :key="String(item)"><Check :size="15" />{{ item }}</span></div>
        </div>
        <div class="actions">
          <button class="button primary" :disabled="!canOrder" @click="orderNow">{{ t('detail.uploadAndOrder') }}</button>
          <a
            v-if="supportContact"
            class="button ghost"
            :href="supportUrlForProduct()"
            :target="supportContact.external ? '_blank' : undefined"
            :rel="supportContact.external ? 'noopener noreferrer' : undefined"
          >{{ t(supportContact.ctaKey) }}</a>
          <RouterLink v-else class="button ghost" to="/support">{{ t('detail.consult') }}</RouterLink>
        </div>
        <div class="assurance-grid">
          <div v-for="item in tm('detail.assurances')" :key="item.title"><strong>{{ item.title }}</strong><span>{{ item.desc }}</span></div>
        </div>
        <div class="payment-trust-line"><strong>{{ t('detail.paymentMethods') }}</strong><span>PayPal</span><small>{{ t('detail.paypalOnly') }}</small></div>
        <p v-if="!canOrder" class="form-message error">{{ t('order.optionUnavailable') }}</p>
        <div class="tag-row compact"><span v-for="tag in product.tags" :key="tag">{{ tag }}</span></div>
      </div>
    </div>

    <div id="support" class="detail-panels premium-panels">
      <article><h3>{{ t('detail.description') }}</h3><p class="preserve-lines">{{ product.description }}</p></article>
      <article><h3>{{ t('detail.useCases') }}</h3><p>{{ product.use_cases?.join(' · ') || t('detail.useCasesFallback') }}</p></article>
      <article><h3>{{ t('detail.care') }}</h3><p class="preserve-lines">{{ policyText('care') }}</p></article>
      <article><h3>{{ t('detail.shipping') }}</h3><p class="preserve-lines">{{ policyText('shipping') }}</p></article>
      <article><h3>{{ t('detail.refund') }}</h3><p class="preserve-lines">{{ policyText('refund') }}</p></article>
      <article>
        <h3>{{ t('detail.faq') }}</h3>
        <p v-for="item in detailFaqs" :key="item.question || item.id"><strong>{{ item.question }}</strong><br>{{ item.answer }}</p>
        <p v-if="!detailFaqs.length">{{ t('detail.faqFallback') }}</p>
      </article>
    </div>
    <section v-if="relatedProducts.length" class="related-products">
      <div class="section-head compact">
        <div>
          <p class="eyebrow">{{ t('detail.relatedEyebrow') }}</p>
          <h2>{{ t('detail.relatedTitle') }}</h2>
        </div>
        <RouterLink class="button ghost" to="/collections">{{ t('common.collections') }}</RouterLink>
      </div>
      <div class="product-grid premium-grid">
        <article v-for="item in relatedProducts" :key="item.id" class="product-card premium-product">
          <RouterLink :to="`/products/${item.slug}`">
            <img :src="productImage(item)" :alt="item.alt_text || item.title" @error="useProductImageFallback" />
          </RouterLink>
          <div class="product-body">
            <p class="eyebrow mini">{{ item.category?.title || t('detail.fallbackCategory') }}</p>
            <h3><RouterLink :to="`/products/${item.slug}`">{{ item.title }}</RouterLink></h3>
            <p>{{ item.subtitle || item.description }}</p>
            <div class="product-card-proof"><span>★★★★★</span><small>{{ t('detail.cardCycle') }}</small><small>{{ t('detail.cardHandmade') }}</small></div>
            <div class="price-row">
              <div><small>{{ t('common.from') }}</small><strong>{{ displayMoney(item.base_price_cents, item.currency, locale) }}</strong></div>
              <span>{{ t('detail.cardDeposit') }}</span>
            </div>
            <div class="card-actions">
              <RouterLink class="button ghost" :to="`/products/${item.slug}`">{{ t('common.viewDetails') }}</RouterLink>
              <RouterLink class="button primary" :to="{ path: '/order', query: { product: item.id } }">{{ t('common.orderNow') }}</RouterLink>
            </div>
          </div>
        </article>
      </div>
    </section>
    <section class="detail-trust-section">
      <h2>{{ t('detail.trustTitle') }}</h2>
      <div><article v-for="stat in tm('detail.trustStats')" :key="stat.label"><strong>{{ stat.value }}</strong><span>{{ stat.label }}</span></article></div>
    </section>
    <div v-if="lightboxOpen" class="image-lightbox" role="dialog" aria-modal="true" :aria-label="t('detail.zoomImage')" @click.self="lightboxOpen = false">
      <button class="icon-button lightbox-close" type="button" :aria-label="t('detail.closeImage')" @click="lightboxOpen = false"><X :size="24" /></button>
      <button v-if="gallery.length > 1" class="gallery-nav previous" type="button" :aria-label="t('detail.previousImage')" @click="moveImage(-1)"><ChevronLeft :size="28" /></button>
      <img :src="selectedImage" :alt="product.alt_text || product.title" @error="useProductImageFallback" />
      <button v-if="gallery.length > 1" class="gallery-nav next" type="button" :aria-label="t('detail.nextImage')" @click="moveImage(1)"><ChevronRight :size="28" /></button>
    </div>
    </template>
  </main>
</template>
