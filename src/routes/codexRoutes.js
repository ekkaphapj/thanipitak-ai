// สั่งงาน OpenAI Codex CLI แก้โค้ด repo บนเซิร์ฟเวอร์นี้ (หน้า /codex.html)
// งานเดียวพร้อมกัน สนทนาต่อเนื่องผ่าน codex exec resume --json
// ด่านสิทธิ์: รหัสแยกของ Codex (env CODEX_PASSCODE) ไม่ผูกกับบัญชีทดสอบ
// เพราะ repo นี้เป็นสาธารณะและมีบัญชีทดสอบอยู่ใน README
const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CODEX_BIN = process.env.CODEX_BIN || path.join(HOME, '.local', 'bin', 'codex');
const CODEX_PROJECT_DIR =
  process.env.CODEX_PROJECT_DIR || path.join(HOME, 'udonpolice-datacenter');
const CODEX_TIMEOUT_MS = 60_000 * Number(process.env.CODEX_TIMEOUT_MINUTES || '30');
const CODEX_MAX_PROMPT = 4000;
const CODEX_MAX_EVENTS = 500;

// สถานะเดียวของ process (แอปนี้รัน process เดียว)
const state = { threadId: null, job: null };

function codexArgs(prompt, threadId, overrides) {
  const bin = (overrides && overrides.bin) || CODEX_BIN;
  const projectDir = (overrides && overrides.projectDir) || CODEX_PROJECT_DIR;
  // exec resume ไม่รับ -C/-s: เซสชันเดิมจำ workspace/sandbox ของตัวเอง
  const base = [bin, 'exec'];
  if (threadId) {
    return base.concat(['resume', threadId, '--json', '-c', 'approval_policy="never"', prompt]);
  }
  return base.concat([
    '--json', '-C', projectDir, '-s', 'workspace-write',
    '-c', 'approval_policy="never"', prompt,
  ]);
}

function sanitizeItem(item) {
  const out = Object.assign({}, item);
  if (out.type === 'command_execution') {
    out.command = String(out.command || '').slice(0, 500);
    if (typeof out.aggregated_output === 'string') {
      out.aggregated_output = out.aggregated_output.slice(-1200);
    }
  } else if (out.type === 'agent_message') {
    out.text = String(out.text || '').slice(0, 8000);
  }
  return out;
}

function applyEvent(job, evt) {
  if (!evt || typeof evt !== 'object') return;
  if (evt.type === 'thread.started' && evt.thread_id) job.threadId = evt.thread_id;
  else if (evt.type === 'turn.completed') job.usage = evt.usage || {};
  else if (evt.type === 'error') job.error = String(evt.message || JSON.stringify(evt)).slice(0, 500);
  if (evt.type === 'token_count' || evt.type === 'thread.started') return;
  if (evt.item && typeof evt.item === 'object') {
    evt = Object.assign({}, evt, { item: sanitizeItem(evt.item) });
  }
  job.events.push(evt);
  if (job.events.length > CODEX_MAX_EVENTS) {
    job.events.splice(0, job.events.length - CODEX_MAX_EVENTS);
    job.truncated = true;
  }
}

function runCodexJob(job, deps) {
  const spawnFn = deps.spawn || spawn;
  const projectDir = deps.projectDir || CODEX_PROJECT_DIR;
  const argv = codexArgs(job.prompt, state.threadId, deps);
  let proc;
  try {
    // stdin ต้อง ignore: codex exec รออ่าน stdin จนได้ EOF ถ้าปล่อยเป็น pipe จะค้างตลอดกาล
    proc = spawnFn(argv[0], argv.slice(1), {
      cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    job.status = 'error';
    job.error = `เปิด codex ไม่ได้: ${err.message}`;
    job.finished = Date.now();
    return;
  }
  job.status = 'running';
  const stderrLines = [];
  let stdoutBuf = '';
  let settled = false;

  const onStdout = (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { evt = { type: 'raw', text: line.slice(0, 400) }; }
      applyEvent(job, evt);
    }
  };
  const onStderr = (chunk) => {
    stderrLines.push(chunk.toString('utf8'));
    if (stderrLines.length > 40) stderrLines.shift();
  };
  const finish = (rc) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (job.error) job.status = 'error';
    else if (rc !== 0) {
      const tail = stderrLines.join('').slice(-600).trim();
      job.error = `codex จบด้วยรหัส ${rc}${tail ? `: ${tail}` : ''}`;
      job.status = 'error';
    } else job.status = 'done';
    job.finished = Date.now();
    if (job.threadId) state.threadId = job.threadId;
  };
  const timer = setTimeout(() => {
    job.error = `หมดเวลา ${Math.round(CODEX_TIMEOUT_MS / 60000)} นาที — หยุดงานค้างไว้แล้ว`;
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }, CODEX_TIMEOUT_MS);

  if (proc.stdout) proc.stdout.on('data', onStdout);
  if (proc.stderr) proc.stderr.on('data', onStderr);
  proc.on('error', (err) => { job.error = String(err.message || err).slice(0, 500); finish(-1); });
  proc.on('close', finish);
}

