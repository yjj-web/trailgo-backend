/**
 * server.js — TrailGo 后端服务
 * Express + PostgreSQL (node-postgres)
 */
const express = require('express')
const cors    = require('cors')
const https   = require('https')
const crypto  = require('crypto')
const { pool, dbAll, dbGet, dbRun } = require('./db')
const { hashPassword, comparePassword, signToken, requireAuth, optionalAuth } = require('./auth')

const app  = express()
const PORT = process.env.PORT || 3000

// ── 中间件 ───────────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json())

function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v } catch { return fallback }
}
function parseTrail(row) {
  if (!row) return null
  return {
    ...row,
    tags:   safeJson(row.tags, []),
    images: safeJson(row.images, []),
    path:   safeJson(row.path, []),
  }
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

function publicUser(u) {
  if (!u) return null
  return { id: u.id, username: u.username, nickname: u.nickname || u.username, avatar: u.avatar || null }
}

// ════════════════════════════════════════════════════════════════════════════
// 认证 API
// ════════════════════════════════════════════════════════════════════════════

// POST /api/auth/register  { username, password, nickname? }
app.post('/api/auth/register', handler(async (req, res) => {
  const { username, password, nickname } = req.body || {}
  if (!username || !password)
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' })
  if (String(username).length < 3 || String(password).length < 6)
    return res.status(400).json({ success: false, message: '用户名至少3位，密码至少6位' })

  const exists = await dbGet('SELECT id FROM users WHERE username = ?', [username])
  if (exists) return res.status(409).json({ success: false, message: '用户名已被注册' })

  const hash = await hashPassword(password)
  const row = await dbGet(
    'INSERT INTO users (username, password, nickname) VALUES (?,?,?) RETURNING *',
    [username, hash, nickname || username]
  )
  res.json({ success: true, token: signToken(row), user: publicUser(row) })
}))

// POST /api/auth/login  { username, password }
app.post('/api/auth/login', handler(async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password)
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' })
  const row = await dbGet('SELECT * FROM users WHERE username = ?', [username])
  if (!row || !(await comparePassword(password, row.password)))
    return res.status(401).json({ success: false, message: '用户名或密码错误' })
  res.json({ success: true, token: signToken(row), user: publicUser(row) })
}))

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, handler(async (req, res) => {
  const row = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id])
  if (!row) return res.status(404).json({ success: false, message: '用户不存在' })
  res.json({ success: true, user: publicUser(row) })
}))

// ════════════════════════════════════════════════════════════════════════════
// 路线 API
// ════════════════════════════════════════════════════════════════════════════

// GET /api/trails?province=陕西&city=西安&difficulty=进阶&q=百花
app.get('/api/trails', optionalAuth, handler(async (req, res) => {
  const { province, city, difficulty, q } = req.query
  let sql = 'SELECT * FROM trails WHERE 1=1'
  const params = []
  if (province && province !== '全部') {
    sql += ' AND province = ?'; params.push(province)
  }
  if (city) {
    sql += ' AND region LIKE ?'; params.push(`%·${city}%`)
  }
  if (difficulty && difficulty !== '全部') {
    sql += ' AND difficulty = ?'; params.push(difficulty)
  }
  if (q) {
    sql += ' AND (name LIKE ? OR region LIKE ? OR tags LIKE ?)'
    const like = `%${q}%`; params.push(like, like, like)
  }
  sql += ' ORDER BY id ASC'

  const rows = await dbAll(sql, params)
  // 标记收藏状态（仅当前登录用户的收藏；未登录则都为 false）
  const favSet = new Set()
  if (req.user) {
    const favRows = await dbAll('SELECT trail_id FROM favorites WHERE user_id = ?', [req.user.id])
    favRows.forEach(r => favSet.add(r.trail_id))
  }
  const data = rows.map(r => ({ ...parseTrail(r), isFavorite: favSet.has(r.id) }))
  res.json({ success: true, data })
}))

// GET /api/provinces —— 省份列表（按路线数量排序），供前端选择器使用
app.get('/api/provinces', handler(async (req, res) => {
  const rows = await dbAll(`
    SELECT province, COUNT(*)::int AS n
    FROM trails WHERE province <> ''
    GROUP BY province ORDER BY n DESC, province ASC
  `)
  res.json({ success: true, data: rows })
}))

// GET /api/cities?province=XX —— 从 region 字段解析城市（格式：省·市·区）
app.get('/api/cities', handler(async (req, res) => {
  const { province } = req.query
  if (!province) return res.json({ success: true, data: [] })
  const rows = await dbAll(`
    SELECT
      NULLIF(TRIM(split_part(region, '·', 2)), '') AS city,
      COUNT(*)::int AS n
    FROM trails
    WHERE province = ?
      AND NULLIF(TRIM(split_part(region, '·', 2)), '') IS NOT NULL
    GROUP BY city
    ORDER BY n DESC, city ASC
  `, [province])
  res.json({ success: true, data: rows })
}))

