import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataFile = path.join(rootDir, 'api-node', 'data', 'store.json')
const uploadDir = path.join(rootDir, 'api-node', 'uploads')
const apply = process.argv.includes('--apply')
const cleanMissingRefs = process.argv.includes('--missing-refs')

const store = JSON.parse(await readFile(dataFile, 'utf8'))
const uploadPattern = /^[0-9]+-[a-f0-9-]+\.[a-z0-9]+$/i
function uploadBasename(value = '') {
  const text = String(value || '').trim()
  if (!text.startsWith('/uploads/')) return ''
  const name = path.basename(text)
  return uploadPattern.test(name) ? name : ''
}

const orderReferenced = new Set((store.orders || [])
  .flatMap((order) => Array.isArray(order.photo_urls) ? order.photo_urls : [])
  .map(uploadBasename)
  .filter(Boolean))
const productReferenced = new Set((store.products || [])
  .flatMap((product) => [
    product.image_url,
    ...(Array.isArray(product.images) ? product.images : []),
  ])
  .map(uploadBasename)
  .filter(Boolean))
const blogReferenced = new Set((store.site?.blog || [])
  .map((post) => uploadBasename(post?.image_url))
  .filter(Boolean))
const referenced = new Set([...orderReferenced, ...productReferenced, ...blogReferenced])

const files = await readdir(uploadDir).catch(() => [])
const fileSet = new Set(files)
const orphanFiles = files.filter((file) => uploadPattern.test(file) && !referenced.has(file))
const missingReferencedFiles = [...referenced].filter((file) => !fileSet.has(file))

let removed = 0
let cleanedOrderRefs = 0
let cleanedProductRefs = 0
let cleanedBlogRefs = 0
if (apply) {
  for (const file of orphanFiles) {
    await rm(path.join(uploadDir, file), { force: true })
    removed += 1
  }
  if (cleanMissingRefs && missingReferencedFiles.length) {
    const missingSet = new Set(missingReferencedFiles)
    for (const order of store.orders || []) {
      if (!Array.isArray(order.photo_urls)) continue
      const before = order.photo_urls.length
      order.photo_urls = order.photo_urls.filter((url) => {
        const name = uploadBasename(url)
        return !name || !missingSet.has(name)
      })
      cleanedOrderRefs += before - order.photo_urls.length
    }
    for (const product of store.products || []) {
      if (missingSet.has(uploadBasename(product.image_url))) {
        product.image_url = ''
        cleanedProductRefs += 1
      }
      if (Array.isArray(product.images)) {
        const before = product.images.length
        product.images = product.images.filter((url) => {
          const name = uploadBasename(url)
          return !name || !missingSet.has(name)
        })
        cleanedProductRefs += before - product.images.length
      }
    }
    for (const post of store.site?.blog || []) {
      if (missingSet.has(uploadBasename(post.image_url))) {
        post.image_url = ''
        cleanedBlogRefs += 1
      }
    }
    await writeFile(dataFile, JSON.stringify(store, null, 2))
  }
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  upload_dir: uploadDir,
  total_upload_files: files.length,
  referenced_upload_files: referenced.size,
  order_referenced_upload_files: orderReferenced.size,
  product_referenced_upload_files: productReferenced.size,
  blog_referenced_upload_files: blogReferenced.size,
  missing_referenced_upload_files: missingReferencedFiles.length,
  missing_referenced_samples: missingReferencedFiles.slice(0, 20),
  orphan_upload_files: orphanFiles.length,
  orphan_upload_samples: orphanFiles.slice(0, 20),
  removed,
  clean_missing_refs: cleanMissingRefs,
  cleaned_order_refs: cleanedOrderRefs,
  cleaned_product_refs: cleanedProductRefs,
  cleaned_blog_refs: cleanedBlogRefs,
}, null, 2))
