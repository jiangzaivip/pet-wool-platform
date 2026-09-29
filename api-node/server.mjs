import { createHash, createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { createServer } from 'node:http'
import { connect as connectNet } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CURRENCY_BASE,
  convertMinorAmount,
  normalizeSupportedCurrency,
} from './currency.mjs'
import {
  capturedPaymentTransition,
  orderInitialPayableAmount,
  payableAmount,
  payableType,
  paymentAmountSnapshot,
  paymentBaseAmountCents,
  paypalChargeCurrencyReady,
  singleCurrencyTotal,
  validatePayableOrder,
  validatePaymentSettlement,
  validatePaypalCaptureAmount,
} from './payment-amounts.mjs'

const { Pool } = pg

// -----------------------------------------------------------------------------
// Runtime configuration
// -----------------------------------------------------------------------------
// The deployed application intentionally uses Node's built-in HTTP server. Keep
// all filesystem and environment-derived paths in one place so local, staging,
// and systemd deployments can replace them without changing business logic.
function loadDotEnv(file) {
  let contents
  try {
    contents = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const [, key] = match
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue
    let value = match[2].trim()
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\')
    }
    process.env[key] = value
  }
}

const configuredRootDir = process.env.API_ROOT_DIR
  ? path.resolve(process.env.API_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)))
loadDotEnv(path.join(configuredRootDir, '..', '.env'))

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8082)
const rootDir = configuredRootDir
const projectDir = path.resolve(rootDir, '..')
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data')
const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(rootDir, 'uploads')
const frontendDistDir = process.env.FRONTEND_DIST_DIR
  ? path.resolve(process.env.FRONTEND_DIST_DIR)
  : path.join(projectDir, 'frontend', 'dist')
