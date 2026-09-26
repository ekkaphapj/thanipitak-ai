const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRealDataRoutes, detectOwnStationOverview, detectProvinceStationOverview } = require('../src/routes/realDataRoutes');
const { detectOverview } = require('../src/services/overviewService');

// Registry fixtures behind the mocked Supabase: สภ.บ้านดุง (station 73) with
// three target people across two subdistricts, plus one neighbouring station.
const PEOPLE = [
  { id: 1, type_id: 10, station_id: 73, province: 'อุดรธานี', amphoe: 'บ้านดุง', tambon: 'บ้านดุง' },
  { id: 2, type_id: 11, station_id: 73, province: 'อุดรธานี', amphoe: 'บ้านดุง', tambon: 'โพนสูง' },
  { id: 3, type_id: 12, station_id: 73, province: 'อุดรธานี', amphoe: 'บ้านดุง', tambon: 'บ้านดุง' },
];
const TYPES = [
  { type_id: 10, type_name: 'ผู้ป่วยจิตเวช' },
  { type_id: 11, type_name: 'ผู้เสพ' },
  { type_id: 12, type_name: 'ผู้พ้นโทษ' },
];
const STATIONS = [
  { station_id: 73, station_name: 'สภ.บ้านดุง', province: 'อุดรธานี' },
  { station_id: 74, station_name: 'สภ.หนองหาปลา', province: 'อุดรธานี' },
];

function page(items) {
  return { ok: true, headers: new Headers({ 'content-range': items.length ? `0-${items.length - 1}/${items.length}` : '*/0' }), json: async () => items };
}

function makeMock() {
  const calls = [];
  const handler = async (url, opts) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: u.searchParams, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u.pathname.endsWith('/functions/v1/ai-summary')) {
      return { ok: true, json: async () => ({ report_type: 'target_person_summary', scope: { level: 'province', province: 'อุดรธานี' }, rows: [
        { station_name: 'สภ.บ้านดุง', province: 'อุดรธานี', psychiatric_total: 1, drug_user_total: 1, dealer_total: 0, released_total: 1, target_total: 3 },
        { station_name: 'สภ.หนองหาปลา', province: 'อุดรธานี', psychiatric_total: 0, drug_user_total: 0, dealer_total: 0, released_total: 0, target_total: 0 },
      ] }) };
    }
    if (u.pathname.endsWith('/stations')) {
      const name = u.searchParams.get('station_name');
      if (name) return page(STATIONS.filter((row) => row.station_name.includes(name.replace('ilike.*', '').replace(/\*$/, ''))));
      const ids = (u.searchParams.get('station_id') || '').replace(/^eq\.|^in\./, '').replace(/[()]/g, '').split(',').map(Number).filter(Number.isFinite);
      const province = u.searchParams.get('province');
      return page(STATIONS.filter((row) => (!ids.length || ids.includes(row.station_id)) && (!province || row.province === province.replace('eq.', ''))));
    }
    if (u.pathname.endsWith('/people_type')) {
      const term = u.searchParams.get('type_name');
      if (term) {
        const needle = term.replace('ilike.*', '').replace(/\*$/, '');
        return page(TYPES.filter((row) => row.type_name.includes(needle)));
      }
      return page(TYPES);
    }
    if (u.pathname.endsWith('/people')) {
      const select = u.searchParams.get('select') || '';
      let rows = PEOPLE;
      const stationParam = u.searchParams.get('station_id');
      if (stationParam) {
        const ids = stationParam.replace(/^eq\.|^in\./, '').replace(/[()]/g, '').split(',').map(Number);
        rows = rows.filter((row) => ids.includes(row.station_id));
      }
      const typeParam = u.searchParams.get('type_id');
      if (typeParam) {
        const ids = typeParam.replace(/^eq\.|^in\./, '').replace(/[()]/g, '').split(',').map(Number);
        rows = rows.filter((row) => ids.includes(row.type_id));
      }
      return page(rows.map((row) => (select.includes('first_name') ? { ...row, prefix: 'นาย', first_name: 'ทดสอบ', last_name: `ห้า${row.id}`, status: 'ปกติ' } : row)));
    }
    if (u.pathname.endsWith('/visits')) return page([]);
    if (u.pathname.endsWith('/person_report_status')) return page([]);
    throw new Error(`unexpected read ${url}`);
  };
  return { handler, calls };
}

function makeApp(mockRequest, user) {
  const app = express(); app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => {
    req.realToken = 'verified-session';
    req.user = user;
    next();
  }, { url: 'https://example.test', key: 'anon', request: mockRequest, interpret: async () => { throw new Error('overview commands must not call the model'); } }));
  return app;
}

const STATION_USER = { role: 'officer', stationId: 73, stationName: 'สภ.บ้านดุง', province: 'อุดรธานี', aiScope: { level: 'province', read_only: true, provinces: ['อุดรธานี'] } };

