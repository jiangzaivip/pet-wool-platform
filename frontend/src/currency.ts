// Fixed business rates; keep aligned with api-node/currency.mjs.
// Display conversions are estimates; the server payment snapshot is authoritative.

export const CURRENCY_BASE = 'KRW'
export const CURRENCY_RATE_VERSION = 'fixed-krw-v1'
export const CURRENCY_RATES: Record<string, number> = { KRW: 1, USD: 1370, CNY: 203.5 }
export const CURRENCY_DECIMALS: Record<string, number> = { KRW: 0, USD: 2, CNY: 2 }
export const LANG_CURRENCY: Record<string, string> = { ko: 'KRW', en: 'USD', zh: 'CNY' }

export function normalizeSupportedCurrency(value = ''): string {
  const code = String(value || '').trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(CURRENCY_RATES, code) ? code : ''
}

export function displayCurrencyForLang(lang = ''): string {
  const key = String(lang || '').trim().toLowerCase().split(/[-_]/)[0]
  return LANG_CURRENCY[key] || CURRENCY_BASE
}

function bigConvert(amount: bigint, fromRate: number, toRate: number, fromDecimals: number, toDecimals: number): bigint {
  const numerator = amount * BigInt(Math.round(fromRate * 10)) * 10n ** BigInt(toDecimals)
  const denominator = BigInt(Math.round(toRate * 10)) * 10n ** BigInt(fromDecimals)
  return (2n * numerator + denominator) / (2n * denominator)
}

// Same rounding contract as the server: convert through the KRW pivot with
// integer arithmetic, round half up once at the target minor unit. Returns 0
// for unsupported currencies or unsafe amounts so callers can fall back to
// showing the stored amount untouched.
export function convertMinorAmount(minor = 0, from = CURRENCY_BASE, to = CURRENCY_BASE): number {
  const fromCode = normalizeSupportedCurrency(from)
  const toCode = normalizeSupportedCurrency(to)
  const amount = Number(minor)
  if (!fromCode || !toCode || !Number.isSafeInteger(amount) || amount <= 0) return 0
  if (fromCode === toCode) return amount
  const converted = bigConvert(
    BigInt(amount),
    CURRENCY_RATES[fromCode],
    CURRENCY_RATES[toCode],
    CURRENCY_DECIMALS[fromCode],
    CURRENCY_DECIMALS[toCode],
  )
  return converted <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(converted) : 0
}

function currencyCode(currency: string): string {
  const code = String(currency || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : CURRENCY_BASE
}

function currencyDecimals(code: string): number {
  return CURRENCY_DECIMALS[code] ?? new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2
}

export function formatMinorAmount(amountMinor: number, currency = CURRENCY_BASE, lang = ''): string {
  const code = currencyCode(currency)
  const decimals = currencyDecimals(code)
  try {
    return new Intl.NumberFormat(lang || undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format((Number.isFinite(amountMinor) ? amountMinor : 0) / 10 ** decimals)
  } catch {
    return `${(amountMinor / 10 ** decimals).toFixed(decimals)} ${code}`
  }
}

// Plain decimal string in the currency's major unit (no symbol), e.g. for
// JSON-LD structured data. KRW has zero decimals, USD/CNY have two.
export function majorAmountString(amountMinor: number, currency = CURRENCY_BASE): string {
  const code = currencyCode(currency)
  const decimals = currencyDecimals(code)
  return ((Number.isFinite(amountMinor) ? amountMinor : 0) / 10 ** decimals).toFixed(decimals)
}

// Display amount for the current language: converts the stored currency into
// the language's currency (rounded) and formats it. Unsupported or unknown
// amounts fall back to the stored currency untouched.
export function displayMoney(amountMinor: number, fromCurrency = CURRENCY_BASE, lang = ''): string {
  const from = String(fromCurrency || '').trim().toUpperCase() || CURRENCY_BASE
  if (!normalizeSupportedCurrency(from) || !Number.isSafeInteger(Number(amountMinor))) {
    return formatMinorAmount(Number(amountMinor) || 0, from, lang)
  }
  return formatMinorAmount(convertMinorAmount(amountMinor, from, displayCurrencyForLang(lang)), displayCurrencyForLang(lang), lang)
}

// Rounded display conversion where a part must equal the whole minus the rest
// (deposit + balance == full price). The server guarantees the same invariant
// for actual charge amounts.
export function displayMoneyBreakdown(totalMinor: number, paidMinor: number, fromCurrency = CURRENCY_BASE, lang = ''): { total: string; paid: string; remaining: string } {
  const from = String(fromCurrency || '').trim().toUpperCase() || CURRENCY_BASE
  const target = displayCurrencyForLang(lang)
  const total = Number.isSafeInteger(Number(totalMinor)) ? Number(totalMinor) : 0
  const paid = Number.isSafeInteger(Number(paidMinor)) ? Number(paidMinor) : 0
  if (!normalizeSupportedCurrency(from)) {
    return { total: formatMinorAmount(total, from, lang), paid: formatMinorAmount(paid, from, lang), remaining: formatMinorAmount(Math.max(0, total - paid), from, lang) }
  }
  const totalRounded = convertMinorAmount(total, from, target)
  const paidRounded = convertMinorAmount(paid, from, target)
  const remainingRounded = Math.max(0, totalRounded - paidRounded)
  return {
    total: formatMinorAmount(totalRounded, target, lang),
    paid: formatMinorAmount(paidRounded, target, lang),
    remaining: formatMinorAmount(remainingRounded, target, lang),
  }
}

// Actual PayPal charge amount for a stored (base) amount. The storefront uses
// this to show the exact amount PayPal will capture when the display currency
// differs from the charge currency (PayPal cannot charge KRW). The server
// computes the real charge with the same table and returns it on the payment
// snapshot; this helper only mirrors that number for previews.
export function chargeMoney(amountMinor: number, fromCurrency = CURRENCY_BASE, chargeCurrency = 'USD', lang = ''): string {
  const from = String(fromCurrency || '').trim().toUpperCase() || CURRENCY_BASE
  const to = String(chargeCurrency || '').trim().toUpperCase() || 'USD'
  if (!normalizeSupportedCurrency(from) || !normalizeSupportedCurrency(to) || !Number.isSafeInteger(Number(amountMinor))) {
    return formatMinorAmount(Number(amountMinor) || 0, from, lang)
  }
  return formatMinorAmount(convertMinorAmount(amountMinor, from, to), to, lang)
}
