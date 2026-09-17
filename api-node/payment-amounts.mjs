import * as rates from './currency.mjs'

export const PAYMENT_RATE_VERSION = rates.CURRENCY_RATE_VERSION || 'fixed-krw-v1'
const code = (value) => String(value || '').trim().toUpperCase()
const positiveMinor = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0

// Intersection of the pricing table and the server's PayPal currency list.
// CNY is display-only; KRW is never a PayPal charge currency.
export function paypalChargeCurrencyReady(currency) {
  return code(currency) === 'USD' && Boolean(rates.normalizeSupportedCurrency(currency))
}

export function chargeAmountCents(baseMinor, baseCurrency, chargeCurrency = 'USD') {
  if (!positiveMinor(baseMinor) || !paypalChargeCurrencyReady(chargeCurrency)) return 0
  const amount = rates.convertMinorAmount(Number(baseMinor), baseCurrency, chargeCurrency)
  return positiveMinor(amount) ? amount : 0
}

// Never infer an exchange rate from a legacy payment. Fallback is safe only
// when BOTH snapshot fields are absent and the recorded currencies match.
export function paymentBaseAmountCents(payment = {}, order = {}) {
  const orderCurrency = code(order.currency)
  if (!orderCurrency || !positiveMinor(payment.amount_cents)) return 0
  const hasAmount = Object.prototype.hasOwnProperty.call(payment, 'base_amount_cents')
  const hasCurrency = Object.prototype.hasOwnProperty.call(payment, 'base_currency')
  if (hasAmount || hasCurrency) {
    return hasAmount && hasCurrency && code(payment.base_currency) === orderCurrency
      && positiveMinor(payment.base_amount_cents) ? Number(payment.base_amount_cents) : 0
  }
  return code(payment.currency) === orderCurrency ? Number(payment.amount_cents) : 0
}

export function orderInitialPayableAmount(order = {}) {
  if (positiveMinor(order.initial_payment_cents)) {
    return Math.min(Number(order.initial_payment_cents), Number(order.amount_cents || 0))
  }
  if (order.payment_type === 'full') return Number(order.amount_cents || 0)
  const percent = Number(order.deposit_percent || 50)
  return Math.round(Number(order.amount_cents || 0) * Math.min(100, Math.max(1, percent)) / 100)
}

export function payableAmount(order = {}) {
  if (order.payment_status === 'unpaid') return orderInitialPayableAmount(order)
  return Math.max(0, Number(order.amount_cents || 0) - Number(order.paid_amount_cents || 0))
}

export function payableType(order = {}) {
  return order.payment_status === 'balance_due' ? 'balance' : order.payment_type
}

export function validatePayableOrder(order = {}) {
  if (order.order_status === 'cancelled') return 'cancelled order cannot be paid'
  if (order.payment_status === 'refunded') return 'refunded order cannot be paid'
  if (['paid', 'deposit_paid'].includes(order.payment_status)) return 'order already paid'
  if (!['unpaid', 'balance_due'].includes(order.payment_status)) return 'invalid payment status'
  return ''
}

export function validatePaymentSettlement(order = {}, payment = {}) {
  const payableError = validatePayableOrder(order)
  if (payableError) return payableError
  if (payment.order_id !== order.id || payment.status !== 'created') return 'payment no longer matches order'
  if (!paypalChargeCurrencyReady(payment.currency)) return 'unsupported paypal currency'
  const base = paymentBaseAmountCents(payment, order)
  if (!base) return 'payment base amount or currency mismatch'
  const total = Number(order.amount_cents)
  const paid = Number(order.paid_amount_cents ?? 0)
  if (!positiveMinor(total) || !Number.isSafeInteger(paid) || paid < 0) return 'invalid order amount'
  if (payment.payment_type !== payableType(order) || base !== payableAmount(order)) return 'payment no longer matches order'
  if (base > total - paid) return 'payment would exceed order amount'
  return ''
}

export function validatePaypalCaptureAmount(payment = {}, capture = {}) {
  if (!paypalChargeCurrencyReady(payment.currency) || code(capture.currency) !== code(payment.currency)) return 'paypal currency mismatch'
  // PayPal USD values must be exact minor units, not rounded malformed values.
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(capture.amount_value ?? ''))) return 'paypal amount mismatch'
  const amount = Math.round(Number(capture.amount_value) * 100)
  if (!positiveMinor(payment.amount_cents) || amount !== Number(payment.amount_cents)) return 'paypal amount mismatch'
  return ''
}

// Pure transition shared by webhook/direct capture; duplicate captured records
// remain no-ops even after the order advances to its next payment stage.
export function capturedPaymentTransition(order = {}, payment = {}, capture = {}) {
  if (payment.status === 'captured') return null
  const error = validatePaymentSettlement(order, payment) || validatePaypalCaptureAmount(payment, capture)
    || (capture.capture_status !== 'COMPLETED' ? 'paypal capture not completed' : '')
  if (error) throw Object.assign(new Error(error), { status: 409 })
  const paid = Number(order.paid_amount_cents || 0) + paymentBaseAmountCents(payment, order)
  return {
    paid_amount_cents: paid,
    payment_status: paid === Number(order.amount_cents) ? 'paid' : 'deposit_paid',
    order_status: payment.payment_type === 'balance' ? 'ready_ship' : 'confirmed',
  }
}

export function paymentAmountSnapshot(order, payments = [], chargeCurrency = 'USD') {
  const base = payableAmount(order)
  let amount = chargeAmountCents(base, order.currency, chargeCurrency)
  // Allocate the rounding remainder to the balance only when the entire paid
  // amount is accounted for by compatible immutable snapshots. Historical,
  // manual and mixed-rate payments retain per-installment conversion.
  if (payableType(order) === 'balance' && amount > 0) {
    const prior = payments.filter((p) => p.order_id === order.id && p.status === 'captured')
    if (prior.length && prior.every((p) => p.provider === 'paypal'
      && code(p.currency) === code(chargeCurrency) && p.rate_version === PAYMENT_RATE_VERSION
      && positiveMinor(p.base_amount_cents) && paymentBaseAmountCents(p, order) > 0)
      && prior.reduce((sum, p) => sum + paymentBaseAmountCents(p, order), 0) === Number(order.paid_amount_cents)) {
      amount = chargeAmountCents(order.amount_cents, order.currency, chargeCurrency)
        - prior.reduce((sum, p) => sum + Number(p.amount_cents), 0)
    }
  }
  if (!positiveMinor(amount)) throw Object.assign(new Error('payment amount cannot be converted'), { status: 409 })
  return {
    amount_cents: amount,
    currency: code(chargeCurrency),
    base_amount_cents: base,
    base_currency: code(order.currency),
    rate_version: PAYMENT_RATE_VERSION,
  }
}

// A scalar is meaningful only for a single currency; never sum unlike units.
export function singleCurrencyTotal(byCurrency = {}) {
  const currencies = Object.keys(byCurrency)
  return {
    amount: currencies.length > 1 ? null : currencies.length ? byCurrency[currencies[0]] : 0,
    currency: currencies.length === 1 ? currencies[0] : '',
  }
}
