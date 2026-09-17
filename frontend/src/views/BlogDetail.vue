<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { api, primarySupportContact, type SiteSettings } from '../api'
import { blogImage, useBlogImageFallback } from '../contentImages'
import { setHead } from '../head'

const { locale, t } = useI18n()
const route = useRoute()
const post = ref<any>(null)
const site = ref<SiteSettings>({})
const loading = ref(true)
const loadError = ref('')
const supportContact = computed(() => {
  return primarySupportContact(site.value, t('support.emailLabel'))
})
const safePostContent = computed(() => sanitizeBlogHtml(post.value?.content || ''))

function escapeHtmlText(value: string) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function textToHtml(value: string) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  return text.split(/\n{2,}/)
    .map((part) => `<p>${escapeHtmlText(part.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function sanitizeBlogHtml(input: string) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (!/<[a-z][\s\S]*>/i.test(raw)) return textToHtml(raw)
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

function postSupportSummary(compact = false) {
  const title = post.value?.title || t('blog.title')
  const url = post.value?.slug ? `${window.location.origin}/blog/${post.value.slug}` : window.location.href
  const lines = [
    `${t('blog.supportPost')} ${title}`,
    `${t('blog.supportPage')} ${url}`,
  ]
  if (!compact) lines.push(t('blog.supportPrompt'))
  return lines.join('\n')
}

function supportUrlForPost() {
  const contact = supportContact.value
  if (!contact) return ''
  const subject = `${t('blog.supportSubject')} ${post.value?.title || t('blog.title')}`.trim()
  if (contact.url.startsWith('mailto:')) {
    const [baseUrl, queryText = ''] = contact.url.split('?')
    const params = new URLSearchParams(queryText)
    if (!params.has('subject')) params.set('subject', subject)
    if (!params.has('body')) params.set('body', postSupportSummary(false))
    return `${baseUrl}?${params.toString()}`
  }
  try {
    const url = new URL(contact.url)
    const messageKey = url.searchParams.has('text') ? 'message' : 'text'
    if (!url.searchParams.has('text') && !url.searchParams.has('message')) {
      url.searchParams.set(messageKey, postSupportSummary(true))
    }
    return url.toString()
  } catch {
    return contact.url
  }
}

async function load() {
  loading.value = true
  loadError.value = ''
  post.value = null
  try {
    const [postData, siteData] = await Promise.all([
      api<any>(`/blog/${route.params.slug}?lang=${locale.value}`),
      api<SiteSettings>(`/site?lang=${locale.value}`).catch(() => ({} as SiteSettings))
    ])
    post.value = postData
    site.value = siteData
    setHead(post.value.title, post.value.excerpt, {
      canonical: `${window.location.origin}/blog/${post.value.slug || route.params.slug}`,
      image: blogImage(post.value)
    })
  } catch {
    loadError.value = t('blog.detailLoadFailed')
    setHead(t('blog.notFoundTitle'), t('blog.notFoundDesc'), {
      canonical: `${window.location.origin}/blog`,
      robots: 'noindex,follow',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(locale, load)
watch(() => route.params.slug, load)
</script>

<template>
  <main class="section blog-detail-page">
    <section v-if="loading" class="panel empty-state">
      <h1>{{ t('blog.detailLoadingTitle') }}</h1>
      <p class="muted">{{ t('blog.loadingDesc') }}</p>
    </section>
    <section v-else-if="loadError" class="panel empty-state">
      <h1>{{ t('blog.notFoundTitle') }}</h1>
      <p class="muted">{{ t('blog.notFoundDesc') }}</p>
      <div class="actions">
        <RouterLink class="button primary" to="/blog">{{ t('common.backToBlog') }}</RouterLink>
        <RouterLink class="button ghost" to="/collections">{{ t('common.collections') }}</RouterLink>
        <RouterLink class="button ghost" to="/order">{{ t('blog.startOrder') }}</RouterLink>
        <a
          v-if="supportContact"
          class="button ghost"
          :href="supportUrlForPost()"
          :target="supportContact.external ? '_blank' : undefined"
          :rel="supportContact.external ? 'noopener noreferrer' : undefined"
        >{{ t('blog.contactSupport') }}</a>
        <RouterLink v-else class="button ghost" to="/support">{{ t('blog.contactSupport') }}</RouterLink>
        <button class="button ghost" type="button" @click="load">{{ t('blog.retry') }}</button>
      </div>
    </section>
    <article v-else-if="post" class="article-shell">
      <p class="eyebrow">{{ post.date }}</p>
      <h1>{{ post.title }}</h1>
      <p class="lead">{{ post.excerpt }}</p>
      <img :src="blogImage(post)" :alt="post.title" @error="useBlogImageFallback" />
      <div class="tag-row compact"><span v-for="tag in post.tags" :key="tag">{{ tag }}</span></div>
      <div class="rich-article" v-html="safePostContent"></div>
      <section class="article-cta">
        <div>
          <p class="eyebrow mini">{{ t('blog.nextStepEyebrow') }}</p>
          <h2>{{ t('blog.nextStepTitle') }}</h2>
          <p>{{ t('blog.nextStepDesc') }}</p>
        </div>
        <div class="actions">
          <RouterLink class="button primary" to="/order">{{ t('home.startOrder') }}</RouterLink>
          <RouterLink class="button ghost" to="/collections">{{ t('common.collections') }}</RouterLink>
          <a
            v-if="supportContact"
            class="button ghost"
            :href="supportUrlForPost()"
            :target="supportContact.external ? '_blank' : undefined"
            :rel="supportContact.external ? 'noopener noreferrer' : undefined"
          >{{ t('support.contactCta') }}</a>
          <RouterLink v-else class="button ghost" to="/support">{{ t('blog.contactSupport') }}</RouterLink>
          <RouterLink class="button ghost" to="/blog">{{ t('common.backToBlog') }}</RouterLink>
        </div>
      </section>
    </article>
  </main>
</template>