function passcodeOk(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function jobPayload(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, prompt: job.prompt,
    started: job.started, finished: job.finished || null,
    error: job.error || null, usage: job.usage || null,
    truncated: !!job.truncated, events: job.events.slice(),
  };
}

function runGitSync(deps, done) {
  // ดึงโค้ดใหม่จาก GitHub เข้าโฟลเดอร์โปรเจกต์ (codex ใน sandbox ห้ามใช้เน็ต
  // จึงต้องให้ตัวเซิร์ฟเวอร์ pull แทน — ใช้หลังที่ codex คลาวด์ push งานมา)
  const spawnFn = deps.spawn || spawn;
  const projectDir = deps.projectDir || CODEX_PROJECT_DIR;
  const proc = spawnFn('git', ['-C', projectDir, 'pull', '--ff-only', '--autostash'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 120_000);
  proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
  proc.on('error', (err) => { clearTimeout(timer); done(1, String(err.message || err)); });
  proc.on('close', (rc) => { clearTimeout(timer); done(rc, out); });
}

function createCodexRoutes(options = {}) {
  const router = express.Router();
  const deps = {
    spawn: options.spawn,
    bin: options.bin,
    projectDir: options.projectDir,
  };
  const expected = () => options.passcode || process.env.CODEX_PASSCODE || '';

  router.get('/ping', (req, res) => res.json({ enabled: !!expected() }));

  const gate = (req, res, next) => {
    const pass = expected();
    if (!pass) return res.status(503).json({ error: 'ยังไม่เปิดใช้งาน — ตั้ง CODEX_PASSCODE บนเซิร์ฟเวอร์ก่อน', code: 'CODEX_DISABLED' });
    if (!passcodeOk(req.get('X-Codex-Key'), pass)) {
      return res.status(401).json({ error: 'รหัส Codex ไม่ถูกต้อง', code: 'BAD_CODEX_KEY' });
    }
    next();
  };

  router.get('/status', gate, (req, res) => {
    res.json({
      allowed: true,
      busy: !!(state.job && state.job.status === 'running'),
      session_active: !!state.threadId,
      project_dir: CODEX_PROJECT_DIR,
      job: jobPayload(state.job),
    });
  });

  router.post('/send', gate, (req, res) => {
    const prompt = String((req.body && req.body.prompt) || '').trim();
    if (!prompt || prompt.length > CODEX_MAX_PROMPT) {
      return res.status(400).json({ error: `พิมพ์งาน 1-${CODEX_MAX_PROMPT} ตัวอักษร`, code: 'BAD_PROMPT' });
    }
    if (state.job && state.job.status === 'running') {
      return res.status(409).json({ error: 'มีงาน codex กำลังทำอยู่ รอให้จบก่อน', code: 'BUSY' });
    }
    if (!fs.existsSync(deps.bin || CODEX_BIN)) {
      return res.status(503).json({ error: `ไม่พบ codex binary ที่ ${deps.bin || CODEX_BIN}`, code: 'NO_CODEX' });
    }
    if (!fs.existsSync(deps.projectDir || CODEX_PROJECT_DIR)) {
      return res.status(503).json({ error: `ไม่พบโฟลเดอร์โปรเจกต์ ${deps.projectDir || CODEX_PROJECT_DIR}`, code: 'NO_PROJECT' });
    }
    const job = {
      id: crypto.randomBytes(6).toString('hex'), status: 'running',
      prompt, events: [], started: Date.now(), finished: null,
      threadId: null, usage: null, error: null, truncated: false,
    };
    state.job = job;
    runCodexJob(job, deps);
    res.json({ id: job.id });
  });

  router.post('/sync', gate, (req, res) => {
    if (state.job && state.job.status === 'running') {
      return res.status(409).json({ error: 'มีงาน codex กำลังทำอยู่ รอให้จบก่อนค่อยดึงโค้ด', code: 'BUSY' });
    }
    if (!fs.existsSync(deps.projectDir || CODEX_PROJECT_DIR)) {
      return res.status(503).json({ error: `ไม่พบโฟลเดอร์โปรเจกต์ ${deps.projectDir || CODEX_PROJECT_DIR}`, code: 'NO_PROJECT' });
    }
    runGitSync(deps, (rc, output) => {
      const trimmed = String(output).trim().slice(-2000);
      res.json({ ok: rc === 0, code: rc === 0 ? 'SYNCED' : 'SYNC_FAILED', output: trimmed });
    });
  });

  router.post('/reset', gate, (req, res) => {
    if (state.job && state.job.status === 'running') {
      return res.status(409).json({ error: 'มีงานกำลังทำอยู่ รอให้จบก่อนเริ่มเซสชันใหม่', code: 'BUSY' });
    }
    state.threadId = null;
    state.job = null;
    res.json({ ok: true });
  });

  return router;
}

module.exports = {
  createCodexRoutes, codexArgs, sanitizeItem, applyEvent, _state: state,
  _constants: { CODEX_BIN, CODEX_PROJECT_DIR, CODEX_MAX_PROMPT, CODEX_MAX_EVENTS },
};