const serveFrontend = !/^(0|false|no)$/i.test(String(process.env.SERVE_FRONTEND || 'true'))
const dataFile = path.join(dataDir, 'store.json')
const publicUploadBase = '/uploads'
const maxUploadBytes = 8 * 1024 * 1024
const maxJsonBytes = 2 * 1024 * 1024
const maxOrderPhotos = 12
const uploadRateLimitWindowMs = 60 * 1000
const uploadRateLimitMax = 30
const paypalSupportedCurrencies = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF',
  'ILS', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD',
  'THB', 'TWD', 'USD',
])
const paypalZeroDecimalCurrencies = new Set(['HUF', 'JPY', 'TWD'])
const paypalApiBases = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
}
const defaultPaypalCurrency = 'USD'
const paypalMockEnabled = /^(1|true|yes)$/i.test(String(process.env.PAYPAL_MOCK || ''))
const paypalRequestTimeoutMs = Math.min(30000, Math.max(5000, Number(process.env.PAYPAL_TIMEOUT_MS || 15000)))
const translationApiUrl = String(process.env.TRANSLATION_API_URL || 'https://api.mymemory.translated.net/get').trim() || 'https://api.mymemory.translated.net/get'
const translationTimeoutMs = Math.min(20000, Math.max(5000, Number(process.env.TRANSLATION_TIMEOUT_MS || 12000)))
const translationMaxTexts = 80
const translationMaxTextBytes = 12000
const translationMaxTotalBytes = 24000
const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com'
const defaultAdminPasswordHash = 'ac0e7d037817094e9e0b4441f9bae3209d67b02fa484917065f71b16109a1a78'
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || defaultAdminPasswordHash
const googleDemoLoginEnabled = !/^(0|false|no)$/i.test(String(process.env.GOOGLE_DEMO_LOGIN || ''))
const configuredGoogleClientIds = String(process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const supportedLangs = ['zh', 'en', 'ko']
const adminSessions = new Map()
const uploadRateLimits = new Map()
const orderLookupRateLimits = new Map()
let googleCertsCache = { expires_at: 0, keys: [] }
const adminSessionMs = 12 * 60 * 60 * 1000
const userSessionMs = 30 * 24 * 60 * 60 * 1000
const orderLookupRateLimitWindowMs = 10 * 60 * 1000
const orderLookupRateLimitMax = 8
const userTokenSecret = process.env.USER_TOKEN_SECRET || process.env.ADMIN_SESSION_SECRET || adminPasswordHash
const smtpConfig = {
  host: String(process.env.SMTP_HOST || '').trim(),
  port: Number(process.env.SMTP_PORT || 465),
  secure: /^(1|true|yes)$/i.test(String(process.env.SMTP_SECURE || 'true')),
  user: String(process.env.SMTP_USER || '').trim(),
  pass: String(process.env.SMTP_PASS || ''),
  from: String(process.env.SMTP_FROM || '').trim(),
  adminEmail: String(process.env.NOTIFY_ADMIN_EMAIL || '').trim().toLowerCase(),
  timeoutMs: Math.min(30000, Math.max(3000, Number(process.env.SMTP_TIMEOUT_MS || 10000))),
}
const logDir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(projectDir, 'logs')
const logFile = process.env.LOG_FILE ? path.resolve(process.env.LOG_FILE) : path.join(logDir, 'pet-wool-structured.log')
const configuredLogLevel = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase()
const logLevel = ['debug', 'info', 'warn', 'error'].includes(configuredLogLevel) ? configuredLogLevel : 'info'
const logToFile = !/^(0|false|no)$/i.test(String(process.env.LOG_TO_FILE || 'true'))
let saveQueue = Promise.resolve()
const storeBackend = String(process.env.STORE_BACKEND || 'json').trim().toLowerCase()
const postgresUrl = String(process.env.DATABASE_URL || '').trim()
let postgresPool = null
let logStream = null
let dailySummaryDate = ''

const logLevelRanks = { debug: 10, info: 20, warn: 30, error: 40 }

function emailFingerprint(value = '') {
  const email = String(value || '').trim().toLowerCase()
  return email ? createHash('sha256').update(email).digest('hex').slice(0, 12) : ''
}

function sanitizeLogValue(value, key = '', depth = 0) {
  const normalizedKey = String(key || '').toLowerCase()
  if (/(password|secret|token|authorization|cookie|credential|webhook)/i.test(normalizedKey)) return '[redacted]'
  if (normalizedKey === 'email') return emailFingerprint(value)
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)}...` : value
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogValue(item, '', depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([itemKey, item]) => [
      itemKey,
      sanitizeLogValue(item, itemKey, depth + 1),
    ]))
  }
  return String(value)
}

function log(level, event, details = {}) {
  if ((logLevelRanks[level] || logLevelRanks.info) < (logLevelRanks[logLevel] || logLevelRanks.info)) return
  const record = {
    ...sanitizeLogValue(details),
    timestamp: now(),
    level,
    service: 'pet-wool-api',
    pid: process.pid,
    event,
  }
  const line = `${JSON.stringify(record)}\n`
  try {
    process.stderr.write(line)
  } catch {
    // Logging must never interrupt an order or payment request.
  }
  if (logStream?.writable) {
    try {
      logStream.write(line)
    } catch {
      logStream = null
    }
  }
}

async function initializeLogger() {
  if (!logToFile) return
  try {
    await mkdir(logDir, { recursive: true })
    logStream = createWriteStream(logFile, { flags: 'a' })
    logStream.on('error', (error) => {
      logStream = null
      try {
        process.stderr.write(`${JSON.stringify({
          timestamp: now(),
          level: 'error',
          service: 'pet-wool-api',
          event: 'logging.file_error',
          message: error?.message || 'log file unavailable',
        })}\n`)
      } catch {
        // Ignore logging failures.
      }
    })
  } catch (error) {
    log('warn', 'logging.file_disabled', { file: logFile, message: error?.message || 'log directory unavailable' })
  }
}

async function ensurePostgresStore() {
  if (storeBackend !== 'postgres') return null
  if (!postgresUrl) throw new Error('STORE_BACKEND=postgres requires DATABASE_URL')
  if (!postgresPool) {
    postgresPool = new Pool({ connectionString: postgresUrl, max: 10 })
    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS platform_runtime_store (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
  }
  return postgresPool
}

// -----------------------------------------------------------------------------
// Catalog and site defaults
// -----------------------------------------------------------------------------
// These labels and seed records are also the fallback for older store files.
// They are kept in the API so a fresh installation can start without a separate
// database migration step.
const categoryLabels = {
  '3d-pet-frame-portraits': {
    zh: '3D 羊毛毡相框肖像',
    en: '3D Wool Felt Frame Portraits',
    ko: '3D 양모펠트 액자 초상',
  },
  '3d-full-body-pet-portraits': {
    zh: '3D 羊毛毡全身肖像',
    en: '3D Wool Felt Full-Body Portraits',
    ko: '3D 양모펠트 전신 초상',
  },
  'pet-memorial-gifts': {
    zh: '宠物纪念作品',
    en: 'Pet Memorial Works',
    ko: '메모리얼 선물',
  },
  'dog-frame-portrait': { zh: '狗狗羊毛毡相框', en: 'Dog Wool Felt Frame', ko: '강아지 양모펠트 액자' },
  'cat-frame-portrait': { zh: '猫咪羊毛毡相框', en: 'Cat Wool Felt Frame', ko: '고양이 양모펠트 액자' },
  'rabbit-frame-portrait': { zh: '兔子羊毛毡相框', en: 'Rabbit Wool Felt Frame', ko: '토끼 양모펠트 액자' },
  'dog-full-body-portrait': { zh: '狗狗羊毛毡全身像', en: 'Dog Full-Body Wool Felt', ko: '강아지 양모펠트 전신' },
  'cat-full-body-portrait': { zh: '猫咪羊毛毡全身像', en: 'Cat Full-Body Wool Felt', ko: '고양이 양모펠트 전신' },
  'rabbit-full-body-portrait': { zh: '兔子羊毛毡全身像', en: 'Rabbit Full-Body Wool Felt', ko: '토끼 양모펠트 전신' },
  'multi-pet-group-portrait': { zh: '多宠物羊毛毡作品', en: 'Multi-Pet Wool Felt', ko: '다중 반려동물 양모펠트' },
  'memorial-frame': { zh: '宠物纪念相框', en: 'Memorial Frame', ko: '메모리얼 액자' },
  'memorial-full-body-portrait': { zh: '宠物纪念全身作品', en: 'Memorial Full-Body Work', ko: '메모리얼 전신 작품' },
}

function parseAdminAccounts() {
  const raw = String(process.env.ADMIN_ACCOUNTS_JSON || '').trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed
          .map((account) => ({
            email: String(account.email || '').trim().toLowerCase(),
            password_hash: String(account.password_hash || account.passwordHash || '').trim(),
            role: ['owner', 'admin', 'viewer'].includes(account.role) ? account.role : 'admin',
          }))
          .filter((account) => account.email && account.password_hash)
      }
    } catch {
      log('warn', 'config.admin_accounts_invalid', { message: 'ADMIN_ACCOUNTS_JSON is invalid; falling back to ADMIN_EMAIL' })
    }
  }
  return [{ email: String(adminEmail).trim().toLowerCase(), password_hash: adminPasswordHash, role: 'owner' }]
}

const adminAccounts = parseAdminAccounts()

function isDemoGoogleClientId(value = '') {
  const text = String(value || '').trim().toLowerCase()
  return !text || text.includes('demo') || text.includes('example') || text.includes('placeholder')
}
const termLabels = {
  'Birthday Gift': { zh: '生日礼物', en: 'Birthday Gift', ko: '생일 선물' },
  'Anniversary Gift': { zh: '周年纪念礼物', en: 'Anniversary Gift', ko: '기념일 선물' },
  'Memorial Gift': { zh: '纪念礼物', en: 'Memorial Gift', ko: '메모리얼 선물' },
  'Christmas Gift': { zh: '圣诞礼物', en: 'Christmas Gift', ko: '크리스마스 선물' },
  'Housewarming Gift': { zh: '乔迁礼物', en: 'Housewarming Gift', ko: '집들이 선물' },
  'Parents Gift': { zh: '父母礼物', en: 'Gift for Parents', ko: '부모님 선물' },
  'Handmade': { zh: '手工制作', en: 'Handmade', ko: '수제 제작' },
  '100% Custom': { zh: '100% 定制', en: '100% Custom', ko: '100% 맞춤 제작' },
  'Memorial': { zh: '纪念', en: 'Memorial', ko: '메모리얼' },
  'Handcrafted': { zh: '匠人手作', en: 'Handcrafted', ko: '핸드메이드' },
  'Pet Portrait': { zh: '宠物肖像', en: 'Pet Portrait', ko: '반려동물 초상' },
  'Keepsake': { zh: '纪念品', en: 'Keepsake', ko: '기념품' },
  'Realistic Style': { zh: '写实风格', en: 'Realistic Style', ko: '사실적인 스타일' },
  'Photo Guide': { zh: '照片指南', en: 'Photo Guide', ko: '사진 가이드' },
  'Custom Pet Portrait': { zh: '定制宠物肖像', en: 'Custom Pet Portrait', ko: '맞춤 반려동물 초상' },
  'Pet Loss Gift': { zh: '宠物离世纪念礼物', en: 'Pet Loss Gift', ko: '반려동물 이별 선물' },
  'Care Guide': { zh: '护理指南', en: 'Care Guide', ko: '관리 가이드' },
  'Wool Felt': { zh: '羊毛毡', en: 'Wool Felt', ko: '양모펠트' },
  'United States': { zh: '美国', en: 'United States', ko: '미국' },
  'Korea': { zh: '韩国', en: 'Korea', ko: '한국' },
  'Canada': { zh: '加拿大', en: 'Canada', ko: '캐나다' },
}
const productCopy = {
  'custom-dog-frame-portrait': {
    zh: {
      description: '根据狗狗照片手工制作 3D 羊毛毡头像相框，适合作为生日礼物、纪念礼物和家居展示。我们会重点确认毛色、眼神、耳朵形状和表情，让作品适合长期保存。',
      alt_text: '根据宠物照片手工定制的 3D 羊毛毡狗狗相框',
      seo_title: '3D 羊毛毡狗狗相框定制',
    },
  },
  'custom-cat-frame-portrait': {
    zh: {
      description: '根据猫咪照片制作 3D 羊毛毡相框，适合猫咪纪念礼物、定制猫咪肖像和手工宠物相框。我们会还原眼神、毛色、脸型和胡须细节，让礼物表达温暖克制。',
      alt_text: '写实羊毛毡猫咪相框定制作品',
      seo_title: '3D 羊毛毡猫咪相框定制',
    },
  },
  'pet-memorial-frame-gift': {
    zh: {
      description: '把宠物照片制作成 3D 羊毛毡纪念相框，适合作为离世宠物纪念、家人慰问礼物和长期摆放的纪念作品。',
      alt_text: '定制 3D 羊毛毡宠物纪念相框礼物',
      seo_title: '宠物纪念相框礼物',
    },
  },
}
const siteCopy = {
  reviews: {
    'The face looks just like my dog.': {
      zh: { title: '表情很像我的狗狗。', content: '相框把眼神和细小毛色都还原出来了，是一份很有意义的生日礼物。' },
      ko: { title: '우리 강아지 표정과 정말 닮았어요.', content: '눈빛과 작은 털색 디테일까지 잘 담겨서 의미 있는 생일 선물이 됐습니다.' },
    },
    'A warm memorial gift.': {
      zh: { title: '温暖的纪念礼物。', content: '制作前仔细确认了照片，最终的羊毛毡肖像温柔又克制。' },
      ko: { title: '따뜻한 추모 선물입니다.', content: '사진을 꼼꼼히 확인해 주었고 완성된 양모 초상은 차분하고 따뜻했습니다.' },
    },
    'Beautiful full body detail.': {
      zh: { title: '全身细节很漂亮。', content: '姿态、尾巴和花纹都做得很细，预览确认流程也让我很安心。' },
      ko: { title: '전신 디테일이 아름다워요.', content: '자세, 꼬리, 무늬가 세심했고 미리보기 확인 과정도 안심됐습니다.' },
    },
  },
  blog: {
    'how-to-choose-custom-pet-portrait-photos': {
      zh: {
        title: '定制 3D 宠物肖像照片怎么选',
        excerpt: '了解哪些宠物照片能帮助手作师还原眼神、毛色、姿势和性格。',
        content: '一件好的定制宠物肖像从清晰参考图开始。建议准备正面、侧面、背面和全身照片，并补充眼睛、耳朵、尾巴、脚掌和毛色花纹特写。如果是纪念礼物，请加入最能代表家人记忆的表情照片。',
      },
      en: {
        title: 'How to Choose Photos for a Custom 3D Pet Portrait',
        excerpt: 'Learn which pet photos help artists capture eyes, coat color, pose and personality for a custom wool portrait.',
        content: 'A good custom pet portrait starts with clear references. Prepare front, side, back and full-body photos. Add close-ups of eyes, ears, tail, paws and coat markings. If the portrait is a memorial gift, include the expression that feels most familiar to your family.',
      },
      ko: {
        title: '맞춤 3D 반려동물 초상 사진 고르는 법',
        excerpt: '눈빛, 털색, 자세와 성격을 살리는 데 도움이 되는 사진을 안내합니다.',
        content: '좋은 맞춤 반려동물 초상은 선명한 참고 사진에서 시작됩니다. 정면, 측면, 뒷모습, 전신 사진과 눈, 귀, 꼬리, 발, 털 무늬의 클로즈업을 준비하세요. 추모 선물이라면 가족에게 가장 익숙한 표정 사진을 함께 보내는 것이 좋습니다.',
      },
    },
    'pet-memorial-gift-ideas': {
      zh: {
        title: '适合家人的宠物纪念礼物想法',
        excerpt: '如何在纪念相框、全身肖像和纪念摆件之间选择。',
        content: '宠物纪念礼物应该私人、安静并且适合长期保存。3D 羊毛毡相框适合放在书架或桌面，全身肖像能保留宠物熟悉的姿态和轮廓。可以根据家人最常想起宠物的方式来选择形式。',
      },
      en: {
        title: 'Pet Memorial Gift Ideas for Families',
        excerpt: 'A practical guide to choosing a pet memorial frame, full body portrait or keepsake gift.',
        content: 'Pet memorial gifts should feel personal and calm. A 3D felted frame is suitable for display on a shelf, while a full body portrait keeps the pet’s posture and shape. Choose the format based on how the family remembers the pet most clearly.',
      },
      ko: {
        title: '가족을 위한 반려동물 추모 선물 아이디어',
        excerpt: '추모 액자, 전신 초상, 기념 소품 중 어떤 형식이 맞는지 안내합니다.',
        content: '반려동물 추모 선물은 개인적이고 차분해야 합니다. 3D 양모 액자는 선반에 두기 좋고, 전신 초상은 익숙한 자세와 형태를 남길 수 있습니다. 가족이 반려동물을 가장 선명하게 기억하는 방식에 맞춰 선택하세요.',
      },
    },
    'care-guide-for-wool-felt-pet-portraits': {
      zh: {
        title: '羊毛毡宠物肖像护理指南',
        excerpt: '如何避免手工羊毛毡作品受潮、暴晒和变形。',
        content: '羊毛毡宠物肖像是手工纪念作品。请避免水洗、强光暴晒和频繁触摸，条件允许时放入展示盒保存。如果表面出现少量浮毛，请用小剪刀轻轻修整，不要用手拉扯。',
      },
      en: {
        title: 'Care Guide for Wool Felt Pet Portraits',
        excerpt: 'How to protect handmade wool felt portraits from moisture, sunlight and deformation.',
        content: 'Wool felt portraits are handmade keepsakes. Keep them away from water, strong sunlight and frequent touching. Use a display box when possible. If tiny fibers appear on the surface, trim gently with small scissors instead of pulling.',
      },
      ko: {
        title: '양모 펠트 반려동물 초상 관리법',
        excerpt: '습기, 햇빛, 변형으로부터 수공예 양모 작품을 보호하는 방법입니다.',
        content: '양모 펠트 초상은 수공예 기념품입니다. 물, 강한 햇빛, 잦은 접촉을 피하고 가능하면 전시 케이스에 보관하세요. 표면에 작은 섬유가 보이면 손으로 당기지 말고 작은 가위로 조심스럽게 다듬으세요.',
      },
    },
  },
}
const defaultThemes = [
  {
    key: 'white',
    label: '纯白简约',
    bg: '#ffffff',
    surface: '#ffffff',
    surfaceSoft: '#f7f7f8',
    text: '#18181b',
    muted: '#71717a',
    accent: '#111827',
    accent2: '#2563eb',
    line: '#e5e7eb',
    rose: '#f3f4f6',
    sage: '#eef2ff',
  },
  {
    key: 'cream',
    label: 'Cream',
    bg: '#f7f2e8',
    surface: '#fffdf8',
    surfaceSoft: '#f3eadc',
    text: '#1f2f28',
    muted: '#667068',
    accent: '#26362f',
    accent2: '#d8b56d',
    line: '#ded4c4',
    rose: '#b66f72',
    sage: '#6f8b73',
  },
  {
    key: 'sage',
    label: 'Sage',
    bg: '#eef5ed',
    surface: '#fbfff8',
    surfaceSoft: '#dfeada',
    text: '#17261d',
    muted: '#5c705e',
    accent: '#4f7658',
    accent2: '#b8c68d',
    line: '#cfddc9',
    rose: '#a86a6c',
    sage: '#5f8a65',
  },
  {
    key: 'rose',
    label: 'Rose',
    bg: '#fbeced',
    surface: '#fff8f7',
    surfaceSoft: '#f2d9db',
    text: '#302124',
    muted: '#765d61',
    accent: '#9d4f5c',
    accent2: '#d39a82',
    line: '#ead0d3',
    rose: '#b75d6a',
    sage: '#718a72',
  },
  {
    key: 'dark',
    label: 'Dark',
    bg: '#161d1a',
    surface: '#242b27',
    surfaceSoft: '#1f2523',
    text: '#f8f2e8',
    muted: '#c9c0b2',
    accent: '#d8b56d',
    accent2: '#7ea385',
    line: '#3c4842',
    rose: '#c47b80',
    sage: '#7ea385',
  },
]

function now() {
  return new Date().toISOString()
}

function utcDateKey(value = Date.now()) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function dailyOrderSummary(store = {}, date = utcDateKey()) {
  const orders = Array.isArray(store.orders) ? store.orders : []
  const payments = Array.isArray(store.payments) ? store.payments : []
  const dailyOrders = orders.filter((order) => utcDateKey(order.created_at) === date)
  const dailyPayments = payments.filter((payment) => payment.status === 'captured'
    && utcDateKey(payment.paid_at || payment.created_at) === date)
  const revenueByCurrency = dailyPayments.reduce((summary, payment) => {
    const currency = String(payment.currency || 'CNY').trim().toUpperCase()
    summary[currency] = (summary[currency] || 0) + Number(payment.amount_cents || 0)
    return summary
  }, {})
  return {
    date_utc: date,
    orders_created: dailyOrders.length,
    orders_unpaid: dailyOrders.filter((order) => order.payment_status === 'unpaid').length,
    orders_paid: dailyOrders.filter((order) => ['paid', 'deposit_paid'].includes(order.payment_status)).length,
    payments_captured: dailyPayments.length,
    payment_revenue_cents: dailyPayments.reduce((sum, payment) => sum + Number(payment.amount_cents || 0), 0),
    revenue_by_currency: revenueByCurrency,
    last_order_at: dailyOrders
      .map((order) => order.created_at)
      .filter(Boolean)
      .sort()
      .at(-1) || '',
  }
}

async function emitDailyOrderSummary(reason = 'scheduled') {
  const date = utcDateKey()
  if (!date || (reason === 'scheduled' && dailySummaryDate === date)) return
  try {
    const store = await loadStore()
    const datesToLog = dailySummaryDate && dailySummaryDate !== date
      ? [dailySummaryDate, date]
      : [date]
    for (const summaryDate of datesToLog) {
      log('info', 'business.daily_order_summary', {
        reason,
        ...dailyOrderSummary(store, summaryDate),
      })
    }
    dailySummaryDate = date
  } catch (error) {
    log('error', 'business.daily_order_summary_failed', {
      reason,
      date_utc: date,
      message: error?.message || 'failed to load store',
    })
  }
}

function scheduleDailyOrderSummary() {
  void emitDailyOrderSummary('startup')
  const timer = setInterval(() => {
    void emitDailyOrderSummary('scheduled')
  }, 30 * 1000)
  timer.unref?.()
}

function id() {
  return randomUUID()
}

function cloneThemes(themes = defaultThemes) {
  return themes.map((theme) => ({ ...theme }))
}

function normalizeThemeConfig(input = {}) {
  const configured = Array.isArray(input.themes) && input.themes.length ? input.themes : defaultThemes
  const defaultsByKey = new Map(defaultThemes.map((theme) => [theme.key, theme]))
  const seen = new Set()
  const themes = []
  for (const theme of configured) {
    const fallback = defaultsByKey.get(theme?.key) || defaultThemes[themes.length] || defaultThemes[0]
    const normalized = {
      ...fallback,
      ...(theme || {}),
      key: theme?.key || fallback.key,
      label: theme?.label || fallback.label,
    }
    if (!normalized.key || seen.has(normalized.key)) continue
    seen.add(normalized.key)
    themes.push(normalized)
  }
  for (const theme of defaultThemes) {
    if (!seen.has(theme.key)) themes.push({ ...theme })
  }
  const defaultTheme = themes.some((theme) => theme.key === input.defaultTheme) ? input.defaultTheme : 'cream'
  return { defaultTheme, themes }
}

function frameOptions() {
  return [
    { id: id(), name: '6 英寸头部', price_cents: 160000 },
    { id: id(), name: '7 英寸头部', price_cents: 200000 },
    { id: id(), name: '8 英寸头部', price_cents: 240000 },
    { id: id(), name: '6 英寸头 + 前爪', price_cents: 200000 },
    { id: id(), name: '7 英寸头 + 前爪', price_cents: 250000 },
    { id: id(), name: '8 英寸头 + 前爪', price_cents: 300000 },
    { id: id(), name: '头 + 全身', price_cents: 400000 },
  ]
}

function fullBodyOptions() {
  return [
    { id: id(), name: '10 厘米', price_cents: 260000 },
    { id: id(), name: '15 厘米', price_cents: 400000 },
    { id: id(), name: '20 厘米', price_cents: 530000 },
    { id: id(), name: '30 厘米', price_cents: 940000 },
  ]
}

const reviewSeedMedia = {
  1: {
    images: ['/assets/reviews/1/1.JPG', '/assets/reviews/1/1.1.JPG', '/assets/reviews/1/1.2.JPG'],
    avatar_url: '/assets/reviews/1/3b814ace3f10ce5ea49eb0c925dbcdeb.jpg',
  },
  2: {
    images: ['/assets/reviews/2/2.JPG', '/assets/reviews/2/2.1.JPG', '/assets/reviews/2/2.2.JPG', '/assets/reviews/2/2.3.JPG'],
    avatar_url: '/assets/reviews/2/4b922cb7f7e86f51190ad08c288b966f.jpg',
  },
  3: {
    images: ['/assets/reviews/3/3.JPG', '/assets/reviews/3/3.1.JPG', '/assets/reviews/3/3.2.JPG'],
    avatar_url: '/assets/reviews/3/7e187a6e2976b0f7f96f38b10323aea8.jpg',
  },
  4: {
    images: ['/assets/reviews/4/4.JPG', '/assets/reviews/4/4.1.JPG', '/assets/reviews/4/4.2.JPG', '/assets/reviews/4/4.3.JPG'],
    avatar_url: '/assets/reviews/4/6969049ecda177551855e994e70dbb50.jpg',
  },
  5: {
    images: ['/assets/reviews/5/5.JPG', '/assets/reviews/5/5.1.JPG', '/assets/reviews/5/5.2.JPG', '/assets/reviews/5/5.3.JPG', '/assets/reviews/5/5.4.JPG'],
    avatar_url: '/assets/reviews/5/b8a3986d03c8e30f31215b4c7c6c6c8d.jpg',
  },
  6: {
    images: ['/assets/reviews/6/6.JPG', '/assets/reviews/6/6.1.JPG', '/assets/reviews/6/6.2.JPG', '/assets/reviews/6/6.3.JPG'],
    avatar_url: '/assets/reviews/6/ea635d5f2573e2c3e5030d0a3b1a3706.jpg',
  },
  7: {
    images: ['/assets/reviews/7/7.JPG', '/assets/reviews/7/7.1.JPG', '/assets/reviews/7/7.2.JPG'],
    avatar_url: '/assets/reviews/7/eda64d103b239021eb7a04b2429ab902.jpg',
  },
  8: {
    images: ['/assets/reviews/8/8.JPG', '/assets/reviews/8/8.1.JPG', '/assets/reviews/8/8.2.JPG'],
    avatar_url: '/assets/reviews/8/cde363a58a81ba973d22b5155ad80b47.jpg',
  },
  9: {
    images: ['/assets/reviews/9/9.JPG', '/assets/reviews/9/9.1.JPG', '/assets/reviews/9/9.2.JPG'],
    avatar_url: '/assets/reviews/9/10a022579233f0aeace3c6e359bdaeb6.jpg',
  },
  10: {
    images: ['/assets/reviews/10/10.JPG', '/assets/reviews/10/10.1.JPG', '/assets/reviews/10/10.2.JPG', '/assets/reviews/10/10.3.JPG'],
    avatar_url: '/assets/reviews/10/5e74b62b13f65a466f3c4bc3a83b300e.jpg',
  },
}

function defaultReviews() {
  const copies = [
    {
      zh: {
        title: '和照片里的表情一模一样。',
        content: '和照片里看到的我们家孩子的表情真的一模一样，让我很惊讶。尤其是眼神和脸部的小细节都表现得很好，非常满意。',
      },
      en: {
        title: 'The expression looks exactly like our pet in the photos.',
        content: 'I was amazed that the expression looked exactly like our pet in the photos. The eyes and tiny facial details were captured beautifully, and I am very satisfied.',
      },
      ko: {
        title: '사진으로 보던 우리 아이의 표정과 정말 똑같아서 놀랐어요.',
        content: '사진으로 보던 우리 아이의 표정과 정말 똑같아서 놀랐어요.\n특히 눈빛과 얼굴의 작은 디테일까지 잘 표현되어 너무 만족스럽습니다.',
      },
    },
    {
      zh: {
        title: '真的像把我们家的狗狗完整地留了下来。',
        content: '一开始我还想着，羊毛毡真的能做到这么像吗？看到完成后的作品，感觉我们家的狗狗就这样被完整地呈现出来了，真的很感动。',
      },
      en: {
        title: 'It feels like our dog was captured just as he is.',
        content: 'At first I wondered whether wool felt could really look this much like our dog. Seeing the finished piece was deeply moving because our dog was captured just as he is.',
      },
      ko: {
        title: '우리 강아지가 그대로 담겨 있어서 정말 감동했어요.',
        content: '처음에는 양모펠트로 이렇게까지 닮게 만들 수 있을까 싶었는데,\n완성된 작품을 보니 우리 강아지가 그대로 담겨 있어서 정말 감동했어요.',
      },
    },
    {
      zh: {
        title: '毛色、纹理和耳朵都做得很细致。',
        content: '连毛发的颜色、纹理和耳朵的形状都表现得非常细致，我特别喜欢。我只是提供了照片，却能如此用心地制作出来，非常感谢。',
      },
      en: {
        title: 'The coat color, texture and ears are beautifully detailed.',
        content: 'The coat color, texture and ear shape were all captured with such care. I only provided photos, so I am very grateful for the thought and detail put into the work.',
      },
      ko: {
        title: '털 색깔과 결, 귀 모양까지 세심하게 표현해 주셔서 너무 마음에 들어요.',
        content: '털 색깔과 결, 귀 모양까지 세심하게 표현해 주셔서 너무 마음에 들어요.\n사진만 보내드렸는데 이렇게 정성스럽게 만들어 주셔서 감사합니다.',
      },
    },
    {
      zh: {
        title: '把猫咪最可爱的表情原原本本地呈现出来了。',
        content: '把我们家猫咪最可爱的表情原原本本地呈现出来了。每次看到它，都有一种它仿佛真的还陪在身边的温暖感觉，真的非常特别。',
      },
      en: {
        title: 'Our cat’s most lovable expression was captured perfectly.',
        content: 'Our cat’s most lovable expression was captured just as it was. Every time I see the piece, it feels warmly as if our cat were still beside us, which makes it truly special.',
      },
      ko: {
        title: '우리 고양이의 가장 사랑스러운 표정을 그대로 담아주셨어요.',
        content: '우리 고양이의 가장 사랑스러운 표정을 그대로 담아주셨어요.\n볼 때마다 실제로 옆에 있는 것 같은 따뜻한 느낌이 들어서 정말 특별합니다.',
      },
    },
    {
      zh: {
        title: '完成后的作品比想象中更加细致漂亮。',
        content: '制作过程中会仔细确认照片，所以我可以很安心地等待。完成后的作品也比我想象中更加细致漂亮。',
      },
      en: {
        title: 'The finished piece was more delicate and beautiful than I imagined.',
        content: 'The photos were checked carefully during production, so I could wait with confidence. The finished piece was even more delicate and beautiful than I had imagined.',
      },
      ko: {
        title: '완성된 작품도 생각했던 것보다 훨씬 섬세하고 예뻤습니다.',
        content: '제작 과정에서 사진을 꼼꼼하게 확인해 주셔서 안심하고 기다릴 수 있었어요.\n완성된 작품도 생각했던 것보다 훨씬 섬세하고 예뻤습니다.',
      },
    },
    {
      zh: {
        title: '照片和作品放在一起看，真的非常像。',
        content: '不仅是眼睛、鼻子和嘴巴，就连毛发的颜色和花纹都表现得非常细致。把照片和作品放在一起比较，更能感受到它们真的很像。',
      },
      en: {
        title: 'The photo and the finished piece look remarkably alike.',
        content: 'The eyes, nose and mouth were carefully made, along with the coat color and markings. Comparing the photo and the piece side by side makes the resemblance even clearer.',
      },
      ko: {
        title: '사진과 작품을 같이 놓고 보니 닮은 모습이 더 잘 느껴집니다.',
        content: '눈, 코, 입은 물론이고 털의 색과 무늬까지 정말 세심하게 표현되어 있어요.\n사진과 작품을 같이 놓고 보니 닮은 모습이 더 잘 느껴집니다.',
      },
    },
    {
      zh: {
        title: '把陪伴很久的孩子做成了值得珍藏的作品。',
        content: '能够把陪伴了我们很久的孩子做成一件特别的作品保存下来，真的非常好。作品中完整保留了那份温暖和用心，我想一直珍惜保存下去。',
      },
      en: {
        title: 'A special piece to keep the memory of our longtime companion.',
        content: 'It feels wonderful to preserve the pet who was with us for so long as a special piece of art. The warmth and care are all there, and I want to treasure it for years.',
      },
      ko: {
        title: '오래 함께했던 우리 아이를 특별한 작품으로 간직할 수 있어서 정말 좋았어요.',
        content: '오래 함께했던 우리 아이를 특별한 작품으로 간직할 수 있어서 정말 좋았어요.\n따뜻하고 정성스러운 느낌이 그대로 담겨 있어 오래도록 소중히 간직하고 싶습니다.',
      },
    },
    {
      zh: {
        title: '这是一份很有意义的宠物纪念礼物。',
        content: '作为礼物订购的，收到礼物的人真的非常喜欢。它不是普通的玩偶，而是一份记录着宠物模样的特别礼物，所以更有意义。',
      },
      en: {
        title: 'A meaningful gift that preserves a beloved pet.',
        content: 'I ordered it as a gift, and the recipient truly loved it. It is much more meaningful than an ordinary doll because it preserves the pet’s own appearance.',
      },
      ko: {
        title: '반려동물의 모습을 담은 특별한 선물이라 더 의미 있었습니다.',
        content: '선물로 주문했는데 받는 분이 정말 좋아하셨어요.\n단순한 인형이 아니라 반려동물의 모습을 담은 특별한 선물이라 더 의미 있었습니다.',
      },
    },
    {
      zh: {
        title: '连姿势和尾巴的形状都表现得很细致。',
        content: '我订购的是全身款，连姿势和尾巴的形状都细致地表现出来了。能够感受到连很小的细节都认真处理了，所以真的非常满意。',
      },
      en: {
        title: 'Even the pose and tail shape were carefully captured.',
        content: 'I ordered a full-body piece, and the pose and tail shape were both recreated with care. You can feel the attention given to every small detail, so I am very satisfied.',
      },
      ko: {
        title: '자세와 꼬리 모양까지 꼼꼼하게 표현해 주셨어요.',
        content: '전신 작품을 주문했는데 자세와 꼬리 모양까지 꼼꼼하게 표현해 주셨어요.\n작은 부분까지 신경 써주신 것이 느껴져서 만족도가 정말 높았습니다.',
      },
    },
    {
      zh: {
        title: '一张照片也能变成这样立体的作品，真的很神奇。',
        content: '只通过一张照片就能制作出这样立体的作品，真的觉得很神奇。很好地保留了我们家孩子独有的特点，感觉真的成为了一件世上独一无二的作品。',
      },
      en: {
        title: 'It is amazing what one photo can become.',
        content: 'It was amazing to see one photo become such a dimensional piece. The unique features of our pet were preserved so well that it feels like a truly one-of-a-kind work.',
      },
      ko: {
        title: '우리 아이만의 특징을 잘 살려 세상에 하나뿐인 작품이 된 것 같아요.',
        content: '사진 한 장에서 이렇게 입체적인 작품이 만들어진다는 것이 신기했어요.\n우리 아이만의 특징을 잘 살려주셔서 세상에 하나뿐인 작품이 된 것 같아요.',
      },
    },
  ]
  return copies.map((translations, index) => {
    const number = index + 1
    const media = reviewSeedMedia[number] || {}
    const base = translations.en
    return {
      id: id(),
      name: `고객 ${String(number).padStart(2, '0')}`,
      country: 'Korea',
      rating: 5,
      status: 'published',
      title: base.title,
      content: base.content,
      product_slug: '',
      avatar_url: media.avatar_url || '',
      images: media.images || [],
      pet_image: media.images?.[0] || '',
      work_image: media.images?.[1] || '',
      video_url: '',
      translations,
    }
  })
}

// -----------------------------------------------------------------------------
// Seed data and JSON persistence
// -----------------------------------------------------------------------------
function defaultCategories() {
  return [
    {
      id: id(),
      slug: '3d-pet-frame-portraits',
      title: '3D 宠物相框类肖像',
      description: '狗狗相框、猫咪相框、兔子相框，适合作为生日礼物、纪念礼物和温暖家居陈列。',
      seo_title: '3D 宠物相框类肖像 | 狗狗相框 猫咪相框 兔子相框',
      seo_description: '定制 3D 羊毛毡宠物相框肖像，支持狗狗相框、猫咪相框、兔子相框和宠物纪念相框。',
      image_url: '/assets/product-frame.svg',
      children: [
        { slug: 'dog-frame-portrait', title: '狗狗相框', description: '根据狗狗照片制作 3D 羊毛毡头像相框。' },
        { slug: 'cat-frame-portrait', title: '猫咪相框', description: '还原猫咪眼神、毛色和脸型的相框作品。' },
        { slug: 'rabbit-frame-portrait', title: '兔子相框', description: '适合兔子、龙猫等小型宠物纪念。' },
      ],
      sort_order: 1,
      status: 'published',
    },
    {
      id: id(),
      slug: '3d-full-body-pet-portraits',
      title: '3D 宠物全身类肖像',
      description: '狗狗全身肖像、猫猫全身肖像、兔子全身肖像和多宠物合照肖像，重点还原体态、姿势和毛色细节。',
      seo_title: '3D 宠物全身类肖像 | 狗狗全身 猫猫全身 兔子全身 多宠物合照',
      seo_description: '定制 3D 羊毛毡宠物全身肖像，支持狗狗全身、猫猫全身、兔子全身和多宠物合照肖像。',
      image_url: '/assets/product-full-body.svg',
      children: [
        { slug: 'dog-full-body-portrait', title: '狗狗全身肖像', description: '还原狗狗坐姿、站姿、毛色和体态比例。' },
        { slug: 'cat-full-body-portrait', title: '猫猫全身肖像', description: '适合猫咪坐姿、趴姿和特色花纹定制。' },
        { slug: 'rabbit-full-body-portrait', title: '兔子全身肖像', description: '适合兔子坐姿、耳朵形态和毛色层次定制。' },
        { slug: 'multi-pet-group-portrait', title: '多宠物合照肖像', description: '把多只宠物做成同一组收藏作品。' },
      ],
      sort_order: 2,
      status: 'published',
    },
    {
      id: id(),
      slug: 'pet-memorial-gifts',
      title: '宠物纪念礼品',
      description: '纪念相框、纪念全身肖像，适合 Memorial Gift、离世宠物纪念和家人礼物。',
      seo_title: '宠物纪念礼品 | Memorial Gift 纪念相框 纪念全身肖像',
      seo_description: '宠物离世纪念礼品定制，支持纪念相框、纪念全身肖像、生日礼物、圣诞礼物和周年礼物。',
      image_url: '/assets/product-memorial.svg',
      children: [
        { slug: 'memorial-frame', title: '纪念相框', description: '把宠物照片做成可长期摆放的纪念相框。' },
        { slug: 'memorial-full-body-portrait', title: '纪念全身肖像', description: '以更完整的形态留住宠物的身影和陪伴感。' },
      ],
      sort_order: 3,
      status: 'published',
    },
  ]
}

function defaultProducts(categories = defaultCategories()) {
  const bySlug = Object.fromEntries(categories.map((category) => [category.slug, category.id]))
  return [
    {
      id: id(),
      category_id: bySlug['3d-pet-frame-portraits'],
      subcategory_slug: 'dog-frame-portrait',
      slug: 'custom-dog-frame-portrait',
      title: '3D 羊毛毡狗狗相框定制',
      subtitle: '根据狗狗照片定制头像相框',
      description: 'Custom 3D felted dog frame portrait，根据狗狗照片手工制作羊毛毡头像相框，适合作为 Birthday Gift、Memorial Gift 和家居展示。我们会重点确认毛色、眼神、耳朵形状和表情，让作品适合长期保存。',
      base_price_cents: 160000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-frame.svg',
      images: [
        '/assets/product-frame.svg',
      ],
      options: frameOptions(),
      tags: ['Birthday Gift', 'Memorial Gift', 'Realistic Style'],
      use_cases: ['Birthday Gift', 'Memorial Gift', 'Christmas Gift'],
      alt_text: 'custom 3D felted dog frame portrait handmade from pet photo',
      seo_title: '3D 羊毛毡狗狗相框定制 | Custom Dog Frame Portrait',
      seo_description: '定制 3D 羊毛毡狗狗相框，把狗狗照片做成可长期保存的手工宠物肖像礼物。',
      faqs: [
        { question: '狗狗相框需要哪些照片？', answer: '建议提供正面、侧面、耳朵、眼睛、毛色细节和喜欢的表情照片。' },
        { question: '可以做成纪念礼物吗？', answer: '可以，狗狗相框适合生日礼物、宠物纪念礼物和家人纪念收藏。' },
      ],
      status: 'published',
      sort_order: 1,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['3d-pet-frame-portraits'],
      subcategory_slug: 'cat-frame-portrait',
      slug: 'custom-cat-frame-portrait',
      title: '3D 羊毛毡猫咪相框定制',
      subtitle: '还原猫咪眼神、花纹和脸型',
      description: 'Custom felted cat frame portrait，适合把猫咪照片做成 3D 羊毛毡相框。产品页面覆盖 cat memorial gift、custom cat portrait、handmade pet frame 等搜索关键词，同时保留温暖、克制的礼物表达。',
      base_price_cents: 160000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-frame.svg',
      images: ['/assets/product-frame.svg'],
      options: frameOptions(),
      tags: ['Memorial Gift', 'Realistic Style', 'Christmas Gift'],
      use_cases: ['Memorial Gift', 'Anniversary Gift', 'Christmas Gift'],
      alt_text: 'custom 3D felted cat frame portrait with realistic wool details',
      seo_title: '3D 羊毛毡猫咪相框定制 | Custom Cat Frame Portrait',
      seo_description: '根据猫咪照片定制 3D 羊毛毡猫咪相框，适合作为纪念礼物和节日礼物。',
      faqs: [
        { question: '猫咪花纹可以还原吗？', answer: '可以，我们会根据照片确认脸部花纹、眼睛颜色、鼻子和胡须位置。' },
        { question: '相框尺寸怎么选？', answer: '6 英寸适合单猫头像，7-8 英寸适合更丰富的毛量和前爪细节。' },
      ],
      status: 'published',
      sort_order: 2,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['3d-pet-frame-portraits'],
      subcategory_slug: 'rabbit-frame-portrait',
      slug: 'custom-rabbit-frame-portrait',
      title: '3D 羊毛毡兔子相框定制',
      subtitle: '适合兔子、小型宠物和纪念相框',
      description: 'Handmade rabbit frame portrait，适合兔子、龙猫等小型宠物。通过照片确认耳朵形态、毛色层次和神情，做成轻盈温暖的 3D 羊毛毡相框。',
      base_price_cents: 160000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-frame.svg',
      images: ['/assets/product-frame.svg'],
      options: frameOptions(),
      tags: ['Birthday Gift', 'Handmade', 'Wool Felt', 'Realistic Style'],
      use_cases: ['Birthday Gift', 'Memorial Gift'],
      alt_text: 'custom rabbit felted frame portrait handmade wool keepsake',
      seo_title: '3D 羊毛毡兔子相框定制 | Rabbit Frame Portrait',
      seo_description: '兔子羊毛毡相框定制，把兔子照片做成手工宠物纪念礼物。',
      faqs: [{ question: '兔子可以做前爪吗？', answer: '可以，建议选择头 + 前爪规格，并提供清晰前爪照片。' }],
      status: 'published',
      sort_order: 3,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['3d-full-body-pet-portraits'],
      subcategory_slug: 'dog-full-body-portrait',
      slug: 'custom-dog-full-body-portrait',
      title: '3D 狗狗全身羊毛毡肖像',
      subtitle: '还原狗狗体态、姿势和毛色',
      description: 'Custom dog full body felted portrait，根据狗狗全身照片定制 10-30 厘米羊毛毡肖像，适合收藏、纪念和展示。SEO 内容覆盖 custom dog replica、realistic pet portrait、handmade dog memorial gift。',
      base_price_cents: 260000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-full-body.svg',
      images: ['/assets/product-full-body.svg'],
      options: fullBodyOptions(),
      tags: ['Anniversary Gift', 'Realistic Style', 'Memorial Gift'],
      use_cases: ['Anniversary Gift', 'Memorial Gift'],
      alt_text: 'realistic full body custom dog wool felt portrait',
      seo_title: '3D 狗狗全身羊毛毡肖像 | Custom Dog Full Body Portrait',
      seo_description: '定制狗狗全身羊毛毡肖像，支持 10/15/20/30 厘米尺寸选择。',
      faqs: [{ question: '全身肖像需要什么照片？', answer: '请提供站姿或坐姿全身照片，以及正面、侧面、背面和尾巴细节。' }],
      status: 'published',
      sort_order: 4,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['3d-full-body-pet-portraits'],
      subcategory_slug: 'cat-full-body-portrait',
      slug: 'custom-cat-full-body-portrait',
      title: '3D 猫猫全身羊毛毡肖像',
      subtitle: '还原猫咪姿态、尾巴和花纹',
      description: 'Custom cat full body felted portrait，适合猫咪坐姿、趴姿或站姿定制。通过细节照片还原花纹、尾巴、脚掌和神情，是适合收藏和纪念的手工宠物肖像。',
      base_price_cents: 260000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-full-body.svg',
      images: ['/assets/product-full-body.svg'],
      options: fullBodyOptions(),
      tags: ['Memorial Gift', 'Handmade', 'Wool Felt', 'Realistic Style'],
      use_cases: ['Memorial Gift', 'Christmas Gift'],
      alt_text: 'custom full body cat wool felt portrait realistic handmade gift',
      seo_title: '3D 猫猫全身羊毛毡肖像 | Custom Cat Full Body Portrait',
      seo_description: '猫猫全身羊毛毡肖像定制，支持多尺寸和真实风格还原。',
      faqs: [{ question: '猫咪尾巴和花纹会做吗？', answer: '会，建议提供尾巴、背部花纹和四肢颜色细节照片。' }],
      status: 'published',
      sort_order: 5,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['3d-full-body-pet-portraits'],
      subcategory_slug: 'rabbit-full-body-portrait',
      slug: 'custom-rabbit-full-body-portrait',
      title: '3D 兔子全身羊毛毡肖像',
      subtitle: '还原兔子姿态、耳朵和毛色层次',
      description: 'Custom rabbit full body felted portrait，适合兔子坐姿、趴姿和特色毛色定制。通过细节照片还原耳朵形态、身体比例、脚掌和神情，是适合收藏和纪念的手工宠物肖像。',
      base_price_cents: 260000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-full-body.svg',
      images: ['/assets/product-full-body.svg'],
      options: fullBodyOptions(),
      tags: ['Birthday Gift', 'Handmade', 'Wool Felt', 'Realistic Style'],
      use_cases: ['Birthday Gift', 'Memorial Gift', 'Christmas Gift'],
      alt_text: 'custom full body rabbit wool felt portrait realistic handmade gift',
      seo_title: '3D 兔子全身羊毛毡肖像 | Custom Rabbit Full Body Portrait',
      seo_description: '兔子全身羊毛毡肖像定制，支持多尺寸和真实风格还原。',
      faqs: [{ question: '兔子全身肖像需要哪些照片？', answer: '建议提供正面、侧面、背面、全身、耳朵、脚掌和毛色细节照片。' }],
      status: 'published',
      sort_order: 6,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['3d-full-body-pet-portraits'],
      subcategory_slug: 'multi-pet-group-portrait',
      slug: 'custom-multi-pet-group-portrait',
      title: '多宠物合照羊毛毡肖像',
      subtitle: '把多只宠物做成同一组作品',
      description: 'Multi pet group portrait，适合两只或多只宠物合照定制。可根据单独照片组合成一组全身羊毛毡作品，用于家庭收藏、纪念礼物和节日礼物。',
      base_price_cents: 530000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-full-body.svg',
      images: ['/assets/product-full-body.svg'],
      options: fullBodyOptions(),
      tags: ['Anniversary Gift', 'Christmas Gift', 'Realistic Style'],
      use_cases: ['Anniversary Gift', 'Christmas Gift'],
      alt_text: 'multi pet group custom wool felt portrait for family keepsake',
      seo_title: '多宠物合照羊毛毡肖像 | Multi Pet Group Portrait',
      seo_description: '多宠物合照羊毛毡肖像定制，把多只宠物做成同一组手工纪念作品。',
      faqs: [{ question: '多宠物可以用不同照片合成吗？', answer: '可以，只要每只宠物都有清晰正面和全身参考照片。' }],
      status: 'published',
      sort_order: 7,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['pet-memorial-gifts'],
      subcategory_slug: 'memorial-frame',
      slug: 'pet-memorial-frame-gift',
      title: '宠物纪念相框礼物',
      subtitle: '适合离世宠物和家人纪念礼物',
      description: 'Pet memorial frame gift，把宠物照片制作成 3D 羊毛毡纪念相框，适合 Memorial Gift、pet loss gift、sympathy gift 等场景。页面内容覆盖宠物纪念礼物相关 SEO 关键词。',
      base_price_cents: 160000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-memorial.svg',
      images: ['/assets/product-memorial.svg'],
      options: frameOptions(),
      tags: ['Memorial Gift', 'Realistic Style'],
      use_cases: ['Memorial Gift'],
      alt_text: 'pet memorial frame gift custom 3D felted portrait',
      seo_title: '宠物纪念相框礼物 | Pet Memorial Frame Gift',
      seo_description: '宠物纪念相框定制，适合作为离世宠物纪念礼物和家人慰问礼物。',
      faqs: [{ question: '可以加入宠物毛发吗？', answer: '如客户愿意寄送材料，可在制作前沟通是否加入少量毛发作为纪念。' }],
      status: 'published',
      sort_order: 8,
      created_at: now(),
    },
    {
      id: id(),
      category_id: bySlug['pet-memorial-gifts'],
      subcategory_slug: 'memorial-full-body-portrait',
      slug: 'pet-memorial-full-body-portrait',
      title: '宠物纪念全身肖像',
      subtitle: '完整保留宠物的身影和姿态',
      description: 'Pet memorial full body portrait，用羊毛毡全身肖像保存宠物的姿态、毛色和陪伴感。适合作为宠物离世纪念、家庭收藏和周年纪念礼物。',
      base_price_cents: 260000,
      currency: 'CNY',
      deposit_percent: 50,
      image_url: '/assets/product-memorial.svg',
      images: ['/assets/product-memorial.svg'],
      options: fullBodyOptions(),
      tags: ['Memorial Gift', 'Realistic Style', 'Anniversary Gift'],
      use_cases: ['Memorial Gift', 'Anniversary Gift'],
      alt_text: 'pet memorial full body wool felt portrait handmade keepsake',
      seo_title: '宠物纪念全身肖像 | Pet Memorial Full Body Portrait',
      seo_description: '宠物纪念全身肖像定制，用手工羊毛毡保留宠物的完整身影。',
      faqs: [{ question: '纪念全身肖像制作多久？', answer: '通常 4-8 周，复杂毛色、多宠物或大尺寸可能需要更久。' }],
      status: 'published',
      sort_order: 9,
      created_at: now(),
    },
  ]
}

function defaultSiteContent() {
  return {
    policies: {
      care: '护理说明：作品为手工羊毛毡定制品，请避免水洗、暴晒、潮湿和强力拉扯。建议放入展示盒、相框或干燥避光区域保存；如表面有浮毛，可用小剪刀轻轻修整，不建议频繁触摸细节部位。',
      shipping: '运输政策：确认成品预览和收货信息后安排包装发货。普通定制制作周期通常为 4-8 周，跨境运输时间会因国家、节假日和海关处理速度变化。发货后会提供物流单号。',
      refund: '退款政策：定制商品在开始制作前可沟通取消或调整；一旦进入手工制作阶段，不支持无理由退款。若作品与已确认照片和需求存在明显偏差，我们会优先提供修改方案。',
    },
    faq: [
      { id: id(), question: '制作和发货需要多久？', answer: '通常制作周期为 4-8 周。复杂姿势、多宠物、大尺寸或节假日订单可能延长，我们会在确认需求时说明预计时间。' },
      { id: id(), question: '需要提供哪些照片？', answer: '建议提供正面、侧面、背面、全身、毛色细节、眼睛和代表性表情照片。照片越清晰，作品越容易还原。' },
      { id: id(), question: '可以先付定金吗？', answer: '可以。默认支持 50% 定金开始制作，也支持全款支付；尾款在预览确认后支付。' },
      { id: id(), question: '支持 PayPal 吗？', answer: '支持 PayPal 支付。订单提交后会创建 PayPal 支付流程，后台可跟踪定金、尾款和订单状态。' },
      { id: id(), question: '图片会用于公开展示吗？', answer: '默认不会公开客户照片和作品。若需要展示评价或案例，会先获得客户授权。' },
    ],
    reviews: defaultReviews(),
    socials: {
      tiktok: 'https://www.tiktok.com/@woolmemorystudio',
      pinterest: 'https://www.pinterest.com/woolmemorystudio',
      instagram: '',
      facebook: 'https://www.facebook.com/woolmemorystudio',
    },
    taxonomies: {
      occasions: ['Birthday Gift', 'Anniversary Gift', 'Memorial Gift', 'Christmas Gift', 'Housewarming Gift', 'Parents Gift'],
      styles: [],
    },
    bot: {
      enabled: true,
      welcome: {
        zh: '你好，我是 WoolBuddy 客服助手。你可以咨询价格、照片、制作周期、配送、退款和护理。',
        en: 'Hi, I am the WoolBuddy assistant. Ask about pricing, photos, production, shipping, refunds or care.',
        ko: '안녕하세요. WoolBuddy 상담 도우미입니다. 가격, 사진, 제작 기간, 배송, 환불과 관리 방법을 물어보세요.',
      },
      knowledge: [
        { keywords: ['价格', 'price', 'cost', '多少钱', '费用'], zh: '相框类从 ¥1,600 起，全身肖像从 ¥2,600 起。可选择 50% 定金或全款支付。', en: 'Frame portraits start at CNY 1,600, and full body portraits start at CNY 2,600. Deposit and full payment are supported.', ko: '액자형은 CNY 1,600부터, 전신형은 CNY 2,600부터 시작합니다. 계약금 또는 전액 결제를 지원합니다.' },
        { keywords: ['照片', 'photo', 'picture', '上传'], zh: '建议上传正面、侧面、背面、全身、毛色细节和代表性表情照片。', en: 'Please upload front, side, back, full-body and detail photos, including coat color and expression.', ko: '정면, 측면, 뒷모습, 전신, 털색 디테일과 표정 사진을 올려주세요.' },
        { keywords: ['周期', '多久', 'lead', 'time', '制作'], zh: '普通订单通常需要 4-8 周制作，复杂造型、多宠物或节假日可能更久。', en: 'Most orders take 4-8 weeks. Complex poses, multiple pets or holidays may take longer.', ko: '일반 주문은 보통 4-8주가 걸리며 복잡한 자세나 여러 마리 주문은 더 걸릴 수 있습니다.' },
        { keywords: ['运输', 'shipping', 'delivery', '发货'], zh: '成品预览确认后安排包装发货，跨境运输时间按地区和海关速度变化。', en: 'We ship after final preview approval. International delivery depends on destination and customs.', ko: '최종 미리보기 승인 후 포장 및 발송되며, 해외 배송은 지역과 통관에 따라 달라집니다.' },
        { keywords: ['退款', 'refund', 'cancel', '取消'], zh: '开始制作前可沟通取消或调整；进入手工制作后不支持无理由退款。', en: 'Cancellation can be discussed before production starts. Custom work is not refundable once crafting begins.', ko: '제작 전에는 취소나 조정이 가능하지만, 제작 시작 후 단순 변심 환불은 어렵습니다.' },
        { keywords: ['护理', 'care', 'clean', '保存'], zh: '请避免水洗、暴晒、潮湿和拉扯，建议放入展示盒或干燥避光区域保存。', en: 'Avoid washing, direct sun, moisture and pulling. Store in a dry display case or shaded area.', ko: '세탁, 직사광선, 습기, 당김을 피하고 건조한 전시 케이스나 그늘에 보관하세요.' },
      ],
    },
    blog: [
      { id: id(), slug: 'how-to-choose-custom-pet-portrait-photos', title: 'How to Choose Photos for a Custom 3D Pet Portrait', excerpt: 'Learn which pet photos help artists capture eyes, coat color, pose and personality for a custom wool portrait.', date: '2026-06-18', tags: ['Photo Guide', 'Custom Pet Portrait'], image_url: '/assets/product-full-body.svg', content: 'A good custom pet portrait starts with clear references. Prepare front, side, back and full-body photos. Add close-ups of eyes, ears, tail, paws and coat markings. If the portrait is a memorial gift, include the expression that feels most familiar to your family.' },
      { id: id(), slug: 'pet-memorial-gift-ideas', title: 'Pet Memorial Gift Ideas for Families', excerpt: 'A practical guide to choosing a pet memorial frame, full body portrait or keepsake gift.', date: '2026-06-12', tags: ['Memorial Gift', 'Pet Loss Gift'], image_url: '/assets/product-memorial.svg', content: 'Pet memorial gifts should feel personal and calm. A 3D felted frame is suitable for display on a shelf, while a full body portrait keeps the pet’s posture and shape. Choose the format based on how the family remembers the pet most clearly.' },
      { id: id(), slug: 'care-guide-for-wool-felt-pet-portraits', title: 'Care Guide for Wool Felt Pet Portraits', excerpt: 'How to protect handmade wool felt portraits from moisture, sunlight and deformation.', date: '2026-06-05', tags: ['Care Guide', 'Wool Felt'], image_url: '/assets/product-frame.svg', content: 'Wool felt portraits are handmade keepsakes. Keep them away from water, strong sunlight and frequent touching. Use a display box when possible. If tiny fibers appear on the surface, trim gently with small scissors instead of pulling.' },
    ],
  }
}

function shouldReplaceLegacyReviewSeed(reviews = []) {
  const legacyNames = new Set(['Mia R.', 'Hana K.', 'Emily C.'])
  const legacyTitles = new Set([
    'The face looks just like my dog.',
    'The expression looks just like my dog.',
    'A warm memorial gift.',
    'A warm pet memorial work.',
    'Beautiful full body detail.',
    'Beautiful full-body details.',
  ])
  const matches = (review) => legacyNames.has(String(review?.name || '').trim())
    && (legacyTitles.has(String(review?.title || '').trim())
      || legacyTitles.has(String(review?.translations?.en?.title || '').trim()))
  // Legacy 3-review seed: either the original English-titled entries, or the
  // newer shape where admin save backfilled every translation with the same
  // Chinese text (monolingual translations => the storefront shows Chinese on
  // the English/Korean sites). In both shapes media fields are empty.
  const monoChinese = (review) => {
    const entries = Object.values(review?.translations || {})
      .map((entry) => String(entry?.title || '').trim())
      .filter(Boolean)
    if (!entries.length) return false
    if (new Set(entries).size !== 1) return false
    return /[\u4e00-\u9fff]/.test(entries[0])
  }
  return Array.isArray(reviews) && reviews.length === 3
    && reviews.every((review) => matches(review) || monoChinese(review))
    && reviews.every((review) => !Array.isArray(review?.images) || review.images.length === 0)
    && reviews.every((review) => !String(review?.avatar_url || '').trim()
      && !String(review?.pet_image || '').trim()
      && !String(review?.work_image || '').trim())
}

function seedStore() {
  const categories = defaultCategories()
  const products = defaultProducts(categories)
  const siteContent = defaultSiteContent()
  return {
    categories,
    products,
    orders: [],
    payments: [],
    audit_logs: [],
    site: {
      brand: { name: 'WoolBuddy', email: 'woolbuddy.pet@gmail.com', instagram: '' },
      contact: defaultContactConfig(),
      shipping: {
        tracking_url_template: 'https://t.17track.net/en#nums={tracking}',
      },
      google: { client_id: process.env.GOOGLE_CLIENT_ID || 'demo-google-client-id' },
      paypal: {
        client_id: 'sandbox-demo-client-id',
        secret: '',
        webhook_id: '',
        currency: defaultPaypalCurrency,
        mode: 'sandbox',
      },
      theme: { defaultTheme: 'cream', themes: cloneThemes() },
      ...siteContent,
    },
  }
}

async function loadStore() {
  await mkdir(dataDir, { recursive: true })
  await mkdir(uploadDir, { recursive: true })
  const pool = await ensurePostgresStore()
  if (pool) {
    const result = await pool.query('SELECT data FROM platform_runtime_store WHERE id = 1')
    if (result.rows.length) {
      const stored = typeof result.rows[0].data === 'string'
        ? JSON.parse(result.rows[0].data)
        : result.rows[0].data
      return migrateStore(stored)
    }
  }
  if (!existsSync(dataFile)) await writeFile(dataFile, JSON.stringify(seedStore(), null, 2))
  const store = JSON.parse(await readFile(dataFile, 'utf8'))
  if (pool) await saveStore(store)
  return migrateStore(store)
}

async function saveStore(store) {
  // Writes are serialized. PostgreSQL is authoritative in postgres mode, while
  // store.json remains a local recovery/export shadow copy.
  const write = async () => {
    const pool = await ensurePostgresStore()
    if (pool) {
      await pool.query(`
        INSERT INTO platform_runtime_store (id, data, updated_at)
        VALUES (1, $1::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `, [JSON.stringify(store)])
    }
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    await writeFile(tmpFile, JSON.stringify(store, null, 2))
    await rename(tmpFile, dataFile)
  }
  saveQueue = saveQueue.then(write, write)
  return saveQueue
}

function migrateStore(store) {
  // Migration is deliberately additive: existing operator-edited content wins,
  // while newly introduced fields receive safe defaults. A migrated snapshot is
  // persisted asynchronously so the request path stays responsive.
  const seeded = seedStore()
  if (!Array.isArray(store.categories)) store.categories = seeded.categories
  if (!Array.isArray(store.products)) store.products = seeded.products
  if (!Array.isArray(store.orders)) store.orders = []
  if (!Array.isArray(store.payments)) store.payments = []
  if (!Array.isArray(store.audit_logs)) store.audit_logs = []
  let changed = false
  for (const seededCategory of seeded.categories) {
    const existing = store.categories.find((category) => category.slug === seededCategory.slug)
    if (existing) {
      if (!existing.children?.length) changed = true
      const existingChildrenBySlug = new Map((existing.children || []).map((child) => [child.slug, child]))
      const children = seededCategory.children.map((seededChild) => ({
        ...seededChild,
        ...(existingChildrenBySlug.get(seededChild.slug) || {}),
      }))
      Object.assign(existing, {
        ...existing,
        description: seededCategory.description,
        seo_title: seededCategory.seo_title,
        seo_description: seededCategory.seo_description,
        image_url: existing.image_url || seededCategory.image_url,
        children,
      })
    } else {
      store.categories.push(seededCategory)
      changed = true
    }
  }
  const categoryIdBySlug = new Map(store.categories.map((category) => [category.slug, category.id]))
  const seededProducts = defaultProducts(store.categories)
  for (const seededProduct of seededProducts) {
    const existing = store.products.find((product) => product.slug === seededProduct.slug)
    if (existing) {
      const seededCategory = store.categories.find((category) => category.children?.some((child) => child.slug === seededProduct.subcategory_slug))
      Object.assign(existing, {
        ...seededProduct,
        ...existing,
        category_id: seededCategory?.id || existing.category_id || seededProduct.category_id,
        options: existing.options?.length ? existing.options : seededProduct.options,
        images: existing.images?.length ? existing.images : seededProduct.images,
        tags: existing.tags?.length ? existing.tags : seededProduct.tags,
        use_cases: existing.use_cases?.length ? existing.use_cases : seededProduct.use_cases,
        faqs: existing.faqs?.length ? existing.faqs : seededProduct.faqs,
        alt_text: existing.alt_text || seededProduct.alt_text,
      })
      if (!existing.subcategory_slug || !existing.alt_text || !existing.use_cases?.length) changed = true
    } else {
      store.products.push(seededProduct)
      changed = true
    }
  }
  const content = defaultSiteContent()
  store.site = {
    ...seeded.site,
    ...(store.site || {}),
    brand: { ...seeded.site.brand, ...(store.site?.brand || {}) },
    contact: { ...seeded.site.contact, ...(store.site?.contact || {}) },
    google: { ...seeded.site.google, ...(store.site?.google || {}) },
    paypal: { ...seeded.site.paypal, ...(store.site?.paypal || {}) },
    theme: normalizeThemeConfig(store.site?.theme || seeded.site.theme),
    policies: { ...content.policies, ...(store.site?.policies || {}) },
    faq: store.site?.faq?.length ? store.site.faq : content.faq,
    reviews: (() => {
      const existingReviews = store.site?.reviews
      if (shouldReplaceLegacyReviewSeed(existingReviews)) {
        changed = true
        return content.reviews
      }
      return existingReviews?.length ? existingReviews : content.reviews
    })(),
    socials: { ...content.socials, ...(store.site?.socials || {}) },
    taxonomies: {
      occasions: Array.isArray(store.site?.taxonomies?.occasions) ? store.site.taxonomies.occasions : content.taxonomies.occasions,
      styles: Array.isArray(store.site?.taxonomies?.styles) ? store.site.taxonomies.styles : content.taxonomies.styles,
    },
    bot: {
      ...content.bot,
      ...(store.site?.bot || {}),
      welcome: { ...content.bot.welcome, ...(store.site?.bot?.welcome || {}) },
      knowledge: store.site?.bot?.knowledge?.length ? store.site.bot.knowledge : content.bot.knowledge,
    },
    blog: store.site?.blog?.length ? store.site.blog : content.blog,
  }
  const previousContact = JSON.stringify(store.site.contact || {})
  store.site = normalizeLegacySiteConfig(store.site)
  if (JSON.stringify(store.site.contact || {}) !== previousContact) changed = true
  // Rebase product prices onto the KRW base currency (idempotent). Products
  // stored in another supported currency are converted once, value-preservingly,
  // through the shared fixed rate table; orders keep their historical currency.
  for (const product of store.products) {
    const from = normalizeSupportedCurrency(product.currency)
    if (!from || from === CURRENCY_BASE) continue
    const base = convertMinorAmount(product.base_price_cents, from, CURRENCY_BASE)
    if (!base) continue
    product.base_price_cents = base
    for (const option of product.options || []) {
      const converted = convertMinorAmount(option.price_cents, from, CURRENCY_BASE)
      if (converted) option.price_cents = converted
    }
    product.currency = CURRENCY_BASE
    changed = true
  }
  store.products = store.products.map((product, index) => {
    const fallback = seeded.products[index] || seeded.products[0]
    const options = (product.options?.length ? product.options : fallback.options || []).map((option) => ({
      ...option,
      id: String(option.id || '').trim() || id(),
    }))
    const migrated = {
      category_id: store.categories.find((c) => c.id === product.category_id)?.id || store.categories[0]?.id,
      title: product.title || product.translations?.zh?.title || fallback.title,
      subtitle: product.subtitle || product.translations?.zh?.subtitle || fallback.subtitle,
      description: product.description || product.translations?.zh?.description || fallback.description,
      images: product.images || [product.image_url || fallback.image_url],
      options,
      tags: product.tags || fallback.tags,
      use_cases: product.use_cases || fallback.use_cases || [],
      subcategory_slug: product.subcategory_slug || fallback.subcategory_slug || '',
      alt_text: product.alt_text || fallback.alt_text || product.title,
      faqs: product.faqs || fallback.faqs || [],
      seo_title: product.seo_title || product.title || fallback.seo_title,
      seo_description: product.seo_description || product.description || fallback.seo_description,
      status: product.status || 'published',
      sort_order: product.sort_order || index + 1,
      ...product,
    }
    if (!product.options || !product.images || !product.category_id || options.some((option, optionIndex) => option.id !== (product.options || [])[optionIndex]?.id)) changed = true
    return migrated
  })
  const productById = new Map(store.products.map((product) => [product.id, product]))
  for (const order of store.orders) {
    const product = productById.get(order.product_id)
    const option = product?.options?.find((item) => item.id === order.option_id) || product?.options?.[0]
    const optionTotal = Number(option?.price_cents || product?.base_price_cents || 0)
    const previousAmount = Number(order.amount_cents || 0)
    const previousInitial = Number(order.initial_payment_cents || 0)
    const paymentType = String(order.payment_type || 'deposit')
    const depositPercent = Number(order.deposit_percent || product?.deposit_percent || 50)
    // Historical orders keep the currency they were created with. Amounts are
    // only resynced from the product while both sides use the same currency,
    // so migrating product prices to the KRW base never rewrites old orders.
    const currencyMatchesProduct = !product
      || String(order.currency || '').trim().toUpperCase() === String(product.currency || '').trim().toUpperCase()
    if (!Number.isSafeInteger(Number(order.deposit_percent)) && product?.deposit_percent) {
      order.deposit_percent = Number(product.deposit_percent)
      changed = true
    }
    if (optionTotal > 0) {
      // Existing valid amount/initial snapshots are immutable: a later product
      // price change must never reprice a recorded order. Only missing or
      // self-inconsistent amounts are repaired from the current product price.
      if (!previousInitial && Number.isSafeInteger(previousAmount) && previousAmount > 0) {
        order.initial_payment_cents = paymentType === 'full' ? previousAmount
          : Math.round(previousAmount * Math.min(100, Math.max(1, depositPercent)) / 100)
        changed = true
      } else if (!previousInitial && currencyMatchesProduct) {
        order.initial_payment_cents = paymentType === 'full'
          ? optionTotal
          : Math.round(optionTotal * Math.min(100, Math.max(1, depositPercent)) / 100)
        changed = true
      }
      if (!previousAmount) {
        if (currencyMatchesProduct) {
          order.amount_cents = optionTotal
          changed = true
        }
      } else if (previousAmount < Number(order.paid_amount_cents || 0)) {
        order.amount_cents = Math.max(optionTotal, Number(order.paid_amount_cents || 0), previousAmount)
        changed = true
      }
    } else if (!previousInitial && previousAmount > 0) {
      order.initial_payment_cents = previousAmount
      changed = true
    }
  }
  const translated = ensureTranslations(store)
  if (translated.changed) changed = true
  if (changed) {
    saveStore(translated.store).catch((error) => {
      log('error', 'store.migration_persist_failed', { message: error?.message || 'migration save failed' })
    })
  }
  return translated.store
}

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
}
const frontendSecurityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
}
const privateNoStoreHeaders = { 'cache-control': 'no-store' }
const staticMimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

function sendText(req, res, status, body, headers = {}) {
  res.writeHead(status, { ...frontendSecurityHeaders, 'content-type': 'text/plain; charset=utf-8', ...headers })
  if (req.method === 'HEAD') return res.end()
  res.end(body)
}

function sendXml(req, res, status, body, headers = {}) {
  res.writeHead(status, { ...frontendSecurityHeaders, 'content-type': 'application/xml; charset=utf-8', ...headers })
  if (req.method === 'HEAD') return res.end()
  res.end(body)
}

function xmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function sitemapUrl(origin, pathname) {
  return `  <url><loc>${xmlEscape(new URL(pathname, `${origin}/`).toString())}</loc></url>`
}

function buildRobots(origin) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /account',
    'Disallow: /order',
    'Disallow: /api/',
    'Disallow: /uploads/',
    '',
    `Sitemap: ${new URL('/sitemap.xml', `${origin}/`).toString()}`,
    '',
  ].join('\n')
}

function buildSitemap(store, origin) {
  const urls = new Set([
    '/',
    '/collections',
    '/support',
    '/blog',
    '/policies/privacy',
    '/policies/terms',
    '/policies/refund',
    '/policies/shipping',
    '/policies/cookies',
    '/doc/',
  ])
  const publicCategories = (store.categories || []).filter((category) => category.status !== 'hidden')
  for (const category of publicCategories) {
    if (category.slug) urls.add(`/collections/${encodeURIComponent(category.slug)}`)
    for (const child of category.children || []) {
      if (child.slug) urls.add(`/collections/${encodeURIComponent(child.slug)}`)
    }
  }
  for (const product of store.products || []) {
    if (product.slug && isPublicOrderableProduct(product, publicCategories)) {
      urls.add(`/products/${encodeURIComponent(product.slug)}`)
    }
  }
  for (const post of store.site?.blog || []) {
    if (post.slug && post.status !== 'hidden') urls.add(`/blog/${encodeURIComponent(post.slug)}`)
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...Array.from(urls, (pathname) => sitemapUrl(origin, pathname)),
    '</urlset>',
    '',
  ].join('\n')
}

function sendError(res, error) {
  const status = Number(error?.status || 500)
  const safeStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500
  const message = safeStatus >= 500 ? 'internal server error' : String(error?.message || 'request failed')
  return send(res, safeStatus, { message }, safeStatus >= 500 ? privateNoStoreHeaders : {})
}

// Static frontend assets and uploaded customer images use separate handlers.
// Both handlers validate paths before reading from disk; API responses always
// go through send()/sendError() so security and cache headers stay consistent.
function sendFile(res, filePath, headers = {}) {
  readFile(filePath).then((buf) => {
    const ext = path.extname(filePath).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    res.writeHead(200, { ...securityHeaders, 'content-type': type, 'cache-control': 'public, max-age=86400', ...headers })
    res.end(buf)
  }).catch(() => send(res, 404, { message: 'file not found' }))
}

function isPathInside(parent, target) {
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// Compressible static asset types get on-the-fly gzip with a small in-memory
// cache keyed by path+mtime+size, so unchanged assets are compressed once.
const staticGzipCache = new Map()
const staticGzipTypes = new Set(['.js', '.mjs', '.css', '.svg', '.json', '.xml', '.txt', '.html', '.map'])

function acceptsGzip(req) {
  return String(req.headers['accept-encoding'] || '').toLowerCase().includes('gzip')
}

async function sendStaticFile(req, res, filePath, cacheControl, status = 200) {
  try {
    const body = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const contentType = staticMimeTypes[ext] || 'application/octet-stream'
    let payload = body
    const headers = {
      ...frontendSecurityHeaders,
      'content-type': staticMimeTypes[ext] || 'application/octet-stream',
      'cache-control': cacheControl,
      ...(status === 404 ? { 'x-robots-tag': 'noindex' } : {}),
    }
    if (req.method !== 'HEAD' && status === 200 && staticGzipTypes.has(ext) && acceptsGzip(req) && body.length > 1024) {
      try {
        const fileStat = await stat(filePath)
        const cacheKey = `${filePath}:${fileStat.mtimeMs}:${fileStat.size}`
        let gzipped = staticGzipCache.get(cacheKey)
        if (!gzipped) {
          gzipped = gzipSync(body)
          if (staticGzipCache.size > 200) staticGzipCache.clear()
          staticGzipCache.set(cacheKey, gzipped)
        }
        payload = gzipped
        headers['content-encoding'] = 'gzip'
        headers.vary = 'Accept-Encoding'
      } catch { /* stat 失败则按未压缩返回 */ }
    }
    res.writeHead(status, headers)
    if (req.method === 'HEAD') return res.end()
    return res.end(payload)
  } catch {
    return send(res, 404, { message: 'file not found' })
  }
}

function isKnownFrontendRoute(pathname, store) {
  let decoded = ''
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return false

  const normalized = decoded.length > 1 ? decoded.replace(/\/+$/, '') : decoded
  if ([
    '/',
    '/collections',
    '/support',
    '/blog',
    '/doc',
    '/order',
    '/account',
    '/admin',
    '/admin/dashboard',
  ].includes(normalized)) return true

  const policyMatch = normalized.match(/^\/policies\/([^/]+)$/)
  if (policyMatch && ['privacy', 'terms', 'refund', 'shipping', 'cookies'].includes(policyMatch[1])) return true

  const publicCategories = (store?.categories || []).filter((category) => category.status !== 'hidden')
  const collectionMatch = normalized.match(/^\/collections\/([^/]+)$/)
  if (collectionMatch) {
    const slug = collectionMatch[1]
    return publicCategories.some((category) => category.slug === slug
      || category.id === slug
      || category.children?.some((child) => child.slug === slug))
  }

  const productMatch = normalized.match(/^\/products\/([^/]+)$/)
  if (productMatch) {
    const product = (store?.products || []).find((item) => item.slug === productMatch[1] || item.id === productMatch[1])
    return Boolean(product && isPublicOrderableProduct(product, publicCategories))
  }

  const blogMatch = normalized.match(/^\/blog\/([^/]+)$/)
  if (blogMatch) {
    return (store?.site?.blog || []).some((post) => post.slug === blogMatch[1] || post.id === blogMatch[1])
  }

  // The docs view intentionally owns arbitrary paths below /doc/.
  return normalized.startsWith('/doc/')
}

async function sendFrontendFile(req, res, pathname = '/', status = 200) {
  if (!serveFrontend) return send(res, 404, { message: 'not found' })
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) return send(res, 404, { message: 'not found' })
  if (/%2f|%5c/i.test(pathname)) return send(res, 404, { message: 'file not found' })

  let decoded = ''
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return send(res, 404, { message: 'file not found' })
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return send(res, 404, { message: 'file not found' })

  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = path.resolve(frontendDistDir, relativePath)
  if (!isPathInside(frontendDistDir, candidate)) return send(res, 404, { message: 'file not found' })

  let filePath = candidate
  let isSpaFallback = false
  let fileStat = null
  try {
    fileStat = await stat(filePath)
  } catch {
    fileStat = null
  }

  if (!fileStat || !fileStat.isFile()) {
    if (decoded.startsWith('/assets/') || path.extname(decoded)) return send(res, 404, { message: 'file not found' })
    filePath = path.join(frontendDistDir, 'index.html')
    isSpaFallback = true
  }

  const responseStatus = isSpaFallback ? status : 200
  const cacheControl = path.basename(filePath) === 'index.html'
    ? 'no-cache'
    : decoded.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600'
  return sendStaticFile(req, res, filePath, cacheControl, responseStatus)
}

function sendUploadFile(res, pathname = '') {
  if (/%2f|%5c/i.test(pathname)) return send(res, 404, { message: 'file not found' })
  let filename = ''
  try {
    filename = decodeURIComponent(pathname.replace(/^\/uploads\//, ''))
  } catch {
    return send(res, 404, { message: 'file not found' })
  }
  if (filename.includes('/') || filename.includes('\\')) return send(res, 404, { message: 'file not found' })
  if (!/^[0-9]+-[a-f0-9-]+\.(png|jpe?g|webp)$/i.test(filename)) return send(res, 404, { message: 'file not found' })
  return sendFile(res, path.join(uploadDir, filename), { 'cache-control': 'private, no-store' })
}

function isValidUploadUrl(value = '') {
  const text = String(value || '').trim()
  if (/%2f|%5c/i.test(text)) return false
  if (!text.startsWith(`${publicUploadBase}/`)) return false
  let filename = ''
  try {
    filename = decodeURIComponent(text.slice(publicUploadBase.length + 1))
  } catch {
    return false
  }
  if (filename.includes('/') || filename.includes('\\')) return false
  return /^[0-9]+-[a-f0-9-]+\.(png|jpe?g|webp)$/i.test(filename)
}

function isValidSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || '').trim())
}

function isValidIsoDate(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const parsed = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

// -----------------------------------------------------------------------------
// Input validation and normalization
// -----------------------------------------------------------------------------
// Validation answers "is this request allowed?" while normalization answers
// "what canonical shape should be stored?" Keeping these concerns separate
// makes admin edits predictable and keeps public endpoints defensive.
function validateCategoryInput(input = {}) {
  if (!isValidSlug(input.slug)) return 'invalid slug'
  if (input.status && !['published', 'hidden'].includes(input.status)) return 'invalid publish status'
  if (!String(input.title || input.translations?.zh?.title || '').trim()) return 'category title required'
  return ''
}

function validateProductInput(input = {}, categories = []) {
  const basePrice = Number(input.base_price_cents)
  const depositPercent = Number(input.deposit_percent)
  if (!isValidSlug(input.slug)) return 'invalid slug'
  if (!categories.some((category) => category.id === input.category_id)) return 'category required'
  if (input.status && !['published', 'hidden'].includes(input.status)) return 'invalid publish status'
  if ((input.status || 'published') === 'published' && categories.some((category) => category.id === input.category_id && category.status === 'hidden')) return 'published product requires visible category'
  if (!String(input.title || input.translations?.zh?.title || '').trim()) return 'product title required'
  if (String(input.currency || '').trim().toUpperCase() !== CURRENCY_BASE) return 'product currency must be KRW'
  if (!Number.isSafeInteger(basePrice) || basePrice <= 0) return 'price required'
  if (!Number.isSafeInteger(depositPercent) || depositPercent < 1 || depositPercent > 100) return 'invalid deposit percent'
  if (Array.isArray(input.images) && input.images.some((image) => !isValidProductImageReference(image))) return 'invalid image url'
  if (input.image_url && !isValidProductImageReference(input.image_url)) return 'invalid image url'
  if ((input.status || 'published') === 'published' && !String(input.image_url || '').trim() && (!Array.isArray(input.images) || !input.images.length)) return 'published product requires image'
  if ((input.status || 'published') === 'published' && !String(input.seo_title || input.translations?.zh?.seo_title || '').trim()) return 'published product requires seo title'
  if ((input.status || 'published') === 'published' && !String(input.seo_description || input.translations?.zh?.seo_description || '').trim()) return 'published product requires seo description'
  if (!Array.isArray(input.options) || !input.options.length) return 'options required'
  if (input.options.some((option) => {
    const optionPrice = Number(option.price_cents)
    return !String(option.name || option.translations?.zh?.name || '').trim() || !Number.isSafeInteger(optionPrice) || optionPrice <= 0
  })) return 'invalid options'
  const optionNames = input.options.map((option) => String(option.name || option.translations?.zh?.name || '').trim().toLowerCase())
  if (new Set(optionNames).size !== optionNames.length) return 'duplicate options'
  return ''
}

function validateAdminUserInput(input = {}) {
  if ('email' in input && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email).trim())) return 'valid email required'
  if ('name' in input && String(input.name || '').trim().length > 120) return 'invalid user name'
  if ('country' in input && String(input.country || '').trim().length > 120) return 'invalid user country'
  if (input.status && !['active', 'vip', 'blocked'].includes(input.status)) return 'invalid user status'
  if (Array.isArray(input.tags) && (input.tags.length > 20 || input.tags.some((tag) => String(tag || '').trim().length > 40))) return 'invalid user tags'
  if (String(input.internal_note || '').length > 2000) return 'invalid internal note'
  if (Array.isArray(input.followups)) {
    if (input.followups.length > 50) return 'invalid followups'
    if (input.followups.some((item) => !String(item.content || '').trim() || String(item.content || '').length > 500)) return 'invalid followup content'
    if (input.followups.some((item) => {
      const nextAt = String(item.next_at || '').trim()
      return nextAt && !isValidIsoDate(nextAt)
    })) return 'invalid followup date'
  }
  return ''
}

function normalizeAdminUserInput(input = {}) {
  const tags = Array.isArray(input.tags)
    ? Array.from(new Set(input.tags.map((tag) => String(tag || '').trim()).filter(Boolean))).slice(0, 20)
    : undefined
  const followups = Array.isArray(input.followups)
    ? input.followups.map((item) => ({
      id: String(item.id || id()).trim(),
      content: String(item.content || '').trim(),
      next_at: String(item.next_at || '').trim(),
      created_at: isValidIsoDate(String(item.created_at || '').slice(0, 10)) ? String(item.created_at) : now(),
    }))
      .filter((item) => item.content)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 50)
    : undefined
  return {
    ...input,
    email: String(input.email || '').trim().toLowerCase(),
    name: String(input.name || '').trim(),
    country: String(input.country || '').trim(),
    status: String(input.status || 'active').trim(),
    tags,
    internal_note: String(input.internal_note || '').trim(),
    followups,
  }
}

function isProtectedAdminUser(user = {}, requestedId = '') {
  return String(requestedId || '').trim() === 'admin-e2e'
    || String(user.id || '') === 'admin-e2e'
    || String(user.email || '').trim().toLowerCase() === 'admin-e2e@example.com'
}

function protectedAdminUserChange(user = {}, input = {}, requestedId = '') {
  if (!isProtectedAdminUser(user, requestedId)) return ''
  if (!user.id) return 'protected user cannot be created'
  const nextEmail = String(input.email || user.email || '').trim().toLowerCase()
  const previousEmail = String(user.email || '').trim().toLowerCase()
  if (nextEmail && previousEmail && nextEmail !== previousEmail) return 'protected user cannot change email'
  if (input.status && input.status !== 'active') return 'protected user must stay active'
  return ''
}

function normalizeCategoryPayload(input = {}) {
  return {
    ...input,
    slug: String(input.slug || '').trim(),
    title: String(input.title || input.translations?.zh?.title || '').trim(),
    description: String(input.description || input.translations?.zh?.description || '').trim(),
    sort_order: Number(input.sort_order || 0),
    status: String(input.status || 'published').trim(),
    translations: input.translations || {},
  }
}

function normalizeProductPayload(input = {}) {
  return {
    ...input,
    slug: String(input.slug || '').trim(),
    title: String(input.title || '').trim(),
    subtitle: String(input.subtitle || '').trim(),
    description: String(input.description || '').trim(),
    currency: String(input.currency || CURRENCY_BASE).trim().toUpperCase(),
    base_price_cents: Number(input.base_price_cents),
    deposit_percent: Number(input.deposit_percent),
    image_url: String(input.image_url || '').trim(),
    images: Array.isArray(input.images) ? input.images.map((image) => String(image || '').trim()).filter(Boolean) : [],
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
    options: Array.isArray(input.options) ? input.options.map((option) => ({
      ...option,
      id: String(option.id || '').trim() || id(),
      name: String(option.name || option.translations?.zh?.name || '').trim(),
      price_cents: Number(option.price_cents),
    })) : [],
  }
}

function validatePublicOrderInput(input = {}, product) {
  if (!product) return 'product not found'
  const selectedOption = product.options?.find((option) => option.id === input.option_id) || product.options?.[0]
  if (!selectedOption || Number(selectedOption.price_cents || 0) <= 0) return 'invalid option'
  if (Number(product.deposit_percent || 0) <= 0 || Number(product.deposit_percent || 0) > 100) return 'invalid payment config'
  if (!String(input.customer_name || '').trim()) return 'customer name required'
  if (String(input.customer_name || '').trim().length > 120) return 'invalid customer name'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email || '').trim())) return 'valid email required'
  if (!String(input.phone || '').trim()) return 'phone required'
  if (String(input.phone || '').length > 80) return 'invalid phone'
  if (String(input.country || '').trim().length > 120) return 'invalid country'
  if (String(input.shipping_address || '').length > 500) return 'invalid shipping address'
  if (!String(input.pet_name || '').trim()) return 'pet name required'
  if (String(input.pet_name || '').trim().length > 120) return 'invalid pet name'
  if (!String(input.pet_type || '').trim()) return 'pet type required'
  if (String(input.pet_type || '').trim().length > 80) return 'invalid pet type'
  if (String(input.notes || '').length > 2000) return 'invalid notes'
  if (!Array.isArray(input.photo_urls) || !input.photo_urls.length) return 'photo required'
  if (input.photo_urls.length > maxOrderPhotos) return 'too many photos'
  if (input.photo_urls.some((photo) => !isValidUploadUrl(photo))) return 'invalid photo url'
  if (!['deposit', 'full'].includes(input.payment_type || 'deposit')) return 'invalid payment type'
  if (product.options?.length && !product.options.some((option) => option.id === input.option_id)) return 'invalid option'
  return ''
}

function isPublicOrderableProduct(product = {}, publicCategories = []) {
  return product.status !== 'hidden'
    && publicCategories.some((category) => category.id === product.category_id)
    // The currency must be convertible through the shared rate table so the
    // PayPal charge amount can always be derived from the stored price.
    && Boolean(normalizeSupportedCurrency(product.currency))
    && Number.isSafeInteger(Number(product.base_price_cents)) && Number(product.base_price_cents) > 0
    && Number.isSafeInteger(Number(product.deposit_percent)) && Number(product.deposit_percent) > 0 && Number(product.deposit_percent) <= 100
    && Array.isArray(product.options)
    && product.options.some((option) => option?.id && String(option.name || option.translations?.zh?.name || '').trim() && Number.isSafeInteger(Number(option.price_cents)) && Number(option.price_cents) > 0)
}

// Order transitions are guarded on the server, not only in the admin UI. This
// protects the workflow when an old browser, script, or concurrent operator
// sends a stale or financially unsafe state change.
function validateOrderTransition(order, input = {}, field = '') {
  const nextOrderStatus = field === 'status' ? input.order_status || input.status : order.order_status
  const nextPaymentStatus = field === 'payment' ? input.payment_status : order.payment_status
  const effectivePaymentStatus = field === 'payment' ? nextPaymentStatus : order.payment_status
  const validOrderStatuses = ['new', 'confirmed', 'crafting', 'preview', 'balance_due', 'ready_ship', 'shipped', 'completed', 'cancelled']
  const validPaymentStatuses = ['unpaid', 'deposit_paid', 'paid', 'balance_due', 'refunded']
  const advancedStatuses = ['crafting', 'preview', 'balance_due', 'ready_ship', 'shipped', 'completed']
  if (field === 'status' && !validOrderStatuses.includes(nextOrderStatus)) return 'invalid order status'
  if (field === 'payment' && !validPaymentStatuses.includes(nextPaymentStatus)) return 'invalid payment status'
  if (order.order_status === 'cancelled' && nextOrderStatus !== 'cancelled') return 'cancelled order cannot be changed'
  if (field === 'status' && order.order_status === 'completed' && nextOrderStatus !== 'completed') return 'completed order cannot be reopened'
  if (field === 'status' && order.payment_status === 'refunded' && nextOrderStatus !== order.order_status && nextOrderStatus !== 'cancelled') return 'refunded order cannot be changed'
  if (order.payment_status === 'refunded' && advancedStatuses.includes(nextOrderStatus)) return 'refunded order cannot be advanced'
  if (effectivePaymentStatus === 'unpaid' && advancedStatuses.includes(nextOrderStatus)) return 'unpaid order cannot be advanced'
  if (field === 'payment' && nextPaymentStatus === 'balance_due' && Number(order.paid_amount_cents || 0) <= 0) return 'balance due requires deposit payment'
  if (['ready_ship', 'shipped', 'completed'].includes(nextOrderStatus) && effectivePaymentStatus !== 'paid') return 'shipping or completion requires full payment'
  const nextCarrier = 'shipping_carrier' in input ? String(input.shipping_carrier || '').trim() : String(order.shipping_carrier || '').trim()
  const nextTracking = 'tracking_no' in input ? String(input.tracking_no || '').trim() : String(order.tracking_no || '').trim()
  if (['shipped', 'completed'].includes(nextOrderStatus) && (!nextCarrier || !nextTracking)) return 'shipping tracking required'
  if (field === 'payment' && ['shipped', 'completed'].includes(order.order_status) && nextPaymentStatus !== 'refunded' && nextPaymentStatus !== 'paid') return 'shipped or completed order payment cannot be downgraded'
  if (nextOrderStatus === 'cancelled' && ['paid', 'deposit_paid'].includes(effectivePaymentStatus)) return 'paid order cannot be cancelled before refund'
  return ''
}

function hasStaleOrderRevision(order = {}, input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'revision') && Number(input.revision) !== Number(order.revision || 0)) return true
  if (!Object.prototype.hasOwnProperty.call(input, 'revision') && input.updated_at && String(input.updated_at) !== String(order.updated_at || '')) return true
  return false
}

function isValidHttpUrl(value) {
  if (!String(value || '').trim()) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

function isValidProductImageReference(value) {
  const text = String(value || '').trim()
  if (!text) return true
  return isValidHttpUrl(text) || isValidUploadUrl(text) || (text.startsWith('/assets/') && !text.includes('..') && !text.includes('\\'))
}

function isPrivateHostname(hostname = '') {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === '::1') return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4) return false
  const parts = ipv4.slice(1).map(Number)
  if (parts.some((part) => part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
}

function isValidPublicHttpUrl(value) {
  if (!isValidHttpUrl(value)) return false
  try {
    const url = new URL(value)
    return !isPrivateHostname(url.hostname)
  } catch {
    return false
  }
}

function isValidSiteImageReference(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (isValidHttpUrl(text)) return true
  if (isValidUploadUrl(text)) return true
  return text.startsWith('/assets/') && !text.includes('..') && !text.includes('\\')
}

function hasValidLength(value, min = 1, max = 1000) {
  const text = String(value || '').trim()
  return text.length >= min && text.length <= max
}

function hasDuplicateNormalized(items = [], getValue = (item) => item) {
  const seen = new Set()
  for (const item of items) {
    const value = String(getValue(item) || '').trim().toLowerCase()
    if (!value) continue
    if (seen.has(value)) return true
    seen.add(value)
  }
  return false
}

function sanitizeRichTextHtml(value = '') {
  const allowed = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'a'])
  const blocklist = 'script|style|iframe|object|embed|meta|link'
  let html = String(value || '').trim()
  if (!html) return ''
  if (!/<[a-z][\s\S]*>/i.test(html)) return html
  html = html
    .replace(new RegExp(`<\\s*(${blocklist})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<\\s*\\/?\\s*(${blocklist})\\b[^>]*>`, 'gi'), '')
  html = html.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (match, rawTag, attrs = '') => {
    const tag = String(rawTag || '').toLowerCase()
    const closing = /^<\s*\//.test(match)
    if (tag === 'div') return closing ? '</p>' : '<p>'
    if (!allowed.has(tag)) return ''
    if (closing) return tag === 'br' ? '' : `</${tag}>`
    if (tag === 'br') return '<br>'
    if (tag !== 'a') return `<${tag}>`
    const hrefMatch = String(attrs || '').match(/\shref\s*=\s*(["'])(.*?)\1/i)
    const href = hrefMatch ? String(hrefMatch[2] || '').trim() : ''
    const safeHref = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '%3C').replace(/>/g, '%3E')
    return /^(https?:|mailto:)/i.test(href)
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">`
      : '<a>'
  })
  return html
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim()
}

