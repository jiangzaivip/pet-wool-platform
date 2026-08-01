<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { Check, ChevronLeft, ChevronRight, Clock, Mail } from '@lucide/vue'
import { api, supportContacts, type SiteSettings } from '../api'
import { productFallbackImage } from '../contentImages'
import { setHead, setJsonLd } from '../head'

const { locale, t, tm } = useI18n()
const route = useRoute()
const site = ref<SiteSettings>({})
const loading = ref(true)
const loadError = ref('')
const openFaqId = ref('')
const reviewIndex = ref(0)
const reviewTouchStartX = ref(0)
let reviewTimer = 0

const contactLinks = computed(() => supportContacts(site.value, t('support.emailLabel')))
const activeReview = computed(() => site.value.reviews?.[reviewIndex.value] || null)
const supportContext = computed(() => {
  const orderNo = String(route.query.order || '').trim().slice(0, 80)
  const email = String(route.query.email || '').trim().slice(0, 160)
  return { orderNo, email, hasValue: Boolean(orderNo || email) }
})

function supportContactUrl(link: { url: string }) {
  if (!link.url.startsWith('mailto:')) return link.url
  const [baseUrl, queryText = ''] = link.url.split('?')
  const params = new URLSearchParams(queryText)
  if (!params.has('subject')) params.set('subject', t('support.emailSubject'))
  if (!params.has('body')) {
    const lines = [
      t('support.emailBodyIntro'),
      `${t('support.emailBodyPage')} ${window.location.href}`,
      supportContext.value.orderNo ? `${t('support.contextOrder')} ${supportContext.value.orderNo}` : '',
      supportContext.value.email ? `${t('support.contextEmail')} ${supportContext.value.email}` : '',
      t('support.emailBodyPrompt')
    ].filter(Boolean)
    params.set('body', lines.join('\n'))
  }
  return `${baseUrl}?${params.toString()}`
}

function updateStructuredData() {
  const canonical = `${window.location.origin}/support`
  const faqs = site.value.faq || []
  setJsonLd('support-faq', faqs.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq: any) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer }
    }))
  } : null)
  setJsonLd('support-breadcrumb', {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('common.brand'), item: window.location.origin },
      { '@type': 'ListItem', position: 2, name: t('support.title'), item: canonical }
    ]
  })
  setJsonLd('support-organization', {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: site.value.brand?.name || 'WoolBuddy',
    url: window.location.origin,
    email: site.value.brand?.email || undefined,
    contactPoint: contactLinks.value.map(link => ({
      '@type': 'ContactPoint',
      contactType: 'customer support',
      url: link.url.startsWith('mailto:') ? undefined : link.url,
      email: link.url.startsWith('mailto:') ? link.url.replace('mailto:', '') : undefined,
      availableLanguage: ['Korean', 'English', 'Chinese']
    }))
  })
}

async function loadSupport() {
  setHead(t('support.title'), t('support.desc'), { canonical: `${window.location.origin}/support`, image: productFallbackImage })
  loading.value = true
  loadError.value = ''
  try {
    site.value = await api<SiteSettings>(`/site?lang=${locale.value}`)
    openFaqId.value = ''
    reviewIndex.value = 0
    updateStructuredData()
  } catch {
    loadError.value = t('support.loadFailed')
    setJsonLd('support-faq', null)
    setJsonLd('support-organization', null)
  } finally {
    loading.value = false
  }
}

function policyText(key: 'care' | 'shipping' | 'refund') {
  return site.value.policies?.[key] || t(`support.${key}Fallback`)
}

function toggleFaq(id: string) {
  openFaqId.value = openFaqId.value === id ? '' : id
}

function moveReview(direction: number) {
  const count = site.value.reviews?.length || 0
  if (!count) return
  reviewIndex.value = (reviewIndex.value + direction + count) % count
}

function onReviewTouchStart(event: TouchEvent) {
  reviewTouchStartX.value = event.changedTouches[0]?.clientX || 0
}

function onReviewTouchEnd(event: TouchEvent) {
  const distance = (event.changedTouches[0]?.clientX || 0) - reviewTouchStartX.value
  if (Math.abs(distance) >= 45) moveReview(distance > 0 ? -1 : 1)
}

