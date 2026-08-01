<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, clearUserSession, currentUser, loginWithGoogle, money, primarySupportContact, safeGetLocalStorage, safeSetLocalStorage, type Order, type SiteSettings } from '../api'
import { productFallbackImage } from '../contentImages'
import { setHead } from '../head'
import { clearPaypalContainer, loadPaypalSdk, renderPaypalCardFields } from '../paypal'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const user = ref<any>(currentUser())
const orders = ref<Order[]>([])
const site = ref<SiteSettings>({})
const message = ref('')
const payRecoveryVisible = ref(false)
const routedEmail = String(route.query.email || '').trim().toLowerCase()
const loginEmail = ref(routedEmail || user.value?.email || '')
const loginLoading = ref(false)
const ordersLoading = ref(false)
const payingOrderId = ref('')
const payRecoveryOrderId = ref('')
const pendingPaypal = ref<Record<string, any>>({})
const paypalButtonLoading = ref<Record<string, boolean>>({})
const paypalButtonErrors = ref<Record<string, string>>({})
const paypalCardFields = ref<Record<string, any>>({})
const paypalCardEligible = ref<Record<string, boolean>>({})
const paypalCardLoading = ref<Record<string, boolean>>({})
const paypalCardErrors = ref<Record<string, string>>({})
const expandedOrderId = ref('')
const orderCopyOutput = ref('')
let paypalRenderSeq = 0
const supportContact = computed(() => {
  return primarySupportContact(site.value, t('support.emailLabel'))
})
const payRecoveryOrder = computed(() => {
  return orders.value.find((order) => order.id === payRecoveryOrderId.value)
})

function clearAccountRuntimeState() {
  resetAccountPaypalButtons()
  pendingPaypal.value = {}
  payingOrderId.value = ''
  payRecoveryOrderId.value = ''
  expandedOrderId.value = ''
  orderCopyOutput.value = ''
}

function paypalContainerId(orderId: string) {
  return `account-paypal-${String(orderId || '').replace(/[^a-z0-9_-]/gi, '-')}`
}

function paypalButtonContainerId(order: Order) {
  return paypalContainerId(order.id)
}

function paypalCardContainerId(orderId: string, field: string) {
  return `${paypalContainerId(orderId)}-card-${field}`
}

function setPaypalButtonLoading(orderId: string, value: boolean) {
  paypalButtonLoading.value = { ...paypalButtonLoading.value, [orderId]: value }
}

function setPaypalButtonError(orderId: string, value: string) {
  paypalButtonErrors.value = { ...paypalButtonErrors.value, [orderId]: value }
}

function clearPaypalButtonState(orderId: string) {
  const loading = { ...paypalButtonLoading.value }
  delete loading[orderId]
  paypalButtonLoading.value = loading
  const errors = { ...paypalButtonErrors.value }
  delete errors[orderId]
  paypalButtonErrors.value = errors
  clearPaypalContainer(document.getElementById(paypalContainerId(orderId)))
  ;['name', 'number', 'expiry', 'cvv'].forEach((field) => clearPaypalContainer(document.getElementById(paypalCardContainerId(orderId, field))))
  const fields = { ...paypalCardFields.value }
  delete fields[orderId]
  paypalCardFields.value = fields
  const eligible = { ...paypalCardEligible.value }
  delete eligible[orderId]
  paypalCardEligible.value = eligible
  const cardLoading = { ...paypalCardLoading.value }
  delete cardLoading[orderId]
  paypalCardLoading.value = cardLoading
  const cardErrors = { ...paypalCardErrors.value }
  delete cardErrors[orderId]
  paypalCardErrors.value = cardErrors
}

function resetAccountPaypalButtons(orderId = '') {
  paypalRenderSeq += 1
  if (orderId) {
    clearPaypalButtonState(orderId)
    return
  }
  document.querySelectorAll<HTMLElement>('[data-account-paypal-buttons="true"]').forEach((element) => clearPaypalContainer(element))
  paypalButtonLoading.value = {}
  paypalButtonErrors.value = {}
  paypalCardFields.value = {}
  paypalCardEligible.value = {}
  paypalCardLoading.value = {}
  paypalCardErrors.value = {}
}

