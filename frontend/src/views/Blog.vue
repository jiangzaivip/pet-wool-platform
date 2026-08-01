<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, primarySupportContact, type SiteSettings } from '../api'
import { blogFallbackImage, blogImage, useBlogImageFallback } from '../contentImages'
import { setHead } from '../head'

const { locale, t } = useI18n()
const posts = ref<any[]>([])
const site = ref<SiteSettings>({})
const loading = ref(true)
const loadError = ref('')
const supportContact = computed(() => {
  return primarySupportContact(site.value, t('support.emailLabel'))
})

function blogSupportSummary(compact = false) {
  const lines = [
    `${t('blog.supportPost')} ${t('blog.title')}`,
    `${t('blog.supportPage')} ${window.location.origin}/blog`,
  ]
  if (!compact) lines.push(t('blog.supportPrompt'))
  return lines.join('\n')
}

function supportUrlForBlog() {
  const contact = supportContact.value
  if (!contact) return ''
  const subject = `${t('blog.supportSubject')} ${t('blog.title')}`.trim()
  if (contact.url.startsWith('mailto:')) {
    const [baseUrl, queryText = ''] = contact.url.split('?')
    const params = new URLSearchParams(queryText)
    if (!params.has('subject')) params.set('subject', subject)
    if (!params.has('body')) params.set('body', blogSupportSummary(false))
    return `${baseUrl}?${params.toString()}`
  }
  try {
    const url = new URL(contact.url)
    const messageKey = url.searchParams.has('text') ? 'message' : 'text'
    if (!url.searchParams.has('text') && !url.searchParams.has('message')) {
      url.searchParams.set(messageKey, blogSupportSummary(true))
    }
    return url.toString()
  } catch {
    return contact.url
  }
}

async function load() {
  setHead(t('blog.title'), t('blog.desc'), { canonical: `${window.location.origin}/blog`, image: blogFallbackImage })
  loading.value = true
  loadError.value = ''
  try {
    const [postData, siteData] = await Promise.all([
      api<any[]>(`/blog?lang=${locale.value}`),
      api<SiteSettings>(`/site?lang=${locale.value}`)
    ])
    posts.value = postData
    site.value = siteData
  } catch {
    loadError.value = t('blog.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(locale, load)
</script>

<template>
  <main class="section blog-page">
    <section class="page-hero compact-hero">
      <p class="eyebrow">{{ t('nav.blog') }}</p>
      <h1>{{ t('blog.title') }}</h1>
      <p class="lead">{{ t('blog.desc') }}</p>
    </section>

    <section v-if="loading" class="panel empty-state">
      <h2>{{ t('blog.loadingTitle') }}</h2>
      <p class="muted">{{ t('blog.loadingDesc') }}</p>
    </section>
    <section v-else-if="loadError" class="panel empty-state">
      <h2>{{ t('blog.loadFailedTitle') }}</h2>
      <p class="muted">{{ t('blog.loadFailedDesc') }}</p>
      <div class="actions">
        <button class="button ghost" type="button" @click="load">{{ t('blog.retry') }}</button>
        <RouterLink class="button primary" to="/collections">{{ t('common.collections') }}</RouterLink>
        <RouterLink class="button ghost" to="/order">{{ t('blog.startOrder') }}</RouterLink>
        <a
          v-if="supportContact"
          class="button ghost"
          :href="supportUrlForBlog()"
          :target="supportContact.external ? '_blank' : undefined"
          :rel="supportContact.external ? 'noopener noreferrer' : undefined"
        >{{ t('blog.contactSupport') }}</a>
        <RouterLink v-else class="button ghost" to="/support">{{ t('blog.contactSupport') }}</RouterLink>
      </div>
    </section>
    <section v-else-if="!posts.length" class="panel empty-state">
      <h2>{{ t('blog.emptyTitle') }}</h2>
      <p class="muted">{{ t('blog.emptyDesc') }}</p>
      <div class="actions">
        <RouterLink class="button ghost" to="/collections">{{ t('common.collections') }}</RouterLink>
        <RouterLink class="button primary" to="/order">{{ t('blog.startOrder') }}</RouterLink>
        <a
          v-if="supportContact"
          class="button ghost"
          :href="supportUrlForBlog()"
          :target="supportContact.external ? '_blank' : undefined"
          :rel="supportContact.external ? 'noopener noreferrer' : undefined"
        >{{ t('blog.contactSupport') }}</a>
        <RouterLink v-else class="button ghost" to="/support">{{ t('blog.contactSupport') }}</RouterLink>
      </div>
    </section>
    <template v-else>
      <section class="blog-guide-cta">
        <div>
          <p class="eyebrow mini">{{ t('blog.nextStepEyebrow') }}</p>
          <h2>{{ t('blog.guideTitle') }}</h2>
          <p>{{ t('blog.guideDesc') }}</p>
        </div>
        <div class="actions">
          <RouterLink class="button ghost" to="/collections">{{ t('common.collections') }}</RouterLink>
          <RouterLink class="button primary" to="/order">{{ t('blog.startOrder') }}</RouterLink>
          <a
            v-if="supportContact"
            class="button ghost"
            :href="supportUrlForBlog()"
            :target="supportContact.external ? '_blank' : undefined"
            :rel="supportContact.external ? 'noopener noreferrer' : undefined"
          >{{ t('blog.contactSupport') }}</a>
          <RouterLink v-else class="button ghost" to="/support">{{ t('blog.contactSupport') }}</RouterLink>
        </div>
      </section>
      <section class="blog-grid">
        <article v-for="post in posts" :key="post.id" class="blog-card">
          <RouterLink :to="`/blog/${post.slug}`">
            <img :src="blogImage(post)" :alt="post.title" @error="useBlogImageFallback" />
          </RouterLink>
          <div>
            <p class="eyebrow mini">{{ post.date }}</p>
            <h2><RouterLink :to="`/blog/${post.slug}`">{{ post.title }}</RouterLink></h2>
            <p>{{ post.excerpt }}</p>
            <div class="tag-row compact"><span v-for="tag in post.tags" :key="tag">{{ tag }}</span></div>
            <RouterLink class="button ghost" :to="`/blog/${post.slug}`">{{ t('common.readArticle') }}</RouterLink>
          </div>
        </article>
      </section>
    </template>
  </main>
</template>
