<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowRight,
  Camera,
  ChevronDown,
  CirclePlay,
  Languages,
  Mail,
  Menu,
  MessageCircle,
  Music2,
  Palette,
  ShoppingBag,
  Sparkles,
  UserRound,
  X,
} from '@lucide/vue'
import { api, clearUserSession, currentUser, loginWithGoogle, loginWithGoogleCredential, safeGetLocalStorage, safeSetLocalStorage, socialLinks, type SiteSettings } from './api'
import GoogleSignInButton from './components/GoogleSignInButton.vue'

const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()

// App owns the shared storefront chrome: site settings, theme/language
// preferences, login drawer, mobile navigation, and the support bot. Individual
// views only render page content and use the same API/session helpers.
const site = ref<SiteSettings>({})
type ThemePalette = {
  key: string
  label: string
  bg: string
  surface: string
  surfaceSoft: string
  text: string
  muted: string
  accent: string
  accent2: string
  line: string
  rose?: string
  sage?: string
}
const fallbackThemes: ThemePalette[] = [
  { key: 'white', label: '纯白', bg: '#ffffff', surface: '#ffffff', surfaceSoft: '#f6f7f8', text: '#1d2320', muted: '#67706b', accent: '#24352d', accent2: '#b7c7b9', line: '#e5e8e6', rose: '#b76f72', sage: '#6f8b73' },
  { key: 'cream', label: '奶油', bg: '#f7f2e8', surface: '#fffdf8', surfaceSoft: '#f3eadc', text: '#1f2f28', muted: '#667068', accent: '#26362f', accent2: '#d8b56d', line: '#ded4c4', rose: '#b66f72', sage: '#6f8b73' },
  { key: 'sage', label: '鼠尾草', bg: '#eef5ed', surface: '#fbfff8', surfaceSoft: '#dfeada', text: '#17261d', muted: '#5c705e', accent: '#4f7658', accent2: '#b8c68d', line: '#cfddc9', rose: '#a86a6c', sage: '#5f8a65' },
  { key: 'rose', label: '玫瑰', bg: '#fbeced', surface: '#fff8f7', surfaceSoft: '#f2d9db', text: '#302124', muted: '#765d61', accent: '#9d4f5c', accent2: '#d39a82', line: '#ead0d3', rose: '#b75d6a', sage: '#718a72' },
  { key: 'dark', label: '深色', bg: '#161d1a', surface: '#242b27', surfaceSoft: '#1f2523', text: '#f8f2e8', muted: '#c9c0b2', accent: '#d8b56d', accent2: '#7ea385', line: '#3c4842', rose: '#c47b80', sage: '#7ea385' }
]
const fallbackSite: SiteSettings = {
  brand: { name: 'WoolBuddy', email: '' },
  contact: {
    kakao_enabled: false,
    kakao_label: 'KakaoTalk',
    kakao_id: '',
    kakao_url: '',
    whatsapp_enabled: false,
    whatsapp_label: 'WhatsApp',
    whatsapp_id: '',
    whatsapp_url: '',
  },
  theme: { defaultTheme: 'white', themes: fallbackThemes },
  bot: { enabled: false, welcome: { zh: '你好，需要帮助可以在支持页联系我们。', en: 'Hi, visit support if you need help.', ko: '도움이 필요하면 지원 페이지를 방문해 주세요.' } }
}
const theme = ref(safeGetLocalStorage('theme'))
const user = ref<any>(currentUser())
const botOpen = ref(false)
const botQuestion = ref('')
const botLoading = ref(false)
const botError = ref('')
const botMessages = ref<{ role: 'bot' | 'user'; text: string }[]>([])
const botQuestionMaxLength = 200
const activeHomeSection = ref('')
const loginDrawerOpen = ref(false)
const mobileMenuOpen = ref(false)
const preferencesOpen = ref(false)
const loginLoading = ref(false)
const loginError = ref('')
const loginEmail = ref(currentUser()?.email || '')
const langs = [
  { key: 'ko', label: '한국어', short: '한' },
  { key: 'en', label: 'English', short: 'EN' },
  { key: 'zh', label: '中文', short: '中' }
]

const currentLang = computed(() => langs.find(item => item.key === locale.value) || langs[0])

