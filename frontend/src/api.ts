export const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

export type Product = {
  id: string
  slug: string
  category_id?: string
  category?: Category
  base_price_cents: number
  currency: string
  deposit_percent: number
  image_url?: string
  images?: string[]
  title: string
  subtitle: string
  description: string
  specs?: string[]
  options?: ProductOption[]
  tags?: string[]
  use_cases?: string[]
  alt_text?: string
  faqs?: Faq[]
  subcategory_slug?: string
  status?: string
  seo_title?: string
  seo_description?: string
  translations?: Record<string, any>
}

export type Category = { id: string; slug: string; title: string; description: string; sort_order: number; status: string; translations?: Record<string, any>; children?: Category[] }
export type ProductOption = { id: string; name: string; price_cents: number; translations?: Record<string, any> }
export type Faq = { id: string; question: string; answer: string; translations?: Record<string, any> }
export type SiteSettings = Record<string, any>
export type Order = Record<string, any>
export type SupportContact = { key: 'talk' | 'line' | 'email'; label: string; url: string; external: boolean }

declare global {
  interface Window {
    google?: any
  }
}

export function safeGetLocalStorage(key: string) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

export function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function safeRemoveLocalStorage(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in privacy modes.
  }
}

function withCurrentLang(path: string, options: RequestInit = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const lang = safeGetLocalStorage('lang')
  if (method !== 'GET' || !lang || path.startsWith('/admin') || path.includes('lang=')) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}lang=${encodeURIComponent(lang)}`
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) }
  if (!(options.body instanceof Blob)) headers['Content-Type'] = headers['Content-Type'] || 'application/json'
  if (path.startsWith('/admin')) {
    const token = safeGetLocalStorage('admin_token')
    if (token) headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(`${API_BASE}${withCurrentLang(path, options)}`, { ...options, headers })
  if (!res.ok) {
    if (res.status === 401 && path.startsWith('/admin') && path !== '/admin/login') {
      safeRemoveLocalStorage('admin_token')
    }
    const text = await res.text().catch(() => '')
    let message = text
    try {
      const data = JSON.parse(text)
      message = data?.message || data?.error || text
    } catch {
      message = text
    }
    throw new Error(message || res.statusText || `Request failed with ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function upload(file: File): Promise<{ url: string; filename: string }> {
  return api('/uploads', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  })
}

export function userToken() {
  return safeGetLocalStorage('user_token')
}

export function clearUserSession() {
  safeRemoveLocalStorage('user_profile')
  safeRemoveLocalStorage('user_token')
}

function decodeUserTokenPayload(token: string) {
  const payload = token.split('.')[1] || ''
  const normalized = payload.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(atob(padded))
}

export function currentUser() {
  const token = safeGetLocalStorage('user_token')
  if (!token?.startsWith('user-v1.')) {
    clearUserSession()
    return null
  }
  let tokenUser: any = null
  try {
    tokenUser = decodeUserTokenPayload(token)
  } catch {
    clearUserSession()
    return null
  }
  const raw = safeGetLocalStorage('user_profile')
  if (!raw) return null
  try {
    const profile = JSON.parse(raw)
    const tokenEmail = String(tokenUser?.email || '').trim().toLowerCase()
    const profileEmail = String(profile?.email || '').trim().toLowerCase()
    const expiresAt = Number(tokenUser?.exp || 0)
    if (!tokenEmail || tokenEmail !== profileEmail || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearUserSession()
      return null
    }
    return { ...profile, email: tokenEmail }
  } catch {
    clearUserSession()
    return null
  }
}

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google)
  return new Promise<any>((resolve, reject) => {
    const existing = document.querySelector('script[data-google-identity="true"]') as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google), { once: true })
      existing.addEventListener('error', () => reject(new Error('google identity failed')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.googleIdentity = 'true'
    script.onload = () => window.google?.accounts?.id ? resolve(window.google) : reject(new Error('google identity unavailable'))
    script.onerror = () => reject(new Error('google identity failed'))
    document.head.appendChild(script)
  })
}

export async function requestGoogleIdToken(clientId: string): Promise<string> {
  const normalizedClientId = String(clientId || '').trim()
  if (!normalizedClientId) throw new Error('google client id missing')
  const google = await loadGoogleIdentityScript()
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (token = '') => {
      if (settled) return
      settled = true
      token ? resolve(token) : reject(new Error('google credential missing'))
    }
    google.accounts.id.initialize({
      client_id: normalizedClientId,
      callback: (response: any) => finish(String(response?.credential || '')),
      auto_select: false,
      cancel_on_tap_outside: true,
    })
    google.accounts.id.prompt((notification: any) => {
      if (settled) return
      if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.()) {
        finish('')
      }
    })
    window.setTimeout(() => finish(''), 45000)
  })
}

export async function loginWithGoogle(site: SiteSettings = {}, email = '') {
  const googleConfig = site.google || {}
  const clientId = String(googleConfig.client_id || '').trim()
  if (clientId && googleConfig.auth_mode === 'google') {
    const idToken = await requestGoogleIdToken(clientId)
    return api<any>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ id_token: idToken })
    })
  }
  const demoEmail = String(email || '').trim().toLowerCase()
  return api<any>('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ email: demoEmail, name: demoEmail.split('@')[0].slice(0, 120) })
  })
}

export function money(cents: number, currency = 'USD') {
  const amount = Number.isFinite(Number(cents)) ? Number(cents) : 0
  const normalizedCurrency = /^[A-Z]{3}$/.test(String(currency || '').trim().toUpperCase())
    ? String(currency || '').trim().toUpperCase()
    : 'USD'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: normalizedCurrency }).format(amount / 100)
  } catch {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount / 100)
  }
}

export function supportContacts(site: SiteSettings = {}, emailLabel = 'Email'): SupportContact[] {
  const contact = site.contact || {}
  const email = String(site.brand?.email || '').trim().replace(/\s/g, '')
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
  const validExternalUrl = (value: unknown) => {
    try {
      const url = new URL(String(value || '').trim())
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
    } catch {
      return ''
    }
  }
  const talkUrl = validExternalUrl(contact.talk_url)
  const lineUrl = validExternalUrl(contact.line_url)
  return [
    contact.talk_enabled && talkUrl ? { key: 'talk' as const, label: contact.talk_label || 'TALK', url: talkUrl, external: true } : null,
    contact.line_enabled && lineUrl ? { key: 'line' as const, label: contact.line_label || 'LINE', url: lineUrl, external: true } : null,
    validEmail ? { key: 'email' as const, label: emailLabel, url: `mailto:${validEmail}`, external: false } : null,
  ].filter(Boolean) as SupportContact[]
}

export function primarySupportContact(site: SiteSettings = {}, emailLabel = 'Email') {
  return supportContacts(site, emailLabel)[0] || null
}
