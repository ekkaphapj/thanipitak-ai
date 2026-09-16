const express = require('express');
const { createUserService } = require('../services/userService');
const { authRequired } = require('../middleware/auth');

function createAuthRoutes(db, audit) {
  const router = express.Router();
  const users = createUserService(db);

  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: 'กรุณาส่ง username และ password', code: 'MISSING_CREDENTIALS' });
    }

    const user = users.verifyCredentials(String(username), String(password));
    if (!user) {
      audit(null, 'login_failed', '/api/auth/login', String(username));
      return res
        .status(401)
        .json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', code: 'INVALID_CREDENTIALS' });
    }

    const token = users.signToken(user);
    audit(user, 'login', '/api/auth/login', user.id);
    return res.json({ token, user: users.publicProfile(user) });
  });

  router.get('/me', authRequired, (req, res) => {
    audit(req.user, 'me', '/api/auth/me', req.user.id);
    const fresh = users.findById(req.user.id);
    if (!fresh) return res.status(401).json({ error: 'บัญชีไม่พบในระบบ', code: 'UNKNOWN_USER' });
    return res.json({ user: users.publicProfile(fresh) });
  });

  return router;
}

module.exports = { createAuthRoutes };