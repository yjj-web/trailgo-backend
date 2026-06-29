/**
 * server.js — TrailGo 后端服务
 * Express + PostgreSQL (node-postgres)
 */
const express = require('express')
const cors    = require('cors')
const https   = require('https')
const crypto  = require('crypto')
const multer  = require('multer')
const { pool, dbAll, dbGet, dbRun } = require('./db')
const { hashPassword, comparePassword, signToken, requireAuth, optionalAuth, isAdmin } = require('./auth')

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
  return { id: u.id, username: u.username, nickname: u.nickname || u.username, avatar: u.avatar || null, isAdmin: isAdmin(u) }
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

// PUT /api/auth/me  { nickname?, avatar? } —— 更新个人资料（需登录）
app.put('/api/auth/me', requireAuth, handler(async (req, res) => {
  const b = req.body || {}
  const fields = []
  const params = []
  if (b.nickname != null) { fields.push('nickname = ?'); params.push(String(b.nickname).trim().slice(0, 20) || null) }
  if (b.avatar   != null) { fields.push('avatar = ?');   params.push(String(b.avatar).trim() || null) }
  if (!fields.length) return res.status(400).json({ success: false, message: '没有要更新的内容' })
  params.push(req.user.id)
  await dbRun(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params)
  const row = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id])
  res.json({ success: true, user: publicUser(row) })
}))

// POST /api/auth/password  { oldPassword, newPassword } —— 修改密码（需登录）
app.post('/api/auth/password', requireAuth, handler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!oldPassword || !newPassword)
    return res.status(400).json({ success: false, message: '请填写原密码和新密码' })
  if (String(newPassword).length < 6)
    return res.status(400).json({ success: false, message: '新密码至少6位' })
  const row = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id])
  if (!row || !(await comparePassword(oldPassword, row.password)))
    return res.status(401).json({ success: false, message: '原密码错误' })
  await dbRun('UPDATE users SET password = ? WHERE id = ?', [await hashPassword(newPassword), req.user.id])
  res.json({ success: true })
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
  // 评分聚合（平均分 + 条数）
  const rateMap = {}
  const rateRows = await dbAll('SELECT trail_id, AVG(rating)::numeric(3,1) AS avg, COUNT(*)::int AS n FROM reviews GROUP BY trail_id')
  rateRows.forEach(r => { rateMap[r.trail_id] = { rating: Number(r.avg), rating_count: r.n } })
  const data = rows.map(r => ({
    ...parseTrail(r),
    isFavorite: favSet.has(r.id),
    rating: rateMap[r.id] ? rateMap[r.id].rating : null,
    rating_count: rateMap[r.id] ? rateMap[r.id].rating_count : 0,
  }))
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

// PUT /api/trails/:id —— 编辑自己上传的路线（需登录）
app.put('/api/trails/:id', requireAuth, handler(async (req, res) => {
  const trail = await dbGet('SELECT id,user_id,source FROM trails WHERE id = ?', [req.params.id])
  if (!trail) return res.status(404).json({ success: false, message: '路线不存在' })
  const ownsTrail = trail.source === 'user' && trail.user_id === req.user.id
  if (!ownsTrail && !isAdmin(req.user))
    return res.status(403).json({ success: false, message: '只能编辑自己上传的路线' })

  const b = req.body || {}
  const name = (b.name || '').trim()
  const difficulty = b.difficulty
  if (!name) return res.status(400).json({ success: false, message: '路线名称不能为空' })
  if (!['入门', '进阶', '高难度'].includes(difficulty))
    return res.status(400).json({ success: false, message: '难度需为 入门/进阶/高难度' })

  const num = (v, d = 0) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v))
  const tags   = Array.isArray(b.tags) ? b.tags : []
  const images = Array.isArray(b.images) ? b.images.filter(Boolean) : []
  const coverImage = (b.cover_image || '').trim() || null

  await dbRun(
    `UPDATE trails SET
       name=?, province=?, region=?, difficulty=?,
       distance_km=?, duration_h=?, elevation_m=?, lat=?, lng=?,
       tags=?, summary=?, cover_emoji=?, cover_image=?, images=?
     WHERE id=?`,
    [name, (b.province || '').trim(), (b.region || b.province || '').trim(), difficulty,
     num(b.distance_km), num(b.duration_h), num(b.elevation_m), num(b.lat), num(b.lng),
     JSON.stringify(tags), (b.summary || '').trim(), b.cover_emoji || '⛰️',
     coverImage, JSON.stringify(images), req.params.id]
  )

  // 攻略 / 提示：先清空再按提交内容重建
  const tid = Number(req.params.id)
  if (Array.isArray(b.guides)) {
    await dbRun('DELETE FROM trail_guides WHERE trail_id = ?', [tid])
    let step = 0
    for (const g of b.guides) {
      if (!g || !g.title) continue
      await dbRun('INSERT INTO trail_guides (trail_id,step_no,title,description) VALUES (?,?,?,?)',
        [tid, ++step, g.title, g.description || ''])
    }
  }
  if (Array.isArray(b.tips)) {
    await dbRun('DELETE FROM trail_tips WHERE trail_id = ?', [tid])
    for (const t of b.tips) {
      if (!t || !t.content) continue
      const type = t.type === 'warn' ? 'warn' : 'good'
      await dbRun('INSERT INTO trail_tips (trail_id,type,content) VALUES (?,?,?)', [tid, type, t.content])
    }
  }

  res.json({ success: true, id: Number(req.params.id) })
}))

