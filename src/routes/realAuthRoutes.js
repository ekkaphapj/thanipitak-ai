const express = require('express');

function createRealAuthRoutes({ url = require('../realConfig').url, key = require('../realConfig').key, request = fetch } = {}) {
  const router = express.Router();
  const { createRealAiTools } = require('../services/realAiTools');
  const aiTools = createRealAiTools({ url, key, request });
  router.use((req, res, next) => {
    if (!url || !key) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูลจริง', code: 'REAL_AUTH_NOT_CONFIGURED' });
    next();
  });
  // Stage-coded rejection reasons for journald diagnostics. The marker is
  // never serialized into an HTTP response and carries no credential or
  // personal data: fixed stage words, HTTP status codes, row counts and the
  // row's role label (a system enum, the same class of value the audit log
  // already records).
  function rejection(stage, detail) {
    return { rejected: detail === undefined ? stage : `${stage}:${detail}` };
  }
  function rejected(user) {
    return user && user.rejected ? user.rejected : null;
  }
  function logRejection(route, reason) {
    console.log(`[real-auth] rejected route=${route} stage=${reason}`);
  }
  function safeRoleLabel(value) {
    if (typeof value !== 'string' || !value.trim()) return 'empty';
    const clean = value.trim().replace(/[^A-Za-z0-9ก-๙_.\- ]/g, '').slice(0, 40);
    return clean || 'other';
  }
  // The primary system stores user_type in both English and Thai spellings
  // and has added '+' variants (ผู้ใช้ทั่วไป+ / admin+ / super admin+) after
  // the releases this sandbox could inspect, so exact-string allowlists keep
  // breaking. Classify by normalized tokens instead: external units
  // (หน่วยนอก/External/บุคคลภายนอก) are rejected, unknown values fail closed,
  // and every admitted class still only gets data through RLS-bound reads
  // with the caller's own JWT - this gate is not the data-plane authority.
  function classifyUserType(value) {
    if (typeof value !== 'string') return null;
    const n = value.trim().toLowerCase().replace(/[\s\u200b]+/g, '');
    if (!n) return null;
    if (n.includes('external') || n.includes('ภายนอก') || n.includes('หน่วยนอก')) return null;
    if (n.includes('superadmin') || n.includes('ผู้ดูแลระบบหลัก')) return 'superAdmin';
    if (n.includes('admin') || n.includes('ผู้ดูแลระบบ')) return 'admin';
    if (n === 'user' || n.includes('ผู้ใช้ทั่วไป')) return 'officer';
    return null;
  }
  async function profile(token) {
    const headers = { apikey: key, Authorization: `Bearer ${token}` };
    const auth = await request(`${url}/auth/v1/user`, { headers, signal: AbortSignal.timeout(10000) });
    if (!auth.ok) return rejection('auth_user_http', auth.status);
    const identity = await auth.json();
    const result = await request(`${url}/rest/v1/users?select=user_id,username,name,station_id,user_type&auth_id=eq.${encodeURIComponent(identity.id)}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!result.ok) return rejection('users_http', result.status);
    const rows = await result.json();
    if (!Array.isArray(rows)) return rejection('users_rows', 'invalid');
    if (rows.length !== 1) return rejection('users_rows', rows.length);
    const p = rows[0];
    // The primary profile is the authorization source.  Do not admit an
    // External account merely because it can present a valid Supabase token.
    const typeClass = classifyUserType(p.user_type);
    if (!typeClass) return rejection('user_type', safeRoleLabel(p.user_type));
    const { parseStationId } = require('../services/stationScope');
    const stationId = parseStationId(p.station_id);
    let station = null;
    if (stationId) {
      const params = new URLSearchParams({ select: 'station_id,station_name,division,province', station_id: `eq.${stationId}` });
      const response = await request(`${url}/rest/v1/stations?${params}`, { headers, signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const stations = await response.json();
        if (Array.isArray(stations) && stations.length === 1 && Number(stations[0].station_id) === stationId) station = stations[0];
      }
    }
    // Scope is returned by the primary system's authenticated Edge Function.
    // Do not derive it from the browser profile or from a local role mapping.
    const aiScope = await aiTools.accessScope(token);
    return { id: p.user_id, username: p.username, name: p.name, stationId,
      stationName: station?.station_name || null, division: station?.division || null, province: station?.province || null,
      roleLabel: { superAdmin: 'ผู้ดูแลระบบหลัก', admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่' }[typeClass],
      role: typeClass === 'officer' ? 'officer' : 'admin',
      aiScope, dataSource: 'real' };
  }
  function sessionPayload(session, user) {
    const payload = { token: session.access_token, user, dataSource: 'real' };
    if (session.refresh_token) payload.refreshToken = session.refresh_token;
    if (Number.isFinite(session.expires_in)) payload.expiresIn = session.expires_in;
    return payload;
  }
  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) return res.status(400).json({ error: 'กรุณาระบุชื่อผู้ใช้และรหัสผ่าน' });
    try {
      const result = await request(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${username.trim()}@thaniphitak.local`, password }), signal: AbortSignal.timeout(10000),
      });
      if (!result.ok) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านฐานข้อมูลจริงไม่ถูกต้อง' });
      const session = await result.json();
      const user = await profile(session.access_token);
      const reason = rejected(user);
      if (reason) logRejection('login', reason);
      if (!user || reason) return res.status(403).json({ error: 'ไม่พบบัญชีผู้ใช้ที่มีสิทธิ์ในระบบจริง' });
      return res.json(sessionPayload(session, user));
    } catch { return res.status(502).json({ error: 'ติดต่อระบบเข้าสู่ฐานข้อมูลจริงไม่ได้ กรุณาลองใหม่' }); }
  });
  router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) return res.status(400).json({ error: 'ไม่พบรหัสต่ออายุการเข้าสู่ระบบ' });
    try {
      const result = await request(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.timeout(10000),
      });
      if (!result.ok) return res.status(401).json({ error: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
      const session = await result.json();
      if (!session || !session.access_token) return res.status(401).json({ error: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
      // Re-verify the whole profile after the refresh grant. A disabled or
      // demoted account fails closed here; the new token is never issued to it.
      const user = await profile(session.access_token);
      const reason = rejected(user);
      if (reason) logRejection('refresh', reason);
      if (!user || reason) return res.status(403).json({ error: 'ไม่พบบัญชีผู้ใช้ที่มีสิทธิ์ในระบบจริง' });
      return res.json(sessionPayload(session, user));
    } catch { return res.status(502).json({ error: 'ติดต่อระบบเข้าสู่ฐานข้อมูลจริงไม่ได้ กรุณาลองใหม่' }); }
  });
  router.get('/me', async (req, res) => {
    try {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      const user = token && await profile(token);
      const reason = rejected(user);
      if (reason) logRejection('me', reason);
      if (!user || reason) return res.status(401).json({ error: 'กรุณาเข้าสู่ฐานข้อมูลจริงใหม่' });
      return res.json({ user });
    } catch { return res.status(502).json({ error: 'ติดต่อฐานข้อมูลจริงไม่ได้' }); }
  });
  router.authenticate = async (req,res,next) => {
    try {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      const user = token && await profile(token);
      const reason = rejected(user);
      if (reason) logRejection('authenticate', reason);
      if (!user || reason) return res.status(401).json({error:'กรุณาเข้าสู่ระบบจริงใหม่'});
      req.user=user; req.realToken=token; next();
    } catch {res.status(502).json({error:'ตรวจสอบสิทธิ์ระบบจริงไม่ได้'});}
  };
  return router;
}
module.exports = { createRealAuthRoutes };