function trackingUrl(order: Order) {
  if (order.tracking_url) return String(order.tracking_url)
  const trackingNo = String(order.tracking_no || '').trim()
  const template = String(site.value.shipping?.tracking_url_template || '').trim()
  if (!trackingNo || !template) return ''
  try {
    const urlText = template
      .replaceAll('{tracking}', encodeURIComponent(trackingNo))
      .replaceAll('{carrier}', encodeURIComponent(String(order.shipping_carrier || '').trim()))
    const url = new URL(urlText)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

function accountErrorMessage(error: any) {
  const text = String(error?.message || '')
  if (text === 'user blocked') return t('account.userBlocked')
  if (text === 'login required') return t('account.loginRequired')
  if (['paypal disabled', 'paypal currency mismatch', 'cancelled order cannot be paid', 'refunded order cannot be paid', 'order already paid'].includes(text)) {
    return t('account.payUnavailable')
  }
  return t('account.payFailed')
}

async function loginGoogleDemo() {
  const email = loginEmail.value.trim().toLowerCase()
  loginEmail.value = email
  const requiresEmail = site.value.google?.auth_mode !== 'google'
  if (requiresEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    message.value = t('account.emailInvalid')
    return
  }
  loginLoading.value = true
  message.value = ''
  payRecoveryVisible.value = false
  clearUserSession()
  user.value = null
  orders.value = []
  clearAccountRuntimeState()
  try {
    const result = await loginWithGoogle(site.value, email)
    safeSetLocalStorage('user_token', result.token)
    safeSetLocalStorage('user_profile', JSON.stringify(result.user))
    user.value = result.user
    await loadOrders()
  } catch (e: any) {
    message.value = accountErrorMessage(e)
  } finally {
    loginLoading.value = false
  }
}

function logout() {
  clearUserSession()
  user.value = null
  orders.value = []
  ordersLoading.value = false
  clearAccountRuntimeState()
  message.value = ''
  payRecoveryVisible.value = false
}

function statusText(value: string) {
  return t(`status.${value}`)
}

function orderDate(value: string) {
  return value ? new Date(value).toLocaleString() : '-'
}

function remainingAmount(order: Order) {
  return Math.max(0, Number(order.amount_cents || 0) - Number(order.paid_amount_cents || 0))
}

function nextStepText(order: Order) {
  if (order.payment_status === 'unpaid') return t('account.nextPay')
  if (order.payment_status === 'balance_due') return t('account.nextBalance')
  if (order.order_status === 'new' || order.order_status === 'confirmed') return t('account.nextReview')
  if (order.order_status === 'crafting') return t('account.nextCrafting')
  if (order.order_status === 'preview') return t('account.nextPreview')
  if (order.order_status === 'balance_due') return t('account.nextBalance')
  if (order.order_status === 'ready_ship') return t('account.nextShip')
  if (order.order_status === 'shipped') return t('account.nextTracking')
  if (order.order_status === 'completed') return t('account.nextDone')
  if (order.order_status === 'cancelled') return t('account.nextCancelled')
  return t('account.nextReview')
}

function orderProgressIndex(order: Order) {
  if (order.order_status === 'cancelled') return 0
  if (order.order_status === 'completed') return 5
  if (order.order_status === 'shipped' || order.order_status === 'ready_ship') return 4
  if (order.order_status === 'balance_due' || order.payment_status === 'balance_due') return 4
  if (order.order_status === 'preview') return 3
  if (order.order_status === 'crafting') return 2
  if (order.payment_status === 'unpaid') return 0
  return 1
}

function orderProgressSteps(order: Order) {
  const active = orderProgressIndex(order)
  return [
    t('account.progressSubmitted'),
    t('account.progressReview'),
    t('account.progressCrafting'),
    t('account.progressPreview'),
    t('account.progressShipping'),
    t('account.progressDone'),
  ].map((label, index) => ({ label, done: index <= active }))
}

function supportTextValue(value: unknown, limit = 500) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!text) return '-'
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function orderSummary(order: Order) {
  return [
    `${t('account.detailOrder')} ${supportTextValue(order.order_no, 80)}`,
    `${t('account.detailProduct')} ${supportTextValue(order.product_title, 160)} / ${supportTextValue(order.option_name, 120)}`,
    `${t('account.detailPet')} ${supportTextValue(order.pet_name, 120)} ${supportTextValue(order.pet_type, 80)}`.trim(),
    `${t('account.detailContact')} ${supportTextValue(order.customer_name, 120)} / ${supportTextValue(order.email || user.value?.email, 160)} / ${supportTextValue(order.phone, 80)}`,
    order.shipping_address ? `${t('account.detailShippingAddress')} ${supportTextValue(order.country, 80)} ${supportTextValue(order.shipping_address, 260)}` : '',
    `${t('account.detailStatus')} ${statusText(order.order_status)} / ${statusText(order.payment_status)}`,
    `${t('account.detailAmount')} ${money(order.amount_cents || 0, order.currency)} / ${t('account.paidAmount', { amount: money(order.paid_amount_cents || 0, order.currency) })} / ${t('account.remainingAmount', { amount: money(remainingAmount(order), order.currency) })}`,
    `${t('account.detailPhotos')} ${t('account.photoCount', { count: order.photo_count ?? order.photo_urls?.length ?? 0 })}`,
    order.shipping_carrier || order.tracking_no ? `${t('account.detailTracking')} ${supportTextValue(order.shipping_carrier, 120)} ${supportTextValue(order.tracking_no, 120)}`.trim() : '',
    order.notes ? `${t('order.notes')} ${supportTextValue(order.notes, 500)}` : '',
  ].filter(Boolean).join('\n')
}

function compactOrderSupportMessage(order: Order) {
  return [
    `${t('account.detailOrder')} ${supportTextValue(order.order_no, 80)}`,
    `${t('account.detailContact')} ${supportTextValue(order.email || user.value?.email, 160)} / ${supportTextValue(order.phone, 80)}`,
    `${t('account.detailAmount')} ${money(order.amount_cents || 0, order.currency)} / ${t('account.remainingAmount', { amount: money(remainingAmount(order), order.currency) })}`,
    `${t('account.detailStatus')} ${statusText(order.order_status)} / ${statusText(order.payment_status)}`,
    `${t('account.supportPage')} ${window.location.href}`,
  ].join('\n')
}

function supportLinkValue(value: string, limit = 1200) {
  const text = supportTextValue(value, limit)
  return text === '-' ? '' : text
}

function supportUrlForOrder(order?: Order) {
  const contact = supportContact.value
  if (!contact) return ''
  if (!order) return contact.url
  const subject = supportLinkValue(`${t('account.supportSubject')} ${supportTextValue(order.order_no, 80)}`, 160)
  if (contact.url.startsWith('mailto:')) {
    const summary = supportLinkValue(orderSummary(order), 1200)
    const [baseUrl, queryText = ''] = contact.url.split('?')
    const params = new URLSearchParams(queryText)
    if (!params.has('subject')) params.set('subject', subject)
    if (!params.has('body')) params.set('body', summary)
    return `${baseUrl}?${params.toString()}`
  }
  try {
    const url = new URL(contact.url)
    const messageKey = url.searchParams.has('text') ? 'message' : 'text'
    if (!url.searchParams.has('text') && !url.searchParams.has('message')) {
      url.searchParams.set(messageKey, supportLinkValue(compactOrderSupportMessage(order), 900))
    }
    return url.toString()
  } catch {
    return contact.url
  }
}

function supportRouteForOrder(order?: Order) {
  if (!order) return { path: '/support' }
  return {
    path: '/support',
    query: {
      order: order.order_no || order.id || '',
      email: order.email || user.value?.email || '',
    }
  }
}

async function copyOrderSummary(order: Order) {
  const text = orderSummary(order)
  orderCopyOutput.value = text
  try {
    await navigator.clipboard?.writeText(text)
    message.value = t('account.copiedOrder')
  } catch {
    message.value = t('account.copyOrderFallback')
  }
}

function toggleOrderDetail(order: Order) {
  expandedOrderId.value = expandedOrderId.value === order.id ? '' : order.id
}

function userAuthHeaders() {
  return { Authorization: `Bearer ${safeGetLocalStorage('user_token')}` }
}

async function loadOrders() {
  if (!safeGetLocalStorage('user_token')) return
  ordersLoading.value = true
  try {
    orders.value = await api<Order[]>('/me/orders', {
      headers: userAuthHeaders()
    })
    message.value = ''
    payRecoveryVisible.value = false
  } catch (e: any) {
    if (['login required', 'user blocked'].includes(String(e.message || ''))) {
      logout()
    } else {
      clearAccountRuntimeState()
    }
    message.value = String(e.message || '') === 'user blocked' ? t('account.userBlocked') : t('account.loadFailed')
    payRecoveryVisible.value = false
  } finally {
    ordersLoading.value = false
  }
}

async function loadSite() {
  try {
    site.value = await api<SiteSettings>('/site')
  } catch {
    site.value = {}
  }
}

async function startPaypal(order: Order) {
  if (payingOrderId.value === order.id) return
  payingOrderId.value = order.id
  message.value = ''
  payRecoveryVisible.value = false
  payRecoveryOrderId.value = ''
  try {
    const result = await api<any>('/paypal/create-order', {
      method: 'POST',
      headers: userAuthHeaders(),
      body: JSON.stringify({
        order_id: order.id,
        return_path: `/account?paypal_return=1&email=${encodeURIComponent(user.value?.email || order.email || '')}`,
        cancel_path: `/account?paypal_cancel=1&email=${encodeURIComponent(user.value?.email || order.email || '')}`,
      })
    })
    pendingPaypal.value = { ...pendingPaypal.value, [order.id]: result }
    message.value = t('account.paymentReady')
    await renderAccountPaypalButtons(order, result)
  } catch (e: any) {
    message.value = accountErrorMessage(e)
    const recoverable = message.value === t('account.payUnavailable')
    payRecoveryVisible.value = recoverable
    payRecoveryOrderId.value = recoverable ? order.id : ''
  } finally {
    payingOrderId.value = ''
  }
}

async function captureApprovedAccountPaypalOrder(order: Order, paypalOrderId = pendingPaypal.value[order.id]?.id) {
  await api<any>('/paypal/capture-order', {
    method: 'POST',
    headers: userAuthHeaders(),
    body: JSON.stringify({ paypal_order_id: paypalOrderId })
  })
  const next = { ...pendingPaypal.value }
  delete next[order.id]
  pendingPaypal.value = next
  resetAccountPaypalButtons(order.id)
  message.value = t('account.paySuccess')
  await loadOrders()
}

async function renderAccountPaypalButtons(order: Order, paypalOrder = pendingPaypal.value[order.id]) {
  resetAccountPaypalButtons(order.id)
  if (!paypalOrder || paypalOrder.mock) return
  const clientId = String(site.value.paypal?.client_id || '').trim()
  const currency = String(order.currency || site.value.paypal?.currency || 'USD').trim().toUpperCase()
  if (!clientId) {
    setPaypalButtonError(order.id, t('account.paypalButtonError'))
    return
  }
  const seq = paypalRenderSeq
  setPaypalButtonLoading(order.id, true)
  await nextTick()
  const target = document.getElementById(paypalContainerId(order.id))
  if (!target || seq !== paypalRenderSeq) {
    setPaypalButtonLoading(order.id, false)
    return
  }
  try {
    const paypal = await loadPaypalSdk({ clientId, currency })
    if (seq !== paypalRenderSeq) return
    clearPaypalContainer(target)
    const buttons = paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 44 },
      createOrder: async () => pendingPaypal.value[order.id]?.id || paypalOrder.id,
      onApprove: async (data: any) => {
        payingOrderId.value = order.id
        message.value = ''
        try {
          await captureApprovedAccountPaypalOrder(order, data?.orderID || pendingPaypal.value[order.id]?.id || paypalOrder.id)
        } catch (e: any) {
          message.value = accountErrorMessage(e)
        } finally {
          payingOrderId.value = ''
        }
      },
      onCancel: () => {
        message.value = t('account.payCancelled')
      },
      onError: () => {
        setPaypalButtonError(order.id, t('account.paypalButtonError'))
      },
    })
    if (buttons.isEligible && !buttons.isEligible()) {
      setPaypalButtonError(order.id, t('account.paypalButtonError'))
      return
    }
    await buttons.render(target)
    const cardTargets = {
      name: document.getElementById(paypalCardContainerId(order.id, 'name')),
      number: document.getElementById(paypalCardContainerId(order.id, 'number')),
      expiry: document.getElementById(paypalCardContainerId(order.id, 'expiry')),
      cvv: document.getElementById(paypalCardContainerId(order.id, 'cvv')),
    }
    if (cardTargets.name && cardTargets.number && cardTargets.expiry && cardTargets.cvv && seq === paypalRenderSeq) {
      const fields = await renderPaypalCardFields({
        paypal,
        targets: cardTargets as any,
        createOrder: async () => pendingPaypal.value[order.id]?.id || paypalOrder.id,
        onApprove: async (data: any) => {
          payingOrderId.value = order.id
          message.value = ''
          try {
            await captureApprovedAccountPaypalOrder(order, data?.orderID || pendingPaypal.value[order.id]?.id || paypalOrder.id)
          } catch (e: any) {
            message.value = accountErrorMessage(e)
          } finally {
            payingOrderId.value = ''
          }
        },
      })
      if (seq !== paypalRenderSeq) return
      paypalCardFields.value = { ...paypalCardFields.value, [order.id]: fields }
      paypalCardEligible.value = { ...paypalCardEligible.value, [order.id]: Boolean(fields) }
    }
  } catch {
    setPaypalButtonError(order.id, t('account.paypalButtonError'))
  } finally {
    if (seq === paypalRenderSeq) setPaypalButtonLoading(order.id, false)
  }
}

