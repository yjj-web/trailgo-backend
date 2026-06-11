/**
 * server.js — TrailGo 后端服务
 * Express + PostgreSQL (node-postgres)
 */
const express = require('express')
const cors    = require('cors')
const https   = require('https')
const { pool, dbAll, dbGet, dbRun } = require('./db')

const app  = express()
const PORT = process.env.PORT || 3000

// ── 中间件 ───────────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json())

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
    'INSERT INTO trip_records (trail_id, date, duration_min, note) VALUES (?, ?, ?, ?) RETURNING id',
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
  // pg 的 COUNT/SUM 返回字符串，统一转为数字以保持 API 契约
  res.json({
    success: true,
    data: {
      totalTrips: Number(trips.n),
      totalKm:    Math.round(Number(km.total) * 10) / 10,
      totalElev:  Number(elev.total),
      favCount:   Number(favs.n),
    }
  })
}))

// ════════════════════════════════════════════════════════════════════════════
// 天气代理 API —— 由后端（境外服务器）转发 Open-Meteo，规避客户端国内直连慢/失败
// ════════════════════════════════════════════════════════════════════════════

function fetchJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (r) => {
      if (r.statusCode !== 200) {
        r.resume()
        return reject(new Error('upstream ' + r.statusCode))
      }
      let buf = ''
      r.on('data', (c) => { buf += c })
      r.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
      })
    })
    req.setTimeout(timeout, () => req.destroy(new Error('upstream timeout')))
    req.on('error', reject)
  })
}

// open-meteo 偶发 TLS 断连/超时，重试若干次提升稳定性
async function fetchJsonWithRetry(url, retries = 3) {
  let lastErr
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchJson(url)
    } catch (e) {
      lastErr = e
      if (i < retries - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

// GET /api/weather?lat=39.967&lng=115.477
app.get('/api/weather', handler(async (req, res) => {
  const lat = req.query.lat || '39.967'
  const lng = req.query.lng || '115.477'
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}`
    + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weathercode'
    + '&daily=weathercode,temperature_2m_max,temperature_2m_min'
    + '&forecast_days=3&timezone=Asia%2FShanghai'
  const data = await fetchJsonWithRetry(url)
  res.json({ success: true, data })
}))

// ── 启动 ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌄 TrailGo 后端运行在 http://0.0.0.0:${PORT}`)
  console.log(`   API 文档: GET/POST /api/trails | /api/favorites | /api/records | /api/stats`)
})

// 优雅退出
process.on('SIGINT', async () => { await pool.end(); process.exit(0) })