// GET /api/trails/mine —— 我上传的路线（需登录）
app.get('/api/trails/mine', requireAuth, handler(async (req, res) => {
  const rows = await dbAll('SELECT * FROM trails WHERE user_id = ? ORDER BY id DESC', [req.user.id])
  res.json({ success: true, data: rows.map(parseTrail) })
}))

// POST /api/trails —— 用户上传路线（需登录）
app.post('/api/trails', requireAuth, handler(async (req, res) => {
  const b = req.body || {}
  const name = (b.name || '').trim()
  const difficulty = b.difficulty
  if (!name) return res.status(400).json({ success: false, message: '路线名称不能为空' })
  if (!['入门', '进阶', '高难度'].includes(difficulty))
    return res.status(400).json({ success: false, message: '难度需为 入门/进阶/高难度' })

  const num = (v, d = 0) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v))
  const tags   = Array.isArray(b.tags) ? b.tags : []
  const images = Array.isArray(b.images) ? b.images.filter(Boolean) : []
  const path   = Array.isArray(b.path) ? b.path : []
  const coverImage = (b.cover_image || '').trim() || null

  // 用户路线 id 从 100001 起，避开官方种子 id，重灌官方数据时不受影响
  const { maxid } = await dbGet('SELECT GREATEST(COALESCE(MAX(id),0), 100000) AS maxid FROM trails')
  const id = Number(maxid) + 1

  await dbRun(
    `INSERT INTO trails
       (id,name,province,region,difficulty,distance_km,duration_h,elevation_m,lat,lng,tags,summary,cover_emoji,cover_image,images,path,source,user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'user', ?)`,
    [id, name, (b.province || '').trim(), (b.region || b.province || '').trim(), difficulty,
     num(b.distance_km), num(b.duration_h), num(b.elevation_m), num(b.lat), num(b.lng),
     JSON.stringify(tags), (b.summary || '').trim(), b.cover_emoji || '⛰️',
     coverImage, JSON.stringify(images), JSON.stringify(path), req.user.id]
  )

  // 可选攻略 / 提示
  if (Array.isArray(b.guides)) {
    let step = 0
    for (const g of b.guides) {
      if (!g || !g.title) continue
      await dbRun('INSERT INTO trail_guides (trail_id,step_no,title,description) VALUES (?,?,?,?)',
        [id, ++step, g.title, g.description || ''])
    }
  }
  if (Array.isArray(b.tips)) {
    for (const t of b.tips) {
      if (!t || !t.content) continue
      const type = t.type === 'warn' ? 'warn' : 'good'
      await dbRun('INSERT INTO trail_tips (trail_id,type,content) VALUES (?,?,?)', [id, type, t.content])
    }
  }

  res.json({ success: true, id })
}))

// DELETE /api/trails/:id —— 删除自己上传的路线（需登录）
app.delete('/api/trails/:id', requireAuth, handler(async (req, res) => {
  const trail = await dbGet('SELECT id,user_id,source FROM trails WHERE id = ?', [req.params.id])
  if (!trail) return res.status(404).json({ success: false, message: '路线不存在' })
  if (trail.source !== 'user' || trail.user_id !== req.user.id)
    return res.status(403).json({ success: false, message: '只能删除自己上传的路线' })
  await dbRun('DELETE FROM trails WHERE id = ?', [req.params.id])
  res.json({ success: true })
}))

// GET /api/trails/:id
app.get('/api/trails/:id', optionalAuth, handler(async (req, res) => {
  const trail = parseTrail(await dbGet('SELECT * FROM trails WHERE id = ?', [req.params.id]))
  if (!trail) return res.status(404).json({ success: false, message: '路线不存在' })

  const [guides, tips, fav] = await Promise.all([
    dbAll('SELECT * FROM trail_guides WHERE trail_id = ? ORDER BY step_no', [trail.id]),
    dbAll('SELECT * FROM trail_tips  WHERE trail_id = ?', [trail.id]),
    req.user
      ? dbGet('SELECT id FROM favorites WHERE trail_id = ? AND user_id = ?', [trail.id, req.user.id])
      : Promise.resolve(null),
  ])
  res.json({ success: true, data: { ...trail, guides, tips, isFavorite: !!fav } })
}))

// ════════════════════════════════════════════════════════════════════════════
// 收藏 API
// ════════════════════════════════════════════════════════════════════════════

// GET /api/favorites —— 当前用户的收藏（需登录）
app.get('/api/favorites', requireAuth, handler(async (req, res) => {
  const rows = await dbAll(`
    SELECT t.*, f.created_at AS fav_at
    FROM favorites f
    JOIN trails t ON t.id = f.trail_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `, [req.user.id])
  res.json({ success: true, data: rows.map(r => ({ ...parseTrail(r), isFavorite: true })) })
}))

