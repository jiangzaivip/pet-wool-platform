// Privacy-preserving client error reporting.
//
// Reports go to the same store as everything else instead of a third-party SaaS:
// no customer data leaves the host, and there is no external dependency to fail
// during an incident. What is collected is deliberately narrow — an error class
// and message, the route, and the browser — never form values, order numbers,
// customer names, emails, addresses or any request body.
//
// The endpoint is rate limited per IP like the upload endpoint, and the payload
// is size-capped and stripped of anything that looks like an identifier before
// it is stored.

export const MAX_REPORTS = 200
const REPORT_WINDOW_MS = 60 * 1000
const reportRateLimits = new Map()

function clientIpForReport(req, { normalizeIp, trustedProxyAddresses }) {
  const peer = normalizeIp(req.socket?.remoteAddress)
  if (trustedProxyAddresses.has(peer)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (forwarded) return normalizeIp(forwarded)
  }
  return peer || 'unknown'
}

export function allowReport(req, deps) {
  const key = clientIpForReport(req, deps)
  const now = Date.now()
  const recent = (reportRateLimits.get(key) || []).filter((item) => now - item < REPORT_WINDOW_MS)
  if (recent.length >= 10) {
    reportRateLimits.set(key, recent)
    return false
  }
  recent.push(now)
  reportRateLimits.set(key, recent)
  if (reportRateLimits.size > 2000) reportRateLimits.clear()
  return true
}

// Anything that looks like an email, a URL with an id, a long digit run or a
// currency amount is dropped rather than stored. This is a second line of
// defence: the client already sends a fixed set of fields, but a script-kiddie
// posting arbitrary strings here should not end up persisting them.
function scrub(value, limit = 200) {
  let text = String(value == null ? '' : value)
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  text = text.replace(/https?:\/\/\S+/gi, (match) => {
    try {
      const url = new URL(match)
      return `${url.origin}${url.pathname}`
    } catch {
      return '[url]'
    }
  })
  text = text.replace(/\b\d{6,}\b/g, '[id]')
  text = text.replace(/WP-\d{8}-[0-9A-F]{8}/gi, '[order]')
  text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export function normalizeClientReport(input = {}, { makeId, timestamp }) {
  if (!input || typeof input !== 'object') return null
  const message = scrub(input.message, 200)
  if (!message) return null
  return {
    id: makeId(),
    level: ['error', 'warn', 'info'].includes(input.level) ? input.level : 'error',
    message,
    source: scrub(input.source, 120),
    line: Number.isFinite(Number(input.line)) ? Math.trunc(Number(input.line)) : null,
    route: scrub(input.route, 160),
    user_agent: scrub(input.user_agent, 160),
    lang: /^[a-z]{2}$/i.test(String(input.lang || '')) ? String(input.lang).toLowerCase() : '',
    created_at: timestamp(),
  }
}

export function recentClientReports(store, limit = 50) {
  const reports = Array.isArray(store.client_reports) ? store.client_reports : []
  return reports.slice(-limit).reverse()
}