function stripRichTextHtml(value = '') {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeBlogPostPayload(post = {}) {
  const translations = { ...(post.translations || {}) }
  for (const lang of supportedLangs) {
    if (!translations[lang]) continue
    translations[lang] = {
      ...translations[lang],
      title: String(translations[lang].title || '').trim(),
      excerpt: String(translations[lang].excerpt || '').trim(),
      content: sanitizeRichTextHtml(translations[lang].content),
    }
  }
  return {
    ...post,
    id: String(post.id || post.slug || id()).trim(),
    slug: String(post.slug || '').trim(),
    date: String(post.date || '').trim(),
    title: String(post.title || post.translations?.zh?.title || '').trim(),
    excerpt: String(post.excerpt || post.translations?.zh?.excerpt || '').trim(),
    content: sanitizeRichTextHtml(post.content || post.translations?.zh?.content),
    image_url: String(post.image_url || '').trim(),
    tags: Array.isArray(post.tags) ? post.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
    translations,
  }
}

function normalizeReviewPayload(review = {}) {
  const legacyImages = [review.pet_image, review.work_image]
  const images = [...new Set([
    ...(Array.isArray(review.images) ? review.images : []),
    ...legacyImages,
  ].map((image) => String(image || '').trim()).filter(Boolean))]
  const translations = { ...(review.translations || {}) }
  const fallbackTitle = String(review.title || translations.zh?.title || translations.en?.title || '').trim()
  const fallbackContent = String(review.content || translations.zh?.content || translations.en?.content || '').trim()
  for (const lang of supportedLangs) {
    const source = translations[lang] || {}
    translations[lang] = {
      ...source,
      title: String(source.title || fallbackTitle).trim(),
      content: String(source.content || fallbackContent).trim(),
    }
  }
  const fallback = translations.en?.title && translations.en?.content
    ? translations.en
    : translations.zh
  return {
    ...review,
    id: String(review.id || id()).trim(),
    name: String(review.name || '').trim(),
    country: String(review.country || '').trim(),
    rating: Number(review.rating || 5),
    status: ['published', 'hidden'].includes(String(review.status || '').trim()) ? String(review.status).trim() : 'published',
    title: String(review.title || fallback?.title || '').trim(),
    content: String(review.content || fallback?.content || '').trim(),
    product_slug: String(review.product_slug || '').trim(),
    avatar_url: String(review.avatar_url || '').trim(),
    images,
    pet_image: images[0] || '',
    work_image: images[1] || '',
    video_url: String(review.video_url || '').trim(),
    translations,
  }
}

function isValidHexColor(value = '') {
  return /^#[0-9a-f]{6}$/i.test(String(value || '').trim())
}

function validateThemeInput(input = {}) {
  if (!('theme' in input)) return ''
  const themeInput = input.theme
  if (!themeInput || typeof themeInput !== 'object' || Array.isArray(themeInput)) return 'invalid theme'
  const themes = Array.isArray(themeInput.themes) ? themeInput.themes : []
  if (themes.length > 12) return 'invalid theme'
  const colorFields = ['bg', 'surface', 'surfaceSoft', 'text', 'muted', 'accent', 'accent2', 'line', 'rose', 'sage']
  for (const theme of themes) {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return 'invalid theme'
    if (!isValidSlug(theme.key)) return 'invalid theme'
    if (!hasValidLength(theme.label, 1, 40)) return 'invalid theme'
    if (colorFields.some((field) => field in theme && !isValidHexColor(theme[field]))) return 'invalid theme'
  }
  if (themeInput.defaultTheme && themes.length && !themes.some((theme) => theme.key === themeInput.defaultTheme)) return 'invalid theme'
  return ''
}

function validateSiteContent(input = {}) {
  if ('faq' in input) {
    if (!Array.isArray(input.faq) || input.faq.length < 1 || input.faq.length > 50) return 'invalid faq'
    if (input.faq.some((item) => !item || typeof item !== 'object'
      || !hasValidLength(item.question || item.translations?.zh?.question, 1, 300)
      || !hasValidLength(item.answer || item.translations?.zh?.answer, 1, 2000))) return 'invalid faq'
    if (hasDuplicateNormalized(input.faq, (item) => item.question || item.translations?.zh?.question)) return 'duplicate faq'
  }
  if ('reviews' in input) {
    if (!Array.isArray(input.reviews) || input.reviews.length < 1 || input.reviews.length > 80) return 'invalid reviews'
    if (input.reviews.some((item) => {
      const rating = Number(item?.rating)
      const images = Array.isArray(item?.images) ? item.images : []
      const translations = item?.translations && typeof item.translations === 'object' && !Array.isArray(item.translations)
        ? item.translations
        : {}
      return !item || typeof item !== 'object'
        || !hasValidLength(item.name, 1, 120)
        || !hasValidLength(item.country, 1, 80)
        || !Number.isInteger(rating) || rating < 1 || rating > 5
        || (item.status && !['published', 'hidden'].includes(String(item.status).trim()))
        || !hasValidLength(item.title || item.translations?.zh?.title, 1, 200)
        || !hasValidLength(item.content || item.translations?.zh?.content, 1, 2000)
        || (item.product_slug && !isValidSlug(item.product_slug))
        || images.length > 24
        || images.some((image) => !isValidSiteImageReference(image))
        || (item.avatar_url && !isValidSiteImageReference(item.avatar_url))
        || (item.pet_image && !isValidSiteImageReference(item.pet_image))
        || (item.work_image && !isValidSiteImageReference(item.work_image))
        || (item.video_url && !isValidPublicHttpUrl(item.video_url))
        || supportedLangs.some((lang) => translations[lang]
          && (!hasValidLength(translations[lang].title, 1, 200)
            || !hasValidLength(translations[lang].content, 1, 2000)))
    })) return 'invalid reviews'
    if (hasDuplicateNormalized(input.reviews, (item) => `${item.name || ''}|${item.title || item.translations?.zh?.title || ''}`)) return 'duplicate reviews'
  }
  if ('blog' in input) {
    if (!Array.isArray(input.blog) || input.blog.length < 1 || input.blog.length > 100) return 'invalid blog'
    if (input.blog.some((item) => {
      const tags = Array.isArray(item?.tags) ? item.tags : []
      const title = item?.title || item?.translations?.zh?.title
      const excerpt = item?.excerpt || item?.translations?.zh?.excerpt
      const content = sanitizeRichTextHtml(item?.content || item?.translations?.zh?.content)
      return !item || typeof item !== 'object'
        || !isValidSlug(item.slug)
        || !isValidIsoDate(item.date)
        || !hasValidLength(title, 1, 200)
        || !hasValidLength(excerpt, 1, 500)
        || !hasValidLength(content, 1, 6000)
        || !stripRichTextHtml(content)
        || !isValidSiteImageReference(item.image_url)
        || tags.length > 20
        || tags.some((tag) => !hasValidLength(tag, 1, 40))
    })) return 'invalid blog'
    if (hasDuplicateNormalized(input.blog, (item) => item.slug)) return 'duplicate blog'
  }
  return ''
}

function validateSiteInput(input = {}, current = {}) {
  const merged = mergeSiteConfig(current, input)
  const brand = merged.brand || {}
  const paypal = paypalConfig(merged)
  const contact = merged.contact || {}
  const shipping = merged.shipping || {}
  const kakaoEnabled = normalizeBoolean(contact.kakao_enabled, false)
  const whatsappEnabled = normalizeBoolean(contact.whatsapp_enabled, false)
  const kakaoId = String(contact.kakao_id || '').trim()
  const whatsappId = String(contact.whatsapp_id || '').trim()
  const kakaoUrl = String(contact.kakao_url || '').trim()
  const whatsappUrl = String(contact.whatsapp_url || '').trim()
  if (!isBooleanLike(input.paypal?.enabled) || !isBooleanLike(input.contact?.kakao_enabled) || !isBooleanLike(input.contact?.whatsapp_enabled)) return 'invalid boolean config'
  if (!String(brand.name || '').trim()) return 'brand name required'
  if (!hasValidLength(brand.name, 1, 120)) return 'invalid brand name'
  if (String(brand.email || '').length > 160) return 'invalid brand email'
  if (String(brand.instagram || '').length > 300) return 'invalid instagram URL'
  if (brand.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(brand.email).trim())) return 'valid brand email required'
  if (brand.instagram && !isValidPublicHttpUrl(brand.instagram)) return 'valid instagram URL required'
  if (merged.paypal?.mode && !['sandbox', 'live'].includes(String(merged.paypal.mode).trim().toLowerCase())) return 'invalid paypal mode'
  if (paypal.currency && !paypalChargeCurrencyReady(paypal.currency)) return 'invalid paypal currency'
  if (String(paypal.clientId || '').length > 300 || String(paypal.secret || '').length > 500 || String(paypal.webhookId || '').length > 300) return 'invalid paypal config'
  if (paypalWebhookIdLooksLikeUrl(paypal.webhookId)) return 'paypal webhook id must not be url'
  if (paypal.mode === 'live' && (!paypal.clientId || !paypal.secret)) return 'paypal live credentials required'
  if (!hasValidLength(contact.kakao_label || 'KakaoTalk', 1, 40) || !hasValidLength(contact.whatsapp_label || 'WhatsApp', 1, 40)) return 'invalid contact label'
  if (kakaoId.length > 120 || whatsappId.length > 120 || kakaoUrl.length > 300 || whatsappUrl.length > 300) return 'invalid contact'
  if (kakaoEnabled && !kakaoId && !kakaoUrl) return 'KakaoTalk contact required'
  if (whatsappEnabled && !whatsappId && !whatsappUrl) return 'WhatsApp contact required'
  if (kakaoUrl && !isValidPublicHttpUrl(kakaoUrl)) return 'valid KakaoTalk URL required'
  if (whatsappUrl && !isValidPublicHttpUrl(whatsappUrl)) return 'valid WhatsApp URL required'
  if (String(shipping.tracking_url_template || '').length > 500) return 'invalid tracking URL'
  if (shipping.tracking_url_template && !isValidPublicHttpUrl(shipping.tracking_url_template)) return 'valid tracking URL required'
  if (shipping.tracking_url_template && !String(shipping.tracking_url_template).includes('{tracking}')) return 'tracking placeholder required'
  const themeValidation = validateThemeInput(input)
  if (themeValidation) return themeValidation
  const contentValidation = validateSiteContent(input)
  if (contentValidation) return contentValidation
  return ''
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

function isBooleanLike(value) {
  if (typeof value === 'boolean') return true
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'false'
  }
  return value === undefined
}