async function submitAccountPaypalCardFields(order: Order) {
  const fields = paypalCardFields.value[order.id]
  if (!fields || paypalCardLoading.value[order.id] || payingOrderId.value === order.id) return
  paypalCardLoading.value = { ...paypalCardLoading.value, [order.id]: true }
  paypalCardErrors.value = { ...paypalCardErrors.value, [order.id]: '' }
  try {
    await fields.submit()
  } catch {
    paypalCardErrors.value = { ...paypalCardErrors.value, [order.id]: t('account.paypalButtonError') }
  } finally {
    paypalCardLoading.value = { ...paypalCardLoading.value, [order.id]: false }
  }
}

async function capturePaypal(order: Order) {
  const paypal = pendingPaypal.value[order.id]
  if (!paypal?.id) return
  if (payingOrderId.value === order.id) return
  payingOrderId.value = order.id
  message.value = ''
  payRecoveryVisible.value = false
  try {
    await api<any>('/paypal/capture-order', {
      method: 'POST',
      headers: userAuthHeaders(),
      body: JSON.stringify({ paypal_order_id: paypal.id })
    })
    const next = { ...pendingPaypal.value }
    delete next[order.id]
    pendingPaypal.value = next
    message.value = t('account.paySuccess')
    await loadOrders()
  } catch (e: any) {
    message.value = accountErrorMessage(e)
  } finally {
    payingOrderId.value = ''
  }
}