test('bare สภ. overview commands answer with the officer\'s own station', async () => {
  for (const phrase of ['ขอภาพรวม สภ.', 'สภ.ของฉัน', 'สภ.ของผม', 'ภาพรวมสภ.ของฉัน']) {
    const mock = makeMock();
    const app = makeApp(mock.handler, STATION_USER);
    const res = await request(app).post('/ai/chat').send({ message: phrase });
    assert.equal(res.status, 200, phrase);
    assert.equal(res.body.presentation.type, 'overview', phrase);
    // The header must name the data, the station, and the province.
    assert.equal(res.body.presentation.scopeLabel, 'สภ.บ้านดุง • จังหวัดอุดรธานี', phrase);
    assert.match(res.body.answer, /^ภาพรวมข้อมูล • สภ\.บ้านดุง • จังหวัดอุดรธานี/, phrase);
    assert.equal(res.body.presentation.groupBy, 'subdistrict', phrase);
    assert.equal(res.body.presentation.total, 3, phrase);
    assert.equal(res.body.meta.fastPath, true, phrase);
    assert.equal(res.body.meta.ollamaCalls, 0, phrase);
    // The station filter comes from the server-verified profile, never the message.
    const stationLookup = mock.calls.find((call) => call.path.endsWith('/stations') && call.params.get('station_name'));
    assert.ok(stationLookup, phrase);
    assert.equal(stationLookup.params.get('station_name'), 'ilike.*สภ.บ้านดุง*', phrase);
    const peopleRead = mock.calls.find((call) => call.path.endsWith('/people'));
    // A province-level verified account reads cross-station, so the resolved
    // station arrives as in.(73); a plain own-station account would be eq.73.
    assert.ok(['eq.73', 'in.(73)'].includes(peopleRead.params.get('station_id')), phrase);
    assert.equal(res.body.conversation.topic.station, 'สภ.บ้านดุง', phrase);
  }
});

test('a typed person type alongside the bare สภ. cue keeps the own-station scope', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler, STATION_USER);
  const res = await request(app).post('/ai/chat').send({ message: 'ขอภาพรวมผู้ป่วยจิตเวช สภ.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation.type, 'overview');
  assert.equal(res.body.presentation.scopeLabel, 'สภ.บ้านดุง • จังหวัดอุดรธานี');
  assert.equal(res.body.presentation.byType.find((row) => row.type === 'psychiatric').count, 1);
  const peopleRead = mock.calls.find((call) => call.path.endsWith('/people') && call.params.get('select').includes('tambon'));
  assert.match(peopleRead.params.get('type_id'), /in\.\(10\)/);
});

test('accounts without a direct station get explicit guidance instead of a guess', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler, { role: 'officer', stationId: null, stationName: null, province: 'อุดรธานี', aiScope: { level: 'province', read_only: true, provinces: ['อุดรธานี'] } });
  const res = await request(app).post('/ai/chat').send({ message: 'สภ.ของฉัน' });
  assert.equal(res.status, 200);
  assert.match(res.body.answer, /ไม่ได้สังกัด สภ\./);
  assert.match(res.body.answer, /ภาพรวมราย สภ\./);
  assert.equal(mock.calls.some((call) => call.path.endsWith('/people')), false);
});

test('“ภาพรวมราย สภ.” answers with the per-station aggregate of the working province', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler, STATION_USER);
  const res = await request(app).post('/ai/chat').send({ message: 'ขอภาพรวมราย สภ.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation.type, 'target_person_summary');
  assert.match(res.body.answer, /^ภาพรวมบุคคลเป้าหมายราย สภ\. • จังหวัดอุดรธานี/);
  assert.equal(res.body.presentation.scopeLabel, 'ภาพรวมบุคคลเป้าหมายราย สภ. • จังหวัดอุดรธานี');
  assert.equal(res.body.presentation.rows.length, 2);
  assert.equal(res.body.presentation.totals.total, 3);
  const summaryCall = mock.calls.find((call) => call.path.endsWith('/functions/v1/ai-summary'));
  assert.ok(summaryCall);
  assert.equal(summaryCall.body.summary_kind, 'target_people');
  assert.equal(summaryCall.body.province, 'อุดรธานี');
});

test('an overview that names a station or province keeps its previous behaviour', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler, STATION_USER);
  const res = await request(app).post('/ai/chat').send({ message: 'ขอภาพรวมของ สภ.หนองหาปลา จังหวัดอุดรธานี' });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation.type, 'overview');
  // A named station is NOT redirected to the officer's own station.
  assert.equal(res.body.presentation.scopeLabel, 'สภ.หนองหาปลา');
});

test('overview detectors: positive and negative phrasings', () => {
  for (const phrase of ['ขอภาพรวม สภ.', 'สภ.ของฉัน', 'สภ.ของผม', 'ภาพรวมสภ.ของฉัน', 'สรุปภาพรวม สภ.', 'ภาพรวมผู้เสพ สภ.ของฉัน']) {
    assert.equal(detectOwnStationOverview(phrase), true, `own: ${phrase}`);
  }
  for (const phrase of ['ภาพรวมราย สภ.', 'ขอภาพรวมของ สภ.บ้านดุง', 'ขอรายชื่อ สภ.', 'ขอภาพรวมบุคคลเป้าหมาย', 'ภาพรวม สภ. ในจังหวัด']) {
    assert.equal(detectOwnStationOverview(phrase), false, `not own: ${phrase}`);
  }
  for (const phrase of ['ภาพรวมราย สภ.', 'ขอภาพรวมราย สภ.', 'ภาพรวมราย สภ. จังหวัดร้อยเอ็ด', 'ภาพรวมรายสภ.ค่ะ']) {
    assert.equal(detectProvinceStationOverview(phrase), true, `province: ${phrase}`);
  }
  for (const phrase of ['ภาพรวมราย สภ.บ้านดุง', 'ขอรายชื่อ สภ.บ้านดุง', 'ขอภาพรวม สภ.']) {
    assert.equal(detectProvinceStationOverview(phrase), false, `not province: ${phrase}`);
  }
});

test('test-mode overview detection treats “สภ.ของฉัน” as an own-station overview', () => {
  const parsed = detectOverview('สภ.ของฉัน');
  assert.ok(parsed);
  assert.equal(parsed.filters.station, undefined);
  // A possessive pronoun must never be captured as a station name.
  const misheard = detectOverview('ภาพรวมสภ.ของฉัน');
  assert.ok(misheard);
  assert.equal(misheard.filters.station, undefined);
});
