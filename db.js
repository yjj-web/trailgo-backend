/**
 * db.js — PostgreSQL 连接池与辅助函数
 * 通过 DATABASE_URL 连接（Render 部署时由 render.yaml 自动注入）。
 * 对外暴露与原 sqlite 版本同名的 dbAll / dbGet / dbRun，
 * 并把 sqlite 风格的 ? 占位符自动转换为 pg 的 $1,$2…，尽量少改业务 SQL。
 */
const { Pool } = require('pg')

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('❌ 缺少 DATABASE_URL 环境变量，请在 Render 上关联 PostgreSQL 数据库')
  process.exit(1)
}

// 本地（localhost）连接不启用 SSL；Render 上的数据库需要 SSL
const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString)
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
})

pool.on('error', (err) => console.error('PG 连接池错误:', err.message))

// 将 ?,?,? 占位符转换为 $1,$2,$3（这些 SQL 中没有字符串内的字面 ?，转换安全）
function toPg(sql) {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

const dbAll = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows
const dbGet = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows[0] || undefined
const dbRun = async (sql, p = []) => {
  const r = await pool.query(toPg(sql), p)
  // INSERT 若带 RETURNING id，则 lastID 取首行 id；否则用 rowCount 表示影响行数
  return { lastID: r.rows[0] ? r.rows[0].id : undefined, changes: r.rowCount }
}

module.exports = { pool, dbAll, dbGet, dbRun, toPg }
