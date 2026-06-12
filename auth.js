/**
 * auth.js — 用户认证工具：bcrypt 密码哈希 + JWT 签发/校验 + 鉴权中间件
 */
const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'trailgo-dev-secret-change-me'
const TOKEN_TTL  = '30d'

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10)
}
async function comparePassword(pw, hash) {
  return bcrypt.compare(pw, hash)
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL })
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET) } catch { return null }
}

function bearer(req) {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

// 必须登录：无有效 token 返回 401
function requireAuth(req, res, next) {
  const payload = verifyToken(bearer(req))
  if (!payload) return res.status(401).json({ success: false, message: '请先登录' })
  req.user = payload
  next()
}

// 可选登录：有 token 就附带 req.user，没有也放行
function optionalAuth(req, res, next) {
  const payload = verifyToken(bearer(req))
  if (payload) req.user = payload
  next()
}

module.exports = { hashPassword, comparePassword, signToken, verifyToken, requireAuth, optionalAuth }
