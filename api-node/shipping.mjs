// Shipping is quoted per destination and stored on the order as a fixed minor
// unit amount, never recalculated at payment time. Two reasons:
//
//  1. The admin may adjust or waive shipping while an order is in production.
//     A live rate table would silently change what the customer still owes.
//  2. payableAmount()/validatePaymentSettlement() in payment-amounts.mjs treat
//     order.amount_cents as the single source of truth for what may be charged.
//     A shipping figure that only existed at quote time would be invisible to
//     them and the capture would be rejected, or worse, accepted for less than
//     the customer was quoted.
//
// So: quoteShippingCents() is used when the order is created, the result is
// written into shipping_cents, and the order total becomes product + shipping
// before any payment exists. Everything downstream then works unchanged.

const ZONE_DEFAULTS = {
  domestic: { label: 'Domestic', currency: 'KRW', cents: 0, days: '3-7' },
  asia: { label: 'Asia', currency: 'KRW', cents: 1800000, days: '7-14' },
  europe: { label: 'Europe', currency: 'KRW', cents: 3200000, days: '10-18' },
  north_america: { label: 'North America', currency: 'KRW', cents: 3800000, days: '10-20' },
  oceania: { label: 'Oceania', currency: 'KRW', cents: 4200000, days: '12-22' },
  other: { label: 'Other', currency: 'KRW', cents: 5200000, days: '14-28' },
}

// Region membership is a business decision, so it is data rather than code and
// can be corrected from the admin console without a deploy.
export const DEFAULT_COUNTRY_ZONES = {
  KR: 'domestic', JP: 'asia', CN: 'asia', HK: 'asia', TW: 'asia', SG: 'asia', MY: 'asia', TH: 'asia', VN: 'asia', PH: 'asia', ID: 'asia', KH: 'asia',
  GB: 'europe', IE: 'europe', FR: 'europe', DE: 'europe', IT: 'europe', ES: 'europe', PT: 'europe', NL: 'europe', BE: 'europe',
  AT: 'europe', CH: 'europe', DK: 'europe', SE: 'europe', NO: 'europe', FI: 'europe', PL: 'europe', CZ: 'europe', GR: 'europe',
  US: 'north_america', CA: 'north_america', MX: 'north_america',
  AU: 'oceania', NZ: 'oceania',
}

// Free above this product subtotal, in base minor units (KRW cents here).
// Handmade pieces ship in one small box, so an order that already carries a
// large sculpture should not also carry a shipping line.
export const DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS = 5000000

export function normalizeCountry(value = '') {
  return String(value || '').trim().toUpperCase()
}

export function shippingConfig(site = {}) {
  const raw = (site && site.shipping) || {}
  const zones = { ...ZONE_DEFAULTS }
  for (const [key, value] of Object.entries(raw.zones || {})) {
    if (!value || typeof value !== 'object') continue
    const cents = Number(value.cents)
    if (!Number.isSafeInteger(cents) || cents < 0) continue
    zones[key] = {
      ...zones[key],
      ...value,
      cents,
      label: String(value.label || zones[key]?.label || key),
    }
  }
  const countryZones = { ...DEFAULT_COUNTRY_ZONES, ...(raw.country_zones || {}) }
  const thresholdRaw = Number(
    raw.free_shipping_threshold_cents ?? DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS,
  )
  return {
    // Off unless the operator turns it on: existing orders and the prices shown
    // today do not include shipping, and silently adding a charge to a live
    // storefront is not a default anyone should inherit.
    enabled: raw.enabled === true,
    zones,
    countryZones,
    freeShippingThresholdCents: Number.isSafeInteger(thresholdRaw) && thresholdRaw >= 0
      ? thresholdRaw
      : DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS,
    note: String(raw.note || ''),
  }
}

export function zoneForCountry(config, country) {
  const code = normalizeCountry(country)
  if (!code) return 'other'
  const mapped = config.countryZones[code] || config.countryZones[String(code).toLowerCase()]
  return config.zones[mapped] ? mapped : 'other'
}

export function quoteShippingCents(site = {}, { country = '', subtotalCents = 0 } = {}) {
  const config = shippingConfig(site)
  if (!config.enabled) {
    return { enabled: false, cents: 0, zone: null, label: '', free: false, days: '' }
  }
  const subtotal = Number(subtotalCents || 0)
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return { enabled: true, cents: 0, zone: null, label: '', free: false, days: '', error: 'invalid subtotal' }
  }
  const zone = zoneForCountry(config, country)
  const definition = config.zones[zone] || ZONE_DEFAULTS.other
  const qualifiesFree = subtotal >= config.freeShippingThresholdCents
  const cents = qualifiesFree ? 0 : Number(definition.cents || 0)
  return {
    enabled: true,
    cents: Math.max(0, Math.trunc(cents)),
    zone,
    label: String(definition.label || zone),
    days: String(definition.days || ''),
    free: qualifiesFree,
    freeShippingThresholdCents: config.freeShippingThresholdCents,
  }
}
