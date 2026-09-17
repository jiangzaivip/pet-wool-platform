function upsertMeta(selector: string, attrs: Record<string, string>) {
  let meta = document.querySelector(selector) as HTMLMetaElement | null
  if (!meta) {
    meta = document.createElement('meta')
    document.head.appendChild(meta)
  }
  Object.entries(attrs).forEach(([key, value]) => meta?.setAttribute(key, value))
}

function upsertCanonical(url: string) {
  let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.rel = 'canonical'
    document.head.appendChild(link)
  }
  link.href = url
}

function removeElement(selector: string) {
  document.querySelector(selector)?.remove()
}

function absoluteUrl(value: string) {
  try {
    return new URL(value, window.location.origin).href
  } catch {
    return value
  }
}

function metaText(value: string, limit = 240) {
  const text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text
}

export function setHead(title: string, description = '', options: { canonical?: string; image?: string; robots?: string } = {}) {
  // Views call this on navigation. Updating existing tags instead of appending
  // new ones keeps the document head deterministic during SPA transitions.
  const safeTitle = metaText(title, 90)
  const safeDescription = metaText(description, 260)
  document.title = safeTitle
  const canonicalUrl = absoluteUrl(options.canonical || window.location.href)
  const imageUrl = options.image ? absoluteUrl(options.image) : ''
  upsertMeta('meta[name="description"]', { name: 'description', content: safeDescription })
  upsertMeta('meta[property="og:description"]', { property: 'og:description', content: safeDescription })
  upsertMeta('meta[property="og:title"]', { property: 'og:title', content: safeTitle })
  upsertMeta('meta[property="og:url"]', { property: 'og:url', content: canonicalUrl })
  upsertMeta('meta[property="og:type"]', { property: 'og:type', content: 'website' })
  upsertMeta('meta[name="twitter:card"]', { name: 'twitter:card', content: imageUrl ? 'summary_large_image' : 'summary' })
  upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: safeTitle })
  upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: safeDescription })
  if (imageUrl) {
    upsertMeta('meta[property="og:image"]', { property: 'og:image', content: imageUrl })
    upsertMeta('meta[name="twitter:image"]', { name: 'twitter:image', content: imageUrl })
  }
  else removeElement('meta[property="og:image"]')
  if (!imageUrl) removeElement('meta[name="twitter:image"]')
  if (options.robots) upsertMeta('meta[name="robots"]', { name: 'robots', content: options.robots })
  else removeElement('meta[name="robots"]')
  upsertCanonical(canonicalUrl)
}

export function setJsonLd(id: string, data: Record<string, any> | null) {
  const selector = `script[type="application/ld+json"][data-jsonld-id="${id}"]`
  if (!data) {
    removeElement(selector)
    return
  }
  let script = document.querySelector(selector) as HTMLScriptElement | null
  if (!script) {
    script = document.createElement('script')
    script.type = 'application/ld+json'
    script.dataset.jsonldId = id
    document.head.appendChild(script)
  }
  script.textContent = JSON.stringify(data)
}
