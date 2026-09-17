// Performs a credential-only PayPal live probe. It never creates an order or
// charges an account, and it does not print credentials or access tokens.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.env.PROJECT_ROOT_DIR
  ? path.resolve(process.env.PROJECT_ROOT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const storeFile = path.join(rootDir, 'api-node', 'data', 'store.json')
const store = JSON.parse(await readFile(storeFile, 'utf8'))
const storedPaypal = store?.site?.paypal || {}
const value = (storedName) => String(storedPaypal[storedName] || '').trim()
const mode = value('mode').toLowerCase()
const clientId = value('client_id')
const secret = value('secret')

if (mode !== 'live') throw new Error('PayPal live probe requires site.paypal.mode=live')
if (!clientId || !secret) throw new Error('PayPal live probe requires client ID and secret')

const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials',
  signal: AbortSignal.timeout(15000),
})
const text = await response.text()
let body = {}
try {
  body = text ? JSON.parse(text) : {}
} catch {
  body = {}
}
if (!response.ok || !String(body.access_token || '').trim()) {
  throw new Error(`PayPal live OAuth probe failed with HTTP ${response.status}`)
}

console.log(JSON.stringify({
  ok: true,
  mode,
  endpoint: 'https://api-m.paypal.com',
  token_received: true,
}, null, 2))
