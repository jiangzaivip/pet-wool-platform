<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, MessageCircle, ShoppingBag } from '@lucide/vue'
import { api, type Category, money, type Product, type SiteSettings } from '../api'
import { productFrameImage, productImage, useProductImageFallback } from '../contentImages'
import { setHead, setJsonLd } from '../head'

const { locale, t, tm } = useI18n()
const products = ref<Product[]>([])
const categories = ref<Category[]>([])
const site = ref<SiteSettings>({})
const loading = ref(true)
const loadError = ref('')
const selectedCategorySlug = ref('')

const heroImage = 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=1200&q=82'
const categoryImages = [
  'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82',
  'https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=900&q=82',
  'https://images.unsplash.com/photo-1574158622682-e40e69881006?auto=format&fit=crop&w=900&q=82'
]
const afterImage = productFrameImage

function updateSeo() {
  setHead(t('home.seoTitle'), t('home.seoDescription'), {
    canonical: `${window.location.origin}/`,
    image: afterImage
  })
  const faqs = (site.value.faq || []).slice(0, 8)
  setJsonLd('home-faq', faqs.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq: any) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer }
    }))
  } : null)
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const [productResult, categoryResult, siteResult] = await Promise.allSettled([
      api<Product[]>(`/products?lang=${locale.value}`),
      api<Category[]>(`/categories?lang=${locale.value}`),
      api<SiteSettings>(`/site?lang=${locale.value}`)
    ])
    products.value = productResult.status === 'fulfilled' ? productResult.value : []
    categories.value = categoryResult.status === 'fulfilled' ? categoryResult.value : []
    site.value = siteResult.status === 'fulfilled' ? siteResult.value : {}
    if ([productResult, categoryResult, siteResult].every(result => result.status === 'rejected')) {
      loadError.value = t('common.loadFailed')
    }
    updateSeo()
  } catch {
    loadError.value = t('common.loadFailed')
    updateSeo()
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(locale, load)
</script>

<template>
  <main class="storefront">
    <section class="hero section premium-hero">
      <div class="hero-copy">
        <p class="eyebrow">WoolBuddy · {{ t('hero.eyebrow') }}</p>
        <h1 class="preserve-lines">{{ t('home.heroTitle') }}</h1>
        <p class="lead preserve-lines">{{ t('home.heroDesc') }}</p>
        <div class="actions">
          <RouterLink class="button primary" to="/collections"><ShoppingBag :size="17" />{{ t('home.viewProducts') }}<ArrowRight :size="16" /></RouterLink>
          <RouterLink class="button ghost" to="/order">{{ t('home.startOrder') }}</RouterLink>
          <RouterLink class="button text-button" to="/support"><MessageCircle :size="17" />{{ t('home.askSupport') }}</RouterLink>
        </div>
      </div>
      <div class="hero-media comparison-media">
        <figure>
          <img :src="heroImage" alt="pet reference photo before custom wool felt production" fetchpriority="high" decoding="async" />
          <figcaption>Before · Photo</figcaption>
        </figure>
        <figure>
          <img :src="afterImage" alt="WoolBuddy custom wool felt work after production" decoding="async" @error="useProductImageFallback" />
          <figcaption>After · WoolBuddy</figcaption>
        </figure>
      </div>
      <div class="hero-proof">
        <div class="hero-handoff">
          <strong>{{ t('home.handoffTitle') }}</strong>
          <span>{{ t('home.handoffDesc') }}</span>
        </div>
        <div class="metric-grid">
          <div><strong>4-8</strong><span>{{ t('home.weeks') }}</span></div>
          <div><strong>50%</strong><span>{{ t('home.depositValue') }}</span></div>
          <div><strong>3</strong><span>한국어 · English · 中文</span></div>
        </div>
      </div>
    </section>

    <section class="section home-trust-section">
      <div class="section-head">
        <div>
          <p class="eyebrow">{{ t('home.standardEyebrow') }}</p>
          <h2>{{ t('home.standardTitle') }}</h2>
          <p class="lead">{{ t('home.standardDesc') }}</p>
        </div>
      </div>
      <div class="trust-feature-grid">
        <article v-for="item in tm('home.trustItems')" :key="String(item)"><Check :size="19" /><strong>{{ item }}</strong></article>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <p class="eyebrow">{{ t('home.collectionsEyebrow') }}</p>
          <h2>{{ t('home.collectionsTitle') }}</h2>
        </div>
        <RouterLink class="button ghost" to="/collections">{{ t('home.allCollections') }}</RouterLink>
      </div>
      <p v-if="loadError" class="form-message">{{ loadError }}</p>
      <div class="collection-showcase">
        <RouterLink
          v-for="(category, index) in categories"
          :key="category.id"
          class="collection-card"
          :class="{ active: selectedCategorySlug === category.slug }"
          :to="`/collections/${category.slug}`"
          @click="selectedCategorySlug = category.slug"
        >
          <img :src="categoryImages[index % categoryImages.length]" :alt="category.title" loading="lazy" decoding="async" />
          <div>
            <span>0{{ index + 1 }}</span>
            <h3>{{ category.title }}</h3>
            <p>{{ category.description }}</p>
            <div class="subcat-line"><small v-for="child in (category as any).children" :key="child.slug">{{ child.title }}</small></div>
          </div>
        </RouterLink>
      </div>
      <div v-if="!loading && !categories.length" class="empty-state"><p>{{ t('home.emptyCollections') }}</p></div>
    </section>

    <section id="products" class="section">
      <div class="section-head">
        <div>
          <p class="eyebrow">{{ t('home.featuredEyebrow') }}</p>
          <h2>{{ t('home.featuredTitle') }}</h2>
        </div>
        <span v-if="loading" class="muted">{{ t('common.loading') }}</span>
      </div>
      <div class="product-grid premium-grid">
        <article v-for="product in products.slice(0, 6)" :key="product.id" class="product-card premium-product">
          <RouterLink :to="`/products/${product.slug}`" class="product-image-link">
            <img :src="productImage(product)" :alt="product.alt_text || product.title" loading="lazy" decoding="async" @error="useProductImageFallback" />
          </RouterLink>
          <div class="product-body">
            <p class="eyebrow mini">{{ product.category?.title || t('common.custom') }}</p>
            <h3>{{ product.title }}</h3>
            <p>{{ product.subtitle }}</p>
            <div class="product-card-proof"><span>★★★★★</span><small>{{ t('home.cardCycle') }}</small><small>{{ t('home.cardHandmade') }}</small></div>
            <div class="tag-row compact"><span v-for="tag in product.tags?.slice(0, 3)" :key="tag">{{ tag }}</span></div>
            <div class="price-row">
              <div><small>{{ t('common.from') }}</small><strong>{{ money(product.options?.[0]?.price_cents || product.base_price_cents, product.currency) }}</strong></div>
              <span>{{ product.deposit_percent }}% {{ t('common.deposit') }}</span>
            </div>
            <div class="card-actions">
              <RouterLink class="button primary" :to="`/products/${product.slug}`">{{ t('common.viewDetails') }}</RouterLink>
              <RouterLink class="button ghost" :to="{ path: '/order', query: { product: product.id } }">{{ t('common.orderNow') }}</RouterLink>
            </div>
          </div>
        </article>
      </div>
      <div v-if="!loading && !products.length" class="empty-state"><p>{{ t('home.emptyProducts') }}</p></div>
      <div class="section-tail"><RouterLink class="button ghost" to="/collections">{{ t('home.allProducts') }}</RouterLink></div>
    </section>

    <section id="process" class="section split-section">
      <div>
        <p class="eyebrow">{{ t('home.processEyebrow') }}</p>
        <h2>{{ t('home.processTitle') }}</h2>
        <div class="process-commercial-notes"><strong>Production Time: 4-8 Weeks</strong><strong>50% Deposit · Start Production</strong></div>
      </div>
      <div class="steps">
        <article v-for="(step, index) in tm('home.processSteps')" :key="index" class="step-card">
          <span>{{ String(index + 1).padStart(2, '0') }}</span>
          <h3>{{ step.title }}</h3>
          <p>{{ step.desc }}</p>
        </article>
      </div>
    </section>

    <section class="section review-section">
      <div class="section-head">
        <div><p class="eyebrow">{{ t('home.reviewsEyebrow') }}</p><h2>{{ t('home.reviewsTitle') }}</h2></div>
        <RouterLink class="button ghost" to="/support">{{ t('home.supportLink') }}</RouterLink>
      </div>
      <div class="review-grid">
        <article v-for="review in site.reviews" :key="review.id" class="review-card">
          <div v-if="review.pet_image || review.work_image" class="review-comparison">
            <img v-if="review.pet_image" :src="review.pet_image" :alt="`${review.name} pet photo`" loading="lazy" />
            <img v-if="review.work_image" :src="review.work_image" :alt="`${review.name} WoolBuddy work`" loading="lazy" />
          </div>
          <div class="rating" :aria-label="`${review.rating} stars`">★★★★★</div>
          <img v-if="review.avatar_url" class="review-avatar" :src="review.avatar_url" :alt="review.name" loading="lazy" decoding="async" />
          <h3>{{ review.title }}</h3>
          <p>{{ review.content }}</p>
          <small>{{ review.name }} · {{ review.country }}</small>
          <video v-if="review.video_url" :src="review.video_url" controls preload="metadata"></video>
        </article>
      </div>
    </section>

    <section class="section home-faq-section">
      <div class="section-head"><div><p class="eyebrow">{{ t('home.faqEyebrow') }}</p><h2>{{ t('home.faqTitle') }}</h2></div></div>
      <div class="faq-list">
        <details v-for="faq in (site.faq || []).slice(0, 8)" :key="faq.id">
          <summary>{{ faq.question }}</summary>
          <p>{{ faq.answer }}</p>
        </details>
      </div>
      <div class="section-tail"><RouterLink class="button ghost" to="/support">{{ t('home.supportLink') }}</RouterLink></div>
    </section>

    <section class="section home-final-cta">
      <div><p class="eyebrow">WoolBuddy</p><h2>{{ t('home.finalCtaTitle') }}</h2><p>{{ t('home.finalCtaDesc') }}</p></div>
      <div class="actions">
        <RouterLink class="button primary" to="/order">{{ t('home.startOrder') }}</RouterLink>
        <RouterLink class="button ghost" to="/support">{{ t('home.askSupport') }}</RouterLink>
      </div>
    </section>
  </main>
</template>
