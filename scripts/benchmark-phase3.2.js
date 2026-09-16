const http = require('http');

// Phase 3.2 real-performance benchmark (station1_off against live /api/ai/chat)
const QUESTIONS = [
  { q: 'มีผู้ป่วยจิตเวชกี่คน', expect: ['37'], label: '1' },
  { q: 'มีผู้เสพกี่คน', expect: ['36'], label: '2' },
  { q: 'มีผู้ค้ากี่คน', expect: ['27'], label: '3' },
  { q: 'มีทั้งหมดกี่คน', expect: ['100'], label: '4' },
  { q: 'สรุปจำนวนบุคคลแยกตามประเภท', expect: ['100', '37', '36', '27'], label: '5' },
  { q: 'ขอรายชื่อผู้ป่วยจิตเวช', expect: ['37', '20'], label: '6' },
  { q: 'ขอรายชื่อผู้เสพ', expect: ['36', '20'], label: '7' },
  { q: 'นายสมชายมีประวัติการเยี่ยมอย่างไร', expect: ['latest_visit'], label: '8' },
];

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://127.0.0.1:3100');
    const d = body ? JSON.stringify(body) : null;
    const o = { method, headers: {}, timeout: 180000 };
    if (d) { o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = Buffer.byteLength(d); }
    if (token) o.headers.Authorization = 'Bearer ' + token;
    const r = http.request(url, o, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString('utf8')) }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (d) r.write(d);
    r.end();
  });
}

function ok(body, q) {
  const line = (body.answer || '').toLowerCase();
  const extras = body.presentation ? JSON.stringify(body.presentation).toLowerCase() : line;
  return q.expect.every((e) => extras.includes(e.toLowerCase()));
}

async function main() {
  const target = Number(process.argv[2] || '0');
  const lr = await req('POST', '/api/auth/login', { username: 'station1_off', password: 'thanipitak123' });
  const token = lr.body.token;
  if (!token) { console.log('login failed'); return; }

  const only = target > 0 ? [{ ...QUESTIONS[target - 1], index: target - 1 }] : QUESTIONS.map((q, i) => ({ ...q, index: i }));

  for (const item of only) {
    const s = Date.now();
    try {
      const r = await req('POST', '/api/ai/chat', { message: item.q }, token);
      const wall = Date.now() - s;
      const code = r.body.meta && r.body.meta.fastPath;
      const grounded = r.body.grounded != null ? r.body.grounded : (r.body.meta && r.body.meta.grounded);
      const pres = r.body.presentation;
      console.log(JSON.stringify({
        label: item.label,
        question: item.q,
        expected: item.expect,
        status: r.status,
        responseTimeMs: r.body.meta ? r.body.meta.responseTimeMs : null,
        wallMs: wall,
        fastPath: code,
        tool: (r.body.toolsUsed || []).map((t) => t.name).join(','),
        grounded,
        ok: r.status === 200 && ok(r.body, item),
        total: pres ? pres.total : null,
        returned: pres ? pres.returned : null,
        answer: (r.body.answer || '').slice(0, 220),
      }));
    } catch (e) {
      console.log(JSON.stringify({ label: item.label, error: e.message, wallMs: Date.now() - s }));
    }
  }
}

main();