// DELETE /api/trails/:id —— 删除自己上传的路线（需登录）
app.delete('/api/trails/:id', requireAuth, handler(async (req, res) => {
  const trail = await dbGet('SELECT id,user_id,source FROM trails WHERE id = ?', [req.params.id])
  if (!trail) return res.status(404).json({ success: false, message: '路线不存在' })
  const ownsTrail = trail.source === 'user' && trail.user_id === req.user.id
  if (!ownsTrail && !isAdmin(req.user))
    return res.status(403).json({ success: false, message: '只能删除自己上传的路线' })
  await dbRun('DELETE FROM trails WHERE id = ?', [req.params.id])
  res.json({ success: true })
}))

// GET /api/trails/:id
app.get('/api/trails/:id', optionalAuth, handler(async (req, res) => {
  const trail = parseTrail(await dbGet('SELECT * FROM trails WHERE id = ?', [req.params.id]))
  if (!trail) return res.status(404).json({ success: false, message: '路线不存在' })

  const [guides, tips, fav, agg, reviews, myReview] = await Promise.all([
    dbAll('SELECT * FROM trail_guides WHERE trail_id = ? ORDER BY step_no', [trail.id]),
    dbAll('SELECT * FROM trail_tips  WHERE trail_id = ?', [trail.id]),
    req.user
      ? dbGet('SELECT id FROM favorites WHERE trail_id = ? AND user_id = ?', [trail.id, req.user.id])
      : Promise.resolve(null),
    dbGet('SELECT AVG(rating)::numeric(3,1) AS avg, COUNT(*)::int AS n FROM reviews WHERE trail_id = ?', [trail.id]),
    dbAll(`
      SELECT r.id, r.rating, r.content, r.created_at,
             COALESCE(u.nickname, u.username) AS user_name, u.avatar AS user_avatar
      FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.trail_id = ? ORDER BY r.created_at DESC LIMIT 20
    `, [trail.id]),
    req.user
      ? dbGet('SELECT id, rating, content FROM reviews WHERE trail_id = ? AND user_id = ?', [trail.id, req.user.id])
      : Promise.resolve(null),
  ])
  res.json({
    success: true,
    data: {
      ...trail, guides, tips, isFavorite: !!fav,
      rating: agg && agg.n ? Number(agg.avg) : null,
      rating_count: agg ? agg.n : 0,
      reviews,
      myReview: myReview || null,
    },
  })
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
// 评价 API
// ════════════════════════════════════════════════════════════════════════════

// POST /api/reviews/:trailId  { rating(1-5), content? } —— 新增/更新自己的评价（需登录）
app.post('/api/reviews/:trailId', requireAuth, handler(async (req, res) => {
  const trailId = Number(req.params.trailId)
  const rating = Math.round(Number(req.body && req.body.rating))
  const content = String((req.body && req.body.content) || '').trim().slice(0, 500)
  if (!(rating >= 1 && rating <= 5))
    return res.status(400).json({ success: false, message: '评分需为 1~5' })
  const trail = await dbGet('SELECT id FROM trails WHERE id = ?', [trailId])
  if (!trail) return res.status(404).json({ success: false, message: '路线不存在' })

  await dbRun(`
    INSERT INTO reviews (trail_id, user_id, rating, content)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (trail_id, user_id)
    DO UPDATE SET rating = EXCLUDED.rating, content = EXCLUDED.content,
                  created_at = to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
  `, [trailId, req.user.id, rating, content])

  const agg = await dbGet('SELECT AVG(rating)::numeric(3,1) AS avg, COUNT(*)::int AS n FROM reviews WHERE trail_id = ?', [trailId])
  res.json({ success: true, rating: Number(agg.avg), rating_count: agg.n })
}))

// DELETE /api/reviews/:trailId —— 删除自己的评价（需登录）
app.delete('/api/reviews/:trailId', requireAuth, handler(async (req, res) => {
  await dbRun('DELETE FROM reviews WHERE trail_id = ? AND user_id = ?', [Number(req.params.trailId), req.user.id])
  res.json({ success: true })
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

// PUT /api/records/:id（需登录，仅能改自己的）—— 编辑日期/用时/感受
app.put('/api/records/:id', requireAuth, handler(async (req, res) => {
  const rec = await dbGet('SELECT id, user_id FROM trip_records WHERE id = ?', [req.params.id])
  if (!rec) return res.status(404).json({ success: false, message: '记录不存在' })
  if (rec.user_id !== req.user.id) return res.status(403).json({ success: false, message: '只能编辑自己的记录' })
  const { date, duration_min, note } = req.body || {}
  if (!date) return res.status(400).json({ success: false, message: '请选择日期' })
  await dbRun(
    'UPDATE trip_records SET date = ?, duration_min = ?, note = ? WHERE id = ? AND user_id = ?',
    [date, duration_min || null, note || null, req.params.id, req.user.id]
  )
  res.json({ success: true })
}))

// DELETE /api/records/:id（需登录，仅能删自己的）
app.delete('/api/records/:id', requireAuth, handler(async (req, res) => {
  await dbRun('DELETE FROM trip_records WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  res.json({ success: true })
}))

// ════════════════════════════════════════════════════════════════════════════
// GPS 轨迹 API
// ════════════════════════════════════════════════════════════════════════════

// GET /api/tracks —— 当前用户录的轨迹（需登录）
app.get('/api/tracks', requireAuth, handler(async (req, res) => {
  const rows = await dbAll('SELECT * FROM tracks WHERE user_id = ? ORDER BY date DESC, id DESC', [req.user.id])
  res.json({ success: true, data: rows.map(r => ({ ...r, path: safeJson(r.path, []), waypoints: safeJson(r.waypoints, []) })) })
}))

// GET /api/tracks/public —— 轨迹广场：别人公开的轨迹（可选登录，标记是否已下载）
app.get('/api/tracks/public', optionalAuth, handler(async (req, res) => {
  const q = String(req.query.q || '').trim()
  const params = []
  let sql = `
    SELECT tk.id, tk.name, tk.date, tk.distance_km, tk.duration_min, tk.elevation_m, tk.user_id,
           COALESCE(u.nickname, u.username) AS owner_name
    FROM tracks tk JOIN users u ON u.id = tk.user_id
    WHERE tk.is_public = true`
  if (q) { sql += ' AND tk.name LIKE ?'; params.push(`%${q}%`) }
  sql += ' ORDER BY tk.date DESC, tk.id DESC LIMIT 100'
  const rows = await dbAll(sql, params)
  const savedSet = new Set()
  if (req.user) {
    const s = await dbAll('SELECT track_id FROM saved_tracks WHERE user_id = ?', [req.user.id])
    s.forEach(r => savedSet.add(r.track_id))
  }
  res.json({ success: true, data: rows.map(r => ({ ...r, isSaved: savedSet.has(r.id), isMine: req.user && r.user_id === req.user.id })) })
}))

// GET /api/tracks/saved —— 我下载/收藏的轨迹（需登录）
app.get('/api/tracks/saved', requireAuth, handler(async (req, res) => {
  const rows = await dbAll(`
    SELECT tk.id, tk.name, tk.date, tk.distance_km, tk.duration_min, tk.elevation_m, tk.user_id,
           COALESCE(u.nickname, u.username) AS owner_name, s.created_at AS saved_at
    FROM saved_tracks s
    JOIN tracks tk ON tk.id = s.track_id
    JOIN users u ON u.id = tk.user_id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `, [req.user.id])
  res.json({ success: true, data: rows.map(r => ({ ...r, isSaved: true })) })
}))

// POST /api/tracks —— 保存一条自己录的轨迹（需登录）
app.post('/api/tracks', requireAuth, handler(async (req, res) => {
  const b = req.body || {}
  const num = (v, d = 0) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v))
  const path = Array.isArray(b.path) ? b.path : []
  const waypoints = Array.isArray(b.waypoints) ? b.waypoints : []
  if (!b.date) return res.status(400).json({ success: false, message: '缺少日期' })
  const result = await dbRun(
    `INSERT INTO tracks (user_id, name, date, distance_km, duration_min, elevation_m, path, waypoints, is_public)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.id, String(b.name || '徒步轨迹').slice(0, 40), b.date,
     num(b.distance_km), Math.round(num(b.duration_min)), Math.round(num(b.elevation_m)),
     JSON.stringify(path), JSON.stringify(waypoints), b.is_public === false ? false : true]
  )
  res.json({ success: true, id: result.lastID })
}))

// GET /api/tracks/:id —— 轨迹详情（含完整路径点），可选登录标记是否已下载
app.get('/api/tracks/:id', optionalAuth, handler(async (req, res) => {
  const row = await dbGet(`
    SELECT tk.*, COALESCE(u.nickname, u.username) AS owner_name
    FROM tracks tk JOIN users u ON u.id = tk.user_id WHERE tk.id = ?
  `, [req.params.id])
  if (!row) return res.status(404).json({ success: false, message: '轨迹不存在' })
  let isSaved = false
  if (req.user) {
    const s = await dbGet('SELECT id FROM saved_tracks WHERE user_id = ? AND track_id = ?', [req.user.id, row.id])
    isSaved = !!s
  }
  res.json({ success: true, data: { ...row, path: safeJson(row.path, []), waypoints: safeJson(row.waypoints, []), isSaved, isMine: req.user && row.user_id === req.user.id } })
}))

// POST /api/tracks/:id/save —— 下载/取消下载（toggle，需登录）
app.post('/api/tracks/:id/save', requireAuth, handler(async (req, res) => {
  const trackId = Number(req.params.id)
  const tk = await dbGet('SELECT id FROM tracks WHERE id = ?', [trackId])
  if (!tk) return res.status(404).json({ success: false, message: '轨迹不存在' })
  const exists = await dbGet('SELECT id FROM saved_tracks WHERE user_id = ? AND track_id = ?', [req.user.id, trackId])
  if (exists) {
    await dbRun('DELETE FROM saved_tracks WHERE user_id = ? AND track_id = ?', [req.user.id, trackId])
    res.json({ success: true, isSaved: false })
  } else {
    await dbRun('INSERT INTO saved_tracks (user_id, track_id) VALUES (?, ?)', [req.user.id, trackId])
    res.json({ success: true, isSaved: true })
  }
}))

// DELETE /api/tracks/:id（需登录，仅能删自己录的）
app.delete('/api/tracks/:id', requireAuth, handler(async (req, res) => {
  await dbRun('DELETE FROM tracks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
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
  let { lat, lng, id, track } = req.query
  let pathPts = []
  let marker = true
  if (track) {
    const tk = await dbGet('SELECT path FROM tracks WHERE id = ?', [track])
    if (!tk) return res.status(404).json({ success: false, message: '轨迹不存在' })
    pathPts = safeJson(tk.path, [])
    if (pathPts.length) { lng = pathPts[0][0]; lat = pathPts[0][1] }
    marker = false   // 轨迹只画线，不打单点
  } else if (id) {
    const t = await dbGet('SELECT lat,lng,path FROM trails WHERE id = ?', [id])
    if (!t) return res.status(404).json({ success: false, message: '路线不存在' })
    lat = t.lat; lng = t.lng; pathPts = safeJson(t.path, [])
  }
  if (lat == null || lng == null || lat === '' || lng === '')
    return res.status(400).json({ success: false, message: '缺少坐标' })

  let url = `https://restapi.amap.com/v3/staticmap?key=${AMAP_KEY}`
    + `&location=${lng},${lat}&size=720*360&scale=2`
  if (marker) url += `&markers=large,0x1D9E75,:${lng},${lat}`
  if (Array.isArray(pathPts) && pathPts.length > 1) {
    // 高德静态图 paths 点数有限，超长轨迹做抽稀，最多约 100 点
    const step = Math.ceil(pathPts.length / 100)
    const sampled = pathPts.filter((_, i) => i % step === 0)
    if (sampled[sampled.length - 1] !== pathPts[pathPts.length - 1]) sampled.push(pathPts[pathPts.length - 1])
    const pts = sampled.map(p => `${p[0]},${p[1]}`).join(';')
    url += `&paths=6,0x1D9E75,1,,:${pts}`   // 有轨迹：让高德按路线自适应缩放
  } else {
    url += `&zoom=12`
  }
  pipeImage(url, res)
}))

// ════════════════════════════════════════════════════════════════════════════
// 图片上传（直接存数据库，无需外部对象存储）—— 适合中小体量，Render 重启不丢
// ════════════════════════════════════════════════════════════════════════════
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } })
function uploadSingle(req, res, next) {
  memUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || '上传失败' })
    next()
  })
}