const themeOptions = computed<ThemePalette[]>(() => {
  const configured = site.value.theme?.themes
  return Array.isArray(configured) && configured.length ? configured : fallbackThemes
})
const selectedTheme = computed(() => {
  const configuredDefault = site.value.theme?.defaultTheme
  return themeOptions.value.find(item => item.key === theme.value)
    || themeOptions.value.find(item => item.key === configuredDefault)
    || themeOptions.value[0]
    || fallbackThemes[1]
})
const routeClass = computed(() => `theme-${selectedTheme.value?.key || 'cream'}`)
const isAdminRoute = computed(() => route.path.startsWith('/admin'))
const activeNavKey = computed(() => {
  if (route.path === '/' && activeHomeSection.value) return activeHomeSection.value
  if (route.path.startsWith('/products') || route.path.startsWith('/collections')) return 'collections'
  if (route.path.startsWith('/support')) return 'support'
  if (route.path.startsWith('/blog')) return 'blog'
  if (route.path.startsWith('/order')) return 'order'
  if (route.path.startsWith('/account')) return 'account'
  return ''
})

// Contact links are validated before being rendered. This keeps malformed or
// non-http admin values from becoming clickable navigation in the storefront.
function validExternalContactUrl(value: unknown) {
  try {
    const url = new URL(String(value || '').trim())
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

const kakaoUrl = computed(() => validExternalContactUrl(site.value.contact?.kakao_url))
const whatsappUrl = computed(() => validExternalContactUrl(site.value.contact?.whatsapp_url))
const contactEmail = computed(() => String(site.value.brand?.email || '').trim())
const validContactEmail = computed(() => {
  const email = contactEmail.value.replace(/\s/g, '')
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
})
const showKakaoLink = computed(() => Boolean(site.value.contact?.kakao_enabled && kakaoUrl.value))
const showWhatsappLink = computed(() => Boolean(site.value.contact?.whatsapp_enabled && whatsappUrl.value))
const showEmailLink = computed(() => Boolean(validContactEmail.value))
const floatingEmailHref = computed(() => {
  if (!validContactEmail.value) return ''
  const params = new URLSearchParams({
    subject: t('support.emailSubject'),
    body: [
      t('support.emailBodyIntro'),
      `${t('support.emailBodyPage')} ${window.location.href}`,
      t('support.emailBodyPrompt')
    ].join('\n')
  })
  return `mailto:${validContactEmail.value}?${params.toString()}`
})
const themeVars = computed(() => {
  const item = selectedTheme.value
  return {
    '--bg': item.bg,
    '--surface': item.surface,
    '--surface-soft': item.surfaceSoft,
    '--text': item.text,
    '--muted': item.muted,
    '--accent': item.accent,
    '--accent-2': item.accent2,
    '--line': item.line,
    '--rose': item.rose || item.accent,
    '--sage': item.sage || item.accent,
  }
})
function setTheme(value: string) {
  const next = themeOptions.value.some(item => item.key === value)
    ? value
    : (site.value.theme?.defaultTheme || themeOptions.value[0]?.key || 'white')
  theme.value = next
  safeSetLocalStorage('theme', next)
  document.documentElement.dataset.theme = next
}
function setLang(value: string) {
  if (!langs.some(item => item.key === value)) return
  locale.value = value
  safeSetLocalStorage('lang', value)
  document.documentElement.lang = value === 'zh' ? 'zh-CN' : value === 'ko' ? 'ko-KR' : 'en'
  if (!botMessages.value.length || (botMessages.value.length === 1 && botMessages.value[0].role === 'bot')) seedBotWelcome()
}

function localizedThemeLabel(item: ThemePalette) {
  const knownTheme = ['white', 'cream', 'sage', 'rose', 'dark'].includes(item.key)
  return knownTheme ? t(`chrome.themes.${item.key}`) : item.label
}

function closeNavigation() {
  mobileMenuOpen.value = false
  preferencesOpen.value = false
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  closeNavigation()
  loginDrawerOpen.value = false
  botOpen.value = false
}

async function goHomeSection(section: string) {
  activeHomeSection.value = section
  if (route.path !== '/') await router.push({ path: '/', hash: `#${section}` })
  else await router.replace({ path: '/', hash: `#${section}` })

  requestAnimationFrame(() => {
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

async function loginGoogleDemo() {
  const nextEmail = loginEmail.value.trim().toLowerCase()
  loginEmail.value = nextEmail
  loginError.value = ''
  const requiresEmail = site.value.google?.auth_mode !== 'google'
  if (requiresEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    loginError.value = t('account.emailInvalid')
    return
  }
  loginLoading.value = true
  clearUserSession()
  user.value = null
  try {
    const result = await loginWithGoogle(site.value, nextEmail)
    safeSetLocalStorage('user_token', result.token)
    safeSetLocalStorage('user_profile', JSON.stringify(result.user))
    user.value = result.user
    loginDrawerOpen.value = false
  } catch (error: any) {
    loginError.value = error.message || t('common.loadFailed')
  } finally {
    loginLoading.value = false
  }
}

async function handleGoogleCredential(idToken: string) {
  if (loginLoading.value) return
  loginLoading.value = true
  loginError.value = ''
  clearUserSession()
  user.value = null
  try {
    const result = await loginWithGoogleCredential(idToken)
    safeSetLocalStorage('user_token', result.token)
    safeSetLocalStorage('user_profile', JSON.stringify(result.user))
    user.value = result.user
    loginDrawerOpen.value = false
  } catch (error: any) {
    loginError.value = error.message || t('account.googleCredentialMissing')
  } finally {
    loginLoading.value = false
  }
}

function handleGoogleButtonError(error: string) {
  loginError.value = error === 'google credential missing'
    ? t('account.googleCredentialMissing')
    : t('account.googleLoginUnavailable')
}

function openLoginDrawer() {
  loginError.value = ''
  loginEmail.value = user.value?.email || ''
  loginDrawerOpen.value = true
}

function seedBotWelcome() {
  const welcome = site.value.bot?.welcome?.[locale.value] || site.value.bot?.welcome?.en || 'Hi, how can I help?'
  botMessages.value = [{ role: 'bot', text: welcome }]
}

async function loadSite() {
  try {
    site.value = await api<SiteSettings>('/site')
  } catch {
    site.value = fallbackSite
  }
  setTheme(theme.value || site.value.theme?.defaultTheme || 'white')
}

// The bot is intentionally a lightweight request/response interaction here;
// the API owns the knowledge base and language selection so the browser does
// not need to duplicate business content.
async function askBot(question = botQuestion.value) {
  const text = question.trim()
  botError.value = ''
  if (!text) {
    botError.value = t('bot.empty')
    return
  }
  if (text.length > botQuestionMaxLength) {
    botError.value = t('bot.tooLong')
    return
  }
  botMessages.value.push({ role: 'user', text })
  botQuestion.value = ''
  botLoading.value = true
  try {
    const result = await api<any>('/bot/answer', {
      method: 'POST',
      body: JSON.stringify({ question: text, lang: locale.value })
    })
    botMessages.value.push({ role: 'bot', text: result.answer })
  } catch (error: any) {
    botMessages.value.push({ role: 'bot', text: error.message || 'Please try again.' })
  } finally {
    botLoading.value = false
  }
}

onMounted(async () => {
  document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : locale.value === 'ko' ? 'ko-KR' : 'en'
  window.addEventListener('keydown', handleKeydown)
  await loadSite()
  seedBotWelcome()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.body.classList.remove('site-overlay-open')
})

watch(locale, async () => {
  document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : locale.value === 'ko' ? 'ko-KR' : 'en'
  await loadSite()
  if (!botMessages.value.length || (botMessages.value.length === 1 && botMessages.value[0].role === 'bot')) seedBotWelcome()
})

watch([mobileMenuOpen, loginDrawerOpen], ([menuOpen, drawerOpen]) => {
  document.body.classList.toggle('site-overlay-open', menuOpen || drawerOpen)
})

watch(
  () => [route.path, route.hash],
  ([path, hash]) => {
    closeNavigation()
    if (path.startsWith('/admin') && locale.value !== 'zh') {
      locale.value = 'zh'
      safeSetLocalStorage('lang', 'zh')
    }
    activeHomeSection.value = path === '/' && (hash === '#products' || hash === '#process')
      ? hash.slice(1)
      : ''
  },
  { immediate: true }
)
</script>

<template>
  <div :class="['app-shell', routeClass]" :style="themeVars">
    <div v-if="!isAdminRoute" class="utility-bar">
      <div>
        <span><Sparkles :size="13" />{{ t('chrome.handmade') }}</span>
        <span>{{ t('chrome.preview') }}</span>
        <span>{{ t('chrome.worldwide') }}</span>
      </div>
    </div>
    <header v-if="!isAdminRoute" class="topbar">
      <div class="topbar-inner">
        <RouterLink to="/" class="brand" aria-label="WoolBuddy">
          <span class="brand-mark"><Sparkles :size="18" stroke-width="1.8" /></span>
          <span class="brand-copy">
            <strong>{{ site.brand?.name || 'WoolBuddy' }}</strong>
            <small>{{ t('chrome.studio') }}</small>
          </span>
        </RouterLink>

        <nav class="desktop-nav" :aria-label="t('chrome.navLabel')">
          <a href="/#products" :class="{ active: activeNavKey === 'products' }" @click.prevent="goHomeSection('products')">{{ t('nav.shop') }}</a>
          <RouterLink to="/collections" :class="{ active: activeNavKey === 'collections' }">{{ t('nav.collections') }}</RouterLink>
          <a href="/#process" :class="{ active: activeNavKey === 'process' }" @click.prevent="goHomeSection('process')">{{ t('nav.process') }}</a>
          <RouterLink to="/support" :class="{ active: activeNavKey === 'support' }">{{ t('nav.support') }}</RouterLink>
          <RouterLink to="/blog" :class="{ active: activeNavKey === 'blog' }">{{ t('nav.blog') }}</RouterLink>
        </nav>

        <div class="header-actions">
          <div class="preferences-control">
            <button
              type="button"
              class="icon-button preferences-toggle"
              :aria-label="t('chrome.preferences')"
              :title="t('chrome.preferences')"
              :aria-expanded="preferencesOpen"
              @click.stop="preferencesOpen = !preferencesOpen"
            >
              <Languages :size="18" />
              <span>{{ currentLang.short }}</span>
              <ChevronDown :size="14" :class="{ rotated: preferencesOpen }" />
            </button>
            <Transition name="popover">
              <section v-if="preferencesOpen" class="preferences-popover" @click.stop>
                <div class="preference-head">
                  <div>
                    <span>{{ t('chrome.preferences') }}</span>
                    <strong>{{ currentLang.label }}</strong>
                  </div>
                  <button class="icon-button compact" type="button" :aria-label="t('common.close')" @click="preferencesOpen = false"><X :size="17" /></button>
                </div>
                <div class="preference-group">
                  <span class="preference-label"><Languages :size="15" />{{ t('chrome.language') }}</span>
                  <div class="language-segments">
                    <button v-for="lang in langs" :key="lang.key" type="button" :class="{ active: locale === lang.key }" @click="setLang(lang.key)">{{ lang.label }}</button>
                  </div>
                </div>
                <div class="preference-group">
                  <span class="preference-label"><Palette :size="15" />{{ t('chrome.appearance') }}</span>
                  <div class="theme-choice-list">
                    <button
                      v-for="item in themeOptions"
                      :key="item.key"
                      type="button"
                      class="theme-choice"
                      :class="{ active: selectedTheme.key === item.key }"
                      :aria-pressed="selectedTheme.key === item.key"
                      :style="{ '--choice-bg': item.bg, '--choice-accent': item.accent, '--choice-accent-2': item.accent2, '--choice-line': item.line }"
                      @click="setTheme(item.key)"
                    >
                      <span class="theme-swatch"></span>
                      <em>{{ localizedThemeLabel(item) }}</em>
                    </button>
                  </div>
                </div>
              </section>
            </Transition>
          </div>
          <RouterLink v-if="user" to="/account" class="icon-button account-button" :aria-label="t('nav.account')" :title="t('nav.account')"><UserRound :size="19" /></RouterLink>
          <button v-else type="button" class="icon-button account-button" :aria-label="t('nav.googleLogin')" :title="t('nav.googleLogin')" @click="openLoginDrawer"><UserRound :size="19" /></button>
          <RouterLink class="header-order-button" to="/order">
            <span>{{ t('nav.order') }}</span>
            <ArrowRight :size="16" />
          </RouterLink>
          <button
            type="button"
            class="icon-button mobile-menu-toggle"
            :aria-label="t('chrome.openMenu')"
            :aria-expanded="mobileMenuOpen"
            @click="mobileMenuOpen = true"
          ><Menu :size="21" /></button>
        </div>
      </div>
    </header>

    <Transition name="fade">
      <button v-if="!isAdminRoute && mobileMenuOpen" class="mobile-menu-backdrop" :aria-label="t('chrome.closeMenu')" @click="mobileMenuOpen = false"></button>
    </Transition>
    <Transition name="menu-drawer">
      <aside v-if="!isAdminRoute && mobileMenuOpen" class="mobile-menu" :aria-label="t('chrome.navLabel')">
        <header>
          <RouterLink to="/" class="brand" @click="closeNavigation">
            <span class="brand-mark"><Sparkles :size="18" /></span>
            <span class="brand-copy"><strong>{{ site.brand?.name || 'WoolBuddy' }}</strong><small>{{ t('chrome.studio') }}</small></span>
          </RouterLink>
          <button type="button" class="icon-button" :aria-label="t('chrome.closeMenu')" @click="mobileMenuOpen = false"><X :size="21" /></button>
        </header>
        <nav>
          <a href="/#products" @click.prevent="goHomeSection('products')">{{ t('nav.shop') }}<ArrowRight :size="17" /></a>
          <RouterLink to="/collections">{{ t('nav.collections') }}<ArrowRight :size="17" /></RouterLink>
          <a href="/#process" @click.prevent="goHomeSection('process')">{{ t('nav.process') }}<ArrowRight :size="17" /></a>
          <RouterLink to="/support">{{ t('nav.support') }}<ArrowRight :size="17" /></RouterLink>
          <RouterLink to="/blog">{{ t('nav.blog') }}<ArrowRight :size="17" /></RouterLink>
        </nav>
        <RouterLink class="button primary mobile-order-cta" to="/order"><ShoppingBag :size="18" />{{ t('nav.order') }}</RouterLink>
        <button v-if="!user" type="button" class="mobile-account-link" @click="openLoginDrawer"><UserRound :size="18" />{{ t('nav.googleLogin') }}</button>
        <RouterLink v-else class="mobile-account-link" to="/account"><UserRound :size="18" />{{ t('nav.account') }}</RouterLink>
        <div class="mobile-preferences">
          <span class="preference-label"><Languages :size="15" />{{ t('chrome.language') }}</span>
          <div class="language-segments">
            <button v-for="lang in langs" :key="lang.key" type="button" :class="{ active: locale === lang.key }" @click="setLang(lang.key)">{{ lang.label }}</button>
          </div>
          <span class="preference-label"><Palette :size="15" />{{ t('chrome.appearance') }}</span>
          <div class="theme-choice-list">
            <button
              v-for="item in themeOptions"
              :key="item.key"
              type="button"
              class="theme-choice"
              :class="{ active: selectedTheme.key === item.key }"
              :style="{ '--choice-bg': item.bg, '--choice-accent': item.accent, '--choice-accent-2': item.accent2, '--choice-line': item.line }"
              @click="setTheme(item.key)"
            ><span class="theme-swatch"></span><em>{{ localizedThemeLabel(item) }}</em></button>
          </div>
        </div>
      </aside>
    </Transition>

    <RouterView v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" />
      </Transition>
    </RouterView>
    <div v-if="!isAdminRoute && loginDrawerOpen" class="drawer-backdrop" @click="loginDrawerOpen = false"></div>
    <aside v-if="!isAdminRoute && loginDrawerOpen" class="login-drawer open" :aria-label="t('account.loginDrawerLabel')">
      <header>
        <div>
          <p class="eyebrow mini">{{ t('account.eyebrow') }}</p>
          <h2>{{ t('account.thirdPartyLogin') }}</h2>
        </div>
        <button class="drawer-close" :aria-label="t('common.close')" @click="loginDrawerOpen = false"><X :size="19" /></button>
      </header>
      <label class="drawer-field">
        <span>{{ t('account.loginEmail') }}</span>
        <input v-model="loginEmail" type="email" autocomplete="email" :placeholder="t('account.emailPlaceholder')" />
      </label>
      <GoogleSignInButton
        v-if="site.google?.auth_mode === 'google' && site.google?.client_id"
        :client-id="site.google.client_id"
        :disabled="loginLoading"
        @credential="handleGoogleCredential"
        @error="handleGoogleButtonError"
      />
      <button v-else class="third-login google" :disabled="loginLoading" @click="loginGoogleDemo">
        <span>G</span>
        {{ loginLoading ? t('common.loading') : t('account.google') }}
      </button>
      <p v-if="loginError" class="form-message">{{ loginError }}</p>
    </aside>
    <div class="floating-contact" v-if="site.contact && !isAdminRoute">
      <button v-if="site.bot?.enabled" class="bot-toggle" :aria-label="t('bot.launcher')" :title="t('bot.launcher')" @click="botOpen = !botOpen"><MessageCircle :size="22" /><span>{{ t('bot.launcher') }}</span></button>
      <a v-if="showKakaoLink" :href="kakaoUrl" target="_blank" rel="noopener noreferrer" class="kakao">{{ site.contact.kakao_label || 'KakaoTalk' }}</a>
      <a v-if="showWhatsappLink" :href="whatsappUrl" target="_blank" rel="noopener noreferrer" class="whatsapp">{{ site.contact.whatsapp_label || 'WhatsApp' }}</a>
      <a v-if="showEmailLink" :href="floatingEmailHref" class="email" :aria-label="t('support.emailLabel')" :title="t('support.emailLabel')"><Mail :size="21" /></a>
    </div>
    <section v-if="botOpen && !isAdminRoute" class="bot-panel">
      <header>
        <strong>{{ t('bot.title') }}</strong>
        <button :aria-label="t('common.close')" @click="botOpen = false"><X :size="19" /></button>
      </header>
      <div class="bot-messages">
        <p v-for="(msg, index) in botMessages" :key="index" :class="msg.role">{{ msg.text }}</p>
        <p v-if="botLoading" class="bot">{{ t('bot.typing') }}</p>
      </div>
      <div class="bot-quick">
        <button @click="askBot(t('bot.quickPrice'))">{{ t('bot.quickPrice') }}</button>
        <button @click="askBot(t('bot.quickPhoto'))">{{ t('bot.quickPhoto') }}</button>
        <button @click="askBot(t('bot.quickTime'))">{{ t('bot.quickTime') }}</button>
      </div>
      <form @submit.prevent="askBot()">
        <input v-model="botQuestion" :placeholder="t('bot.askPlaceholder')" :maxlength="botQuestionMaxLength" />
        <button class="button primary">{{ t('bot.send') }}<ArrowRight :size="16" /></button>
      </form>
      <p v-if="botError" class="bot-error">{{ botError }}</p>
    </section>
    <footer v-if="!isAdminRoute" class="site-footer">
      <div class="footer-grid">
        <div class="footer-brand">
          <RouterLink to="/" class="brand">
            <span class="brand-mark"><Sparkles :size="18" /></span>
            <span class="brand-copy"><strong>{{ site.brand?.name || 'WoolBuddy' }}</strong><small>{{ t('chrome.studio') }}</small></span>
          </RouterLink>
          <p>{{ t('footer.desc') }}</p>
          <span class="footer-made">{{ t('footer.made') }}</span>
          <div class="footer-sns">
            <a
              v-for="sns in socialLinks"
              :key="sns.key"
              :href="sns.url"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="sns.label"
              :title="`${sns.label} ${sns.handle}`"
            >
              <Camera v-if="sns.key === 'instagram'" :size="18" />
              <Music2 v-else-if="sns.key === 'tiktok'" :size="18" />
              <CirclePlay v-else :size="18" />
            </a>
          </div>
        </div>
        <nav :aria-label="t('footer.products')">
          <strong>{{ t('footer.explore') }}</strong>
          <a href="/#products" @click.prevent="goHomeSection('products')">{{ t('nav.shop') }}</a>
          <RouterLink to="/collections">{{ t('nav.collections') }}</RouterLink>
          <RouterLink to="/order">{{ t('nav.order') }}</RouterLink>
        </nav>
        <nav :aria-label="t('footer.support')">
          <strong>{{ t('footer.support') }}</strong>
          <RouterLink to="/support">{{ t('nav.support') }}</RouterLink>
          <RouterLink to="/blog">{{ t('footer.blog') }}</RouterLink>
          <RouterLink to="/account">{{ t('nav.account') }}</RouterLink>
        </nav>
        <nav :aria-label="t('footer.legal')">
          <strong>{{ t('footer.legal') }}</strong>
          <RouterLink to="/policies/privacy">{{ t('footer.privacy') }}</RouterLink>
          <RouterLink to="/policies/terms">{{ t('footer.terms') }}</RouterLink>
          <RouterLink to="/policies/refund">{{ t('footer.refund') }}</RouterLink>
          <RouterLink to="/policies/shipping">{{ t('footer.shipping') }}</RouterLink>
          <RouterLink to="/policies/cookies">{{ t('footer.cookies') }}</RouterLink>
          <RouterLink to="/support">{{ t('footer.contact') }}</RouterLink>
        </nav>
        <div class="footer-service">
          <strong>{{ t('footer.promise') }}</strong>
          <span>{{ t('chrome.handmade') }}</span>
          <span>{{ t('chrome.preview') }}</span>
          <span>{{ t('chrome.worldwide') }}</span>
          <span>{{ t('footer.payments') }}</span>
          <span>{{ t('footer.delivery') }}</span>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© {{ new Date().getFullYear() }} {{ site.brand?.name || 'WoolBuddy' }}. {{ t('footer.rights') }}</span>
        <span>한국어 · English · 中文</span>
      </div>
    </footer>
  </div>
</template>