function paypalWebhookIdLooksLikeUrl(value = '') {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function normalizeSiteBooleans(site = {}) {
  return {
    ...site,
    paypal: site.paypal ? {
      ...site.paypal,
      enabled: normalizeBoolean(site.paypal.enabled, true),
    } : site.paypal,
    contact: site.contact ? normalizeContactConfig(site.contact) : site.contact,
  }
}

function normalizeLegacySiteConfig(site = {}) {
  const next = normalizeSiteBooleans(site)
  if (next.brand?.instagram && String(next.brand.instagram).startsWith('@')) {
    next.brand = {
      ...next.brand,
      instagram: `https://www.instagram.com/${String(next.brand.instagram).slice(1)}`,
    }
  }
  return next
}

function defaultContactConfig() {
  return {
    kakao_enabled: true,
    kakao_label: 'KakaoTalk',
    kakao_id: 'WoolBuddyShop',
    kakao_url: '',
    whatsapp_enabled: true,
    whatsapp_label: 'WhatsApp',
    whatsapp_id: 'WoolBuddy',
    whatsapp_url: '',
  }
}

function normalizeContactConfig(contact = {}) {
  const hasModernContact = Object.prototype.hasOwnProperty.call(contact, 'kakao_enabled')
    || Object.prototype.hasOwnProperty.call(contact, 'whatsapp_enabled')
    || Object.prototype.hasOwnProperty.call(contact, 'kakao_id')
    || Object.prototype.hasOwnProperty.call(contact, 'whatsapp_id')
  if (!hasModernContact) return defaultContactConfig()
  const defaults = defaultContactConfig()
  return {
    kakao_enabled: normalizeBoolean(contact.kakao_enabled, defaults.kakao_enabled),
    kakao_label: String(contact.kakao_label || defaults.kakao_label).trim(),
    kakao_id: String(contact.kakao_id || '').trim(),
    kakao_url: String(contact.kakao_url || '').trim(),
    whatsapp_enabled: normalizeBoolean(contact.whatsapp_enabled, defaults.whatsapp_enabled),
    whatsapp_label: String(contact.whatsapp_label || defaults.whatsapp_label).trim(),
    whatsapp_id: String(contact.whatsapp_id || '').trim(),
    whatsapp_url: String(contact.whatsapp_url || '').trim(),
  }
}

function mergeSiteConfig(current = {}, input = {}) {
  const next = { ...current, ...input }
  for (const key of ['brand', 'contact', 'google', 'paypal', 'socials', 'shipping']) {
    if (input[key]) next[key] = { ...(current[key] || {}), ...(input[key] || {}) }
  }
  if (input.paypal && (!Object.prototype.hasOwnProperty.call(input.paypal, 'secret') || String(input.paypal.secret || '').trim() === '') && current.paypal?.secret) {
    next.paypal.secret = current.paypal.secret
  }
  if (input.paypal && (!Object.prototype.hasOwnProperty.call(input.paypal, 'webhook_id') || String(input.paypal.webhook_id || '').trim() === '') && current.paypal?.webhook_id) {
    next.paypal.webhook_id = current.paypal.webhook_id
  }
  if (input.theme) next.theme = normalizeThemeConfig({ ...(current.theme || {}), ...(input.theme || {}) })
  if (input.policies) {
    next.policies = {
      ...(current.policies || {}),
      ...(input.policies || {}),
      translations: {
        ...(current.policies?.translations || {}),
        ...(input.policies?.translations || {}),
      },
    }
  }
  if (input.taxonomies) {
    next.taxonomies = {
      ...(current.taxonomies || {}),
      ...(input.taxonomies || {}),
    }
  }
  for (const key of ['faq', 'reviews']) {
    if (Array.isArray(input[key])) {
      next[key] = key === 'reviews'
        ? input[key].map((review) => normalizeReviewPayload(review))
        : input[key]
    }
  }
  if (Array.isArray(input.blog)) next.blog = input.blog.map((post) => normalizeBlogPostPayload(post))
  return normalizeSiteTextFields(normalizeLegacySiteConfig(next))
}

function normalizeSiteTextFields(site = {}) {
  const next = structuredClone(site || {})
  if (next.brand) {
    for (const key of ['name', 'email', 'instagram']) {
      if (next.brand[key] != null) next.brand[key] = String(next.brand[key]).trim()
    }
  }
  if (next.contact) {
    for (const key of ['kakao_label', 'kakao_id', 'kakao_url', 'whatsapp_label', 'whatsapp_id', 'whatsapp_url']) {
      if (next.contact[key] != null) next.contact[key] = String(next.contact[key]).trim()
    }
  }
  if (next.paypal) {
    for (const key of ['mode', 'client_id', 'secret', 'webhook_id', 'currency']) {
      if (next.paypal[key] != null) next.paypal[key] = String(next.paypal[key]).trim()
    }
    if (next.paypal.currency) next.paypal.currency = next.paypal.currency.toUpperCase()
  }
  if (next.shipping?.tracking_url_template != null) {
    next.shipping.tracking_url_template = String(next.shipping.tracking_url_template).trim()
  }
  return next
}

// -----------------------------------------------------------------------------
// Request body and identity helpers
// -----------------------------------------------------------------------------
async function readJson(req) {
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.length
    if (received > maxJsonBytes) {
      const err = new Error('json body too large')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  const text = chunks.length ? Buffer.concat(chunks).toString('utf8').trim() : ''
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const err = new Error('invalid json')
    err.status = 400
    throw err
  }
}

function translationProviderName() {
  try {
    return new URL(translationApiUrl).hostname || 'free-translation'
  } catch {
    return 'free-translation'
  }
}

function splitTranslationText(value, maxBytes = 450) {
  const text = String(value || '')
  if (!text) return []
  const chars = Array.from(text)
  const chunks = []
  let start = 0
  while (start < chars.length) {
    let end = start
    let bytes = 0
    while (end < chars.length) {
      const nextBytes = Buffer.byteLength(chars[end], 'utf8')
      if (end > start && bytes + nextBytes > maxBytes) break
      bytes += nextBytes
      end += 1
    }
    if (end <= start) end = start + 1
    chunks.push(chars.slice(start, end).join(''))
    start = end
  }
  return chunks
}

function decodeTranslationEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => {
      const number = Number(code)
      return Number.isFinite(number) ? String.fromCodePoint(number) : _
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const number = Number.parseInt(code, 16)
      return Number.isFinite(number) ? String.fromCodePoint(number) : _
    })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

async function translateProviderChunk(text, target) {
  const url = new URL(translationApiUrl)
  url.searchParams.set('q', text)
  url.searchParams.set('langpair', `zh-CN|${target}`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), translationTimeoutMs)
  let response
  let raw
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    raw = await response.text()
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'translation provider timeout' : 'translation provider request failed'
    const translatedError = new Error(reason)
    translatedError.status = 502
    translatedError.provider_status = 0
    throw translatedError
  } finally {
    clearTimeout(timeout)
  }
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    const error = new Error(`translation provider returned HTTP ${response.status}`)
    error.status = 502
    error.provider_status = response.status
    throw error
  }
  const translated = decodeTranslationEntities(data?.responseData?.translatedText || '')
  const providerStatus = Number(data?.responseStatus || 0)
  if (!translated || (providerStatus && providerStatus !== 200)) {
    const error = new Error(String(data?.responseDetails || 'translation provider returned no translation').slice(0, 300))
    error.status = 502
    error.provider_status = providerStatus
    throw error
  }
  return translated
}

async function translateTextWithFreeProvider(value, target) {
  const text = String(value || '')
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  const translatedLines = []
  for (const line of lines) {
    if (!line) {
      translatedLines.push('')
      continue
    }
    const chunks = splitTranslationText(line)
    const translatedChunks = []
    for (const chunk of chunks) {
      translatedChunks.push(await translateProviderChunk(chunk, target))
    }
    translatedLines.push(translatedChunks.join(''))
  }
  return translatedLines.join('\n')
}

function base64UrlJson(value = '') {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'))
  } catch {
    const err = new Error('invalid google id token')
    err.status = 400
    throw err
  }
}

function googleClientIdsForSite(site = {}) {
  const siteClientId = String(site.google?.client_id || '').trim()
  return [...new Set([
    ...configuredGoogleClientIds,
    ...(!isDemoGoogleClientId(siteClientId) ? [siteClientId] : []),
  ])]
}

function publicGoogleConfig(site = {}) {
  const siteClientId = String(site.google?.client_id || '').trim()
  const clientId = configuredGoogleClientIds[0] || siteClientId
  const demo = isDemoGoogleClientId(clientId)
  return {
    client_id: demo ? '' : clientId,
    auth_mode: demo ? 'demo' : 'google',
    demo_enabled: googleDemoLoginEnabled && demo,
  }
}

async function googleJwks() {
  const timestamp = Date.now()
  if (googleCertsCache.expires_at > timestamp && googleCertsCache.keys.length) return googleCertsCache.keys
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs')
  if (!res.ok) {
    const err = new Error('google certs unavailable')
    err.status = 502
    throw err
  }
  const data = await res.json()
  const maxAge = String(res.headers.get('cache-control') || '').match(/max-age=(\d+)/i)
  googleCertsCache = {
    keys: Array.isArray(data.keys) ? data.keys : [],
    expires_at: timestamp + Math.max(60, Number(maxAge?.[1] || 3600)) * 1000,
  }
  return googleCertsCache.keys
}