function paypalReturnOrderId() {
  return String(route.query.token || route.query.paypal_order_id || '').trim()
}

async function capturePaypalReturn() {
  if (!route.query.paypal_return) return
  const paypalOrderId = paypalReturnOrderId()
  if (!paypalOrderId || !safeGetLocalStorage('user_token')) return
  payingOrderId.value = '__paypal_return__'
  message.value = ''
  payRecoveryVisible.value = false
  try {
    await api<any>('/paypal/capture-order', {
      method: 'POST',
      headers: userAuthHeaders(),
      body: JSON.stringify({ paypal_order_id: paypalOrderId })
    })
    await router.replace({ path: '/account', query: loginEmail.value ? { email: loginEmail.value } : {} })
    await loadOrders()
    message.value = t('account.paySuccess')
  } catch (e: any) {
    message.value = accountErrorMessage(e)
  } finally {
    payingOrderId.value = ''
  }
}

function setAccountHead() {
  setHead(t('account.title'), t('account.loginDesc'), { canonical: `${window.location.origin}/account`, image: productFallbackImage })
}

onMounted(async () => {
  setAccountHead()
  await loadSite()
  await loadOrders()
  await capturePaypalReturn()
})
onBeforeUnmount(resetAccountPaypalButtons)
watch(() => t('account.title'), setAccountHead)
</script>

