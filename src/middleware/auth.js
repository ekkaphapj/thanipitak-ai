const jwt = require('jsonwebtoken');
const config = require('../config');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

function authRequired(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'ไม่พบ Token กรุณาเข้าสู่ระบบก่อน', code: 'NO_TOKEN' });
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Token ไม่ถูกต้องหรือหมดอายุแล้ว', code: 'INVALID_TOKEN' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'ต้องเป็นผู้ดูแลระบบ (admin) เท่านั้น', code: 'FORBIDDEN' });
  }
  return next();
}

module.exports = { authRequired, adminOnly, extractToken };