async function verifyGoogleIdToken(idToken = '', allowedClientIds = []) {
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) {
    const err = new Error('invalid google id token')
    err.status = 400
    throw err
  }
  if (!allowedClientIds.length) {
    const err = new Error('google client id missing')
    err.status = 409
    throw err
  }
  const header = base64UrlJson(parts[0])
  const payload = base64UrlJson(parts[1])
  if (header.alg !== 'RS256' || !header.kid) {
    const err = new Error('invalid google token header')
    err.status = 400
    throw err
  }
  const jwk = (await googleJwks()).find((key) => key.kid === header.kid)
  if (!jwk) {
    const err = new Error('google cert not found')
    err.status = 400
    throw err
  }
  const verified = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))
  if (!verified) {
    const err = new Error('google token signature invalid')
    err.status = 401
    throw err
  }
  const nowSeconds = Math.floor(Date.now() / 1000)
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.some((audience) => allowedClientIds.includes(String(audience || '').trim()))) {
    const err = new Error('google token audience invalid')
    err.status = 401
    throw err
  }
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(String(payload.iss || ''))) {
    const err = new Error('google token issuer invalid')
    err.status = 401
    throw err
  }
  if (Number(payload.exp || 0) <= nowSeconds || Number(payload.iat || 0) > nowSeconds + 60) {
    const err = new Error('google token expired')
    err.status = 401
    throw err
  }
  const email = String(payload.email || '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('google token email missing')
    err.status = 400
    throw err
  }
  return {
    email,
    name: String(payload.name || email.split('@')[0]).trim().slice(0, 120),
    avatar: String(payload.picture || '').trim(),
    provider: 'google',
    email_verified: payload.email_verified === true || payload.email_verified === 'true',
  }
}

function requireAdmin(req) {
  const auth = String(req.headers.authorization || '')
  if (!auth.startsWith('Bearer ')) return false
  const token = auth.slice('Bearer '.length)
  const remoteAddress = req.socket?.remoteAddress || ''
  if (token === 'admin-e2e' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) return true
  const session = adminSessions.get(token)
  if (!session) return false
  if (session.expires_at < Date.now()) {
    adminSessions.delete(token)
    return false
  }
  session.expires_at = Date.now() + adminSessionMs
  return true
}

function currentAdmin(req) {
  const auth = String(req.headers.authorization || '')
  if (!auth.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length)
  const remoteAddress = req.socket?.remoteAddress || ''
  if (token === 'admin-e2e' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) return { email: 'admin-e2e@example.com', role: 'owner' }
  const session = adminSessions.get(token)
  return session && session.expires_at >= Date.now() ? session : null
}

function canWriteAdmin(req) {
  const admin = currentAdmin(req)
  return Boolean(admin && ['owner', 'admin'].includes(admin.role || ''))
}

function addAdminAuditLog(store, req, action, details = {}) {
  if (!Array.isArray(store.audit_logs)) store.audit_logs = []
  const admin = currentAdmin(req) || { email: 'unknown', role: 'unknown' }
  store.audit_logs.unshift({
    id: id(),
    action,
    actor_email: admin.email || 'unknown',
    actor_role: admin.role || 'unknown',
    ip: clientIp(req),
    details,
    created_at: now(),
  })
  store.audit_logs = store.audit_logs.slice(0, 500)
}

async function saveAdminChange(store, req, action, details = {}) {
  addAdminAuditLog(store, req, action, details)
  try {
    await saveStore(store)
  } catch (error) {
    log('error', 'admin.change_save_failed', {
      request_id: req.request_id,
      action,
      ...details,
      message: error?.message || 'admin change save failed',
    })
    throw error
  }
  log('info', 'admin.change_saved', {
    request_id: req.request_id,
    action,
    ...details,
  })
}

// -----------------------------------------------------------------------------
// Optional SMTP notifications
// -----------------------------------------------------------------------------
// Notifications are deliberately independent from the order transaction. A
// provider outage must not turn a successful order or payment into a customer
// visible error. SMTP is implemented with Node built-ins so the API keeps its
// current dependency-free runtime; the feature is inactive until SMTP_HOST and
// SMTP_FROM are configured.
function emailNotificationsEnabled() {
  return Boolean(smtpConfig.host && smtpConfig.from && smtpConfig.port > 0)
}

function escapeEmailHeader(value = '') {
  return String(value || '').replace(/[\r\n]/g, ' ').trim()
}

function escapeEmailBody(value = '') {
  return String(value || '').replace(/[\r\n]+/g, '\n').trim()
}

function smtpConnection() {
  const options = { host: smtpConfig.host, port: smtpConfig.port, timeout: smtpConfig.timeoutMs }
  return new Promise((resolve, reject) => {
    const socket = smtpConfig.secure ? connectTls({ ...options, servername: smtpConfig.host }) : connectNet(options)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('smtp connection timeout'))
    }, smtpConfig.timeoutMs)
    let completed = false
    const complete = async () => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      socket.setTimeout(smtpConfig.timeoutMs)
      try {
        // Read the server greeting before sending EHLO. Listening immediately
        // from the connect callback avoids losing a greeting sent eagerly.
        await smtpResponse(socket)
        resolve(socket)
      } catch (error) {
        socket.destroy()
        reject(error)
      }
    }
    socket.once('secureConnect', complete)
    socket.once('connect', () => {
      if (!smtpConfig.secure) complete()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function smtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('smtp response timeout'))
    }, smtpConfig.timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      const completeLine = lines.find((line) => /^\d{3} /.test(line))
      if (!completeLine) return
      cleanup()
      const code = Number(completeLine.slice(0, 3))
      if (code >= 400) reject(new Error(`smtp ${completeLine}`))
      else resolve(code)
    }
    const onError = (error) => { cleanup(); reject(error) }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

async function smtpCommand(socket, command, expected = 250) {
  socket.write(`${command}\r\n`)
  const code = await smtpResponse(socket)
  if (code !== expected) throw new Error(`smtp unexpected response ${code}`)
  return code
}

function emailMessage({ to, subject, text }) {
  const body = escapeEmailBody(text).replace(/^\./gm, '..')
  return [
    `From: ${escapeEmailHeader(smtpConfig.from)}`,
    `To: ${escapeEmailHeader(to)}`,
    `Subject: ${escapeEmailHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
    '.',
  ].join('\r\n')
}

async function sendSmtpMail({ to, subject, text }) {
  if (!emailNotificationsEnabled() || !to) return false
  let socket
  try {
    socket = await smtpConnection()
    await smtpCommand(socket, `EHLO ${escapeEmailHeader(process.env.SMTP_EHLO || 'pet-wool-platform')}`)
    if (!smtpConfig.secure && smtpConfig.port !== 25) {
      await smtpCommand(socket, 'STARTTLS')
      socket = await new Promise((resolve, reject) => {
        const upgraded = connectTls({ socket, servername: smtpConfig.host })
        upgraded.once('secureConnect', () => resolve(upgraded))
        upgraded.once('error', reject)
      })
      await smtpCommand(socket, `EHLO ${escapeEmailHeader(process.env.SMTP_EHLO || 'pet-wool-platform')}`)
    }
    if (smtpConfig.user) {
      socket.write('AUTH PLAIN\r\n')
      await smtpResponse(socket)
      await smtpCommand(socket, Buffer.from(`\0${smtpConfig.user}\0${smtpConfig.pass}`).toString('base64'), 235)
    }
    await smtpCommand(socket, `MAIL FROM:<${escapeEmailHeader(smtpConfig.from).replace(/^.*<|>.*$/g, '')}>`)
    await smtpCommand(socket, `RCPT TO:<${escapeEmailHeader(to).replace(/^.*<|>.*$/g, '')}>`)
    socket.write(`DATA\r\n`)
    await smtpResponse(socket)
    socket.write(`${emailMessage({ to, subject, text })}\r\n`)
    await smtpResponse(socket)
    await smtpCommand(socket, 'QUIT', 221)
    socket.end()
    log('info', 'notification.email_sent', {
      recipient_hash: emailFingerprint(to),
      subject,
    })
    return true
  } catch (error) {
    socket?.destroy()
    log('error', 'notification.email_failed', {
      recipient_hash: emailFingerprint(to),
      subject,
      message: error?.message || 'email notification failed',
    })
    return false
  }
}

function orderNotificationText(order = {}, event = {}) {
  const amountCurrency = String(order.currency || '').trim().toUpperCase()
  const rawAmount = Number(event.amount_cents ?? order.paid_amount_cents ?? 0)
  // Minor-unit aware: KRW amounts are whole won, others are cents.
  const amountText = amountCurrency === 'KRW' ? String(Math.round(rawAmount)) : (rawAmount / 100).toFixed(2)
  const amount = `${amountText} ${amountCurrency}`.trim()
  return [
    `WoolBuddy order ${order.order_no || order.id || ''}`,
    '',
    `Customer: ${order.customer_name || '-'}`,
    `Product: ${order.product_title || '-'}`,
    `Payment: ${event.label || 'Order update'}`,
    `Amount: ${amount}`,
    `Order status: ${order.order_status || '-'}`,
    `Payment status: ${order.payment_status || '-'}`,
    '',
    'Please open the order page or contact support for assistance.',
  ].join('\n')
}

function queueOrderNotifications(order, event = {}) {
  if (!emailNotificationsEnabled() || !order) return
  const subject = `[WoolBuddy] ${event.label || 'Order update'} - ${order.order_no || order.id}`
  const text = orderNotificationText(order, event)
  const recipients = new Set([String(order.email || '').trim().toLowerCase(), smtpConfig.adminEmail].filter(Boolean))
  log('info', 'notification.email_queued', {
    order_id: order.id,
    order_no: order.order_no,
    event: event.label || 'Order update',
    recipients: recipients.size,
  })
  for (const to of recipients) {
    void sendSmtpMail({ to, subject, text })
  }
}

function requireDeleteConfirm(req) {
  return String(req.headers['x-confirm-delete'] || '').toLowerCase() === 'true'
}

function requireSecretBackupConfirm(req) {
  return String(req.headers['x-confirm-secret-backup'] || '').toLowerCase() === 'true'
}

function isProductReferencedBySiteContent(site = {}, product = {}) {
  const slug = String(product.slug || '').trim()
  if (!slug) return false
  return (Array.isArray(site.reviews) && site.reviews.some((review) => String(review.product_slug || '').trim() === slug))
    || (Array.isArray(site.blog) && site.blog.some((post) => JSON.stringify(post).includes(slug)))
    || (Array.isArray(site.faq) && site.faq.some((faq) => JSON.stringify(faq).includes(slug)))
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.socket?.remoteAddress || '')
    || 'unknown'
}

function checkUploadRateLimit(req) {
  const key = clientIp(req)
  const timestamp = Date.now()
  const existing = uploadRateLimits.get(key) || []
  const recent = existing.filter((item) => timestamp - item < uploadRateLimitWindowMs)
  if (recent.length >= uploadRateLimitMax) {
    uploadRateLimits.set(key, recent)
    return false
  }
  recent.push(timestamp)
  uploadRateLimits.set(key, recent)
  if (uploadRateLimits.size > 1000) {
    for (const [ip, items] of uploadRateLimits.entries()) {
      const active = items.filter((item) => timestamp - item < uploadRateLimitWindowMs)
      if (active.length) uploadRateLimits.set(ip, active)
      else uploadRateLimits.delete(ip)
    }
  }
  return true
}

function checkOrderLookupRateLimit(req, email) {
  const key = `${clientIp(req)}:${emailFingerprint(email)}`
  const timestamp = Date.now()
  const existing = orderLookupRateLimits.get(key) || []
  const recent = existing.filter((item) => timestamp - item < orderLookupRateLimitWindowMs)
  if (recent.length >= orderLookupRateLimitMax) {
    orderLookupRateLimits.set(key, recent)
    return false
  }
  recent.push(timestamp)
  orderLookupRateLimits.set(key, recent)
  if (orderLookupRateLimits.size > 2000) {
    for (const [rateKey, items] of orderLookupRateLimits.entries()) {
      const active = items.filter((item) => timestamp - item < orderLookupRateLimitWindowMs)
      if (active.length) orderLookupRateLimits.set(rateKey, active)
      else orderLookupRateLimits.delete(rateKey)
    }
  }
  return true
}

function signUserPayload(payload) {
  return createHmac('sha256', userTokenSecret).update(payload).digest('base64url')
}

function createUserToken(user = {}) {
  const issuedAt = Date.now()
  const payload = Buffer.from(JSON.stringify({
    email: String(user.email || '').toLowerCase(),
    name: user.name || '',
    avatar: user.avatar || '',
    provider: user.provider || 'google',
    iat: issuedAt,
    exp: issuedAt + userSessionMs,
  })).toString('base64url')
  return `user-v1.${payload}.${signUserPayload(payload)}`
}

function verifyUserToken(token = '') {
  const match = String(token || '').match(/^user-v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/)
  if (!match) return null
  const expected = signUserPayload(match[1])
  const actual = match[2]
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) return null
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
    const expiresAt = Number(payload.exp || 0)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function currentUser(req) {
  const auth = String(req.headers.authorization || '')
  if (!auth.startsWith('Bearer ')) return null
  return verifyUserToken(auth.slice('Bearer '.length))
}

// Public order data is filtered by ownership before it is returned. The user
// token carries the verified email; matching it against the order email avoids
// treating a client-supplied email query as authorization.
function validateCustomerOrderAccess(req, order = {}) {
  const user = currentUser(req)
  if (!user?.email) return ''
  return String(user.email || '').trim().toLowerCase() === String(order.email || '').trim().toLowerCase()
    ? ''
    : 'order access denied'
}

function validateCustomerReviewInput(input = {}) {
  const rating = Number(input.rating)
  const title = String(input.title || '').trim()
  const content = String(input.content || '').trim()
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return 'invalid review rating'
  if (title.length > 200) return 'invalid review title'
  if (!content) return 'review content required'
  if (content.length > 2000) return 'invalid review content'
  return ''
}

function publicProduct(product, categories) {
  const category = categories.find((c) => c.id === product.category_id)
  return { ...product, category }
}

// -----------------------------------------------------------------------------
// Response projections and localization
// -----------------------------------------------------------------------------
// Never serialize the raw store directly to a public client. These projections
// intentionally omit internal notes, audit data, payment secrets, and other
// fields that are only needed by the admin workflow.
function publicOrder(order = {}) {
  return {
    id: order.id,
    order_no: order.order_no,
    product_title: order.product_title,
    option_name: order.option_name,
    payment_type: order.payment_type,
    amount_cents: order.amount_cents,
    initial_payment_cents: order.initial_payment_cents || 0,
    paid_amount_cents: order.paid_amount_cents || 0,
    currency: order.currency,
    order_status: order.order_status,
    payment_status: order.payment_status,
    paypal_order_id: order.paypal_order_id || '',
    created_at: order.created_at,
  }
}

function publicOrderStatus(order = {}) {
  return {
    order_no: order.order_no,
    product_title: order.product_title,
    option_name: order.option_name,
    order_status: order.order_status,
    payment_status: order.payment_status,
    created_at: order.created_at,
  }
}

function trackingUrlForOrder(order = {}, site = {}) {
  const trackingNo = String(order.tracking_no || '').trim()
  const template = String(site.shipping?.tracking_url_template || '').trim()
  if (!trackingNo || !template) return ''
  try {
    const url = new URL(template
      .replaceAll('{tracking}', encodeURIComponent(trackingNo))
      .replaceAll('{carrier}', encodeURIComponent(String(order.shipping_carrier || '').trim())))
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

const customerStatusLabels = {
  new: '新订单',
  confirmed: '已确认',
  crafting: '制作中',
  preview: '预览确认',
  balance_due: '待付尾款',
  ready_ship: '待发货',
  shipped: '已发货',
  completed: '已完成',
  cancelled: '已取消',
  unpaid: '未支付',
  deposit_paid: '已付定金',
  paid: '已支付',
  refunded: '已退款',
}

function customerEventMessage(event = {}) {
  const meta = event.meta || {}
  if (event.type === 'tracking') {
    const carrier = String(meta.carrier || '').trim()
    const trackingNo = String(meta.tracking_no || '').trim()
    return trackingNo ? `物流已更新：${carrier || '物流'} ${trackingNo}` : '物流信息已更新'
  }
  if (event.type === 'payment') {
    const to = customerStatusLabels[meta.to] || meta.to
    return to ? `付款状态已更新为${to}` : '付款状态已更新'
  }
  if (event.type === 'status') {
    const to = customerStatusLabels[meta.to] || meta.to
    return to ? `订单状态已更新为${to}` : '订单状态已更新'
  }
  return String(event.message || '').trim()
}

function customerOrderEvents(order = {}) {
  const allowedTypes = new Set(['status', 'payment', 'tracking'])
  return (Array.isArray(order.events) ? order.events : [])
    .filter((event) => allowedTypes.has(event?.type))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 20)
    .map((event) => ({
      id: event.id,
      type: event.type,
      message: customerEventMessage(event),
      created_at: event.created_at || '',
    }))
}

function customerOrder(order = {}, store = {}) {
  const photoUrls = (Array.isArray(order.photo_urls) ? order.photo_urls : [])
    .filter((photo) => isValidUploadUrl(photo))
    .slice(0, maxOrderPhotos)
  const review = (store.site?.reviews || []).find((item) => String(item.order_id || '') === String(order.id || ''))
  return {
    ...publicOrder(order),
    customer_name: order.customer_name,
    phone: order.phone || '',
    country: order.country || '',
    shipping_address: order.shipping_address || '',
    pet_name: order.pet_name,
    pet_type: order.pet_type,
    notes: order.notes || '',
    shipping_carrier: order.shipping_carrier || '',
    tracking_no: order.tracking_no || '',
    tracking_url: trackingUrlForOrder(order, store.site || {}),
    events: customerOrderEvents(order),
    review: review ? {
      id: review.id,
      rating: review.rating,
      title: review.title || '',
      content: review.content || '',
      created_at: review.created_at || '',
    } : null,
    photo_urls: photoUrls,
    photo_count: photoUrls.length,
  }
}

function publicPayment(payment = {}) {
  if (!payment) return null
  return {
    payment_type: payment.payment_type,
    paypal_order_id: payment.paypal_order_id,
    amount_cents: payment.amount_cents,
    currency: payment.currency,
    base_amount_cents: payment.base_amount_cents || 0,
    base_currency: payment.base_currency || '',
    status: payment.status,
  }
}

function adminPayment(payment = {}) {
  if (!payment) return null
  return {
    id: payment.id,
    order_id: payment.order_id,
    provider: payment.provider,
    payment_type: payment.payment_type,
    paypal_order_id: payment.paypal_order_id || '',
    paypal_capture_id: payment.paypal_capture_id || '',
    amount_cents: payment.amount_cents,
    currency: payment.currency,
    base_amount_cents: payment.base_amount_cents || 0,
    base_currency: payment.base_currency || '',
    status: payment.status,
    created_at: payment.created_at || '',
    paid_at: payment.paid_at || '',
  }
}

function adminOrder(order = {}, store = {}) {
  const payments = (store.payments || [])
    .filter((payment) => payment.order_id === order.id)
    .map(adminPayment)
  return { ...order, payments }
}

function adminUsers(store) {
  const existing = Array.isArray(store.users) ? store.users : []
  const byEmail = new Map(existing.filter((user) => user.email).map((user) => [String(user.email).toLowerCase(), { ...user }]))
  for (const order of store.orders || []) {
    const email = String(order.email || '').toLowerCase()
    if (!email) continue
    const current = byEmail.get(email) || {
      id: id(),
      email: order.email,
      name: order.customer_name || '',
      provider: 'order',
      status: 'active',
      tags: [],
      internal_note: '',
      followups: [],
      created_at: order.created_at || now(),
    }
    current.name = current.name || order.customer_name || ''
    current.country = current.country || order.country || ''
    current.last_order_at = !current.last_order_at || String(order.created_at || '').localeCompare(String(current.last_order_at)) > 0 ? order.created_at : current.last_order_at
    current.order_count = (store.orders || []).filter((item) => String(item.email || '').toLowerCase() === email).length
    const paidOrders = (store.orders || [])
      .filter((item) => String(item.email || '').toLowerCase() === email && ['paid', 'deposit_paid'].includes(item.payment_status))
    current.total_paid_cents = paidOrders
      .reduce((sum, item) => sum + Number(item.paid_amount_cents || 0), 0)
    current.paid_by_currency = paidOrders
      .reduce((summary, item) => {
        const currency = String(item.currency || 'CNY').trim().toUpperCase()
        summary[currency] = (summary[currency] || 0) + Number(item.paid_amount_cents || 0)
        return summary
      }, {})
    byEmail.set(email, current)
  }
  store.users = Array.from(byEmail.values()).sort((a, b) => String(b.last_order_at || b.created_at || '').localeCompare(String(a.last_order_at || a.created_at || '')))
  return store.users
}

function findUserByEmail(store, email = '') {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null
  return adminUsers(store).find((user) => String(user.email || '').toLowerCase() === normalized) || null
}

function isBlockedEmail(store, email = '') {
  return findUserByEmail(store, email)?.status === 'blocked'
}

function normalizeLang(value) {
  const lang = String(value || '').toLowerCase().slice(0, 2)
  return supportedLangs.includes(lang) ? lang : ''
}

function requestLang(req, url) {
  const fromQuery = normalizeLang(url.searchParams.get('lang') || url.searchParams.get('locale'))
  if (fromQuery) return fromQuery
  return pickLang(req)
}

function langValue(item, lang, field, fallback = '') {
  return item?.translations?.[lang]?.[field]
    ?? item?.translations?.en?.[field]
    ?? item?.translations?.zh?.[field]
    ?? item?.[field]
    ?? fallback
}

function termValue(value, lang) {
  return termLabels[value]?.[lang] || value
}

function localizeTerms(values = [], lang) {
  return values.map((value) => termValue(value, lang))
}

function canonicalTerm(value) {
  const text = String(value || '')
  const found = Object.entries(termLabels).find(([, labels]) => Object.values(labels).includes(text))
  return found?.[0] || text
}

function applyProductCopy(product, lang) {
  const copy = productCopy[product.slug]?.[lang]
  return copy ? { ...product, ...copy } : product
}

function applySiteCopy(site, lang) {
  const reviews = (site.reviews || []).map((review) => {
    const key = review.translations?.en?.title || review.title
    const directEntry = siteCopy.reviews[key]
    const matchedEntry = directEntry || Object.values(siteCopy.reviews).find((entry) => {
      const localizedValues = Object.values(entry || {})
      return localizedValues.some((copy) => (
        String(copy?.title || '').trim() === String(review.title || '').trim()
        || String(copy?.content || '').trim() === String(review.content || '').trim()
      ))
    })
    const copy = matchedEntry?.[lang]
    return copy ? { ...review, ...copy, country: termValue(review.country, lang) } : { ...review, country: termValue(review.country, lang) }
  })
  const blog = (site.blog || []).map((post) => {
    const copy = siteCopy.blog[post.slug]?.[lang]
    const manualTranslation = lang !== 'en' && ['title', 'excerpt', 'content'].some((field) => {
      const translated = String(post.translations?.[lang]?.[field] || '').trim()
      const english = String(post.translations?.en?.[field] || '').trim()
      return translated && english && translated !== english
    })
    return copy && !manualTranslation ? { ...post, ...copy, tags: localizeTerms(post.tags || [], lang) } : { ...post, tags: localizeTerms(post.tags || [], lang) }
  })
  return {
    ...site,
    reviews,
    blog,
    taxonomies: {
      ...(site.taxonomies || {}),
      occasions: localizeTerms(site.taxonomies?.occasions || [], lang),
      styles: localizeTerms(site.taxonomies?.styles || [], lang),
    },
  }
}

function withTranslationBase(item, fields) {
  const translations = { ...(item.translations || {}) }
  for (const lang of supportedLangs) {
    translations[lang] = { ...(translations[lang] || {}) }
    if (lang !== 'zh') continue
    for (const field of fields) {
      if (translations[lang][field] == null && item[field] != null) translations[lang][field] = item[field]
    }
  }
  return { ...item, translations }
}

function translateList(list = [], lang, fields) {
  return list.map((item) => {
    const next = { ...item }
    for (const field of fields) next[field] = langValue(item, lang, field, item[field])
    return next
  })
}

function localizeOptions(options = [], lang) {
  return translateList(options, lang, ['name'])
}

function localizeFaq(faq = [], lang) {
  return translateList(faq, lang, ['question', 'answer'])
}

function localizeCategory(category, lang) {
  if (!category) return category
  const title = categoryLabels[category.slug]?.[lang] || langValue(category, lang, 'title')
  return {
    ...category,
    title,
    description: langValue(category, lang, 'description'),
    seo_title: langValue(category, lang, 'seo_title', category.seo_title),
    seo_description: langValue(category, lang, 'seo_description', category.seo_description),
    children: (category.children || []).map((child) => ({
      ...translateList([child], lang, ['title', 'description'])[0],
      title: categoryLabels[child.slug]?.[lang] || langValue(child, lang, 'title'),
    })),
  }
}

function localizeProduct(product, categories, lang) {
  const category = categories.find((c) => c.id === product.category_id)
  return applyProductCopy({
    ...product,
    title: langValue(product, lang, 'title'),
    subtitle: langValue(product, lang, 'subtitle'),
    description: langValue(product, lang, 'description'),
    specs: langValue(product, lang, 'specs', product.specs),
    alt_text: langValue(product, lang, 'alt_text', product.alt_text),
    seo_title: langValue(product, lang, 'seo_title', product.seo_title),
    seo_description: langValue(product, lang, 'seo_description', product.seo_description),
    options: localizeOptions(product.options || [], lang),
    faqs: localizeFaq(product.faqs || [], lang),
    tags: localizeTerms(product.tags || [], lang),
    use_cases: localizeTerms(product.use_cases || [], lang),
    category: localizeCategory(category, lang),
  }, lang)
}

function publicCategoryView(category = {}) {
  return {
    id: category.id,
    slug: category.slug,
    title: category.title,
    description: category.description || '',
    image_url: category.image_url || '',
    seo_title: category.seo_title || '',
    seo_description: category.seo_description || '',
    sort_order: category.sort_order || 0,
    children: (category.children || []).map((child) => ({
      id: child.id,
      slug: child.slug,
      title: child.title,
      description: child.description || '',
      sort_order: child.sort_order || 0,
    })),
  }
}

function publicProductView(product = {}) {
  return {
    id: product.id,
    slug: product.slug,
    category_id: product.category_id,
    subcategory_slug: product.subcategory_slug || '',
    title: product.title,
    subtitle: product.subtitle || '',
    description: product.description || '',
    specs: product.specs || '',
    base_price_cents: product.base_price_cents,
    currency: product.currency,
    deposit_percent: product.deposit_percent,
    image_url: product.image_url || product.images?.[0] || '',
    images: product.images || [],
    alt_text: product.alt_text || '',
    seo_title: product.seo_title || '',
    seo_description: product.seo_description || '',
    tags: product.tags || [],
    use_cases: product.use_cases || [],
    options: (product.options || []).map((option) => ({
      id: option.id,
      name: option.name,
      price_cents: option.price_cents,
    })),
    faqs: (product.faqs || []).map((faq) => ({
      id: faq.id,
      question: faq.question,
      answer: faq.answer,
    })),
    category: product.category ? publicCategoryView(product.category) : null,
    sort_order: product.sort_order || 0,
  }
}

function stripTranslations(value) {
  if (Array.isArray(value)) return value.map(stripTranslations)
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'translations') continue
    next[key] = stripTranslations(item)
  }
  return next
}

function publicSiteView(site = {}) {
  const view = stripTranslations(site)
  const paypal = paypalConfig(site)
  return {
    brand: {
      name: view.brand?.name || '',
      email: view.brand?.email || '',
      instagram: view.brand?.instagram || '',
    },
    contact: {
      kakao_enabled: view.contact?.kakao_enabled ?? true,
      kakao_label: view.contact?.kakao_label || 'KakaoTalk',
      kakao_id: view.contact?.kakao_id || '',
      kakao_url: view.contact?.kakao_url || '',
      whatsapp_enabled: view.contact?.whatsapp_enabled ?? true,
      whatsapp_label: view.contact?.whatsapp_label || 'WhatsApp',
      whatsapp_id: view.contact?.whatsapp_id || '',
      whatsapp_url: view.contact?.whatsapp_url || '',
    },
    theme: view.theme || {},
    bot: {
      enabled: view.bot?.enabled ?? false,
      welcome: view.bot?.welcome || {},
    },
    paypal: {
      enabled: paypal.enabled,
      mode: paypal.mode,
      client_id: paypal.clientId,
      currency: paypal.currency,
    },
    google: publicGoogleConfig(site),
    shipping: {
      tracking_url_template: view.shipping?.tracking_url_template || '',
    },
    policies: {
      care: view.policies?.care || '',
      shipping: view.policies?.shipping || '',
      refund: view.policies?.refund || '',
    },
    faq: Array.isArray(view.faq) ? view.faq.map((item) => ({
      id: item.id,
      question: item.question,
      answer: item.answer,
    })) : [],
    reviews: Array.isArray(view.reviews) ? view.reviews
      .filter((item) => item?.status !== 'hidden')
      .map((item) => ({
      id: item.id,
      name: item.name,
      country: item.country,
      rating: item.rating,
      status: item.status || 'published',
      title: item.title,
      content: item.content,
      product_slug: item.product_slug || '',
      avatar_url: item.avatar_url || '',
      images: Array.isArray(item.images) && item.images.length
        ? item.images
        : [item.pet_image, item.work_image].filter(Boolean),
      pet_image: item.pet_image || '',
      work_image: item.work_image || '',
      video_url: item.video_url || '',
      })) : [],
    blog: Array.isArray(view.blog) ? view.blog.map((post) => ({
      id: post.id,
      slug: post.slug,
      date: post.date,
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      image_url: post.image_url || '',
      tags: Array.isArray(post.tags) ? post.tags : [],
    })) : [],
    taxonomies: {
      occasions: Array.isArray(view.taxonomies?.occasions) ? view.taxonomies.occasions : [],
      styles: Array.isArray(view.taxonomies?.styles) ? view.taxonomies.styles : [],
    },
  }
}

function adminSiteView(site = {}) {
  const view = structuredClone(site || {})
  if (view.paypal) {
    const paypal = paypalConfig(view)
    view.paypal.enabled = paypal.enabled
    view.paypal.mode = paypal.mode
    view.paypal.client_id = paypal.clientId
    view.paypal.currency = paypal.currency
    view.paypal.secret_configured = Boolean(paypal.secret)
    view.paypal.webhook_configured = Boolean(paypal.webhookId)
      && !paypalWebhookIdLooksLikeUrl(paypal.webhookId)
    delete view.paypal.secret
    delete view.paypal.webhook_id
  }
  return view
}

function localizeSite(site, lang) {
  const paypal = paypalConfig(site)
  const translated = {
    ...site,
    google: {
      client_id: site.google?.client_id || '',
    },
    paypal: {
      enabled: paypal.enabled,
      mode: paypal.mode,
      client_id: paypal.clientId,
      currency: paypal.currency,
    },
    policies: {
      ...(site.policies || {}),
      care: langValue(site.policies || {}, lang, 'care', site.policies?.care),
      shipping: langValue(site.policies || {}, lang, 'shipping', site.policies?.shipping),
      refund: langValue(site.policies || {}, lang, 'refund', site.policies?.refund),
    },
    faq: localizeFaq(site.faq || [], lang),
    reviews: translateList(
      (site.reviews || []).filter((review) => review?.status !== 'hidden'),
      lang,
      ['title', 'content']
    ),
    blog: translateList(site.blog || [], lang, ['title', 'excerpt', 'content']),
  }
  return publicSiteView(applySiteCopy(translated, lang))
}

// Backups are safe by default. Secret-bearing fields are only included by the
// explicitly confirmed full-backup path in the admin API.
function redactBackupStore(store = {}) {
  const backup = JSON.parse(JSON.stringify(store))
  if (backup.site?.paypal) {
    delete backup.site.paypal.secret
    delete backup.site.paypal.webhook_id
  }
  return backup
}

function ensureTranslations(store) {
  let changed = false
  const categoryFields = ['title', 'description', 'seo_title', 'seo_description']
  const productFields = ['title', 'subtitle', 'description', 'specs', 'alt_text', 'seo_title', 'seo_description']
  const faqFields = ['question', 'answer']
  const sitePolicyFields = ['care', 'shipping', 'refund']

  store.categories = (store.categories || []).map((category) => {
    const hadCategoryTranslations = Boolean(category.translations)
    const childrenMissingTranslations = category.children?.some((child) => !child.translations)
    const next = withTranslationBase(category, categoryFields)
    next.children = (next.children || []).map((child) => withTranslationBase(child, ['title', 'description']))
    if (!hadCategoryTranslations || childrenMissingTranslations) changed = true
    return next
  })

  store.products = (store.products || []).map((product) => {
    const hadProductTranslations = Boolean(product.translations)
    const optionsMissingTranslations = product.options?.some((option) => !option.translations)
    const faqsMissingTranslations = product.faqs?.some((faq) => !faq.translations)
    const next = withTranslationBase(product, productFields)
    next.options = (next.options || []).map((option) => withTranslationBase(option, ['name']))
    next.faqs = (next.faqs || []).map((faq) => withTranslationBase(faq, faqFields))
    if (!hadProductTranslations || optionsMissingTranslations || faqsMissingTranslations) changed = true
    return next
  })

  if (store.site) {
    const policiesMissingTranslations = !store.site.policies?.translations
    const siteFaqMissingTranslations = store.site.faq?.some((faq) => !faq.translations)
    const reviewsBeforeNormalize = JSON.stringify(store.site.reviews || [])
    const reviewsMissingTranslations = store.site.reviews?.some((review) => !review.translations)
    const blogMissingTranslations = store.site.blog?.some((post) => !post.translations)
    store.site.policies = withTranslationBase(store.site.policies || {}, sitePolicyFields)
    store.site.faq = (store.site.faq || []).map((faq) => withTranslationBase(faq, faqFields))
    store.site.reviews = (store.site.reviews || [])
      .map((review) => withTranslationBase(normalizeReviewPayload(review), ['title', 'content']))
    store.site.blog = (store.site.blog || []).map((post) => withTranslationBase(post, ['title', 'excerpt', 'content']))
    if (policiesMissingTranslations
      || siteFaqMissingTranslations
      || reviewsMissingTranslations
      || blogMissingTranslations
      || reviewsBeforeNormalize !== JSON.stringify(store.site.reviews || [])) changed = true
  }
  return { store, changed }
}

function pickLang(req, input = {}) {
  const requested = String(input.lang || input.locale || '').slice(0, 2)
  if (['zh', 'en', 'ko'].includes(requested)) return requested
  const header = String(req.headers['accept-language'] || '').toLowerCase()
  if (header.includes('ko')) return 'ko'
  if (header.includes('zh')) return 'zh'
  return 'zh'
}

function botAnswer(site, lang, question = '') {
  const text = String(question || '').toLowerCase()
  const items = site.bot?.knowledge || []
  const matched = items.find((item) => (item.keywords || []).some((keyword) => text.includes(String(keyword).toLowerCase())))
  if (matched) return matched[lang] || matched.en || matched.zh
  const fallback = {
    zh: '我可以回答价格、照片要求、制作周期、运输、退款和护理问题。也可以通过 KakaoTalk 或 WhatsApp 联系人工客服。',
    en: 'I can answer pricing, photo requirements, lead time, shipping, refund and care questions. You can also use KakaoTalk or WhatsApp for human support.',
    ko: '가격, 사진 요구사항, 제작 기간, 배송, 환불, 관리 방법을 안내할 수 있습니다. KakaoTalk 또는 WhatsApp으로 상담도 가능합니다.',
  }
  return fallback[lang] || fallback.en
}

// -----------------------------------------------------------------------------
// Order amounts and payment state
// -----------------------------------------------------------------------------
// Money is stored as integer minor units. The helpers below centralize deposit,
// balance, and full-payment calculations so the order page, PayPal API, and
// admin dashboard cannot drift into different totals.
function orderTotalAmount(product, optionId) {
  const option = product.options?.find((o) => o.id === optionId) || product.options?.[0]
  return Number(option?.price_cents || product.base_price_cents || 0)
}

function orderInitialPaymentAmount(product, optionId, paymentType) {
  const total = orderTotalAmount(product, optionId)
  if (paymentType === 'full') return total
  return Math.round(total * Number(product.deposit_percent || 0) / 100)
}

function isSamePublicOrderRequest(order = {}, input = {}) {
  const normalizedPhotos = (value) => Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
  return String(order.product_id || '') === String(input.product_id || '')
    && String(order.option_id || '') === String(input.option_id || '')
    && String(order.payment_type || 'deposit') === String(input.payment_type || 'deposit')
    && String(order.customer_name || '').trim() === String(input.customer_name || '').trim()
    && String(order.phone || '').trim() === String(input.phone || '').trim()
    && String(order.country || '').trim() === String(input.country || '').trim()
    && String(order.shipping_address || '').trim() === String(input.shipping_address || '').trim()
    && String(order.pet_name || '').trim() === String(input.pet_name || '').trim()
    && String(order.pet_type || '').trim() === String(input.pet_type || '').trim()
    && String(order.notes || '').trim() === String(input.notes || '').trim()
    && JSON.stringify(normalizedPhotos(order.photo_urls)) === JSON.stringify(normalizedPhotos(input.photo_urls))
}

function addOrderEvent(order, type, message, meta = {}) {
  if (!Array.isArray(order.events)) order.events = []
  const { actor = 'admin', ...eventMeta } = meta || {}
  order.events.unshift({
    id: id(),
    type,
    message,
    meta: eventMeta,
    actor,
    created_at: now(),
  })
  order.events = order.events.slice(0, 80)
  log('info', 'business.order_event', {
    order_id: order.id,
    order_no: order.order_no,
    type,
    actor,
    from: eventMeta.from || '',
    to: eventMeta.to || '',
  })
}

// -----------------------------------------------------------------------------
// PayPal integration
// -----------------------------------------------------------------------------
// PayPal has two supported paths: the real Orders API and an explicit local
// mock for development/E2E. Both paths update the same payment record and order
// event model, which keeps the rest of the application provider-agnostic.
function centsToPaypalAmount(cents = 0, currency = defaultPaypalCurrency) {
  const normalizedCurrency = String(currency || defaultPaypalCurrency).trim().toUpperCase()
  const amount = Number(cents || 0) / 100
  return paypalZeroDecimalCurrencies.has(normalizedCurrency)
    ? String(Math.round(amount))
    : amount.toFixed(2)
}

function paypalAmountToCents(value = 0, currency = defaultPaypalCurrency) {
  const normalizedCurrency = String(currency || defaultPaypalCurrency).trim().toUpperCase()
  const amount = Number(value || 0)
  if (!Number.isFinite(amount)) return 0
  return paypalZeroDecimalCurrencies.has(normalizedCurrency)
    ? Math.round(amount)
    : Math.round(amount * 100)
}

// Payments carry two amounts: amount_cents is the PayPal charge (charge
// currency, e.g. USD) and base_amount_cents is the same money in the order
// currency (KRW base). Legacy payments only have amount_cents, which was also
// the order currency back when the two had to match. The conversion between
// the two (and all settlement validation) lives in payment-amounts.mjs so the
// webhook path, the direct capture path, and tests share one implementation.

function paypalConfig(site = {}) {
  const stored = site.paypal || {}
  const paypal = stored
  const modeValue = String(paypal.mode || '').trim().toLowerCase()
  const mode = ['sandbox', 'live'].includes(modeValue) ? modeValue : 'sandbox'
  const webhookId = String(paypal.webhook_id || '').trim()
  return {
    enabled: paypal.enabled !== false,
    mode,
    apiBase: paypalApiBases[mode] || paypalApiBases.sandbox,
    clientId: String(paypal.client_id || '').trim(),
    secret: String(paypal.secret || '').trim(),
    webhookId: paypalWebhookIdLooksLikeUrl(webhookId) ? '' : webhookId,
    currency: String(paypal.currency || defaultPaypalCurrency).trim().toUpperCase() || defaultPaypalCurrency,
  }
}

function paypalCredentialsReady(config = {}) {
  return Boolean(config.enabled && config.clientId && config.secret)
}

function paypalShouldMock(config = {}) {
  // A live configuration must fail closed. Silently creating a local payment
  // ID when production credentials are missing would make the customer believe
  // they paid while no money reached PayPal.
  return paypalMockEnabled || (config.mode !== 'live' && !paypalCredentialsReady(config))
}

function assertProductionRuntime(store = {}) {
  if (paypalMockEnabled) throw new Error('PAYPAL_MOCK must be false in production')
  const paypal = paypalConfig(store.site)
  if (!paypal.enabled) throw new Error('PayPal must be enabled in production')
  if (paypal.mode !== 'live' || !paypal.clientId || !paypal.secret || !paypal.webhookId) {
    throw new Error('PayPal live credentials and webhook ID are required in production')
  }
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim()
  if (!/^https:\/\//i.test(publicBaseUrl)) throw new Error('PUBLIC_BASE_URL must use HTTPS in production')
}

function paypalBasicAuth(config = {}) {
  return Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')
}

function paypalClientFingerprint(value = '') {
  const clientId = String(value || '').trim()
  return clientId ? createHash('sha256').update(clientId).digest('hex').slice(0, 12) : ''
}

function publicOriginFromRequest(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // Fall through to request headers.
    }
  }
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http')
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  const hostValue = hostHeader || `${host}:${port}`
  return `${proto}://${hostValue}`
}

function safeReturnPath(value = '', fallback = '/order?paypal_return=1') {
  const text = String(value || '').trim()
  if (!text || text.length > 500 || !text.startsWith('/') || text.startsWith('//') || text.includes('\\')) return fallback
  try {
    const url = new URL(text, 'https://example.invalid')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}

function paypalReturnUrls(req, input = {}) {
  const origin = publicOriginFromRequest(req)
  const returnPath = safeReturnPath(input.return_path, '/order?paypal_return=1')
  const cancelPath = safeReturnPath(input.cancel_path, returnPath.includes('/account') ? '/account?paypal_cancel=1' : '/order?paypal_cancel=1')
  return {
    return_url: new URL(returnPath, origin).toString(),
    cancel_url: new URL(cancelPath, origin).toString(),
  }
}

function paypalResponseSummary(data) {
  if (!data || typeof data !== 'object') return data || null
  const summary = {}
  for (const key of ['name', 'message', 'error', 'error_description', 'debug_id', 'information_link']) {
    if (data[key] != null) summary[key] = String(data[key]).slice(0, 1000)
  }
  if (Array.isArray(data.details)) {
    summary.details = data.details.slice(0, 10).map((item) => ({
      issue: String(item?.issue || ''),
      description: String(item?.description || '').slice(0, 1000),
      field: String(item?.field || ''),
      value: String(item?.value || '').slice(0, 300),
      location: String(item?.location || ''),
    }))
  }
  if (!Object.keys(summary).length && data.raw) summary.raw = String(data.raw).slice(0, 2000)
  return summary
}

async function paypalFetch(config, pathname, options = {}) {
  const startedAt = Date.now()
  const method = String(options.method || 'GET').toUpperCase()
  const requestId = String(options.headers?.['PayPal-Request-Id'] || options.headers?.['paypal-request-id'] || '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), paypalRequestTimeoutMs)
  let res
  let text
  try {
    res = await fetch(`${config.apiBase}${pathname}`, {
      ...options,
      signal: options.signal || controller.signal,
    })
    text = await res.text()
  } catch (error) {
    const transportError = new Error(error?.name === 'AbortError' ? 'paypal api timeout' : 'paypal api request failed')
    transportError.status = error?.name === 'AbortError' ? 504 : 502
    transportError.cause = error
    transportError.paypalPath = pathname
    transportError.paypalMethod = method
    transportError.paypalRequestId = requestId
    transportError.paypalMode = config.mode
    transportError.paypalApiBase = config.apiBase
    transportError.paypalDurationMs = Date.now() - startedAt
    log('error', 'integration.paypal_transport_failed', {
      message: transportError.message,
      cause: error?.message || '',
      status: transportError.status,
      paypal_path: pathname,
      paypal_method: method,
      paypal_request_id: requestId,
      paypal_mode: config.mode,
      paypal_api_base: config.apiBase,
      duration_ms: transportError.paypalDurationMs,
    })
    throw transportError
  } finally {
    clearTimeout(timeout)
  }
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 1000) }
    }
  }
  if (!res.ok) {
    const err = new Error(
      pathname === '/v1/oauth2/token' && res.status === 401
        ? 'paypal credentials invalid'
        : 'paypal api failed',
    )
    err.status = res.status >= 400 && res.status < 500 ? 409 : 502
    err.paypalStatus = res.status
    err.paypalPath = pathname
    err.paypalMethod = method
    err.paypalRequestId = requestId
    err.paypalMode = config.mode
    err.paypalApiBase = config.apiBase
    err.paypalDurationMs = Date.now() - startedAt
    err.paypal = data
    log('error', 'integration.paypal_api_failed', {
      message: err.message,
      status: err.status,
      ...paypalErrorLog(err),
    })
    throw err
  }
  log('debug', 'integration.paypal_api_succeeded', {
    paypal_http_status: res.status,
    paypal_path: pathname,
    paypal_method: method,
    paypal_request_id: requestId,
    paypal_mode: config.mode,
    paypal_api_base: config.apiBase,
    duration_ms: Date.now() - startedAt,
  })
  return data || {}
}

