export const productFrameImage = 'https://images.unsplash.com/photo-1507146426996-ef05306b995a?auto=format&fit=crop&w=1000&q=82'
export const productFullBodyImage = 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=1000&q=82'
export const productMemorialImage = 'https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=1000&q=82'
export const blogFallbackImage = productMemorialImage
export const productFallbackImage = productFrameImage

const legacyAssetImageMap: Record<string, string> = {
  '/assets/product-frame.svg': productFrameImage,
  '/assets/product-full-body.svg': productFullBodyImage,
  '/assets/product-memorial.svg': productMemorialImage,
  '/assets/hero-studio.svg': productFullBodyImage,
}

export function resolveContentImage(value = '') {
  const image = String(value || '').trim()
  return legacyAssetImageMap[image] || image
}

export function blogImage(post: { image_url?: string } = {}) {
  return resolveContentImage(post.image_url) || blogFallbackImage
}

export function productImage(product: { image_url?: string; images?: string[] } = {}) {
  const primary = resolveContentImage(product.image_url)
  const gallery = Array.isArray(product.images) ? product.images.map((image) => resolveContentImage(image)).filter(Boolean) : []
  return primary || gallery[0] || productFallbackImage
}

export function productGallery(product: { image_url?: string; images?: string[] } = {}) {
  const images = Array.isArray(product.images) ? product.images.map((image) => resolveContentImage(image)).filter(Boolean) : []
  const primary = resolveContentImage(product.image_url)
  const gallery = [primary, ...images].filter(Boolean)
  return gallery.length ? [...new Set(gallery)] : [productFallbackImage]
}

function replaceBrokenImage(event: Event, fallback: string) {
  const img = event.target as HTMLImageElement | null
  if (!img || img.src === fallback) return
  img.src = fallback
}

export function useBlogImageFallback(event: Event) {
  replaceBrokenImage(event, blogFallbackImage)
}

export function useProductImageFallback(event: Event) {
  replaceBrokenImage(event, productFallbackImage)
}
