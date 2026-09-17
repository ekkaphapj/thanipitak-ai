const express = require('express');

function createRealAuthRoutes({ url = require('../realConfig').url, key = require('../realConfig').key, request = fetch } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!url || !key) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูลจริง', code: 'REAL_AUTH_NOT_CONFIGURED' });
    next();
  });
  async function profile(token) {
    const headers = { apikey: key, Authorization: `Bearer ${token}` };
    const auth = await request(`${url}/auth/v1/user`, { headers, signal: AbortSignal.timeout(10000) });
    if (!auth.ok) return null;
    const identity = await auth.json();
    const result = await request(`${url}/rest/v1/users?select=user_id,username,name,station_id,user_type&auth_id=eq.${encodeURIComponent(identity.id)}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!result.ok) return null;
    const rows = await result.json();
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const p = rows[0];
    let station = null;
    if (Number.isSafeInteger(p.station_id)) {
      const params = new URLSearchParams({ select: 'station_id,station_name,division,province', station_id: `eq.${p.station_id}` });
      const response = await request(`${url}/rest/v1/stations?${params}`, { headers, signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const stations = await response.json();
        if (Array.isArray(stations) && stations.length === 1 && stations[0].station_id === p.station_id) station = stations[0];
      }
    }
    return { id: p.user_id, username: p.username, name: p.name, stationId: p.station_id,
      stationName: station?.station_name || null, division: station?.division || null, province: station?.province || null,
      roleLabel: { Admin: 'ผู้ดูแลระบบ', User: 'เจ้าหน้าที่', External: 'หน่วยงานภายนอก' }[p.user_type] || 'ผู้ใช้งาน',
      role: p.user_type === 'Admin' ? 'admin' : p.user_type === 'User' ? 'officer' : 'viewer', dataSource: 'real' };
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
      if (!user) return res.status(403).json({ error: 'ไม่พบบัญชีผู้ใช้ที่มีสิทธิ์ในระบบจริง' });
      return res.json({ token: session.access_token, user, dataSource: 'real' });
    } catch { return res.status(502).json({ error: 'ติดต่อระบบเข้าสู่ฐานข้อมูลจริงไม่ได้ กรุณาลองใหม่' }); }
  });
  router.get('/me', async (req, res) => {
    try {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      const user = token && await profile(token);
      if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ฐานข้อมูลจริงใหม่' });
      return res.json({ user });
    } catch { return res.status(502).json({ error: 'ติดต่อฐานข้อมูลจริงไม่ได้' }); }
  });
  router.authenticate = async (req,res,next) => {
    try {
      const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
      const user = token && await profile(token);
      if (!user) return res.status(401).json({error:'กรุณาเข้าสู่ระบบจริงใหม่'});
      req.user=user; req.realToken=token; next();
    } catch {res.status(502).json({error:'ตรวจสอบสิทธิ์ระบบจริงไม่ได้'});}
  };
  return router;
}
module.exports = { createRealAuthRoutes };