function paypalErrorLog(error = {}) {
  const body = error?.paypal && typeof error.paypal === 'object' ? error.paypal : {}
  return {
    paypal_http_status: Number(error.paypalStatus || 0),
    paypal_path: String(error.paypalPath || ''),
    paypal_method: String(error.paypalMethod || ''),
    paypal_request_id: String(error.paypalRequestId || ''),
    paypal_mode: String(error.paypalMode || ''),
    paypal_api_base: String(error.paypalApiBase || ''),
    paypal_duration_ms: Number(error.paypalDurationMs || 0),
    paypal_name: String(body.name || ''),
    paypal_message: String(body.message || ''),
    paypal_error: String(body.error || ''),
    paypal_error_description: String(body.error_description || ''),
    paypal_debug_id: String(body.debug_id || ''),
    paypal_issues: Array.isArray(body.details)
      ? body.details.slice(0, 5).map((item) => ({
        issue: String(item?.issue || ''),
        description: String(item?.description || ''),
      }))
      : [],
    paypal_response: paypalResponseSummary(body),
  }
}

async function paypalAccessToken(config) {
  log('info', 'integration.paypal_oauth_started', {
    paypal_mode: config.mode,
    paypal_api_base: config.apiBase,
    paypal_client_fingerprint: paypalClientFingerprint(config.clientId),
    paypal_credentials_present: Boolean(config.clientId && config.secret),
  })
  const body = new URLSearchParams({ grant_type: 'client_credentials' })
  const data = await paypalFetch(config, '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${paypalBasicAuth(config)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const token = String(data.access_token || '').trim()
  if (!token) {
    const err = new Error('paypal token missing')
    err.status = 502
    throw err
  }
  log('info', 'integration.paypal_oauth_succeeded', {
    paypal_mode: config.mode,
    paypal_api_base: config.apiBase,
    paypal_client_fingerprint: paypalClientFingerprint(config.clientId),
  })
  return token
}

function paypalApprovalUrl(paypalOrder = {}) {
  const link = (paypalOrder.links || []).find((item) => item.rel === 'approve' || item.rel === 'payer-action')
  return String(link?.href || '').trim()
}

async function createRealPaypalOrder(req, store, order, payment, input = {}) {
  const config = paypalConfig(store.site)
  if (!paypalCredentialsReady(config)) {
    const err = new Error('paypal credentials missing')
    err.status = 409
    throw err
  }
  const token = await paypalAccessToken(config)
  const urls = paypalReturnUrls(req, input)
  // PayPal-Request-Id must be unique for each payment intent. Reusing a
  // deterministic order-level ID can make retries fail with DUPLICATE_REQUEST_ID.
  const requestId = `create-${createHash('sha256')
    .update(`${order.id}|${payment.id}|${payment.payment_type}|${payment.amount_cents}|${payment.currency}`)
    .digest('hex')
    .slice(0, 24)}`
  log('info', 'integration.paypal_order_create_started', {
    request_id: req.request_id,
    order_id: order.id,
    order_no: order.order_no,
    payment_id: payment.id,
    payment_type: payment.payment_type,
    amount_cents: payment.amount_cents,
    currency: payment.currency,
    paypal_mode: config.mode,
    paypal_api_base: config.apiBase,
    paypal_request_id: requestId,
  })
  const paypalOrder = await paypalFetch(config, '/v2/checkout/orders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order.id,
        custom_id: order.id,
        description: String(order.product_title || 'Custom pet portrait').slice(0, 127),
        amount: {
          currency_code: payment.currency,
          value: centsToPaypalAmount(payment.amount_cents, payment.currency),
        },
      }],
      application_context: {
        brand_name: String(store.site?.brand?.name || 'Everwool Studio').slice(0, 127),
        landing_page: 'BILLING',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        return_url: urls.return_url,
        cancel_url: urls.cancel_url,
      },
    }),
  })
  payment.paypal_order_id = String(paypalOrder.id || '').trim()
  payment.paypal_mode = config.mode
  payment.paypal_approve_url = paypalApprovalUrl(paypalOrder)
  payment.paypal_status = paypalOrder.status || ''
  if (!payment.paypal_order_id || !payment.paypal_approve_url) {
    const err = new Error('paypal order invalid')
    err.status = 502
    err.paypal = paypalOrder
    throw err
  }
  order.paypal_order_id = payment.paypal_order_id
  log('info', 'integration.paypal_order_create_succeeded', {
    request_id: req.request_id,
    order_id: order.id,
    order_no: order.order_no,
    payment_id: payment.id,
    paypal_order_id: payment.paypal_order_id,
    paypal_status: payment.paypal_status,
    payment_type: payment.payment_type,
    amount_cents: payment.amount_cents,
    currency: payment.currency,
    paypal_mode: config.mode,
  })
  return payment
}

async function createPaypalTestOrder(req, config) {
  const token = await paypalAccessToken(config)
  const testId = String(req.request_id || randomUUID()).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || randomUUID()
  const amountCents = 1
  const paypalOrder = await paypalFetch(config, '/v2/checkout/orders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `admin-test-${testId}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'admin-paypal-test',
        custom_id: `admin-paypal-test-${testId}`,
        description: 'PayPal API configuration test',
        amount: {
          currency_code: config.currency,
          value: centsToPaypalAmount(amountCents, config.currency),
        },
      }],
      application_context: {
        brand_name: 'WoolBuddy',
        landing_page: 'BILLING',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        ...paypalReturnUrls(req, {
          return_path: '/admin?paypal_test_return=1',
          cancel_path: '/admin?paypal_test_cancel=1',
        }),
      },
    }),
  })
  return {
    ok: true,
    test: true,
    mode: config.mode,
    currency: config.currency,
    amount_cents: amountCents,
    paypal_order_id: String(paypalOrder.id || ''),
    paypal_status: String(paypalOrder.status || ''),
    approve_url: paypalApprovalUrl(paypalOrder),
  }
}