// POST /api/favorites/:trailId  (toggle，需登录)
app.post('/api/favorites/:trailId', requireAuth, handler(async (req, res) => {
  const trailId = Number(req.params.trailId)
  const exists  = await dbGet('SELECT id FROM favorites WHERE trail_id = ? AND user_id = ?', [trailId, req.user.id])
  if (exists) {
    await dbRun('DELETE FROM favorites WHERE trail_id = ? AND user_id = ?', [trailId, req.user.id])
    res.json({ success: true, isFavorite: false })
  } else {
    await dbRun('INSERT INTO favorites (trail_id, user_id) VALUES (?, ?)', [trailId, req.user.id])
    res.json({ success: true, isFavorite: true })
  }
}))

// ════════════════════════════════════════════════════════════════════════════
// 出行记录 API
// ════════════════════════════════════════════════════════════════════════════

// GET /api/records —— 当前用户的出行记录（需登录）
app.get('/api/records', requireAuth, handler(async (req, res) => {
  const rows = await dbAll(`
    SELECT r.*, t.name AS trail_name, t.region, t.difficulty, t.cover_emoji, t.distance_km
    FROM trip_records r
    JOIN trails t ON t.id = r.trail_id
    WHERE r.user_id = ?
    ORDER BY r.date DESC
  `, [req.user.id])
  res.json({ success: true, data: rows })
}))

// POST /api/records（需登录）
app.post('/api/records', requireAuth, handler(async (req, res) => {
  const { trail_id, date, duration_min, note } = req.body
  if (!trail_id || !date)
    return res.status(400).json({ success: false, message: '缺少 trail_id 或 date' })
  const result = await dbRun(
    'INSERT INTO trip_records (trail_id, date, duration_min, note, user_id) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [trail_id, date, duration_min || null, note || null, req.user.id]
  )
  res.json({ success: true, id: result.lastID })
}))

