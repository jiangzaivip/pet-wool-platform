// Fixed business rates, not a live exchange-rate quote. Keep the frontend
// table aligned; verify-multicurrency.mjs checks both implementations.
export const CURRENCY_BASE = 'KRW'
export const CURRENCY_RATE_VERSION = 'fixed-krw-v1'
export const CURRENCY_RATES = { KRW: 1, USD: 1370, CNY: 203.5 }
export const CURRENCY_DECIMALS = { KRW: 0, USD: 2, CNY: 2 }
export const LANG_CURRENCY = { ko: 'KRW', en: 'USD', zh: 'CNY' }

export function normalizeSupportedCurrency(value = '') {
  const code = String(value || '').trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(CURRENCY_RATES, code) ? code : ''
}

export function displayCurrencyForLang(lang = '') {
  const key = String(lang || '').trim().toLowerCase().split(/[-_]/)[0]
  return LANG_CURRENCY[key] || CURRENCY_BASE
}

// Integer rational arithmetic avoids binary floating-point errors at half cents.
// Zero signals an invalid or unchargeable amount and must be rejected at checkout.
export function convertMinorAmount(minor = 0, from = CURRENCY_BASE, to = CURRENCY_BASE) {
  const fromCode = normalizeSupportedCurrency(from)
  const toCode = normalizeSupportedCurrency(to)
  const amount = Number(minor)
  if (!fromCode || !toCode || !Number.isSafeInteger(amount) || amount <= 0) return 0
  const numerator = BigInt(amount) * BigInt(Math.round(CURRENCY_RATES[fromCode] * 10)) * 10n ** BigInt(CURRENCY_DECIMALS[toCode])
  const denominator = BigInt(Math.round(CURRENCY_RATES[toCode] * 10)) * 10n ** BigInt(CURRENCY_DECIMALS[fromCode])
  const rounded = (2n * numerator + denominator) / (2n * denominator)
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : 0
}