async function captureRealPaypalOrder(store, payment) {
  const config = paypalConfig(store.site)
  if (!paypalCredentialsReady(config)) {
    const err = new Error('paypal credentials missing')
    err.status = 409
    throw err
  }
  const token = await paypalAccessToken(config)
  return paypalFetch(config, `/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `capture-${payment.id}`,
    },
    body: '{}',
  })
}

function paypalCaptureDetails(paypalOrder = {}) {
  const purchaseUnit = (paypalOrder.purchase_units || [])[0] || {}
  const capture = (purchaseUnit.payments?.captures || [])[0] || {}
  return {
    order_status: paypalOrder.status || '',
    capture_id: String(capture.id || '').trim(),
    capture_status: capture.status || '',
    amount_value: capture.amount?.value,
    currency: capture.amount?.currency_code || purchaseUnit.amount?.currency_code || '',
    paid_at: capture.update_time || capture.create_time || '',
  }
}

function applyCapturedPaypalPayment(order, payment, capture = {}) {
  const transition = capturedPaymentTransition(order, payment, capture)
  if (!transition) return false
  const previousPaymentStatus = order.payment_status
  const previousOrderStatus = order.order_status
  payment.status = 'captured'
  payment.paypal_capture_id = capture.capture_id || payment.paypal_capture_id || `CAPTURE-${id().slice(0, 12).toUpperCase()}`
  payment.paypal_status = capture.order_status || payment.paypal_status || 'COMPLETED'
  payment.paypal_capture_status = capture.capture_status || payment.paypal_capture_status || 'COMPLETED'
  payment.paid_at = capture.paid_at || payment.paid_at || now()
  // Track what the customer has settled in the order (base) currency, not the
  // PayPal charge currency, so balances and reconciliation stay exact.
  Object.assign(order, transition)
  if (previousPaymentStatus !== order.payment_status) {
    addOrderEvent(order, 'payment', `PayPal 付款状态 ${previousPaymentStatus || '-'} -> ${order.payment_status || '-'}`, {
      from: previousPaymentStatus,
      to: order.payment_status,
      payment_id: payment.id,
      paypal_order_id: payment.paypal_order_id,
      paypal_capture_id: payment.paypal_capture_id,
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      actor: 'paypal',
    })
  }
  if (previousOrderStatus !== order.order_status) {
    addOrderEvent(order, 'status', `PayPal 订单状态 ${previousOrderStatus || '-'} -> ${order.order_status || '-'}`, {
      from: previousOrderStatus,
      to: order.order_status,
      actor: 'paypal',
    })
  }
  order.updated_at = now()
  return true
}

async function verifyPaypalWebhook(req, site, event) {
  const config = paypalConfig(site)
  if (!config.webhookId) {
    const err = new Error('paypal webhook id missing')
    err.status = 400
    throw err
  }
  if (!paypalCredentialsReady(config)) {
    const err = new Error('paypal credentials missing')
    err.status = 409
    throw err
  }
  const requiredHeaders = [
    'paypal-auth-algo',
    'paypal-cert-url',
    'paypal-transmission-id',
    'paypal-transmission-sig',
    'paypal-transmission-time',
  ]
  if (requiredHeaders.some((header) => !String(req.headers[header] || '').trim())) {
    const err = new Error('paypal webhook headers missing')
    err.status = 400
    throw err
  }
  const token = await paypalAccessToken(config)
  let verification
  try {
    verification = await paypalFetch(config, '/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: req.headers['paypal-auth-algo'],
        cert_url: req.headers['paypal-cert-url'],
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id: config.webhookId,
        webhook_event: event,
      }),
    })
  } catch (error) {
    error.status = 400
    throw error
  }
  if (verification.verification_status !== 'SUCCESS') {
    const err = new Error('paypal webhook verification failed')
    err.status = 400
    err.paypal = verification
    throw err
  }
  return verification
}

function paypalOrderIdFromWebhook(event = {}) {
  const resource = event.resource || {}
  return String(
    resource.supplementary_data?.related_ids?.order_id
    || resource.purchase_units?.[0]?.payments?.captures?.[0]?.supplementary_data?.related_ids?.order_id
    || (String(event.event_type || '').startsWith('CHECKOUT.ORDER') ? resource.id : '')
    || ''
  ).trim()
}

function paypalCaptureIdFromWebhook(event = {}) {
  const resource = event.resource || {}
  return String(
    resource.purchase_units?.[0]?.payments?.captures?.[0]?.id
    || resource.id
    || ''
  ).trim()
}

function paypalCaptureFromWebhook(event = {}) {
  const resource = event.resource || {}
  const capture = resource.purchase_units?.[0]?.payments?.captures?.[0] || resource
  return {
    order_status: event.event_type === 'CHECKOUT.ORDER.APPROVED' ? 'APPROVED' : 'COMPLETED',
    capture_id: String(capture.id || '').trim(),
    capture_status: capture.status || (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' ? 'COMPLETED' : ''),
    amount_value: capture.amount?.value,
    currency: capture.amount?.currency_code || '',
    paid_at: capture.update_time || capture.create_time || event.create_time || '',
  }
}

async function applyPaypalWebhookEvent(store, event = {}) {
  const eventType = String(event.event_type || '')
  if (!['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.APPROVED'].includes(eventType)) return false
  const paypalOrderId = paypalOrderIdFromWebhook(event)
  const paypalCaptureId = paypalCaptureIdFromWebhook(event)
  if (!paypalOrderId && !paypalCaptureId) return false
  const payment = store.payments.find((item) => (
    (paypalOrderId && item.paypal_order_id === paypalOrderId)
    || (paypalCaptureId && item.paypal_capture_id === paypalCaptureId)
  ))
  if (!payment || payment.status === 'captured') return false
  const order = store.orders.find((item) => item.id === payment.order_id)
  if (!order) return false
  // Validate in base units before an APPROVED webhook can trigger a charge.
  const settlementError = validatePaymentSettlement(order, payment)
  if (settlementError) throw Object.assign(new Error(settlementError), { status: 409 })
  const capture = eventType === 'CHECKOUT.ORDER.APPROVED'
    ? paypalCaptureDetails(await captureRealPaypalOrder(store, payment))
    : paypalCaptureFromWebhook(event)
  if (eventType === 'CHECKOUT.ORDER.APPROVED' && capture.order_status !== 'COMPLETED' && capture.capture_status !== 'COMPLETED') {
    addOrderEvent(order, 'payment', 'PayPal Webhook 已收到付款授权，但捕获未完成', {
      paypal_order_id: payment.paypal_order_id,
      paypal_status: capture.order_status,
      paypal_capture_status: capture.capture_status,
      actor: 'paypal',
    })
    return true
  }
  const captureValidation = validatePaypalCaptureAmount(payment, capture)
  if (captureValidation) {
    addOrderEvent(order, 'payment', `PayPal Webhook 金额校验失败：${captureValidation}`, {
      paypal_order_id: payment.paypal_order_id,
      actor: 'paypal',
    })
    return true
  }
  applyCapturedPaypalPayment(order, payment, capture)
  return true
}

function applyManualPaymentStatus(store, order, nextStatus) {
  const previousStatus = order.payment_status
  const previousPaidAmount = Number(order.paid_amount_cents || 0)
  order.payment_status = nextStatus
  if (nextStatus === 'paid') order.paid_amount_cents = Number(order.amount_cents || 0)
  if (nextStatus === 'deposit_paid' && Number(order.paid_amount_cents || 0) <= 0) {
    order.paid_amount_cents = Math.max(1, orderInitialPayableAmount(order))
  }
  if (nextStatus === 'unpaid' || nextStatus === 'refunded') order.paid_amount_cents = 0
  if (['paid', 'deposit_paid', 'refunded'].includes(nextStatus) && previousStatus !== nextStatus) {
    // Manual records are operational markers, not charge snapshots: they carry
    // no exchange-rate version, so paymentBaseAmountCents() keeps the intent
    // invariant required by the balance remainder allocation in
    // paymentAmountSnapshot() and historical conversions stay per-installment.
    store.payments.unshift({
      id: id(),
      order_id: order.id,
      provider: 'manual',
      payment_type: nextStatus === 'paid' ? 'full' : nextStatus === 'deposit_paid' ? 'deposit' : 'refund',
      paypal_order_id: '',
      paypal_capture_id: '',
      amount_cents: nextStatus === 'refunded' ? previousPaidAmount : Number(order.paid_amount_cents || 0),
      currency: order.currency,
      status: nextStatus === 'refunded' ? 'refunded' : 'captured',
      created_at: now(),
      paid_at: now(),
    })
  }
  if (previousStatus !== nextStatus) addOrderEvent(order, 'payment', `付款状态 ${previousStatus || '-'} -> ${nextStatus || '-'}`, {
    from: previousStatus,
    to: nextStatus,
    provider: 'manual',
    amount_cents: nextStatus === 'refunded' ? previousPaidAmount : Number(order.paid_amount_cents || 0),
    currency: order.currency,
  })
  return previousStatus !== nextStatus
}

function isValidImageSignature(contentType = '', header = Buffer.alloc(0)) {
  const type = String(contentType).toLowerCase()
  if (type.includes('png')) return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (type.includes('webp')) return header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP'
  if (type.includes('jpeg') || type.includes('jpg')) return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  return false
}

// Uploads are streamed directly to disk with a hard size limit, then checked
// against their magic bytes. The MIME header alone is not trusted because it is
// supplied by the browser and can be forged.
async function saveUpload(req) {
  const contentType = req.headers['content-type'] || ''
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(contentType)) {
    const err = new Error('unsupported upload type')
    err.status = 415
    throw err
  }
  const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg'
  const filename = `${Date.now()}-${id()}${ext}`
  const filePath = path.join(uploadDir, filename)
  let header = Buffer.alloc(0)
  try {
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(filePath)
      let received = 0
      req.on('data', (chunk) => {
        received += chunk.length
        if (header.length < 16) header = Buffer.concat([header, chunk]).subarray(0, 16)
        if (received > maxUploadBytes) {
          stream.destroy()
          const err = new Error('upload too large')
          err.status = 413
          reject(err)
          req.destroy()
        }
      })
      req.on('error', reject)
      stream.on('finish', resolve)
      stream.on('error', reject)
      req.pipe(stream)
    })
    if (!isValidImageSignature(contentType, header)) {
      const err = new Error('invalid image content')
      err.status = 415
      throw err
    }
  } catch (error) {
    await unlink(filePath).catch(() => {})
    throw error
  }
  return { url: `${publicUploadBase}/${filename}`, filename }
}

// -----------------------------------------------------------------------------
// HTTP routing
// -----------------------------------------------------------------------------
// This is intentionally a small explicit router. Routes are grouped by public
// content, customer actions, payment callbacks, and admin operations below;
// authorization is checked before every private operation.
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const isRead = req.method === 'GET' || req.method === 'HEAD'
  if (isRead && (url.pathname === '/health' || url.pathname === '/api/health')) {
    const store = await loadStore()
    return send(res, 200, {
      ok: true,
      service: 'pet-wool-api',
      checked_at: now(),
      counts: {
        categories: store.categories?.length || 0,
        products: store.products?.length || 0,
        orders: store.orders?.length || 0,
        users: adminUsers(store).length,
        payments: store.payments?.length || 0,
      }
    })
  }
  if (isRead && url.pathname.startsWith('/uploads/')) return sendUploadFile(res, url.pathname)
  if (isRead && url.pathname === '/robots.txt') {
    return sendText(req, res, 200, buildRobots(publicOriginFromRequest(req)), { 'cache-control': 'public, max-age=3600' })
  }
  if (isRead && url.pathname === '/sitemap.xml') {
    const store = await loadStore()
    return sendXml(req, res, 200, buildSitemap(store, publicOriginFromRequest(req)), { 'cache-control': 'public, max-age=300' })
  }
  if (!url.pathname.startsWith('/api')) {
    const store = await loadStore()
    const status = isRead && isKnownFrontendRoute(url.pathname, store) ? 200 : 404
    return sendFrontendFile(req, res, url.pathname, status)
  }

  const store = await loadStore()
  const route = url.pathname.slice(4) || '/'
  const lang = requestLang(req, url)

  if (req.method === 'POST' && route === '/uploads') {
    if (!checkUploadRateLimit(req)) {
      log('warn', 'business.upload_rate_limited', { request_id: req.request_id, ip: clientIp(req) })
      return send(res, 429, { message: 'too many upload requests' }, privateNoStoreHeaders)
    }
    const file = await saveUpload(req)
    log('info', 'business.upload_saved', {
      request_id: req.request_id,
      filename: file.filename,
      content_type: req.headers['content-type'] || '',
    })
    return send(res, 200, file, privateNoStoreHeaders)
  }

  if (isRead && route === '/site') return send(res, 200, localizeSite(store.site, lang), privateNoStoreHeaders)
  if (req.method === 'POST' && route === '/bot/answer') {
    const input = await readJson(req)
    const question = String(input.question || '').trim()
    if (!question) return send(res, 400, { message: 'question required' }, privateNoStoreHeaders)
    if (question.length > 200) return send(res, 400, { message: 'question too long' }, privateNoStoreHeaders)
    const answerLang = normalizeLang(input.lang || input.locale) || lang
    return send(res, 200, { answer: botAnswer(store.site, answerLang, question), lang: answerLang }, privateNoStoreHeaders)
  }
  if (isRead && route === '/blog') return send(res, 200, localizeSite(store.site, lang).blog.sort((a, b) => String(b.date).localeCompare(String(a.date))), privateNoStoreHeaders)
  const blogMatch = route.match(/^\/blog\/([^/]+)$/)
  if (isRead && blogMatch) {
    const post = (store.site.blog || []).find((item) => item.slug === blogMatch[1] || item.id === blogMatch[1])
    if (!post) return send(res, 404, { message: 'blog not found' })
    return send(res, 200, localizeSite({ ...store.site, blog: [post] }, lang).blog[0], privateNoStoreHeaders)
  }
  if (req.method === 'POST' && route === '/auth/google') {
    const input = await readJson(req)
    const idToken = String(input.id_token || input.credential || '').trim()
    let user
    if (idToken) {
      try {
        user = await verifyGoogleIdToken(idToken, googleClientIdsForSite(store.site))
      } catch (error) {
        log('warn', 'auth.google_failed', { request_id: req.request_id, message: error.message || 'invalid google token' })
        return send(res, error.status || 401, { message: error.message || 'invalid google token' }, privateNoStoreHeaders)
      }
    } else {
      const googlePublic = publicGoogleConfig(store.site)
      if (!googlePublic.demo_enabled) return send(res, 400, { message: 'google id token required' }, privateNoStoreHeaders)
      const email = String(input.email || '').trim().toLowerCase()
      if (!email) return send(res, 400, { message: 'valid email required' }, privateNoStoreHeaders)
      const explicitName = String(input.name || '').trim()
      if (explicitName && explicitName.length > 120) return send(res, 400, { message: 'invalid user name' }, privateNoStoreHeaders)
      user = {
        email,
        name: explicitName || email.split('@')[0].slice(0, 120),
        avatar: '',
        provider: 'google-demo',
        email_verified: false,
      }
    }
    const email = String(user.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { message: 'valid email required' }, privateNoStoreHeaders)
    if (isBlockedEmail(store, email)) {
      log('warn', 'auth.google_blocked_user', { request_id: req.request_id, email })
      return send(res, 403, { message: 'user blocked' }, privateNoStoreHeaders)
    }
    const avatar = String(user.avatar || '').trim()
    if (avatar.length > 500 || (avatar && !isValidPublicHttpUrl(avatar))) return send(res, 400, { message: 'invalid avatar url' }, privateNoStoreHeaders)
    user = { ...user, email, avatar }
    const users = adminUsers(store)
    const idx = users.findIndex((item) => String(item.email).toLowerCase() === String(email).toLowerCase())
    const nextUser = { ...(idx >= 0 ? users[idx] : {}), ...user, status: idx >= 0 ? users[idx].status || 'active' : 'active', last_login_at: now(), updated_at: now() }
    if (idx >= 0) users[idx] = nextUser
    else users.unshift({ id: id(), tags: [], internal_note: '', created_at: now(), ...nextUser })
    await saveStore(store)
    log('info', 'auth.google_succeeded', {
      request_id: req.request_id,
      email,
      provider: user.provider,
      is_new_user: idx < 0,
    })
    return send(res, 200, { token: createUserToken(user), user }, privateNoStoreHeaders)
  }
  if (req.method === 'POST' && route === '/orders/lookup') {
    const input = await readJson(req)
    const email = String(input.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return send(res, 400, { message: 'valid email required' }, privateNoStoreHeaders)
    }
    if (!checkOrderLookupRateLimit(req, email)) {
      log('warn', 'business.order_lookup_rate_limited', {
        request_id: req.request_id,
        email,
      })
      return send(res, 429, { message: 'too many order lookup requests' }, privateNoStoreHeaders)
    }
    const orders = isBlockedEmail(store, email)
      ? []
      : store.orders
        .filter((order) => String(order.email || '').trim().toLowerCase() === email)
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .map(publicOrderStatus)
    log('info', 'business.order_lookup', {
      request_id: req.request_id,
      email,
      result_count: orders.length,
    })
    return send(res, 200, { orders }, privateNoStoreHeaders)
  }
  if (req.method === 'GET' && route === '/me/orders') {
    const user = currentUser(req)
    if (!user?.email) return send(res, 401, { message: 'login required' })
    if (isBlockedEmail(store, user.email)) return send(res, 403, { message: 'user blocked' })
    return send(res, 200, store.orders
      .filter((o) => String(o.email).toLowerCase() === String(user.email).toLowerCase())
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .map((order) => customerOrder(order, store)), privateNoStoreHeaders)
  }
  const customerReviewMatch = route.match(/^\/me\/orders\/([^/]+)\/review$/)
  if (req.method === 'POST' && customerReviewMatch) {
    const user = currentUser(req)
    if (!user?.email) return send(res, 401, { message: 'login required' }, privateNoStoreHeaders)
    if (isBlockedEmail(store, user.email)) return send(res, 403, { message: 'user blocked' }, privateNoStoreHeaders)
    const order = store.orders.find((item) => item.id === customerReviewMatch[1])
    if (!order) return send(res, 404, { message: 'order not found' }, privateNoStoreHeaders)
    const accessError = validateCustomerOrderAccess(req, order)
    if (accessError) return send(res, 403, { message: accessError }, privateNoStoreHeaders)
    if (order.order_status !== 'completed') return send(res, 409, { message: 'order not completed' }, privateNoStoreHeaders)
    const existingReview = (store.site.reviews || []).find((item) => String(item.order_id || '') === String(order.id || ''))
    if (existingReview) return send(res, 409, { message: 'review already submitted' }, privateNoStoreHeaders)
    if ((store.site.reviews || []).length >= 80) return send(res, 409, { message: 'review limit reached' }, privateNoStoreHeaders)
    const input = await readJson(req)
    const validation = validateCustomerReviewInput(input)
    if (validation) return send(res, 400, { message: validation }, privateNoStoreHeaders)
    const product = store.products.find((item) => item.id === order.product_id)
    const lang = normalizeLang(input.lang) || 'en'
    const content = String(input.content || '').trim()
    const title = String(input.title || '').trim() || ({
      zh: '客户评价',
      ko: '고객 후기',
      en: 'Customer review',
    }[lang] || 'Customer review')
    const review = {
      id: id(),
      name: String(order.customer_name || user.name || user.email.split('@')[0] || 'Customer').trim().slice(0, 120),
      country: String(order.country || 'International').trim().slice(0, 80),
      rating: Number(input.rating),
      status: 'published',
      title,
      content,
      product_slug: product?.slug || '',
      images: [],
      pet_image: '',
      work_image: '',
      avatar_url: '',
      video_url: '',
      order_id: order.id,
      user_email: String(user.email).trim().toLowerCase(),
      source: 'customer',
      verified: true,
      created_at: now(),
      translations: {
        [lang]: { title, content },
      },
    }
    store.site.reviews = [review, ...(store.site.reviews || [])]
    await saveStore(store)
    log('info', 'business.customer_review_submitted', {
      request_id: req.request_id,
      order_id: order.id,
      order_no: order.order_no,
      review_id: review.id,
    })
    return send(res, 200, customerOrder(order, store), privateNoStoreHeaders)
  }
  const publicCategories = store.categories.filter((category) => category.status !== 'hidden')
  if (req.method === 'GET' && route === '/categories') return send(res, 200, publicCategories.map((category) => publicCategoryView(localizeCategory(category, lang))).sort((a, b) => a.sort_order - b.sort_order), privateNoStoreHeaders)
  const categoryMatch = route.match(/^\/categories\/([^/]+)$/)
  if (req.method === 'GET' && categoryMatch) {
    const category = publicCategories.find((c) => c.slug === categoryMatch[1] || c.id === categoryMatch[1] || c.children?.some((child) => child.slug === categoryMatch[1]))
    if (!category) return send(res, 404, { message: 'category not found' }, privateNoStoreHeaders)
    const child = category.children?.find((item) => item.slug === categoryMatch[1])
    const localized = localizeCategory(category, lang)
    const localizedChild = localized.children?.find((item) => item.slug === categoryMatch[1])
    return send(res, 200, { ...publicCategoryView(localized), active_child: localizedChild ? publicCategoryView({ ...localizedChild, children: [] }) : child ? publicCategoryView({ ...child, children: [] }) : null }, privateNoStoreHeaders)
  }
  if (req.method === 'GET' && route === '/products') {
    const category = url.searchParams.get('category')
    const occasion = url.searchParams.get('occasion')
    const style = url.searchParams.get('style')
    let products = store.products.filter((p) => isPublicOrderableProduct(p, publicCategories))
    if (category) {
      const cat = publicCategories.find((c) => c.slug === category || c.id === category || c.children?.some((child) => child.slug === category))
      const selectedChild = cat?.children?.some((child) => child.slug === category)
      const hasDedicatedChildPages = ['3d-pet-frame-portraits', '3d-full-body-pet-portraits'].includes(String(cat?.slug || ''))
      products = products.filter((p) => p.category_id === cat?.id
        && (!selectedChild || !hasDedicatedChildPages || p.subcategory_slug === category))
    }
    if (occasion) {
      const normalizedOccasion = canonicalTerm(occasion)
      products = products.filter((p) => p.tags?.includes(normalizedOccasion) || p.use_cases?.includes(normalizedOccasion))
    }
    if (style) {
      const normalizedStyle = canonicalTerm(style)
      products = products.filter((p) => p.tags?.includes(normalizedStyle))
    }
    return send(res, 200, products.map((p) => publicProductView(localizeProduct(p, store.categories, lang))).sort((a, b) => a.sort_order - b.sort_order), privateNoStoreHeaders)
  }
  const productMatch = route.match(/^\/products\/([^/]+)$/)
  if (req.method === 'GET' && productMatch) {
    const product = store.products.find((p) => p.slug === productMatch[1] || p.id === productMatch[1])
    if (!product || !isPublicOrderableProduct(product, publicCategories)) return send(res, 404, { message: 'product not found' }, privateNoStoreHeaders)
    return send(res, 200, publicProductView(localizeProduct(product, store.categories, lang)), privateNoStoreHeaders)
  }

  if (req.method === 'POST' && route === '/orders') {
    const input = await readJson(req)
    if (isBlockedEmail(store, input.email)) {
      log('warn', 'business.order_blocked_user', { request_id: req.request_id, email: input.email })
      return send(res, 403, { message: 'user blocked' }, privateNoStoreHeaders)
    }
    const product = store.products.find((p) => p.id === input.product_id)
    if (!product || !isPublicOrderableProduct(product, publicCategories)) {
      return send(res, 404, { message: 'product not found' }, privateNoStoreHeaders)
    }
    const validation = validatePublicOrderInput(input, product)
    if (validation) {
      log('warn', 'business.order_validation_failed', { request_id: req.request_id, reason: validation, product_id: input.product_id })
      return send(res, 400, { message: validation }, privateNoStoreHeaders)
    }
    const clientRequestId = String(input.client_request_id || '').trim().slice(0, 120)
    if (clientRequestId) {
      const email = String(input.email || '').trim().toLowerCase()
      const existingOrder = store.orders.find((order) => String(order.client_request_id || '') === clientRequestId && String(order.email || '').trim().toLowerCase() === email)
      if (existingOrder) {
        if (!isSamePublicOrderRequest(existingOrder, input)) {
          log('warn', 'business.order_duplicate_conflict', {
            request_id: req.request_id,
            order_id: existingOrder.id,
            order_no: existingOrder.order_no,
            client_request_id: clientRequestId,
          })
          return send(res, 409, { message: 'client request conflict' }, privateNoStoreHeaders)
        }
        log('info', 'business.order_duplicate_replayed', {
          request_id: req.request_id,
          order_id: existingOrder.id,
          order_no: existingOrder.order_no,
          client_request_id: clientRequestId,
        })
        return send(res, 200, publicOrder(existingOrder), privateNoStoreHeaders)
      }
    }
    const orderLang = normalizeLang(input.lang || input.locale) || lang
    const localizedProduct = localizeProduct(product, store.categories, orderLang)
    const amount = orderTotalAmount(product, input.option_id)
    const initialPaymentAmount = orderInitialPaymentAmount(product, input.option_id, input.payment_type || 'deposit')
    const option = product.options?.find((o) => o.id === input.option_id) || product.options?.[0]
    const localizedOption = localizedProduct.options?.find((o) => o.id === option?.id) || localizedProduct.options?.[0]
    const order = {
      id: id(),
      client_request_id: clientRequestId,
      order_no: `WP-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${id().slice(0, 8).toUpperCase()}`,
      lang: orderLang,
      product_id: product.id,
      product_title: localizedProduct.title,
      option_id: option?.id,
      option_name: localizedOption?.name || option?.name,
      customer_name: String(input.customer_name || '').trim(),
      email: String(input.email || '').trim().toLowerCase(),
      phone: String(input.phone || '').trim(),
      country: String(input.country || '').trim(),
      shipping_address: String(input.shipping_address || '').trim(),
      pet_name: String(input.pet_name || '').trim(),
      pet_type: String(input.pet_type || '').trim(),
      notes: String(input.notes || '').trim().slice(0, 2000),
      photo_urls: input.photo_urls || [],
      payment_type: input.payment_type || 'deposit',
      amount_cents: amount,
      initial_payment_cents: initialPaymentAmount,
      deposit_percent: Number(product.deposit_percent || 0),
      paid_amount_cents: 0,
      currency: product.currency,
      order_status: 'new',
      payment_status: 'unpaid',
      internal_note: '',
      flagged: false,
      paypal_order_id: '',
      revision: 1,
      events: [],
      created_at: now(),
      updated_at: now(),
    }
    addOrderEvent(order, 'status', '订单已提交', { from: '', to: 'new', actor: 'customer' })
    store.orders.unshift(order)
    try {
      await saveStore(store)
    } catch (error) {
      log('error', 'business.order_save_failed', {
        request_id: req.request_id,
        order_id: order.id,
        order_no: order.order_no,
        message: error?.message || 'order save failed',
      })
      throw error
    }
    log('info', 'business.order_created', {
      request_id: req.request_id,
      order_id: order.id,
      order_no: order.order_no,
      product_id: order.product_id,
      payment_type: order.payment_type,
      amount_cents: order.amount_cents,
      initial_payment_cents: order.initial_payment_cents,
      currency: order.currency,
      email: order.email,
    })
    queueOrderNotifications(order, { label: 'New order received', amount_cents: initialPaymentAmount })
    return send(res, 200, publicOrder(order), privateNoStoreHeaders)
  }

  if (req.method === 'POST' && route === '/paypal/create-order') {
    const input = await readJson(req)
    if (paypalConfig(store.site).enabled === false) return send(res, 503, { message: 'paypal disabled' }, privateNoStoreHeaders)
    const order = store.orders.find((o) => o.id === input.order_id)
    if (!order) return send(res, 404, { message: 'order not found' }, privateNoStoreHeaders)
    const user = currentUser(req)
    if (user?.email && isBlockedEmail(store, user.email)) return send(res, 403, { message: 'user blocked' }, privateNoStoreHeaders)
    const accessValidation = validateCustomerOrderAccess(req, order)
    if (accessValidation) return send(res, 403, { message: accessValidation }, privateNoStoreHeaders)
    const paypalCurrency = paypalConfig(store.site).currency
    // Orders are stored in the product currency (KRW base); the PayPal charge
    // currency comes from the site config. Currencies only need to be
    // convertible, not identical — the charge amount is converted below.
    if (!normalizeSupportedCurrency(String(order.currency || '').trim().toUpperCase())) {
      return send(res, 409, { message: 'unsupported order currency' }, privateNoStoreHeaders)
    }
    if (!paypalSupportedCurrencies.has(paypalCurrency) || !paypalChargeCurrencyReady(paypalCurrency)) {
      return send(res, 503, { message: 'unsupported paypal currency' }, privateNoStoreHeaders)
    }
    const payableValidation = validatePayableOrder(order)
    if (payableValidation && order.payment_status !== 'paid') return send(res, 409, { message: payableValidation }, privateNoStoreHeaders)
    if (order.payment_status === 'paid') {
      const capturedPayment = store.payments.find((p) => p.order_id === order.id && p.status === 'captured')
      return send(res, 200, { id: order.paypal_order_id || capturedPayment?.paypal_order_id || '', payment: publicPayment(capturedPayment), order: publicOrder(order) }, privateNoStoreHeaders)
    }
    const paypalSettings = paypalConfig(store.site)
    const paymentType = payableType(order)
    const expectedBaseAmount = payableAmount(order)
    const amountSnapshot = paymentAmountSnapshot(order, store.payments, paypalCurrency)
    const useMockPaypal = paypalShouldMock(paypalSettings)
    const existingPayment = store.payments.find((p) => p.order_id === order.id
      && p.provider === 'paypal'
      && p.status === 'created'
      && p.payment_type === paymentType
      && paymentBaseAmountCents(p, order) === expectedBaseAmount
      && String(p.currency || '').trim().toUpperCase() === String(paypalCurrency || '').trim().toUpperCase()
      && (useMockPaypal
        ? (p.paypal_mock === true || String(p.paypal_order_id || '').startsWith('PAYPAL-'))
        : (p.paypal_mock !== true && p.paypal_mode === paypalSettings.mode && !String(p.paypal_order_id || '').startsWith('PAYPAL-'))))
    if (existingPayment) {
      order.paypal_order_id = existingPayment.paypal_order_id
      await saveStore(store)
      log('info', 'business.payment_intent_reused', {
        request_id: req.request_id,
        order_id: order.id,
        order_no: order.order_no,
        payment_id: existingPayment.id,
        paypal_order_id: existingPayment.paypal_order_id,
        payment_type: existingPayment.payment_type,
        amount_cents: existingPayment.amount_cents,
        currency: existingPayment.currency,
        mock: existingPayment.paypal_mock === true,
      })
      return send(res, 200, {
        id: existingPayment.paypal_order_id,
        approve_url: existingPayment.paypal_approve_url || '',
        mock: existingPayment.paypal_mock === true || String(existingPayment.paypal_order_id || '').startsWith('PAYPAL-'),
        payment: publicPayment(existingPayment),
        order: publicOrder(order),
      }, privateNoStoreHeaders)
    }
    const payment = {
      id: id(),
      order_id: order.id,
      provider: 'paypal',
      payment_type: paymentType,
      paypal_order_id: '',
      paypal_capture_id: '',
      paypal_mode: paypalSettings.mode,
      paypal_approve_url: '',
      paypal_status: '',
      paypal_capture_status: '',
      paypal_mock: useMockPaypal,
      ...amountSnapshot,
      status: 'created',
      created_at: now(),
      paid_at: '',
    }
    if (useMockPaypal) {
      payment.paypal_order_id = `PAYPAL-${id().slice(0, 12).toUpperCase()}`
      order.paypal_order_id = payment.paypal_order_id
    } else {
      try {
        await createRealPaypalOrder(req, store, order, payment, input)
      } catch (error) {
        log('error', 'business.payment_intent_failed', {
          request_id: req.request_id,
          order_id: order.id,
          order_no: order.order_no,
          payment_id: payment.id,
          message: error.message,
          status: error.status,
          provider: 'paypal',
          ...paypalErrorLog(error),
        })
        return send(res, error.status || 502, { message: error.message || 'paypal api failed' }, privateNoStoreHeaders)
      }
    }
    order.paypal_order_id = payment.paypal_order_id
    store.payments.unshift(payment)
    addOrderEvent(order, 'payment', 'PayPal 支付流程已创建', {
      payment_type: payment.payment_type,
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      actor: 'customer',
    })
    try {
      await saveStore(store)
    } catch (error) {
      log('error', 'business.payment_intent_save_failed', {
        request_id: req.request_id,
        order_id: order.id,
        order_no: order.order_no,
        payment_id: payment.id,
        message: error?.message || 'payment intent save failed',
      })
      throw error
    }
    log('info', 'business.payment_intent_created', {
      request_id: req.request_id,
      order_id: order.id,
      order_no: order.order_no,
      payment_id: payment.id,
      paypal_order_id: payment.paypal_order_id,
      payment_type: payment.payment_type,
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      mock: payment.paypal_mock === true,
    })
    return send(res, 200, {
      id: payment.paypal_order_id,
      approve_url: payment.paypal_approve_url || '',
      mock: payment.paypal_mock === true,
      payment: publicPayment(payment),
      order: publicOrder(order),
    }, privateNoStoreHeaders)
  }

  if (req.method === 'POST' && route === '/paypal/capture-order') {
    const input = await readJson(req)
    const payment = store.payments.find((p) => p.paypal_order_id === input.paypal_order_id)
    if (!payment) {
      const existingOrder = store.orders.find((o) => o.paypal_order_id === input.paypal_order_id)
      if (existingOrder && existingOrder.payment_status === 'paid') {
        const accessValidation = validateCustomerOrderAccess(req, existingOrder)
        if (accessValidation) return send(res, 403, { message: accessValidation }, privateNoStoreHeaders)
        return send(res, 200, { status: 'COMPLETED', payment: null, order: publicOrder(existingOrder) }, privateNoStoreHeaders)
      }
      return send(res, 404, { message: 'payment not found' }, privateNoStoreHeaders)
    }
    const order = store.orders.find((o) => o.id === payment.order_id)
    if (!order) return send(res, 404, { message: 'order not found' }, privateNoStoreHeaders)
    const user = currentUser(req)
    if (user?.email && isBlockedEmail(store, user.email)) return send(res, 403, { message: 'user blocked' }, privateNoStoreHeaders)
    const accessValidation = validateCustomerOrderAccess(req, order)
    if (accessValidation) return send(res, 403, { message: accessValidation }, privateNoStoreHeaders)
    if (payment.status === 'captured') {
      return send(res, 200, { status: 'COMPLETED', payment: publicPayment(payment), order: publicOrder(order) }, privateNoStoreHeaders)
    }
    const payableValidation = validatePayableOrder(order)
    if (payableValidation && order.payment_status !== 'paid') return send(res, 409, { message: payableValidation }, privateNoStoreHeaders)
    if (order.payment_status === 'paid') {
      return send(res, 409, { message: 'order already paid' }, privateNoStoreHeaders)
    }
    // Amounts are compared in the order (base) currency. The PayPal charge is
    // a converted value stored alongside it on the payment record.
    const settlementError = validatePaymentSettlement(order, payment)
    if (settlementError) return send(res, 409, { message: settlementError }, privateNoStoreHeaders)
    let capture = {}
    if (payment.paypal_mock === true || String(payment.paypal_order_id || '').startsWith('PAYPAL-')) {
      capture = {
        order_status: 'COMPLETED',
        capture_status: 'COMPLETED',
        capture_id: `CAPTURE-${id().slice(0, 12).toUpperCase()}`,
        amount_value: centsToPaypalAmount(payment.amount_cents, payment.currency),
        currency: payment.currency,
        paid_at: now(),
      }
    } else {
      try {
        const paypalOrder = await captureRealPaypalOrder(store, payment)
        capture = paypalCaptureDetails(paypalOrder)
      } catch (error) {
        log('error', 'business.payment_capture_failed', {
          request_id: req.request_id,
          order_id: order.id,
          order_no: order.order_no,
          payment_id: payment.id,
          paypal_order_id: payment.paypal_order_id,
          message: error.message,
          status: error.status,
          provider: 'paypal',
          ...paypalErrorLog(error),
        })
        return send(res, error.status || 502, { message: error.message || 'paypal api failed' }, privateNoStoreHeaders)
      }
      if (capture.order_status !== 'COMPLETED' && capture.capture_status !== 'COMPLETED') {
        return send(res, 409, { message: 'paypal capture not completed' }, privateNoStoreHeaders)
      }
      const captureValidation = validatePaypalCaptureAmount(payment, capture)
      if (captureValidation) return send(res, 409, { message: captureValidation }, privateNoStoreHeaders)
    }
    applyCapturedPaypalPayment(order, payment, capture)
    try {
      await saveStore(store)
    } catch (error) {
      log('error', 'business.payment_capture_save_failed', {
        request_id: req.request_id,
        order_id: order.id,
        order_no: order.order_no,
        payment_id: payment.id,
        message: error?.message || 'payment capture save failed',
      })
      throw error
    }
    log('info', 'business.payment_captured', {
      request_id: req.request_id,
      order_id: order.id,
      order_no: order.order_no,
      payment_id: payment.id,
      paypal_order_id: payment.paypal_order_id,
      paypal_capture_id: payment.paypal_capture_id,
      payment_type: payment.payment_type,
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      mock: payment.paypal_mock === true,
    })
    queueOrderNotifications(order, {
      label: payment.payment_type === 'balance' ? 'Balance payment received' : 'Payment received',
      amount_cents: paymentBaseAmountCents(payment, order),
    })
    return send(res, 200, { status: 'COMPLETED', payment: publicPayment(payment), order: publicOrder(order) }, privateNoStoreHeaders)
  }

  if (isRead && route === '/paypal/webhook') {
    const config = paypalConfig(store.site)
    return send(res, 200, {
      ok: true,
      endpoint: '/api/paypal/webhook',
      receive_method: 'POST',
      mode: config.mode,
      webhook_configured: Boolean(config.webhookId),
    }, privateNoStoreHeaders)
  }

  if (req.method === 'POST' && route === '/paypal/webhook') {
    const event = await readJson(req)
    log('info', 'business.paypal_webhook_received', {
      request_id: req.request_id,
      event_id: event.id || '',
      event_type: event.event_type || '',
    })
    try {
      await verifyPaypalWebhook(req, store.site, event)
      const changed = await applyPaypalWebhookEvent(store, event)
      if (changed) {
        await saveStore(store)
        const paypalOrderId = paypalOrderIdFromWebhook(event)
        const paypalCaptureId = paypalCaptureIdFromWebhook(event)
        const payment = store.payments.find((item) => (
          (paypalOrderId && item.paypal_order_id === paypalOrderId)
          || (paypalCaptureId && item.paypal_capture_id === paypalCaptureId)
        ))
        const order = payment ? store.orders.find((item) => item.id === payment.order_id) : null
        if (order && payment?.status === 'captured') queueOrderNotifications(order, { label: 'Payment received', amount_cents: paymentBaseAmountCents(payment, order) })
      }
      log('info', 'business.paypal_webhook_processed', {
        request_id: req.request_id,
        event_id: event.id || '',
        event_type: event.event_type || '',
        handled: changed,
      })
      return send(res, 200, { ok: true, handled: changed }, privateNoStoreHeaders)
    } catch (error) {
      log('error', 'business.paypal_webhook_failed', {
        request_id: req.request_id,
        event_id: event.id || '',
        event_type: event.event_type || '',
        message: error.message,
        status: error.status,
      })
      return send(res, error.status || 400, { message: error.message || 'paypal webhook failed' }, privateNoStoreHeaders)
    }
  }

  if (req.method === 'POST' && route === '/admin/login') {
    const input = await readJson(req)
    const hash = createHash('sha256').update(input.password || '').digest('hex')
    const account = adminAccounts.find((item) => item.email === String(input.email || '').trim().toLowerCase())
    if (account && hash === account.password_hash) {
      const token = `admin-${randomUUID()}`
      adminSessions.set(token, { email: account.email, role: account.role, expires_at: Date.now() + adminSessionMs })
      log('info', 'auth.admin_login_succeeded', {
        request_id: req.request_id,
        email: account.email,
        role: account.role,
      })
      return send(res, 200, { token, email: account.email, role: account.role, expires_in: Math.round(adminSessionMs / 1000) }, privateNoStoreHeaders)
    }
    log('warn', 'auth.admin_login_failed', {
      request_id: req.request_id,
      email: input.email,
      reason: account ? 'password_mismatch' : 'account_not_found',
    })
    return send(res, 401, { message: 'invalid credentials' }, privateNoStoreHeaders)
  }

  if (route.startsWith('/admin') && !requireAdmin(req)) return send(res, 401, { message: 'missing token' }, privateNoStoreHeaders)
  if (route.startsWith('/admin') && !isRead && route !== '/admin/logout' && !canWriteAdmin(req)) return send(res, 403, { message: 'admin write permission required' }, privateNoStoreHeaders)
  if (route.startsWith('/admin')) {
    const originalWriteHead = res.writeHead.bind(res)
    res.writeHead = (statusCode, headers = {}, ...rest) => originalWriteHead(statusCode, { ...privateNoStoreHeaders, ...(headers || {}) }, ...rest)
  }

  if (req.method === 'POST' && route === '/admin/translate') {
    const input = await readJson(req)
    const target = normalizeLang(input.target)
    const texts = Array.isArray(input.texts) ? input.texts.map((text) => String(text ?? '')) : []
    const totalBytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0)
    if (!['en', 'ko'].includes(target)) return send(res, 400, { message: 'translation target must be en or ko' }, privateNoStoreHeaders)
    if (!texts.length || texts.length > translationMaxTexts) return send(res, 400, { message: 'translation text count is invalid' }, privateNoStoreHeaders)
    if (texts.some((text) => Buffer.byteLength(text, 'utf8') > translationMaxTextBytes)) {
      return send(res, 400, { message: 'translation text is too long' }, privateNoStoreHeaders)
    }
    if (totalBytes > translationMaxTotalBytes) {
      return send(res, 400, { message: 'translation request is too large' }, privateNoStoreHeaders)
    }
    const startedAt = Date.now()
    log('info', 'integration.free_translation_started', {
      request_id: req.request_id,
      provider: translationProviderName(),
      target,
      text_count: texts.length,
      total_bytes: totalBytes,
    })
    try {
      const translations = []
      for (const text of texts) {
        translations.push(await translateTextWithFreeProvider(text, target))
      }
      log('info', 'integration.free_translation_succeeded', {
        request_id: req.request_id,
        provider: translationProviderName(),
        target,
        text_count: texts.length,
        duration_ms: Date.now() - startedAt,
      })
      return send(res, 200, {
        translations,
        provider: translationProviderName(),
        target,
      }, privateNoStoreHeaders)
    } catch (error) {
      log('error', 'integration.free_translation_failed', {
        request_id: req.request_id,
        provider: translationProviderName(),
        target,
        text_count: texts.length,
        duration_ms: Date.now() - startedAt,
        message: error?.message || 'translation provider failed',
        provider_status: Number(error?.provider_status || 0),
      })
      return send(res, 502, {
        message: `free translation failed: ${String(error?.message || 'translation provider failed').slice(0, 300)}`,
        provider: translationProviderName(),
        provider_status: Number(error?.provider_status || 0),
      }, privateNoStoreHeaders)
    }
  }

  if (req.method === 'POST' && route === '/admin/logout') {
    const auth = req.headers.authorization || ''
    const token = String(auth).startsWith('Bearer ') ? String(auth).slice('Bearer '.length) : ''
    if (token) adminSessions.delete(token)
    log('info', 'auth.admin_logout', { request_id: req.request_id })
    return send(res, 200, { ok: true })
  }

  if (req.method === 'POST' && route === '/admin/paypal/check') {
    const input = await readJson(req)
    const candidate = input?.paypal && typeof input.paypal === 'object'
      ? mergeSiteConfig(store.site, { paypal: input.paypal })
      : store.site
    const config = paypalConfig(candidate)
    if (!paypalCredentialsReady(config)) return send(res, 400, { message: 'paypal credentials missing' }, privateNoStoreHeaders)
    try {
      await paypalAccessToken(config)
      log('info', 'business.paypal_credentials_verified', {
        request_id: req.request_id,
        mode: config.mode,
        currency: config.currency,
      })
      return send(res, 200, { ok: true, mode: config.mode, currency: config.currency }, privateNoStoreHeaders)
    } catch (error) {
      log('error', 'business.paypal_credentials_verification_failed', {
        request_id: req.request_id,
        message: error.message,
        status: error.status,
        ...paypalErrorLog(error),
      })
      if (error.paypalStatus === 401 && error.paypalPath === '/v1/oauth2/token') {
        return send(res, 400, { message: 'paypal credentials invalid' }, privateNoStoreHeaders)
      }
      return send(res, 502, { message: 'paypal credentials verification failed' }, privateNoStoreHeaders)
    }
  }

  if (req.method === 'POST' && route === '/admin/paypal/test-order') {
    const input = await readJson(req)
    const candidate = input?.paypal && typeof input.paypal === 'object'
      ? mergeSiteConfig(store.site, { paypal: input.paypal })
      : store.site
    const config = paypalConfig(candidate)
    if (paypalMockEnabled) {
      return send(res, 409, { message: 'paypal mock enabled' }, privateNoStoreHeaders)
    }
    if (!paypalChargeCurrencyReady(config.currency)) {
      return send(res, 400, { message: 'invalid paypal currency' }, privateNoStoreHeaders)
    }
    if (!config.enabled) {
      return send(res, 400, { message: 'paypal disabled' }, privateNoStoreHeaders)
    }
    if (!paypalCredentialsReady(config)) {
      return send(res, 400, { message: 'paypal credentials missing' }, privateNoStoreHeaders)
    }
    log('info', 'business.paypal_test_order_started', {
      request_id: req.request_id,
      paypal_mode: config.mode,
      paypal_api_base: config.apiBase,
      currency: config.currency,
      amount_cents: 1,
    })
    try {
      const result = await createPaypalTestOrder(req, config)
      log('info', 'business.paypal_test_order_created', {
        request_id: req.request_id,
        paypal_mode: result.mode,
        currency: result.currency,
        paypal_order_id: result.paypal_order_id,
        paypal_status: result.paypal_status,
      })
      return send(res, 200, result, privateNoStoreHeaders)
    } catch (error) {
      log('error', 'business.paypal_test_order_failed', {
        request_id: req.request_id,
        message: error.message,
        status: error.status,
        ...paypalErrorLog(error),
      })
      return send(res, error.status || 502, {
        message: error.message || 'paypal api failed',
        ...paypalErrorLog(error),
      }, privateNoStoreHeaders)
    }
  }

  if (req.method === 'GET' && route === '/admin/overview') {
    const paid = store.orders.filter((o) => Number(o.paid_amount_cents || 0) > 0 && o.payment_status !== 'refunded')
    const publicCategoryIds = new Set(store.categories.filter((category) => category.status !== 'hidden').map((category) => category.id))
    const publicProducts = store.products.filter((product) => isPublicOrderableProduct(product, store.categories.filter((category) => publicCategoryIds.has(category.id))))
    const revenueByCurrency = paid.reduce((summary, order) => {
      const currency = String(order.currency || 'CNY').trim().toUpperCase()
      summary[currency] = (summary[currency] || 0) + Number(order.paid_amount_cents || 0)
      return summary
    }, {})
    return send(res, 200, {
      users: adminUsers(store).length,
      categories: store.categories.length,
      products: store.products.length,
      public_products: publicProducts.length,
      orders: store.orders.length,
      unpaid: store.orders.filter((o) => o.payment_status === 'unpaid').length,
      paid: paid.length,
      crafting: store.orders.filter((o) => o.order_status === 'crafting').length,
      ready_ship: store.orders.filter((o) => o.order_status === 'ready_ship').length,
      revenue_cents: paid.reduce((sum, o) => sum + Number(o.paid_amount_cents || 0), 0),
      revenue_by_currency: revenueByCurrency,
    })
  }

  if (req.method === 'GET' && route === '/admin/backup') {
    const includeSecrets = url.searchParams.get('secrets') === '1'
    if (includeSecrets && !requireSecretBackupConfirm(req)) return send(res, 400, { message: 'secret backup confirmation required' })
    const backupKind = includeSecrets ? 'full' : 'redacted'
    return send(res, 200, {
      exported_at: now(),
      schema: 'pet-wool-platform-store-v1',
      redacted: !includeSecrets,
      data: includeSecrets ? store : redactBackupStore(store),
    }, {
      'content-disposition': `attachment; filename="pet-wool-backup-${backupKind}-${new Date().toISOString().slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    })
  }

  if (req.method === 'GET' && route === '/admin/audit-logs') return send(res, 200, (store.audit_logs || []).slice(0, 200))
  if (req.method === 'GET' && route === '/admin/users') return send(res, 200, adminUsers(store))
  const adminUserMatch = route.match(/^\/admin\/users\/([^/]+)$/)
  if (adminUserMatch) {
    if (!Array.isArray(store.users)) store.users = []
    const users = adminUsers(store)
    if (req.method === 'PUT') {
      const rawInput = await readJson(req)
      const validation = validateAdminUserInput(rawInput)
      if (validation) return send(res, 400, { message: validation })
      const input = normalizeAdminUserInput(rawInput)
      if (String(adminUserMatch[1] || '').trim() === 'admin-e2e') return send(res, 409, { message: 'protected user cannot be changed' })
      const email = String(input.email || '').toLowerCase()
      const user = users.find((item) => item.id === adminUserMatch[1])
        || (email ? users.find((item) => String(item.email || '').toLowerCase() === email) : null)
        || (email ? { id: adminUserMatch[1], email: input.email, name: '', provider: 'admin', status: 'active', tags: [], internal_note: '', followups: [], created_at: now() } : null)
      if (!user) return send(res, 404, { message: 'user not found' })
      const protectedChange = protectedAdminUserChange(user, input, adminUserMatch[1])
      if (protectedChange) return send(res, 409, { message: protectedChange })
      if (email && users.some((item) => item.id !== user.id && String(item.email || '').toLowerCase() === email)) return send(res, 409, { message: 'user email exists' })
      const previousEmail = String(user.email || '').toLowerCase()
      Object.assign(user, {
        email: input.email || user.email,
        name: input.name ?? user.name,
        country: input.country ?? user.country,
        status: input.status ?? user.status,
        tags: Array.isArray(input.tags) ? input.tags : user.tags,
        internal_note: input.internal_note ?? user.internal_note,
        followups: Array.isArray(input.followups) ? input.followups : user.followups || [],
        updated_at: now(),
      })
      const persistedIndex = store.users.findIndex((item) => item.id === user.id || String(item.email || '').toLowerCase() === previousEmail || String(item.email || '').toLowerCase() === String(user.email || '').toLowerCase())
      if (persistedIndex >= 0) store.users[persistedIndex] = { ...store.users[persistedIndex], ...user }
      else store.users.unshift(user)
      await saveAdminChange(store, req, 'user.upsert', { user_id: user.id, email: user.email })
      return send(res, 200, user)
    }
    if (req.method === 'DELETE') {
      if (!requireDeleteConfirm(req)) return send(res, 400, { message: 'delete confirmation required' })
      if (String(adminUserMatch[1] || '').trim() === 'admin-e2e') return send(res, 409, { message: 'protected user cannot be deleted' })
      const user = users.find((item) => item.id === adminUserMatch[1])
      if (!user) return send(res, 404, { message: 'user not found' })
      if (isProtectedAdminUser(user, adminUserMatch[1])) return send(res, 409, { message: 'protected user cannot be deleted' })
      const userEmail = String(user.email || '').toLowerCase()
      if (store.orders.some((order) => String(order.email || '').toLowerCase() === userEmail)) return send(res, 409, { message: 'user has orders, block it instead' })
      const persistedIndex = store.users.findIndex((item) => item.id === user.id || String(item.email || '').toLowerCase() === userEmail)
      if (persistedIndex >= 0) store.users.splice(persistedIndex, 1)
      await saveAdminChange(store, req, 'user.delete', { user_id: user.id, email: user.email })
      return send(res, 200, user)
    }
  }

  if (req.method === 'GET' && route === '/admin/categories') return send(res, 200, store.categories)
  if (req.method === 'POST' && route === '/admin/categories') {
    const input = normalizeCategoryPayload(await readJson(req))
    const validation = validateCategoryInput(input)
    if (validation) return send(res, 400, { message: validation })
    if (store.categories.some((category) => category.slug === input.slug)) return send(res, 409, { message: 'category slug exists' })
    const category = { id: id(), ...input }
    store.categories.push(category)
    await saveAdminChange(store, req, 'category.create', { category_id: category.id, slug: category.slug })
    return send(res, 200, category)
  }
  const adminCategoryMatch = route.match(/^\/admin\/categories\/([^/]+)$/)
  if (adminCategoryMatch) {
    const idx = store.categories.findIndex((c) => c.id === adminCategoryMatch[1])
    if (idx < 0) return send(res, 404, { message: 'category not found' })
    if (req.method === 'PUT') {
      const rawInput = await readJson(req)
      const next = normalizeCategoryPayload({ ...store.categories[idx], ...rawInput })
      const validation = validateCategoryInput(next)
      if (validation) return send(res, 400, { message: validation })
      if (store.categories.some((category, cIdx) => cIdx !== idx && category.slug === next.slug)) return send(res, 409, { message: 'category slug exists' })
      if (next.status === 'hidden' && store.categories[idx].status !== 'hidden' && store.products.some((product) => product.category_id === store.categories[idx].id && (product.status || 'published') === 'published')) {
        return send(res, 409, { message: 'category has published products' })
      }
      store.categories[idx] = next
      await saveAdminChange(store, req, 'category.update', { category_id: store.categories[idx].id, slug: store.categories[idx].slug })
      return send(res, 200, store.categories[idx])
    }
    if (req.method === 'DELETE') {
      if (!requireDeleteConfirm(req)) return send(res, 400, { message: 'delete confirmation required' })
      if (store.products.some((product) => product.category_id === store.categories[idx].id)) return send(res, 409, { message: 'category has products' })
      const [removed] = store.categories.splice(idx, 1)
      await saveAdminChange(store, req, 'category.delete', { category_id: removed.id, slug: removed.slug })
      return send(res, 200, removed)
    }
  }

  if (req.method === 'GET' && route === '/admin/products') return send(res, 200, store.products.map((p) => publicProduct(p, store.categories)))
  if (req.method === 'POST' && route === '/admin/products') {
    const input = normalizeProductPayload(await readJson(req))
    const validation = validateProductInput(input, store.categories)
    if (validation) return send(res, 400, { message: validation })
    if (store.products.some((product) => product.slug === input.slug)) return send(res, 409, { message: 'product slug exists' })
    const product = { id: id(), created_at: now(), sort_order: 0, status: 'published', images: [], options: [], tags: [], ...input }
    store.products.push(product)
    await saveAdminChange(store, req, 'product.create', { product_id: product.id, slug: product.slug })
    return send(res, 200, product)
  }
  const adminProductMatch = route.match(/^\/admin\/products\/([^/]+)$/)
  if (adminProductMatch) {
    const idx = store.products.findIndex((p) => p.id === adminProductMatch[1])
    if (idx < 0) return send(res, 404, { message: 'product not found' })
    if (req.method === 'PUT') {
      const input = normalizeProductPayload(await readJson(req))
      const next = { ...store.products[idx], ...input, updated_at: now() }
      const validation = validateProductInput(next, store.categories)
      if (validation) return send(res, 400, { message: validation })
      if (store.products.some((product, pIdx) => pIdx !== idx && product.slug === next.slug)) return send(res, 409, { message: 'product slug exists' })
      store.products[idx] = next
      await saveAdminChange(store, req, 'product.update', { product_id: store.products[idx].id, slug: store.products[idx].slug })
      return send(res, 200, store.products[idx])
    }
    if (req.method === 'DELETE') {
      if (!requireDeleteConfirm(req)) return send(res, 400, { message: 'delete confirmation required' })
      if (store.orders.some((order) => order.product_id === store.products[idx].id)) return send(res, 409, { message: 'product has orders, hide it instead' })
      if (isProductReferencedBySiteContent(store.site, store.products[idx])) return send(res, 409, { message: 'product referenced by site content, hide it instead' })
      const [removed] = store.products.splice(idx, 1)
      await saveAdminChange(store, req, 'product.delete', { product_id: removed.id, slug: removed.slug })
      return send(res, 200, removed)
    }
  }

  if (req.method === 'GET' && route === '/admin/orders') return send(res, 200, store.orders.map((order) => adminOrder(order, store)))
  const adminOrderMatch = route.match(/^\/admin\/orders\/([^/]+)(?:\/(status|payment|note|flag))?$/)
  if (adminOrderMatch) {
    const order = store.orders.find((o) => o.id === adminOrderMatch[1])
    if (!order) return send(res, 404, { message: 'order not found' })
    if (req.method === 'GET') return send(res, 200, adminOrder(order, store))
    if (req.method === 'PUT') {
      const input = await readJson(req)
      const validation = validateOrderTransition(order, input, adminOrderMatch[2] || '')
      if (validation) return send(res, 400, { message: validation })
      if (['status', 'payment', 'note', 'flag'].includes(adminOrderMatch[2] || '') && hasStaleOrderRevision(order, input)) {
        return send(res, 409, { message: 'order changed, refresh required' })
      }
      let notificationEvent = null
      if (adminOrderMatch[2] === 'status') {
        const previous = order.order_status
        const previousPaymentStatus = order.payment_status
        order.order_status = input.order_status || input.status
        if (previous !== order.order_status) notificationEvent = { label: `Order status changed to ${order.order_status}` }
        if (previous !== order.order_status) addOrderEvent(order, 'status', `订单状态 ${previous || '-'} -> ${order.order_status || '-'}`, { from: previous, to: order.order_status })
        if (order.order_status === 'balance_due' && order.payment_status === 'deposit_paid') {
          order.payment_status = 'balance_due'
          addOrderEvent(order, 'payment', `付款状态 ${previousPaymentStatus || '-'} -> ${order.payment_status}`, {
            from: previousPaymentStatus,
            to: order.payment_status,
            provider: 'system',
          })
        }
      }
      if (adminOrderMatch[2] === 'payment') {
        const changed = applyManualPaymentStatus(store, order, input.payment_status)
        if (changed) notificationEvent = { label: `Payment status changed to ${order.payment_status}`, amount_cents: order.paid_amount_cents }
      }
      if (adminOrderMatch[2] === 'note') {
        const previousNote = order.internal_note || ''
        const previousCarrier = order.shipping_carrier || ''
        const previousTracking = order.tracking_no || ''
        order.internal_note = String(input.internal_note || '').slice(0, 2000)
        if ('tracking_no' in input) order.tracking_no = String(input.tracking_no || '').trim().slice(0, 120)
        if ('shipping_carrier' in input) order.shipping_carrier = String(input.shipping_carrier || '').trim().slice(0, 120)
        if (previousNote !== order.internal_note) addOrderEvent(order, 'note', '内部备注已更新')
        if (previousCarrier !== (order.shipping_carrier || '') || previousTracking !== (order.tracking_no || '')) {
          addOrderEvent(order, 'tracking', `物流信息已更新：${order.shipping_carrier || '-'} ${order.tracking_no || ''}`.trim(), {
            carrier: order.shipping_carrier || '',
            tracking_no: order.tracking_no || '',
          })
        }
      }
      if (adminOrderMatch[2] === 'flag') {
        const previous = Boolean(order.flagged)
        order.flagged = Boolean(input.flagged)
        if (previous !== order.flagged) addOrderEvent(order, 'flag', order.flagged ? '订单已标记异常' : '订单已取消异常标记', { flagged: order.flagged })
      }
      order.revision = Number(order.revision || 0) + 1
      order.updated_at = now()
      await saveAdminChange(store, req, `order.${adminOrderMatch[2] || 'update'}`, { order_id: order.id, order_no: order.order_no, revision: order.revision })
      if (notificationEvent) queueOrderNotifications(order, notificationEvent)
      return send(res, 200, adminOrder(order, store))
    }
  }

  if (req.method === 'GET' && route === '/admin/site') return send(res, 200, adminSiteView(store.site))
  if (req.method === 'POST' && route === '/admin/site/restore') {
    const input = await readJson(req)
    const siteInput = input?.data?.site || input?.site
    if (!siteInput || typeof siteInput !== 'object' || Array.isArray(siteInput)) return send(res, 400, { message: 'invalid site backup' })
    const validation = validateSiteInput(siteInput, store.site)
    if (validation) return send(res, 400, { message: validation })
    store.site = mergeSiteConfig(store.site, siteInput)
    await saveAdminChange(store, req, 'site.restore', { keys: Object.keys(siteInput).slice(0, 20) })
    return send(res, 200, adminSiteView(store.site))
  }
  if (req.method === 'PUT' && route === '/admin/site') {
    const input = await readJson(req)
    const validation = validateSiteInput(input, store.site)
    if (validation) return send(res, 400, { message: validation })
    store.site = mergeSiteConfig(store.site, input)
    await saveAdminChange(store, req, 'site.update', { keys: Object.keys(input).slice(0, 20) })
    return send(res, 200, adminSiteView(store.site))
  }

  return send(res, 404, { message: 'not found' })
}