// POST /api/upload —— 表单字段名 file（需登录）。返回 { id, url }
app.post('/api/upload', requireAuth, uploadSingle, handler(async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: '未收到图片文件' })
  const mime = req.file.mimetype || 'image/jpeg'
  if (!/^image\//.test(mime)) return res.status(400).json({ success: false, message: '仅支持图片文件' })
  const r = await dbRun('INSERT INTO images (user_id, mime, data) VALUES (?, ?, ?) RETURNING id',
    [req.user.id, mime, req.file.buffer])
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
  const host  = req.headers['x-forwarded-host'] || req.get('host')
  res.json({ success: true, id: r.lastID, url: `${proto}://${host}/api/images/${r.lastID}` })
}))

// GET /api/images/:id —— 读取图片字节（公开）
app.get('/api/images/:id', handler(async (req, res) => {
  const row = await dbGet('SELECT mime, data FROM images WHERE id = ?', [req.params.id])
  if (!row) return res.status(404).end()
  res.set('Content-Type', row.mime || 'image/jpeg')
  res.set('Cache-Control', 'public, max-age=2592000')
  res.send(row.data)
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

// ── 法律页面（供 App 隐私弹窗链接，无 /api 前缀，直接返回 HTML）──────────────────
function legalPage(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 野径 TrailGo</title>
<style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;line-height:1.8;max-width:720px;margin:0 auto;padding:24px}
h1{font-size:22px;color:#0F6E56}h2{font-size:17px;margin-top:24px}p{font-size:15px;color:#333}small{color:#888}</style>
</head><body><h1>${title}</h1>${bodyHtml}
<p><small>野径 TrailGo · 更新日期 2026-06</small></p></body></html>`
}

app.get('/privacy', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(legalPage('隐私政策', `
<p>欢迎使用「野径 TrailGo」（以下简称"本应用"）。我们非常重视您的个人信息与隐私保护，本政策说明我们如何收集、使用与保护您的信息。</p>
<h2>一、我们收集的信息</h2>
<p>1. <b>位置信息</b>：当您使用"附近路线""轨迹记录""跟随导航"等功能时，我们会在您授权后获取设备的精确定位（GPS/网络定位），用于显示附近徒步路线、记录您的运动轨迹、提供沿轨迹导航。位置信息仅在您主动使用相关功能时获取。</p>
<p>2. <b>账号信息</b>：您注册时提供的用户名、昵称、头像。</p>
<p>3. <b>内容信息</b>：您上传的路线、图片、出行记录、评价与轨迹。</p>
<h2>二、信息的使用</h2>
<p>用于实现路线浏览、定位与导航、轨迹记录、收藏、评价、个人中心等核心功能；不会用于与上述无关的用途。</p>
<h2>三、第三方服务</h2>
<p>本应用使用<b>高德地图（Amap）SDK</b>提供地图展示与定位服务，可能收集设备位置、设备标识等信息，详见高德相应隐私政策。</p>
<h2>四、信息的存储与保护</h2>
<p>数据存储于服务器并采取合理的安全措施保护。您可随时删除自己上传的内容与记录。</p>
<h2>五、您的权利</h2>
<p>您可在系统设置中关闭定位权限（关闭后定位相关功能将不可用）；可注销账号删除个人数据。</p>
<h2>六、联系我们</h2>
<p>如有疑问，请通过应用内反馈与我们联系。</p>`))
})

app.get('/agreement', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(legalPage('服务协议', `
<p>在使用「野径 TrailGo」前，请阅读并同意本服务协议。</p>
<h2>一、服务内容</h2>
<p>本应用提供户外徒步路线浏览、天气查询、GPS 轨迹记录与跟随导航、路线收藏与评价、内容上传等功能。</p>
<h2>二、用户行为规范</h2>
<p>您应对自己上传的路线、图片、评价等内容负责，不得发布违法、侵权或不实信息。</p>
<h2>三、户外安全免责</h2>
<p>本应用提供的路线、轨迹与导航信息<b>仅供参考</b>，实际路况、天气与风险请您自行评估。户外活动存在固有风险，请做好准备并量力而行，因户外活动造成的人身或财产损失，本应用不承担责任。</p>
<h2>四、账号</h2>
<p>请妥善保管账号密码，账号下的操作视为您本人行为。</p>
<h2>五、协议变更</h2>
<p>我们可能适时更新本协议，更新后继续使用即视为同意。</p>`))
})

// ── 启动前确保新表存在（幂等，Render 部署无需手动迁移）──────────────────────────
async function ensureSchema() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS reviews (
      id         SERIAL  PRIMARY KEY,
      trail_id   INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      rating     INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      content    TEXT    DEFAULT '',
      created_at TEXT    DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(trail_id, user_id)
    )
  `)
  // GPS 实时轨迹（不依赖具体路线，独立记录）
  await dbRun(`
    CREATE TABLE IF NOT EXISTS tracks (
      id           SERIAL  PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL DEFAULT '徒步轨迹',
      date         TEXT    NOT NULL,
      distance_km  REAL    NOT NULL DEFAULT 0,
      duration_min INTEGER NOT NULL DEFAULT 0,
      elevation_m  INTEGER NOT NULL DEFAULT 0,
      path         TEXT    NOT NULL DEFAULT '[]',
      waypoints    TEXT    NOT NULL DEFAULT '[]',
      is_public    BOOLEAN NOT NULL DEFAULT true,
      created_at   TEXT    DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await dbRun(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true`)
  await dbRun(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS waypoints TEXT NOT NULL DEFAULT '[]'`)
  // 轨迹下载/收藏关系
  await dbRun(`
    CREATE TABLE IF NOT EXISTS saved_tracks (
      id         SERIAL  PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      created_at TEXT    DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(user_id, track_id)
    )
  `)
  // 图片：直接存库（无需外部对象存储，Render 重启不丢）
  await dbRun(`
    CREATE TABLE IF NOT EXISTS images (
      id         SERIAL  PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      mime       TEXT    NOT NULL DEFAULT 'image/jpeg',
      data       BYTEA   NOT NULL,
      created_at TEXT    DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
ensureSchema()
  .catch(err => console.error('ensureSchema 失败:', err))
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌄 TrailGo 后端运行在 http://0.0.0.0:${PORT}`)
      console.log(`   API 文档: GET/POST /api/trails | /api/favorites | /api/records | /api/stats | /api/reviews`)
    })
  })

// 优雅退出
process.on('SIGINT', async () => { await pool.end(); process.exit(0) })
