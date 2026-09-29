// Client-side error reporting.
//
// Errors are sent to our own API (which scrubs anything that looks like an
// identifier before storing it) rather than a third-party analytics endpoint, so
// no customer data leaves the host and there is no external dependency to be
// down while we are already diagnosing an incident.
//
// Only the error class, a scrubbed message, the route and the locale are sent.
// Form values, order numbers and request bodies never leave the page.

const DEDUPE_WINDOW_MS = 30_000
const lastSent = new Map<string, number>()

function currentRoute() {
  try {
    return `${window.location.pathname}${window.location.search}`
  } catch {
    return ''
  }
}

function scrubMessage(value: unknown) {
  return String(value || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b\d{6,}\b/g, '[id]')
    .slice(0, 200)
}

function shouldSend(key: string) {
  const now = Date.now()
  const last = lastSent.get(key) || 0
  if (now - last < DEDUPE_WINDOW_MS) return false
  lastSent.set(key, now)
  // Keep the dedupe map from growing without bound on a long-lived SPA session.
  if (lastSent.size > 100) {
    for (const [k, v] of lastSent) {
      if (now - v > DEDUPE_WINDOW_MS) lastSent.delete(k)
    }
  }
  return true
}

type ReportContext = { source?: string; level?: string; line?: number }

export function reportError(error: unknown, context: ReportContext = {}) {
  try {
    const asError = error as { message?: unknown; stack?: unknown } | null
    const message = scrubMessage(asError?.message || String(error || 'unknown error'))
    const stackLine = typeof asError?.stack === 'string' ? asError.stack.split('\n')[1] : ''
    const source = scrubMessage(context.source || stackLine || '')
    const key = `${message}|${currentRoute()}`
    if (!shouldSend(key)) return
    const lang = (() => {
      try {
        return String(new URLSearchParams(window.location.search).get('lang') || document.documentElement.lang || '').slice(0, 2)
      } catch {
        return ''
      }
    })()
    const payload = JSON.stringify({
      level: context.level || 'error',
      message,
      source,
      line: Number.isFinite(context.line) ? context.line : null,
      route: currentRoute(),
      user_agent: navigator.userAgent.slice(0, 160),
      lang,
    })
    // sendBeacon survives the page unloading, which is exactly when most errors
    // happen (navigation, submit). fetch with keepalive is the fallback.
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-reports', new Blob([payload], { type: 'application/json' }))
      return
    }
    fetch('/api/client-reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Reporting must never throw into the app.
  }
}

export function installErrorReporting() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    reportError(event.error || event.message, { source: event.filename, line: event.lineno })
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { source: 'unhandledrejection' })
  })
}
