/**
 * initDb.js — 初始化 SQLite 数据库，建表并写入种子数据
 * 使用: node initDb.js
 */
const sqlite3 = require('sqlite3').verbose()
const path = require('path')

const DB_PATH = path.join(__dirname, 'trailgo.db')
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('打开数据库失败:', err.message); process.exit(1) }
  console.log('📂 数据库已连接:', DB_PATH)
})

// 辅助：将 db.run 包装成 Promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this)
    })
  })
}

async function init() {
  // ── 开启外键 & WAL ──────────────────────────────────────────────────────────
  await run('PRAGMA foreign_keys = ON')
  await run('PRAGMA journal_mode = WAL')

  // ── 建表 ────────────────────────────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS trails (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
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
      created_at  TEXT    DEFAULT (datetime('now','localtime'))
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS trail_guides (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      trail_id    INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      step_no     INTEGER NOT NULL,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS trail_tips (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      trail_id INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      type     TEXT    NOT NULL CHECK(type IN ('good','warn')),
      content  TEXT    NOT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trail_id   INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      created_at TEXT    DEFAULT (datetime('now','localtime')),
      UNIQUE(trail_id)
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS trip_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      trail_id     INTEGER NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
      date         TEXT    NOT NULL,
      duration_min INTEGER,
      note         TEXT,
      created_at   TEXT    DEFAULT (datetime('now','localtime'))
    )
  `)

  // ── 种子：路线 ──────────────────────────────────────────────────────────────
  const trails = [
    [1, '百花山穿越',   '北京·门头沟', '进阶',   16.5, 7, 980,  39.967, 115.477, '["赏花","登顶","亲子"]',   '百花山国家级自然保护区核心穿越线路，春夏百花盛开，山顶可俯瞰京西群峰。', '🌸'],
    [2, '灵山主峰穿越', '北京·门头沟', '高难度', 22,   9, 1420, 40.052, 115.283, '["草甸","挑战","摄影"]',   '北京最高峰2303米，高山草甸壮阔，越野体验极佳，需具备丰富山地经验。',   '🏔️'],
    [3, '妙峰山环线',   '北京·门头沟', '入门',   8,    3, 460,  40.013, 116.057, '["花卉","短途","拍照"]',   '全程台阶铺装，玫瑰花节期间花海如潮，适合家庭亲子和初级徒步者。',       '🌹'],
    [4, '东灵山环穿',   '河北·涿鹿',   '进阶',   18,   8, 1100, 40.046, 115.318, '["草甸","越野","宿营"]',   '跨省穿越线路，山脊草甸延绵数公里，可扎营，秋季层林尽染。',             '⛺'],
    [5, '箭扣长城穿越', '北京·怀柔',   '高难度', 12,   6, 850,  40.434, 116.452, '["长城","险峻","摄影"]',   '北京最险野长城路段，鹰飞倒仰、天梯等标志性景点，摄影圣地。',           '🧱'],
    [6, '凤凰岭北线',   '北京·海淀',   '入门',   9,  3.5, 520,  40.103, 116.099, '["森林","休闲","负氧离子"]','城区近郊首选，森林覆盖率高，空气清新，适合周末短途放松。',             '🌲'],
  ]

  for (const t of trails) {
    await run(
      `INSERT OR IGNORE INTO trails
         (id,name,region,difficulty,distance_km,duration_h,elevation_m,lat,lng,tags,summary,cover_emoji)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      t
    )
  }

  // ── 种子：攻略步骤 ──────────────────────────────────────────────────────────
  const guides = [
    [1,1,'出发',     '从百花山停车场出发，沿景区主登山道上行，约3km到达半山亭，有饮水站可补水休息。'],
    [1,2,'陡升段',   '过半山亭后路段开始陡升，累计爬升约400m进入草甸区，视野豁然开朗，注意防风。'],
    [1,3,'草甸穿越', '草甸区横向穿越约4km，春夏百花盛开，建议放慢脚步拍照赏景。'],
    [1,4,'登顶',     '到达百花山主峰（海拔1991m），360°观景台可俯瞰京西群峰，推荐在此午餐30分钟。'],
    [1,5,'下撤',     '从主峰沿另一侧山脊下撤，途经古庙遗址和天然泉眼，全程返回停车场约2.5小时。'],

    [2,1,'起点集合', '灵山村停车场集合，办理入山登记（需提前预约），装备检查确认。'],
    [2,2,'林区上升', '穿越华北落叶松林区，爬升约600m，路迹清晰，节奏不宜过快。'],
    [2,3,'高山草甸', '进入2000m以上草甸地带，风力增大，穿上冲锋衣，向主峰推进。'],
    [2,4,'主峰登顶', '北京最高峰2303m，晴天可远眺张家口方向，停留拍照后及时下撤。'],
    [2,5,'原路返回', '建议原路下撤，切勿走捷径，下山前确认所有成员状态良好。'],

    [3,1,'景区入口', '从妙峰山景区东门购票入场，沿台阶主道上行，全程铺装路面。'],
    [3,2,'玫瑰花谷', '约2km处进入玫瑰花谷，花期（5-6月）花海壮观，建议充分拍照留念。'],
    [3,3,'山顶平台', '登顶妙峰山（海拔1291m），有小卖部可补充食水，休息15分钟。'],
    [3,4,'环形返回', '走另一侧路线下山，欣赏不同角度风景，形成完整环线。'],

    [4,1,'河北侧出发','从涿鹿县东灵山登山口出发，需自驾或包车前往，路程较远建议早起。'],
    [4,2,'山脊主线', '沿东西走向山脊穿行，草甸开阔，视野极佳，注意GPS轨迹避免走偏。'],
    [4,3,'扎营区域', '如选择宿营，在指定区域搭帐篷，夜晚星空纯净，强烈推荐体验。'],
    [4,4,'下撤北京侧','从北京门头沟侧下撤，需提前安排好接送车辆，完成穿越。'],

    [5,1,'涧口村出发','从涧口村停车，步行进入箭扣长城区域，需一定攀爬技术。'],
    [5,2,'鹰飞倒仰', '最险峻段，几乎垂直的长城敌楼需手脚并用攀爬，注意安全。'],
    [5,3,'北京结',   '长城交汇的标志性地点，绝佳摄影位，多角度拍摄长城蜿蜒之美。'],
    [5,4,'西大墙',   '穿越终点，景色壮阔，在此等待接驳或原路返回涧口村。'],

    [6,1,'东门入场', '从凤凰岭东门购票，沿主道进入，前500m为热身平路段。'],
    [6,2,'北线岔路', '分叉口走北线，进入茂密松林，空气清新，负氧离子丰富。'],
    [6,3,'飞来石塔', '参观飞来石塔古迹，了解当地历史文化，短暂休息。'],
    [6,4,'环线返回', '走南线环回东门，全程路况良好，适合带小朋友的家庭。'],
  ]

  for (const [tid, step, title, desc] of guides) {
    await run(
      `INSERT OR IGNORE INTO trail_guides (trail_id,step_no,title,description) VALUES (?,?,?,?)`,
      [tid, step, title, desc]
    )
  }

  // ── 种子：出行提示 ──────────────────────────────────────────────────────────
  const tips = [
    [1,'good','建议早7点前出发，避开午后高温和可能的雷阵雨'],
    [1,'good','携带至少2L饮水，山顶无稳定补水点'],
    [1,'warn','海拔1800m以上风力较大，备好抓绒或冲锋衣'],
    [1,'warn','湿滑天气请勿出行，近期有降雨需等路面干燥再行'],

    [2,'good','需提前在灵山景区官网预约入山，旺季名额紧张'],
    [2,'good','携带头灯以防下山时间过晚，备足高热量食物'],
    [2,'warn','主峰气温比山脚低8-12°C，必须携带保暖层'],
    [2,'warn','高难度路线，心肺功能较弱者请选择其他路线'],

    [3,'good','花期（5月下旬-6月）最佳，可结合景区活动参观'],
    [3,'good','全程铺装台阶，普通运动鞋即可，适合老人小孩'],
    [3,'warn','节假日游客较多，建议工作日或早8点前出发'],

    [4,'good','提前规划接送车辆，穿越路线两端停车场不同'],
    [4,'good','扎营需自备所有装备，山上无任何设施'],
    [4,'warn','跨省路线手机信号弱，提前下载离线地图'],
    [4,'warn','秋季9-10月最佳，避开7-8月雷暴高发期'],

    [5,'good','日出时拍摄长城云海效果绝佳，建议提前抵达'],
    [5,'good','结伴而行，至少3人以上组队，携带对讲机'],
    [5,'warn','部分地段无固定路迹，需有经验者领队'],
    [5,'warn','禁止在长城文物上攀爬涂刻，文明游览'],

    [6,'good','城区距离近，地铁+公交可达，无需自驾'],
    [6,'good','全年开放，秋季红叶、春季山花均值得一游'],
    [6,'warn','景区内部分路段有台阶，不适合轮椅使用者'],
  ]

  for (const [tid, type, content] of tips) {
    await run(
      `INSERT OR IGNORE INTO trail_tips (trail_id,type,content) VALUES (?,?,?)`,
      [tid, type, content]
    )
  }

  console.log('✅ 数据库初始化完成，共写入：')
  console.log('   路线 6 条 | 攻略步骤 24 条 | 提示 21 条')
  db.close()
}

init().catch((err) => {
  console.error('初始化失败:', err)
  db.close()
  process.exit(1)
})
