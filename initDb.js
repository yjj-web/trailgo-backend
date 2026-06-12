/**
 * initDb.js — 初始化 PostgreSQL 数据库，建表并写入种子数据
 * 使用: node initDb.js
 *
 * 种子版本机制：seedData.SEED_VERSION 变化时自动重灌路线数据（清空 trails →
 * 级联清掉 guides/tips/收藏/记录 → 重新写入），版本不变则跳过，保留用户数据。
 */
const { pool, toPg } = require('./db')
const seed = require('./seedData')

const run = (sql, params = []) => pool.query(toPg(sql), params)

async function init() {
  // ── 建表 ────────────────────────────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS trails (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      province    TEXT    NOT NULL DEFAULT '',
      region      TEXT    NOT NULL,
      difficulty  TEXT    NOT NULL CHECK(difficulty IN ('入门','进阶','高难度')),
      distance_km REAL    NOT NULL,
      duration_h  REAL    NOT NULL,
      elevation_m INTEGER NOT NULL,
      lat         REAL    NOT NULL,
      lng         REAL    NOT NULL,
      tags        TEXT    NOT NULL DEFAULT '[]',
      summary     TEXT,
      cover_emoji TEXT    DEFAULT '⛰️',
      created_at  TEXT    DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  // 兼容已存在的旧表：补 province 列
  await run(`ALTER TABLE trails ADD COLUMN IF NOT EXISTS province TEXT NOT NULL DEFAULT ''`)

  await run(`
    CREATE TABLE IF NOT EXISTS trail_guides (
      id          SERIAL  PRIMARY KEY,
      trail_id    INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      step_no     INTEGER NOT NULL,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS trail_tips (
      id       SERIAL  PRIMARY KEY,
      trail_id INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      type     TEXT    NOT NULL CHECK(type IN ('good','warn')),
      content  TEXT    NOT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id         SERIAL  PRIMARY KEY,
      trail_id   INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      created_at TEXT    DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(trail_id)
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS trip_records (
      id           SERIAL  PRIMARY KEY,
      trail_id     INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      date         TEXT    NOT NULL,
      duration_min INTEGER,
      note         TEXT,
      created_at   TEXT    DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // 元数据表：记录种子版本
  await run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)

  // ── 种子版本判断 ─────────────────────────────────────────────────────────────
  const { rows: vrows } = await run(`SELECT value FROM meta WHERE key = 'seed_version'`)
  const current = vrows[0] && vrows[0].value
  if (current === seed.SEED_VERSION) {
    console.log(`ℹ️  种子版本一致 (${current})，跳过重灌`)
    return
  }
  console.log(`♻️  种子版本变化：${current || '(无)'} → ${seed.SEED_VERSION}，重新写入路线数据`)

  // 清空路线（级联清掉 guides/tips/收藏/记录），再写入新种子
  await run(`DELETE FROM trails`)

  for (const t of seed.trails) {
    await run(
      `INSERT INTO trails
         (id,name,province,region,difficulty,distance_km,duration_h,elevation_m,lat,lng,tags,summary,cover_emoji)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t
    )
  }
  for (const g of seed.guides) {
    await run(`INSERT INTO trail_guides (trail_id,step_no,title,description) VALUES (?,?,?,?)`, g)
  }
  for (const tp of seed.tips) {
    await run(`INSERT INTO trail_tips (trail_id,type,content) VALUES (?,?,?)`, tp)
  }

  // 记录新版本
  await run(
    `INSERT INTO meta (key,value) VALUES ('seed_version', ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [seed.SEED_VERSION]
  )

  console.log('✅ 数据库初始化完成，共写入：')
  console.log(`   路线 ${seed.trails.length} 条 | 攻略步骤 ${seed.guides.length} 条 | 提示 ${seed.tips.length} 条`)
}

init()
  .then(() => pool.end())
  .catch((err) => {
    console.error('初始化失败:', err)
    pool.end()
    process.exit(1)
  })