function startReviewTimer() {
  window.clearInterval(reviewTimer)
  reviewTimer = window.setInterval(() => moveReview(1), 6000)
}

onMounted(() => {
  void loadSupport()
  startReviewTimer()
})
onBeforeUnmount(() => window.clearInterval(reviewTimer))
watch(locale, loadSupport)
</script>

<template>
  <main class="section support-page">
    <section class="page-hero compact-hero">
      <p class="eyebrow">WoolBuddy · {{ t('support.eyebrow') }}</p>
      <h1>{{ t('support.title') }}</h1>
      <p class="lead">{{ t('support.desc') }}</p>
    </section>

    <section v-if="loading" class="panel empty-state">
      <h2>{{ t('support.loadingTitle') }}</h2>
      <p class="muted">{{ t('support.loadingDesc') }}</p>
    </section>

    <section v-else-if="loadError" class="panel empty-state">
      <h2>{{ t('support.loadFailedTitle') }}</h2>
      <p class="muted">{{ t('support.loadFailedDesc') }}</p>
      <div class="actions">
        <button class="button ghost" type="button" @click="loadSupport">{{ t('support.retry') }}</button>
        <RouterLink class="button primary" to="/order">{{ t('support.startOrder') }}</RouterLink>
      </div>
    </section>

    <template v-else>
      <section class="support-contact-card">
        <div>
          <p class="eyebrow mini">{{ t('support.contactTitle') }}</p>
          <h2>{{ t('detail.consult') }}</h2>
          <p>{{ contactLinks.length ? t('support.contactDesc') : t('support.contactFallback') }}</p>
          <div class="contact-business-meta">
            <span v-if="site.brand?.email"><Mail :size="15" />{{ t('support.businessEmail') }}: {{ site.brand.email }}</span>
            <span><Clock :size="15" />{{ t('support.businessHours') }}</span>
            <span><Clock :size="15" />{{ t('support.replyTime') }}</span>
          </div>
          <p v-if="supportContext.hasValue" class="muted support-context">
            {{ t('support.contextTitle') }}
            <span v-if="supportContext.orderNo">{{ t('support.contextOrder') }} {{ supportContext.orderNo }}</span>
            <span v-if="supportContext.email">{{ t('support.contextEmail') }} {{ supportContext.email }}</span>
          </p>
        </div>
        <div class="row-actions">
          <a
            v-for="link in contactLinks"
            :key="link.key"
            class="button primary"
            :class="`support-${link.key}`"
            :href="supportContactUrl(link)"
            :target="link.external ? '_blank' : undefined"
            :rel="link.external ? 'noopener noreferrer' : undefined"
          >{{ t('detail.consultWith', { label: link.label }) }}</a>
          <RouterLink v-if="!contactLinks.length" class="button primary" to="/order">{{ t('support.startOrder') }}</RouterLink>
        </div>
      </section>

      <section class="support-prep-card">
        <h2>{{ t('support.prepTitle') }}</h2>
        <div><p v-for="item in tm('support.prepItems')" :key="String(item)">{{ item }}</p></div>
      </section>

      <section class="policy-grid">
        <article class="policy-card"><p class="eyebrow mini">{{ t('support.careGuide') }}</p><h2>{{ t('support.care') }}</h2><p class="preserve-lines">{{ policyText('care') }}</p></article>
        <article class="policy-card"><p class="eyebrow mini">{{ t('support.shipping') }}</p><h2>{{ t('support.shipping') }}</h2><p class="preserve-lines">{{ policyText('shipping') }}</p></article>
        <article class="policy-card"><p class="eyebrow mini">{{ t('support.refund') }}</p><h2>{{ t('support.refund') }}</h2><p class="preserve-lines">{{ policyText('refund') }}</p></article>
      </section>

      <section class="section-inner support-section">
        <div><p class="eyebrow">FAQ</p><h2>{{ t('faqTitle') }}</h2></div>
        <div class="faq-list accordion-list">
          <article v-for="faq in site.faq" :key="faq.id" class="faq-item">
            <h3>
              <button type="button" :aria-expanded="openFaqId === faq.id" :aria-controls="`faq-${faq.id}`" @click="toggleFaq(faq.id)">
                <span>{{ faq.question }}</span><span aria-hidden="true">{{ openFaqId === faq.id ? '−' : '+' }}</span>
              </button>
            </h3>
            <Transition name="accordion">
              <div v-if="openFaqId === faq.id" :id="`faq-${faq.id}`" class="faq-answer"><p>{{ faq.answer }}</p></div>
            </Transition>
          </article>
          <p v-if="!site.faq?.length" class="muted">{{ t('support.faqFallback') }}</p>
        </div>
      </section>

      <section class="section-inner review-carousel-section">
        <div class="section-head">
          <div><p class="eyebrow">{{ t('support.reviews') }}</p><h2>{{ t('support.reviews') }}</h2></div>
          <div v-if="site.reviews?.length > 1" class="carousel-controls">
            <button class="icon-button" type="button" :aria-label="t('support.previousReview')" @click="moveReview(-1)"><ChevronLeft :size="19" /></button>
            <span>{{ reviewIndex + 1 }} / {{ site.reviews.length }}</span>
            <button class="icon-button" type="button" :aria-label="t('support.nextReview')" @click="moveReview(1)"><ChevronRight :size="19" /></button>
          </div>
        </div>
        <div class="review-carousel" @touchstart.passive="onReviewTouchStart" @touchend.passive="onReviewTouchEnd">
          <article v-if="activeReview" :key="activeReview.id" class="review-card featured-review">
            <div v-if="activeReview.pet_image || activeReview.work_image" class="review-comparison">
              <img v-if="activeReview.pet_image" :src="activeReview.pet_image" :alt="`${activeReview.name} pet photo`" loading="lazy" decoding="async" />
              <img v-if="activeReview.work_image" :src="activeReview.work_image" :alt="`${activeReview.name} WoolBuddy work`" loading="lazy" decoding="async" />
            </div>
            <div class="review-copy">
              <img v-if="activeReview.avatar_url" class="review-avatar" :src="activeReview.avatar_url" :alt="activeReview.name" loading="lazy" decoding="async" />
              <div class="rating" :aria-label="`${activeReview.rating} stars`">★★★★★</div>
              <h3>{{ activeReview.title }}</h3>
              <p>{{ activeReview.content }}</p>
              <small>{{ activeReview.name }} · {{ activeReview.country }}</small>
              <video v-if="activeReview.video_url" :src="activeReview.video_url" controls preload="metadata"></video>
            </div>
          </article>
          <article v-else class="review-card">
            <div class="rating" aria-label="5 stars">★★★★★</div>
            <h3>{{ t('support.reviewFallbackTitle') }}</h3><p>{{ t('support.reviewFallbackDesc') }}</p><small>{{ t('support.reviewFallbackName') }}</small>
          </article>
        </div>
      </section>

      <section class="support-trust-section">
        <h2>{{ t('support.trustTitle') }}</h2>
        <div><span v-for="item in tm('support.trustItems')" :key="String(item)"><Check :size="18" />{{ item }}</span></div>
      </section>

      <section class="support-process-section">
        <div><p class="eyebrow">WoolBuddy</p><h2>{{ t('support.processTitle') }}</h2></div>
        <ol><li v-for="(step, index) in tm('support.processSteps')" :key="String(step)"><span>{{ String(index + 1).padStart(2, '0') }}</span>{{ step }}</li></ol>
      </section>

      <section class="support-final-cta">
        <div>
          <p class="eyebrow mini">{{ t('blog.nextStepEyebrow') }}</p>
          <h2>{{ t('support.finalCtaTitle') }}</h2>
          <p>{{ t('support.finalCtaDesc') }}</p>
          <div class="paypal-trust-list"><span v-for="item in tm('support.paypalTrust')" :key="String(item)"><Check :size="15" />{{ item }}</span></div>
        </div>
        <div class="actions">
          <RouterLink class="button primary" to="/order">{{ t('support.startOrder') }}</RouterLink>
          <RouterLink class="button ghost" to="/collections">{{ t('support.browseCollections') }}</RouterLink>
          <a
            v-if="contactLinks[0]"
            class="button ghost"
            :href="supportContactUrl(contactLinks[0])"
            :target="contactLinks[0].external ? '_blank' : undefined"
            :rel="contactLinks[0].external ? 'noopener noreferrer' : undefined"
          >{{ t('support.contactDesigner') }}</a>
        </div>
      </section>
    </template>
  </main>
</template>
