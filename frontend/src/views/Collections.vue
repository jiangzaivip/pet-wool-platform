<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, primarySupportContact, type Category, type Product, type SiteSettings } from '../api'
import { displayMoney } from '../currency'
import { productFallbackImage, productImage, useProductImageFallback } from '../contentImages'
import { setHead, setJsonLd } from '../head'

const { locale, t, tm } = useI18n()
const route = useRoute()
const router = useRouter()
const categories = ref<Category[]>([])
const products = ref<Product[]>([])
const site = ref<SiteSettings>({})
const active = ref('')
const activeOccasion = ref('')
const loading = ref(true)
const productLoading = ref(false)
const loadError = ref('')
const productLoadError = ref('')
const productCache = new Map<string, Product[]>()
let productRequestId = 0

async function focusProductsOnMobile() {
  if (typeof window === 'undefined' || !window.matchMedia('(max-width: 640px)').matches) return
  await nextTick()
  requestAnimationFrame(() => {
    document.getElementById('collection-products')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

// Category changes can trigger overlapping requests. The request id and cache
// below prevent a slower previous response from replacing the current filter.
const supportContact = computed(() => {
  return primarySupportContact(site.value, t('support.emailLabel'))
})

const activeCategory = computed<any>(() => categories.value.find((category: any) =>
  category.slug === active.value || category.children?.some((child: any) => child.slug === active.value)
) || categories.value[0])
const activeChild = computed<any>(() => activeCategory.value?.children?.find((child: any) => child.slug === active.value))
const title = computed(() => activeChild.value?.title || activeCategory.value?.title || t('collections.fallbackTitle'))
const description = computed(() => activeChild.value?.description || activeCategory.value?.description || '')
const seoTitle = computed(() => {
  const filters = [activeOccasion.value].filter(Boolean)
  return filters.length ? `${title.value} - ${filters.join(' / ')}` : String(title.value)
})
const seoDescription = computed(() => {
  const base = description.value || t('home.heroDesc')
  const filters = [activeOccasion.value].filter(Boolean)
  return filters.length ? `${base} ${t('collections.filteredDesc', { filters: filters.join(' / ') })}` : base
})

function updateHead() {
  const categoryPath = active.value ? `/collections/${encodeURIComponent(active.value)}` : '/collections'
  setHead(seoTitle.value, seoDescription.value, {
    canonical: `${window.location.origin}${categoryPath}`,
    image: productFallbackImage,
  })
  setJsonLd('collection-item-list', {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: seoTitle.value,
    description: seoDescription.value,
    url: `${window.location.origin}${categoryPath}`,
    itemListElement: products.value.map((product, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: `${window.location.origin}/products/${product.slug}`,
      name: product.title,
    })),
  })
}

function categoryExists(slug: string) {
  return categories.value.some((category: any) => category.slug === slug || category.children?.some((child: any) => child.slug === slug))
}

function normalizeActiveCategory(next: unknown) {
  const candidate = String(next || '')
  const fallback = categories.value[0]?.slug || ''
  const normalized = candidate && categoryExists(candidate) ? candidate : fallback
  active.value = normalized
  if (candidate && candidate !== normalized) {
    void router.replace({ path: normalized ? `/collections/${normalized}` : '/collections', query: { occasion: activeOccasion.value || undefined } })
    return false
  }
  return true
}

function syncFiltersFromRoute() {
  activeOccasion.value = String(route.query.occasion || '')
  return normalizeActiveCategory(route.params.category || route.query.category)
}

function productCacheKey() {
  return [
    String(locale.value),
    active.value,
    activeOccasion.value,
  ].join('|')
}

async function load() {
  loading.value = true
  loadError.value = ''
  productLoadError.value = ''
  try {
    const [categoryData, siteData] = await Promise.all([
      api<Category[]>(`/categories?lang=${locale.value}`),
      api<SiteSettings>(`/site?lang=${locale.value}`)
    ])
    categories.value = categoryData
    site.value = siteData
    const ready = syncFiltersFromRoute()
    if (!ready) return
    await loadProducts()
    if (route.params.category) await focusProductsOnMobile()
  } catch {
    loadError.value = t('common.loadFailed')
    products.value = []
    setJsonLd('collection-item-list', null)
  } finally {
    loading.value = false
  }
}

async function loadProducts() {
  const key = productCacheKey()
  const requestId = ++productRequestId
  const cached = productCache.get(key)
  productLoadError.value = ''
  if (cached) {
    productLoading.value = false
    products.value = cached
    updateHead()
    return
  }
  productLoading.value = true
  const params = new URLSearchParams()
  if (active.value) params.set('category', active.value)
  if (activeOccasion.value) params.set('occasion', activeOccasion.value)
  params.set('lang', String(locale.value))
  try {
    const nextProducts = await api<Product[]>(`/products?${params.toString()}`)
    if (requestId !== productRequestId) return
    productCache.set(key, nextProducts)
    products.value = nextProducts
    updateHead()
  } catch {
    if (requestId !== productRequestId) return
    productLoadError.value = t('common.loadFailed')
  } finally {
    if (requestId === productRequestId) productLoading.value = false
  }
}

async function selectCategory(slug: string) {
  active.value = slug
  await router.replace({ path: `/collections/${slug}`, query: { occasion: activeOccasion.value || undefined } })
}

async function selectOccasion(value: string) {
  activeOccasion.value = activeOccasion.value === value ? '' : value
  await router.replace({ path: active.value ? `/collections/${active.value}` : '/collections', query: { occasion: activeOccasion.value || undefined } })
}

async function clearFilters() {
  activeOccasion.value = ''
  await router.replace({ path: active.value ? `/collections/${active.value}` : '/collections' })
}

onMounted(load)
watch(() => [route.params.category, route.query.category, route.query.occasion], async () => {
  if (!categories.value.length) return
  const ready = syncFiltersFromRoute()
  if (!ready) return
  await loadProducts()
  if (route.params.category) await focusProductsOnMobile()
})
watch(locale, load)
</script>

<template>
  <main class="section collection-page">
    <section v-if="loading" class="panel empty-state">
      <h2>{{ t('collections.loadingTitle') }}</h2>
      <p class="muted">{{ t('collections.loadingDesc') }}</p>
    </section>

    <section v-else-if="loadError" class="panel empty-state">
      <h2>{{ t('collections.loadFailedTitle') }}</h2>
      <p class="muted">{{ t('collections.loadFailedDesc') }}</p>
      <div class="empty-actions">
        <button class="button ghost" type="button" @click="load">{{ t('collections.retry') }}</button>
        <RouterLink class="button ghost" to="/order">{{ t('collections.startOrder') }}</RouterLink>
        <a
          v-if="supportContact"
          class="button ghost"
          :href="supportContact.url"
          :target="supportContact.external ? '_blank' : undefined"
          :rel="supportContact.external ? 'noopener noreferrer' : undefined"
        >{{ t('collections.contactSupport') }}</a>
        <RouterLink v-else class="button ghost" to="/support">{{ t('collections.contactSupport') }}</RouterLink>
      </div>
    </section>

    <template v-else>
    <section class="page-hero compact-hero collection-hero">
      <div>
        <p class="eyebrow">{{ t('collections.eyebrow') }}</p>
        <h1>{{ title }}</h1>
        <p class="lead">{{ description }}</p>
      </div>
      <div class="price-table">
        <h3>{{ t('collections.pricing') }}</h3>
        <div>
          <strong>{{ t('collections.frame') }}</strong>
          <p v-for="item in tm('collections.framePrices')" :key="String(item)">{{ item }}</p>
        </div>
        <div>
          <strong>{{ t('collections.fullBody') }}</strong>
          <p>{{ t('collections.fullBodyPrices') }}</p>
        </div>
      </div>
    </section>

    <section class="category-layout">
      <aside class="category-sidebar">
        <h2>{{ t('collections.categories') }}</h2>
        <article v-for="category in categories" :key="category.id" class="category-tree">
          <button :class="{ active: active === category.slug }" @click="selectCategory(category.slug)">{{ category.title }}</button>
          <div>
            <button v-for="child in (category as any).children" :key="child.slug" :class="{ active: active === child.slug }" @click="selectCategory(child.slug)">{{ child.title }}</button>
          </div>
        </article>

        <h2>{{ t('collections.occasion') }}</h2>
        <div class="filter-list">
          <button v-for="item in site.taxonomies?.occasions" :key="item" :class="{ active: activeOccasion === item }" @click="selectOccasion(item)">{{ item }}</button>
        </div>
      </aside>

      <section id="collection-products">
        <div class="collection-guide">
          <h3>{{ t('collections.chooseGuideTitle') }}</h3>
          <p v-for="item in tm('collections.chooseGuideItems')" :key="String(item)">{{ item }}</p>
        </div>
        <div class="section-head">
          <div>
            <p class="eyebrow">{{ t('collections.products') }}</p>
            <h2>{{ t('collections.worksTitle') }}</h2>
          </div>
          <span class="muted">{{ productLoading ? t('common.loading') : `${products.length} ${t('common.items')}` }}</span>
        </div>
        <p v-if="productLoadError" class="form-message error">{{ productLoadError }}</p>
        <div class="product-grid premium-grid" :class="{ 'is-updating': productLoading }" :aria-busy="productLoading">
          <article class="product-card premium-product" v-for="product in products" :key="product.id">
            <RouterLink :to="`/products/${product.slug}`" class="product-image-link">
              <img :src="productImage(product)" :alt="product.alt_text || product.title" @error="useProductImageFallback" />
            </RouterLink>
            <div class="product-body">
              <p class="eyebrow mini">{{ product.category?.title }}</p>
              <h3><RouterLink class="product-title-link" :to="`/products/${product.slug}`">{{ product.title }}</RouterLink></h3>
              <p>{{ product.subtitle }}</p>
              <div class="product-card-proof"><span>★★★★★</span><small>{{ t('detail.cardCycle') }}</small><small>{{ t('detail.cardHandmade') }}</small></div>
              <div class="tag-row compact"><span v-for="tag in product.tags?.slice(0, 6)" :key="tag">{{ tag }}</span></div>
              <div class="price-row">
                <strong>{{ displayMoney(product.options?.[0]?.price_cents || product.base_price_cents, product.currency, locale) }}</strong>
                <span>{{ t('collections.deposit', { percent: product.deposit_percent }) }}</span>
              </div>
              <div class="card-actions">
                <RouterLink class="button primary" :to="`/products/${product.slug}`">{{ t('common.viewDetails') }}</RouterLink>
                <RouterLink class="button ghost" :to="{ path: '/order', query: { product: product.id } }">{{ t('common.orderNow') }}</RouterLink>
              </div>
            </div>
          </article>
        </div>
        <div v-if="!products.length" class="empty-state">
          <h3>{{ t('collections.emptyTitle') }}</h3>
          <p>{{ t('collections.emptyDesc') }}</p>
          <div class="empty-actions">
            <button class="button ghost" type="button" @click="clearFilters">{{ t('collections.clearFilters') }}</button>
            <RouterLink class="button primary" to="/order">{{ t('collections.startOrder') }}</RouterLink>
            <a
              v-if="supportContact"
              class="button ghost"
              :href="supportContact.url"
              :target="supportContact.external ? '_blank' : undefined"
              :rel="supportContact.external ? 'noopener noreferrer' : undefined"
            >{{ t('collections.contactSupport') }}</a>
            <RouterLink v-else class="button ghost" to="/support">{{ t('collections.contactSupport') }}</RouterLink>
          </div>
        </div>
      </section>
    </section>
    </template>
  </main>
</template>
