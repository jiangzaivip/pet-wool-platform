import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const { Pool } = pg
const rootDir = path.resolve(process.env.PROJECT_ROOT_DIR || process.cwd())
const dataFile = path.join(rootDir, 'api-node', 'data', 'store.json')
const databaseUrl = String(process.env.DATABASE_URL || '').trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const store = JSON.parse(await readFile(dataFile, 'utf8'))
const pool = new Pool({ connectionString: databaseUrl, max: 2 })
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_runtime_store (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  const current = await pool.query('SELECT id FROM platform_runtime_store WHERE id = 1')
  if (current.rows.length && !process.argv.includes('--replace')) {
    throw new Error('PostgreSQL store already contains data; use --replace to overwrite it')
  }
  await pool.query(`
    INSERT INTO platform_runtime_store (id, data, updated_at)
    VALUES (1, $1::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `, [JSON.stringify(store)])
  const check = await pool.query('SELECT jsonb_array_length(data->\'products\') AS products, jsonb_array_length(data->\'orders\') AS orders, jsonb_array_length(data->\'users\') AS users FROM platform_runtime_store WHERE id = 1')
  console.log(JSON.stringify({ migrated: true, data_file: dataFile, ...check.rows[0] }, null, 2))
} finally {
  await pool.end()
}