<template>
  <main class="section">
    <div class="section-head">
      <div>
        <p class="eyebrow">{{ t('account.eyebrow') }}</p>
        <h1>{{ t('account.title') }}</h1>
      </div>
      <button v-if="user" class="button ghost" @click="logout">{{ t('account.logout') }}</button>
    </div>

    <section v-if="!user" class="panel">
      <h2>{{ t('account.loginTitle') }}</h2>
      <p class="muted">{{ t('account.loginDesc') }}</p>
      <div class="account-login-box">
        <label>
          <span>{{ t('account.loginEmail') }}</span>
          <input v-model="loginEmail" type="email" autocomplete="email" inputmode="email" maxlength="160" />
        </label>
        <button class="button primary" :disabled="loginLoading" @click="loginGoogleDemo">{{ loginLoading ? t('common.loading') : t('account.google') }}</button>
      </div>
      <div class="account-login-help">
        <p>{{ t('account.loginHelp') }}</p>
        <div class="empty-actions">
          <RouterLink class="button ghost" to="/order">{{ t('account.startOrder') }}</RouterLink>
          <a
            v-if="supportContact"
            class="button ghost"
            :href="supportContact.url"
            :target="supportContact.external ? '_blank' : undefined"
            :rel="supportContact.external ? 'noopener noreferrer' : undefined"
          >{{ t('account.contactSupport') }}</a>
          <RouterLink v-else class="button ghost" to="/support">{{ t('account.contactSupport') }}</RouterLink>
        </div>
      </div>
    </section>

    <section v-else class="panel account-panel">
      <div class="account-panel-head">
        <div>
          <h2>{{ t('account.userOrders', { name: user.name }) }}</h2>
          <p class="muted">{{ user.email }}</p>
        </div>
        <button class="button ghost" type="button" :disabled="ordersLoading" @click="loadOrders">
          {{ ordersLoading ? t('common.loading') : t('account.refreshOrders') }}
        </button>
      </div>
      <div class="account-service-note">
        <strong>{{ t('account.servicePromiseTitle') }}</strong>
        <span>{{ t('account.servicePromiseDesc') }}</span>
      </div>
      <p v-if="ordersLoading" class="muted">{{ t('account.loadingOrders') }}</p>
      <div class="mini-list">
        <article v-for="order in orders" :key="order.id" class="order-card">
          <div class="order-card-main">
            <div>
              <strong>{{ order.order_no }}</strong><br>
              <small>{{ order.customer_name }} / {{ order.pet_name }} {{ order.pet_type }}</small><br>
              <small>{{ order.product_title }} / {{ order.option_name }}</small><br>
              <small>{{ t('account.createdAt') }} {{ orderDate(order.created_at) }}</small>
            </div>
            <p class="order-next-step">{{ nextStepText(order) }}</p>
          </div>
          <div>
            {{ money(order.amount_cents, order.currency) }}<br>
            <small>{{ statusText(order.payment_status) }}</small><br>
            <small>{{ t('account.paidAmount', { amount: money(order.paid_amount_cents || 0, order.currency) }) }}</small><br>
            <small>{{ t('account.remainingAmount', { amount: money(remainingAmount(order), order.currency) }) }}</small><br>
            <small>{{ t(`order.${order.payment_type}`) }}</small><br>
            <small>{{ t('account.photoCount', { count: order.photo_count ?? order.photo_urls?.length ?? 0 }) }}</small>
          </div>
          <div class="account-order-status">
            <span class="status-pill">{{ statusText(order.order_status) }}</span>
            <small>{{ t('account.supportHint') }}</small>
            <a
              v-if="supportContact"
              class="button ghost"
              :href="supportUrlForOrder(order)"
              :target="supportContact.external ? '_blank' : undefined"
              :rel="supportContact.external ? 'noopener noreferrer' : undefined"
            >{{ t('account.contactSupport') }}</a>
            <RouterLink v-else class="button ghost" :to="supportRouteForOrder(order)">{{ t('account.contactSupport') }}</RouterLink>
            <button
              v-if="['unpaid', 'balance_due'].includes(order.payment_status) && !pendingPaypal[order.id]"
              class="button ghost"
              type="button"
              :disabled="payingOrderId === order.id"
              @click="startPaypal(order)"
            >
              {{ payingOrderId === order.id ? t('common.loading') : t('account.continuePay') }}
            </button>
            <button
              v-if="pendingPaypal[order.id]?.mock"
              class="button ghost"
              type="button"
              :disabled="payingOrderId === order.id"
              @click="capturePaypal(order)"
            >
              {{ payingOrderId === order.id ? t('common.loading') : t('account.confirmPay') }}
            </button>
            <section v-if="pendingPaypal[order.id] && !pendingPaypal[order.id]?.mock" class="paypal-inline-panel account-paypal-panel">
              <div>
                <strong>{{ t('account.paypalInlineTitle') }}</strong>
                <span>{{ t('account.paypalInlineDesc') }}</span>
              </div>
              <div :id="paypalButtonContainerId(order)" class="paypal-button-host" data-account-paypal-buttons="true"></div>
              <div v-show="paypalCardEligible[order.id]" class="paypal-card-fields">
                <div :id="paypalCardContainerId(order.id, 'name')" class="paypal-card-field"></div>
                <div :id="paypalCardContainerId(order.id, 'number')" class="paypal-card-field"></div>
                <div class="paypal-card-field-row">
                  <div :id="paypalCardContainerId(order.id, 'expiry')" class="paypal-card-field"></div>
                  <div :id="paypalCardContainerId(order.id, 'cvv')" class="paypal-card-field"></div>
                </div>
                <button class="button primary" type="button" :disabled="payingOrderId === order.id || paypalCardLoading[order.id]" @click="submitAccountPaypalCardFields(order)">
                  {{ paypalCardLoading[order.id] ? t('common.loading') : t('account.confirmPay') }}
                </button>
                <small v-if="paypalCardErrors[order.id]" class="form-message error">{{ paypalCardErrors[order.id] }}</small>
              </div>
              <small v-if="paypalButtonLoading[order.id]" class="muted">{{ t('account.paypalButtonLoading') }}</small>
              <small v-if="paypalButtonErrors[order.id]" class="form-message error">{{ paypalButtonErrors[order.id] }}</small>
            </section>
            <button class="button ghost" type="button" @click="toggleOrderDetail(order)">
              {{ expandedOrderId === order.id ? t('account.hideDetails') : t('account.viewDetails') }}
            </button>
            <button class="button ghost" type="button" @click="copyOrderSummary(order)">
              {{ t('account.copyOrder') }}
            </button>
          </div>
          <div v-if="expandedOrderId === order.id" class="account-order-detail">
            <div class="account-progress">
              <h3>{{ t('account.progressTitle') }}</h3>
              <div class="account-progress-steps">
                <span
                  v-for="step in orderProgressSteps(order)"
                  :key="step.label"
                  :class="{ done: step.done }"
                >{{ step.label }}</span>
              </div>
            </div>
            <dl>
              <div>
                <dt>{{ t('account.detailOrder') }}</dt>
                <dd>{{ order.order_no }}</dd>
              </div>
              <div>
                <dt>{{ t('account.detailProduct') }}</dt>
                <dd>{{ order.product_title }} / {{ order.option_name }}</dd>
              </div>
              <div>
                <dt>{{ t('account.detailPet') }}</dt>
                <dd>{{ order.pet_name }} {{ order.pet_type }}</dd>
              </div>
              <div v-if="order.phone">
                <dt>{{ t('account.detailContact') }}</dt>
                <dd>{{ order.phone }}<span v-if="order.country"> / {{ order.country }}</span></dd>
              </div>
              <div v-if="order.shipping_address">
                <dt>{{ t('account.detailShippingAddress') }}</dt>
                <dd>{{ order.shipping_address }}</dd>
              </div>
              <div v-if="order.notes">
                <dt>{{ t('admin.customerNote') }}</dt>
                <dd>{{ order.notes }}</dd>
              </div>
              <div v-if="order.shipping_carrier || order.tracking_no">
                <dt>{{ t('account.detailTracking') }}</dt>
                <dd>
                  {{ order.shipping_carrier || '-' }} {{ order.tracking_no || '' }}
                  <a
                    v-if="trackingUrl(order)"
                    class="inline-action"
                    :href="trackingUrl(order)"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ t('account.trackPackage') }}</a>
                </dd>
              </div>
              <div>
                <dt>{{ t('account.detailAmount') }}</dt>
                <dd>{{ money(order.amount_cents, order.currency) }} / {{ t(`order.${order.payment_type}`) }}<br>{{ t('account.paidAmount', { amount: money(order.paid_amount_cents || 0, order.currency) }) }} / {{ t('account.remainingAmount', { amount: money(remainingAmount(order), order.currency) }) }}</dd>
              </div>
              <div>
                <dt>{{ t('account.detailStatus') }}</dt>
                <dd>{{ statusText(order.order_status) }} / {{ statusText(order.payment_status) }}</dd>
              </div>
              <div>
                <dt>{{ t('account.detailPhotos') }}</dt>
                <dd>
                  {{ t('account.photoCount', { count: order.photo_count ?? order.photo_urls?.length ?? 0 }) }}
                  <small>{{ t('account.photoSecureNote') }}</small>
                </dd>
              </div>
            </dl>
            <section v-if="order.events?.length" class="account-event-timeline">
              <h3>{{ t('account.timelineTitle') }}</h3>
              <ol>
                <li v-for="event in order.events" :key="event.id || `${event.type}-${event.created_at}`">
                  <span>{{ orderDate(event.created_at) }}</span>
                  <strong>{{ event.message }}</strong>
                </li>
              </ol>
            </section>
            <div class="account-aftercare">
              <strong>{{ t('account.aftercareTitle') }}</strong>
              <span>{{ t('account.aftercareDesc') }}</span>
              <a
                v-if="supportContact"
                class="button ghost"
                :href="supportUrlForOrder(order)"
                :target="supportContact.external ? '_blank' : undefined"
                :rel="supportContact.external ? 'noopener noreferrer' : undefined"
              >{{ t('account.contactSupport') }}</a>
              <RouterLink v-else class="button ghost" :to="supportRouteForOrder(order)">{{ t('account.contactSupport') }}</RouterLink>
            </div>
            <p class="order-next-step">{{ nextStepText(order) }}</p>
          </div>
        </article>
      </div>
      <div v-if="user && orderCopyOutput" class="copy-output account-copy-output">
        <label>
          {{ t('account.copyOrderOutput') }}
          <textarea :value="orderCopyOutput" readonly @focus="($event.target as HTMLTextAreaElement).select()" />
        </label>
      </div>
      <div v-if="!ordersLoading && !orders.length" class="empty-state account-empty-state">
        <h3>{{ t('account.emptyTitle') }}</h3>
        <p>{{ t('account.empty') }}</p>
        <div class="empty-actions">
          <RouterLink class="button primary" to="/order">{{ t('account.startOrder') }}</RouterLink>
          <a
            v-if="supportContact"
            class="button ghost"
            :href="supportContact.url"
            :target="supportContact.external ? '_blank' : undefined"
            :rel="supportContact.external ? 'noopener noreferrer' : undefined"
          >{{ t('account.contactSupport') }}</a>
          <RouterLink v-else class="button ghost" :to="supportRouteForOrder()">{{ t('account.contactSupport') }}</RouterLink>
        </div>
      </div>
    </section>
    <p v-if="message" class="form-message">{{ message }}</p>
    <div v-if="payRecoveryVisible" class="payment-recovery-panel">
      <strong>{{ t('account.payRecoveryTitle') }}</strong>
      <span>{{ t('account.payRecoveryDesc') }}</span>
      <div class="empty-actions">
        <a
          v-if="supportContact"
          class="button primary"
          :href="payRecoveryOrder ? supportUrlForOrder(payRecoveryOrder) : supportContact.url"
          :target="supportContact.external ? '_blank' : undefined"
          :rel="supportContact.external ? 'noopener noreferrer' : undefined"
        >{{ t('account.contactSupport') }}</a>
        <RouterLink v-else class="button primary" :to="supportRouteForOrder(payRecoveryOrder)">{{ t('account.contactSupport') }}</RouterLink>
        <button class="button ghost" type="button" :disabled="ordersLoading" @click="loadOrders">
          {{ ordersLoading ? t('common.loading') : t('account.refreshOrders') }}
        </button>
      </div>
    </div>
  </main>
</template>