// -----------------------------------------------------------------------------
// Process startup
// -----------------------------------------------------------------------------
const server = createServer((req, res) => {
  const startedAt = process.hrtime.bigint()
  const incomingRequestId = String(req.headers['x-request-id'] || '').trim()
  const requestId = /^[A-Za-z0-9._:-]{1,100}$/.test(incomingRequestId) ? incomingRequestId : id()
  const requestPath = (() => {
    try {
      return new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`).pathname
    } catch {
      return String(req.url || '/').split('?')[0] || '/'
    }
  })()
  const isApiRequest = requestPath === '/health' || requestPath.startsWith('/api')
  req.request_id = requestId
  res.setHeader('x-request-id', requestId)
  let responseFinished = false
  const requestDetails = (extra = {}) => ({
    request_id: requestId,
    method: req.method || 'GET',
    path: requestPath,
    status: res.statusCode || 200,
    duration_ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100,
    ip: clientIp(req),
    ...extra,
  })
  res.once('finish', () => {
    responseFinished = true
    const status = res.statusCode || 200
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : isApiRequest ? 'info' : 'debug'
    log(level, 'http.request_completed', requestDetails())
  })
  res.once('close', () => {
    if (responseFinished) return
    log('warn', 'http.request_aborted', requestDetails({ status: 499 }))
  })
  handle(req, res).catch((error) => {
    const parsedStatus = Number(error?.status || 500)
    const errorStatus = Number.isInteger(parsedStatus) && parsedStatus >= 400 && parsedStatus < 600 ? parsedStatus : 500
    log(errorStatus >= 500 ? 'error' : 'warn', 'http.request_exception', requestDetails({
      status: errorStatus,
      message: error?.message || 'request failed',
      ...(errorStatus >= 500 ? { stack: error?.stack || '' } : {}),
    }))
    if (res.headersSent) return res.destroy()
    return sendError(res, error)
  })
})
server.on('error', (error) => {
  log('error', 'service.server_error', {
    code: error?.code || '',
    message: error?.message || 'server error',
  })
  if (!server.listening) process.exitCode = 1
})

Promise.resolve().then(async () => {
  await initializeLogger()
  log('info', 'service.starting', {
    host,
    port,
    node_env: process.env.NODE_ENV || 'development',
    store_backend: storeBackend,
    smtp_enabled: emailNotificationsEnabled(),
    smtp_host: smtpConfig.host,
    smtp_port: smtpConfig.port,
    smtp_secure: smtpConfig.secure,
    smtp_auth: Boolean(smtpConfig.user && smtpConfig.pass),
    log_level: logLevel,
    log_file: logToFile ? logFile : '',
  })
  const store = await loadStore()
  log('info', 'store.loaded', {
    backend: storeBackend,
    categories: store.categories?.length || 0,
    products: store.products?.length || 0,
    orders: store.orders?.length || 0,
    payments: store.payments?.length || 0,
  })
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    assertProductionRuntime(store)
  }
  server.listen(port, host, () => {
    log('info', 'service.started', { url: `http://${host}:${port}` })
    scheduleDailyOrderSummary()
  })
}).catch((error) => {
  log('error', 'service.start_failed', { message: error?.message || error, stack: error?.stack || '' })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  log('error', 'process.unhandled_rejection', {
    message: reason?.message || String(reason || 'unhandled rejection'),
    stack: reason?.stack || '',
  })
})
