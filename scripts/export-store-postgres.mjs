import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const storeFile = path.join(rootDir, 'api-node', 'data', 'store.json')
const outDir = path.join(rootDir, 'workspace', 'generated')
const outFile = path.join(outDir, 'store-postgres-seed.sql')

function sqlString(value = '') {
  return `'${String(value ?? '').replaceAll("'", "''")}'`
}

function jsonb(value) {
  return `${sqlString(JSON.stringify(value ?? null))}::jsonb`
}

function row(table, values) {
  return `INSERT INTO ${table} (${Object.keys(values).join(', ')}) VALUES (${Object.values(values).join(', ')});\n`
}

const store = JSON.parse(await readFile(storeFile, 'utf8'))
await mkdir(outDir, { recursive: true })

let sql = ''
sql += '-- Generated from api-node/data/store.json. Review before applying to production.\n'
sql += 'BEGIN;\n\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_store_snapshots (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_categories (id text PRIMARY KEY, slug text UNIQUE NOT NULL, data jsonb NOT NULL);\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_products (id text PRIMARY KEY, slug text UNIQUE NOT NULL, category_id text, status text, data jsonb NOT NULL);\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_orders (id text PRIMARY KEY, order_no text UNIQUE, email text, product_id text, order_status text, payment_status text, data jsonb NOT NULL);\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_payments (id text PRIMARY KEY, order_id text, provider text, status text, data jsonb NOT NULL);\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_users (id text PRIMARY KEY, email text, status text, data jsonb NOT NULL);\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_audit_logs (id text PRIMARY KEY, actor_email text, actor_role text, action text, created_at timestamptz, data jsonb NOT NULL);\n'
sql += 'CREATE TABLE IF NOT EXISTS platform_site_settings (key text PRIMARY KEY, value jsonb NOT NULL);\n\n'
sql += 'TRUNCATE platform_store_snapshots, platform_categories, platform_products, platform_orders, platform_payments, platform_users, platform_audit_logs, platform_site_settings;\n\n'
sql += row('platform_store_snapshots', { id: sqlString(`snapshot-${new Date().toISOString()}`), data: jsonb(store) })

for (const item of store.categories || []) {
  sql += row('platform_categories', { id: sqlString(item.id), slug: sqlString(item.slug), data: jsonb(item) })
}
for (const item of store.products || []) {
  sql += row('platform_products', {
    id: sqlString(item.id),
    slug: sqlString(item.slug),
    category_id: sqlString(item.category_id || ''),
    status: sqlString(item.status || 'published'),
    data: jsonb(item),
  })
}
for (const item of store.orders || []) {
  sql += row('platform_orders', {
    id: sqlString(item.id),
    order_no: sqlString(item.order_no || ''),
    email: sqlString(item.email || ''),
    product_id: sqlString(item.product_id || ''),
    order_status: sqlString(item.order_status || ''),
    payment_status: sqlString(item.payment_status || ''),
    data: jsonb(item),
  })
}
for (const item of store.payments || []) {
  sql += row('platform_payments', {
    id: sqlString(item.id),
    order_id: sqlString(item.order_id || ''),
    provider: sqlString(item.provider || ''),
    status: sqlString(item.status || ''),
    data: jsonb(item),
  })
}
for (const item of store.users || []) {
  sql += row('platform_users', {
    id: sqlString(item.id),
    email: sqlString(item.email || ''),
    status: sqlString(item.status || ''),
    data: jsonb(item),
  })
}
for (const item of store.audit_logs || []) {
  sql += row('platform_audit_logs', {
    id: sqlString(item.id),
    actor_email: sqlString(item.actor_email || ''),
    actor_role: sqlString(item.actor_role || ''),
    action: sqlString(item.action || ''),
    created_at: item.created_at ? sqlString(item.created_at) : 'NULL',
    data: jsonb(item),
  })
}
for (const [key, value] of Object.entries(store.site || {})) {
  sql += row('platform_site_settings', { key: sqlString(key), value: jsonb(value) })
}

sql += '\nCOMMIT;\n'

await writeFile(outFile, sql)
console.log(JSON.stringify({
  output: outFile,
  categories: store.categories?.length || 0,
  products: store.products?.length || 0,
  orders: store.orders?.length || 0,
  payments: store.payments?.length || 0,
  users: store.users?.length || 0,
  audit_logs: store.audit_logs?.length || 0,
}, null, 2))