// DELETE /api/records/:id（需登录，仅能删自己的）
app.delete('/api/records/:id', requireAuth, handler(async (req, res) => {
  await dbRun('DELETE FROM trip_records WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  res.json({ success: true })
}))

// ════════════════════════════════════════════════════════════════════════════
// 统计 API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', requireAuth, handler(async (req, res) => {
  const uid = req.user.id
  const [trips, km, elev, favs] = await Promise.all([
    dbGet('SELECT COUNT(*) AS n FROM trip_records WHERE user_id = ?', [uid]),
    dbGet('SELECT COALESCE(SUM(t.distance_km),0) AS total FROM trip_records r JOIN trails t ON t.id=r.trail_id WHERE r.user_id = ?', [uid]),
    dbGet('SELECT COALESCE(SUM(t.elevation_m),0) AS total FROM trip_records r JOIN trails t ON t.id=r.trail_id WHERE r.user_id = ?', [uid]),
    dbGet('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', [uid]),
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

// ════════════════════════════════════════════════════════════════════════════
// 位置 API —— 后端代理高德 Web 服务（key 不暴露给客户端）
// ════════════════════════════════════════════════════════════════════════════
const AMAP_KEY = process.env.AMAP_KEY || 'b180ecfd198102a0e25aa2283300a2f1'

// 省份去后缀，便于与 trails.province 匹配（北京市→北京 / 新疆维吾尔自治区→新疆）
function normalizeProvince(p) {
  if (!p) return ''
  return String(p).replace(/(维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/, '')
}

// GET /api/geo/reverse?lat=&lng=  坐标 → 省/市/区
app.get('/api/geo/reverse', handler(async (req, res) => {
  const { lat, lng } = req.query
  if (!lat || !lng) return res.status(400).json({ success: false, message: '缺少 lat/lng' })
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${AMAP_KEY}&location=${lng},${lat}`
  const r = await fetchJson(url)
  if (r.status !== '1') return res.status(502).json({ success: false, message: '高德逆地理失败: ' + r.info })
  const a = r.regeocode.addressComponent || {}
  res.json({
    success: true,
    data: {
      province: normalizeProvince(a.province),
      city:     Array.isArray(a.city) ? '' : (a.city || ''),
      district: a.district || '',
      formatted: r.regeocode.formatted_address || '',
    },
  })
}))

// GET /api/geo/route?fromLat=&fromLng=&toLat=&toLng=  起终点 → 驾车距离/时长
app.get('/api/geo/route', handler(async (req, res) => {
  const { fromLat, fromLng, toLat, toLng } = req.query
  if (!fromLat || !fromLng || !toLat || !toLng)
    return res.status(400).json({ success: false, message: '缺少起终点坐标' })
  const url = `https://restapi.amap.com/v3/direction/driving?key=${AMAP_KEY}`
    + `&origin=${fromLng},${fromLat}&destination=${toLng},${toLat}`
  const r = await fetchJson(url)
  const p = r.status === '1' && r.route && r.route.paths && r.route.paths[0]
  if (!p) return res.json({ success: true, data: null })
  res.json({
    success: true,
    data: { distance_km: Math.round(p.distance / 100) / 10, duration_min: Math.round(p.duration / 60) },
  })
}))

// 把上游图片字节流原样转发给客户端（key 不暴露）
function pipeImage(url, res, timeout = 15000) {
  const upstream = https.get(url, (u) => {
    if (u.statusCode !== 200) { u.resume(); if (!res.headersSent) res.status(502).end(); return }
    res.set('Content-Type', u.headers['content-type'] || 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    u.pipe(res)
  })
  upstream.setTimeout(timeout, () => upstream.destroy(new Error('staticmap timeout')))
  upstream.on('error', () => { if (!res.headersSent) res.status(502).end() })
}

// GET /api/geo/staticmap?id=  或  ?lat=&lng=  → 高德静态地图图片（登山口标记 + 有轨迹则画线）
app.get('/api/geo/staticmap', handler(async (req, res) => {
  let { lat, lng, id } = req.query
  let pathPts = []
  if (id) {
    const t = await dbGet('SELECT lat,lng,path FROM trails WHERE id = ?', [id])
    if (!t) return res.status(404).json({ success: false, message: '路线不存在' })
    lat = t.lat; lng = t.lng; pathPts = safeJson(t.path, [])
  }
  if (lat == null || lng == null || lat === '' || lng === '')
    return res.status(400).json({ success: false, message: '缺少坐标' })

  let url = `https://restapi.amap.com/v3/staticmap?key=${AMAP_KEY}`
    + `&location=${lng},${lat}&size=720*360&scale=2`
    + `&markers=large,0x1D9E75,:${lng},${lat}`
  if (Array.isArray(pathPts) && pathPts.length > 1) {
    const pts = pathPts.map(p => `${p[0]},${p[1]}`).join(';')
    url += `&paths=6,0x1D9E75,1,,:${pts}`   // 有轨迹：让高德按路线自适应缩放
  } else {
    url += `&zoom=12`
  }
  pipeImage(url, res)
}))

// ════════════════════════════════════════════════════════════════════════════
// 对象存储（七牛）—— 前端直传：后端只签发上传凭证，图片字节不经过本服务
//   需在环境变量配置：QINIU_AK / QINIU_SK / QINIU_BUCKET / QINIU_DOMAIN（公开访问域名，
//   形如 https://cdn.example.com，不带结尾斜杠）/ QINIU_UP_HOST（可选，默认华东）
// ════════════════════════════════════════════════════════════════════════════
const QINIU = {
  ak:     process.env.QINIU_AK     || '',
  sk:     process.env.QINIU_SK     || '',
  bucket: process.env.QINIU_BUCKET || '',
  domain: (process.env.QINIU_DOMAIN || '').replace(/\/+$/, ''),
  upHost: process.env.QINIU_UP_HOST || 'https://up.qiniup.com',
}
// 七牛 URL-safe base64
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}
function qiniuUploadToken(putPolicy) {
  const encoded = b64url(Buffer.from(JSON.stringify(putPolicy)))
  const sign    = b64url(crypto.createHmac('sha1', QINIU.sk).update(encoded).digest())
  return `${QINIU.ak}:${sign}:${encoded}`
}

// GET /api/upload/token?ext=jpg —— 签发七牛上传凭证（需登录）
app.get('/api/upload/token', requireAuth, handler(async (req, res) => {
  if (!QINIU.ak || !QINIU.sk || !QINIU.bucket || !QINIU.domain) {
    return res.status(503).json({ success: false, message: '对象存储未配置（缺少 QINIU_* 环境变量）' })
  }
  const ext = String(req.query.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg'
  const key = `trails/${req.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const putPolicy = {
    scope:      `${QINIU.bucket}:${key}`,  // 限定到具体 key，避免覆盖他人文件
    deadline:   Math.floor(Date.now() / 1000) + 3600,
    fsizeLimit: 5 * 1024 * 1024,           // 单图最大 5MB
    mimeLimit:  'image/*',                  // 仅允许图片
  }
  res.json({
    success: true,
    data: { token: qiniuUploadToken(putPolicy), key, upHost: QINIU.upHost, domain: QINIU.domain },
  })
}))

// ── 启动 ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌄 TrailGo 后端运行在 http://0.0.0.0:${PORT}`)
  console.log(`   API 文档: GET/POST /api/trails | /api/favorites | /api/records | /api/stats`)
})

// 优雅退出
process.on('SIGINT', async () => { await pool.end(); process.exit(0) })
