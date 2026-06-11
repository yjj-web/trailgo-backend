/**
 * server.js — TrailGo 后端服务
 * Express + sqlite3 (异步回调风格，Promise 封装)
 * 支持本地运行和腾讯云 Serverless SCF
 */
const express = require('express')
const cors    = require('cors')
const sqlite3 = require('sqlite3').verbose()
const path    = require('path')

const app      = express()
const PORT     = process.env.PORT || 3000
const DB_PATH  = path.join(__dirname, 'trailgo.db')

// ── 中间件 ───────────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json())

// ── 数据库连接 ───────────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ 数据库连接失败，请先运行: npm run init-db')
    console.error(err.message)
    process.exit(1)
  }
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA journal_mode = WAL')
  console.log('📂 SQLite 连接成功:', DB_PATH)
})

// ── DB 辅助函数 ───────────────────────────────────────────────────────────────
const dbAll  = (sql, p = []) => new Promise((ok, fail) => db.all(sql, p, (e, rows) => e ? fail(e) : ok(rows)))
const dbGet  = (sql, p = []) => new Promise((ok, fail) => db.get(sql, p, (e, row) => e ? fail(e) : ok(row)))
const dbRun  = (sql, p = []) => new Promise((ok, fail) => db.run(sql, p, function(e) { e ? fail(e) : ok(this) }))

function parseTrail(row) {
  if (!row) return null
  return { ...row, tags: JSON.parse(row.tags || '[]') }
}

// ── 错误处理包装 ─────────────────────────────────────────────────────────────
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      console.error(err)
      res.status(500).json({ success: false, message: err.message })
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 路线 API
// ════════════════════════════════════════════════════════════════════════════

// GET /api/trails?difficulty=进阶&q=百花
app.get('/api/trails', handler(async (req, res) => {
  const { difficulty, q } = req.query
  let sql = 'SELECT * FROM trails WHERE 1=1'
  const params = []
  if (difficulty && difficulty !== '全部') {
    sql += ' AND difficulty = ?'; params.push(difficulty)
  }
  if (q) {
    sql += ' AND (name LIKE ? OR region LIKE ? OR tags LIKE ?)'
    const like = `%${q}%`; params.push(like, like, like)
  }
  sql += ' ORDER BY id ASC'

  const rows = await dbAll(sql, params)
  // 标记收藏状态
  const favRows = await dbAll('SELECT trail_id FROM favorites')
  const favSet  = new Set(favRows.map(r => r.trail_id))
  const data    = rows.map(r => ({ ...parseTrail(r), isFavorite: favSet.has(r.id) }))
  res.json({ success: true, data })
}))

// GET /api/trails/:id
app.get('/api/trails/:id', handler(async (req, res) => {
  const trail = parseTrail(await dbGet('SELECT * FROM trails WHERE id = ?', [req.params.id]))
  if (!trail) return res.status(404).json({ success: false, message: '路线不存在' })

  const [guides, tips, fav] = await Promise.all([
    dbAll('SELECT * FROM trail_guides WHERE trail_id = ? ORDER BY step_no', [trail.id]),
    dbAll('SELECT * FROM trail_tips  WHERE trail_id = ?', [trail.id]),
    dbGet('SELECT id FROM favorites  WHERE trail_id = ?', [trail.id]),
  ])
  res.json({ success: true, data: { ...trail, guides, tips, isFavorite: !!fav } })
}))

// ════════════════════════════════════════════════════════════════════════════
// 收藏 API
// ════════════════════════════════════════════════════════════════════════════

// GET /api/favorites
app.get('/api/favorites', handler(async (req, res) => {
  const rows = await dbAll(`
    SELECT t.*, f.created_at AS fav_at
    FROM favorites f
    JOIN trails t ON t.id = f.trail_id
    ORDER BY f.created_at DESC
  `)
  res.json({ success: true, data: rows.map(r => ({ ...parseTrail(r), isFavorite: true })) })
}))

// POST /api/favorites/:trailId  (toggle)
app.post('/api/favorites/:trailId', handler(async (req, res) => {
  const trailId = Number(req.params.trailId)
  const exists  = await dbGet('SELECT id FROM favorites WHERE trail_id = ?', [trailId])
  if (exists) {
    await dbRun('DELETE FROM favorites WHERE trail_id = ?', [trailId])
    res.json({ success: true, isFavorite: false })
  } else {
    await dbRun('INSERT INTO favorites (trail_id) VALUES (?)', [trailId])
    res.json({ success: true, isFavorite: true })
  }
}))

// ════════════════════════════════════════════════════════════════════════════
// 出行记录 API
// ════════════════════════════════════════════════════════════════════════════

// GET /api/records
app.get('/api/records', handler(async (req, res) => {
  const rows = await dbAll(`
    SELECT r.*, t.name AS trail_name, t.region, t.difficulty, t.cover_emoji, t.distance_km
    FROM trip_records r
    JOIN trails t ON t.id = r.trail_id
    ORDER BY r.date DESC
  `)
  res.json({ success: true, data: rows })
}))

// POST /api/records
app.post('/api/records', handler(async (req, res) => {
  const { trail_id, date, duration_min, note } = req.body
  if (!trail_id || !date)
    return res.status(400).json({ success: false, message: '缺少 trail_id 或 date' })
  const result = await dbRun(
    'INSERT INTO trip_records (trail_id, date, duration_min, note) VALUES (?, ?, ?, ?)',
    [trail_id, date, duration_min || null, note || null]
  )
  res.json({ success: true, id: result.lastID })
}))

// DELETE /api/records/:id
app.delete('/api/records/:id', handler(async (req, res) => {
  await dbRun('DELETE FROM trip_records WHERE id = ?', [req.params.id])
  res.json({ success: true })
}))

// ════════════════════════════════════════════════════════════════════════════
// 统计 API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', handler(async (req, res) => {
  const [trips, km, elev, favs] = await Promise.all([
    dbGet('SELECT COUNT(*) AS n FROM trip_records'),
    dbGet('SELECT COALESCE(SUM(t.distance_km),0) AS total FROM trip_records r JOIN trails t ON t.id=r.trail_id'),
    dbGet('SELECT COALESCE(SUM(t.elevation_m),0) AS total FROM trip_records r JOIN trails t ON t.id=r.trail_id'),
    dbGet('SELECT COUNT(*) AS n FROM favorites'),
  ])
  res.json({
    success: true,
    data: {
      totalTrips: trips.n,
      totalKm:    Math.round(km.total * 10) / 10,
      totalElev:  elev.total,
      favCount:   favs.n,
    }
  })
}))

// ── 启动 ─────────────────────────────────────────────────────────────────────
// 支持本地运行和腾讯云 Serverless SCF
if (process.env.NODE_ENV === 'production' && process.env.SCF_RUN) {
  // 腾讯云 SCF 环境
  module.exports.handler = async (event, context) => {
    const serverless = require('serverless-http')
    const handler = serverless(app)
    return handler(event, context)
  }
} else {
  // 本地开发环境
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌄 TrailGo 后端运行在 http://0.0.0.0:${PORT}`)
    console.log(`   API 文档: GET/POST /api/trails | /api/favorites | /api/records | /api/stats`)
  })
}

// 优雅退出
process.on('SIGINT', () => { db.close(); process.exit(0) })
