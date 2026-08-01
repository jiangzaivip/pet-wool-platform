import { chromium } from 'playwright'

const base = process.env.BASE_URL || 'http://127.0.0.1:8888'
const output = []
const browser = await chromium.launch({ headless: true })

function pass(name, detail = '') {
  output.push({ name, status: 'ok', detail })
}

function assert(condition, name, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
  pass(name, detail)
}

async function checkPage(page, path, label) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    text: document.body.innerText,
  }))
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, `${label} no horizontal overflow`, JSON.stringify({ scrollWidth: metrics.scrollWidth, clientWidth: metrics.clientWidth }))
  assert(!/(?:support|home|detail|collections|products)\.[A-Za-z][A-Za-z0-9]+/.test(metrics.text), `${label} has no visible i18n key`)
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await desktop.goto(base, { waitUntil: 'networkidle' })
  await desktop.getByRole('heading', { level: 1, name: /우리 아이의 모습/ }).waitFor()
  await desktop.getByText('WoolBuddy', { exact: true }).first().waitFor()
  pass('Korean is the default language')
  assert(await desktop.title() === 'WoolBuddy | 반려동물 양모펠트 기념 작품', 'Home SEO title uses WoolBuddy')
  const homeHeadings = await desktop.locator('main section h2').allTextContents()
  const order = ['소중한 추억을 위한 작품을 선택하세요', '인기 작품', '제작 과정', '고객 후기', '주문 전 자주 묻는 질문']
  const positions = order.map(text => homeHeadings.findIndex(value => value.includes(text)))
  assert(positions.every((value, index) => value >= 0 && (index === 0 || value > positions[index - 1])), 'Home sections follow requested order', JSON.stringify({ homeHeadings, positions }))
  await checkPage(desktop, '/', 'Desktop home')
  assert(await desktop.getByText('LINE', { exact: true }).count() === 0, 'Home page does not show LINE')
  await desktop.screenshot({ path: 'test-results/feedback-v1-home-desktop.png', fullPage: true })

  await checkPage(desktop, '/collections', 'Desktop collections')
  await desktop.getByRole('heading', { name: '어떤 작품을 선택하면 좋을까요?' }).waitFor()
  assert(await desktop.getByText('스타일', { exact: true }).count() === 0, 'Removed style filter')

  await checkPage(desktop, '/products/full-body-pet-replica', 'Desktop product detail')
  await desktop.getByRole('heading', { level: 1, name: '3D 반려동물 전신 초상' }).waitFor()
  await desktop.getByRole('button', { name: '이미지 확대' }).click()
  await desktop.locator('.image-lightbox').waitFor()
  await desktop.getByRole('button', { name: '확대 이미지 닫기' }).click()
  pass('Product gallery opens and closes zoom view')
  const productJsonLd = await desktop.locator('script[data-jsonld-id="product-detail"]').count()
  assert(productJsonLd === 1, 'Product JSON-LD is present')
  assert(await desktop.locator('.related-products .product-card').count() >= 1, 'Related product cards are present')
  const productText = await desktop.locator('body').innerText()
  assert(!productText.includes('500+') && !productText.includes('30+'), 'Unverified business metrics are not displayed')
  await desktop.screenshot({ path: 'test-results/feedback-v1-product-desktop.png', fullPage: true })

  await checkPage(desktop, '/support', 'Desktop support')
  const faqButtons = desktop.locator('.faq-item h3 button')
  assert(await faqButtons.count() === 20, 'Support page renders 20 FAQ questions')
  await faqButtons.nth(0).click()
  assert(await faqButtons.nth(0).getAttribute('aria-expanded') === 'true', 'First FAQ expands')
  await faqButtons.nth(1).click()
  assert(await faqButtons.nth(0).getAttribute('aria-expanded') === 'false' && await faqButtons.nth(1).getAttribute('aria-expanded') === 'true', 'Opening FAQ closes previous item')
  const schemaIds = await desktop.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-jsonld-id')))
  for (const id of ['support-faq', 'support-breadcrumb', 'support-organization']) assert(schemaIds.includes(id), `${id} JSON-LD is present`)
  await desktop.screenshot({ path: 'test-results/feedback-v1-support-desktop.png', fullPage: true })

  await checkPage(desktop, '/policies/privacy', 'Desktop privacy policy')
  await desktop.getByRole('heading', { level: 1, name: '개인정보 처리방침' }).waitFor()
  pass('Legal policy route renders')
  await desktop.close()

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true })
  for (const [path, label] of [['/', 'Mobile home'], ['/collections', 'Mobile collections'], ['/products/full-body-pet-replica', 'Mobile product'], ['/support', 'Mobile support']]) {
    await checkPage(mobile, path, label)
  }
  await mobile.goto(`${base}/support`, { waitUntil: 'networkidle' })
  const contactWidths = await mobile.locator('.support-contact-card .row-actions .button').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect()
    const parent = node.parentElement?.getBoundingClientRect()
    return { button: Math.round(rect.width), parent: Math.round(parent?.width || 0) }
  }))
  assert(contactWidths.every(item => item.button >= item.parent - 1), 'Mobile contact buttons are full width', JSON.stringify(contactWidths))
  await mobile.screenshot({ path: 'test-results/feedback-v1-support-mobile.png', fullPage: true })
  await mobile.close()
} finally {
  await browser.close()
}

console.log(JSON.stringify(output, null, 2))
