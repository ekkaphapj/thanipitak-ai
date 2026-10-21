const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('events');
const {
  createCodexRoutes, codexArgs, sanitizeItem, applyEvent, _state, _constants,
} = require('../src/routes/codexRoutes');

function fakeSpawn(script) {
  return (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.spawnArgs = args;
    proc.kill = () => {};
    setImmediate(() => script(proc, args));
    return proc;
  };
}

const goodLines = [
  { type: 'thread.started', thread_id: 'th-1' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'เสร็จแล้วครับ' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } },
].map((e) => JSON.stringify(e));

function makeApp(passcode, spawnFn) {
  const app = express();
  app.use(express.json());
  // bin/projectDir ชี้ไปที่ของจริงที่มีบนเครื่องทดสอบ (node + โฟลเดอร์ tests)
  app.use('/api/codex', createCodexRoutes({
    passcode, spawn: spawnFn,
    bin: process.execPath, projectDir: __dirname,
  }));
  return app;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('codex args', () => {
  test('fresh session uses --json -C -s and ends with prompt', () => {
    const args = codexArgs('ทำงาน A', null);
    assert.strictEqual(args[1], 'exec');
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('-C'));
    assert.ok(args.includes('workspace-write'));
    assert.strictEqual(args[args.length - 1], 'ทำงาน A');
  });

  test('resume rejects -C/-s (codex exec resume does not accept them)', () => {
    const args = codexArgs('งานต่อ', 'th-9');
    assert.deepStrictEqual(args.slice(1, 5), ['exec', 'resume', 'th-9', '--json']);
    assert.ok(!args.includes('-C'));
    assert.ok(!args.includes('-s'));
    assert.strictEqual(args[args.length - 1], 'งานต่อ');
  });
});

describe('codex event folding', () => {
  test('thread id captured, token_count dropped, usage kept', () => {
    const job = { events: [], truncated: false, threadId: null, usage: null, error: null };
    applyEvent(job, { type: 'thread.started', thread_id: 'th-2' });
    applyEvent(job, { type: 'token_count', n: 3 });
    applyEvent(job, { type: 'turn.completed', usage: { input_tokens: 7 } });
    assert.strictEqual(job.threadId, 'th-2');
    assert.strictEqual(job.events.length, 1);
    assert.deepStrictEqual(job.usage, { input_tokens: 7 });
  });

  test('command output trimmed for the poll payload', () => {
    const item = sanitizeItem({
      type: 'command_execution', command: 'ls',
      aggregated_output: 'x'.repeat(5000),
    });
    assert.ok(item.aggregated_output.length <= 1200);
  });
});

describe('codex routes', () => {
  beforeEach(() => {
    _state.job = null;
    _state.threadId = null;
  });

  test('ping reports enabled, gate rejects missing/wrong key', async () => {
    const app = makeApp('secret-key', fakeSpawn(() => {}));
    await request(app).get('/api/codex/ping').expect(200, { enabled: true });
    const res = await request(app).get('/api/codex/status');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'BAD_CODEX_KEY');
    await request(app).get('/api/codex/status').set('X-Codex-Key', 'wrong').expect(401);
    const ok = await request(app).get('/api/codex/status').set('X-Codex-Key', 'secret-key');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.allowed, true);
  });

  test('disabled when no passcode configured', async () => {
    const prev = process.env.CODEX_PASSCODE;
    delete process.env.CODEX_PASSCODE;
    const app = makeApp('', fakeSpawn(() => {}));
    try {
      const res = await request(app).get('/api/codex/status').set('X-Codex-Key', 'x');
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.code, 'CODEX_DISABLED');
    } finally {
      if (prev !== undefined) process.env.CODEX_PASSCODE = prev;
    }
  });

  test('send streams events, finishes done and stores thread for resume', async () => {
    const spawns = [];
    const spawnFn = fakeSpawn((proc) => {
      spawns.push(proc.spawnArgs);
      proc.stdout.emit('data', Buffer.from(goodLines.join('\n') + '\n'));
      proc.emit('close', 0);
    });
    const app = makeApp('secret-key', spawnFn);
    const key = { 'X-Codex-Key': 'secret-key' };

    const send = await request(app).post('/api/codex/send').set(key)
      .send({ prompt: 'ทดสอบ' });
    assert.strictEqual(send.status, 200);
    await wait(50);

    const st = await request(app).get('/api/codex/status').set(key);
    assert.strictEqual(st.body.job.status, 'done');
    assert.strictEqual(st.body.job.error, null);
    assert.strictEqual(st.body.session_active, true);
    const texts = st.body.job.events
      .filter((e) => e.item && e.item.type === 'agent_message')
      .map((e) => e.item.text);
    assert.deepStrictEqual(texts, ['เสร็จแล้วครับ']);
    assert.ok(spawns[0].includes('workspace-write'));

    const send2 = await request(app).post('/api/codex/send').set(key)
      .send({ prompt: 'งานต่อ' });
    assert.strictEqual(send2.status, 200);
    await wait(50);
    assert.ok(spawns[1].includes('resume'));
    assert.ok(spawns[1].includes('th-1'));
  });

  test('non-zero exit surfaces stderr tail as error', async () => {
    const spawnFn = fakeSpawn((proc) => {
      proc.stderr.emit('data', Buffer.from('boom: bad flag\n'));
      proc.emit('close', 2);
    });
    const app = makeApp('secret-key', spawnFn);
    await request(app).post('/api/codex/send').set('X-Codex-Key', 'secret-key')
      .send({ prompt: 'x' });
    await wait(50);
    const st = await request(app).get('/api/codex/status').set('X-Codex-Key', 'secret-key');
    assert.strictEqual(st.body.job.status, 'error');
    assert.match(st.body.job.error, /รหัส 2/);
    assert.match(st.body.job.error, /boom/);
  });

  test('busy job returns 409 and prompt must be 1-4000 chars', async () => {
    const app = makeApp('secret-key', fakeSpawn(() => {}));
    const key = { 'X-Codex-Key': 'secret-key' };
    _state.job = { id: 'run', status: 'running', prompt: 'x', events: [], started: 1,
      finished: null, threadId: null, usage: null, error: null, truncated: false };
    await request(app).post('/api/codex/send').set(key).send({ prompt: 'y' }).expect(409);
    _state.job = null;
    await request(app).post('/api/codex/send').set(key).send({ prompt: '   ' }).expect(400);
  });

  test('reset clears session but refuses mid-job', async () => {
    const app = makeApp('secret-key', fakeSpawn(() => {}));
    const key = { 'X-Codex-Key': 'secret-key' };
    _state.threadId = 'th-3';
    await request(app).post('/api/codex/reset').set(key).expect(200, { ok: true });
    assert.strictEqual(_state.threadId, null);
    _state.job = { id: 'run', status: 'running', prompt: 'x', events: [], started: 1,
      finished: null, threadId: null, usage: null, error: null, truncated: false };
    await request(app).post('/api/codex/reset').set(key).expect(409);
  });
});
