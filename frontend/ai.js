(function () {
  'use strict';

  const TOKEN_KEY = 'tp_token';
  const CLIENT_TIMEOUT_MS = 180000;

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: null,
    aiAvailable: null,
    aiModel: 'qwen3.5:9b',
    sending: false,
  };

  const SUGGESTIONS = [
    'ในพื้นที่ของฉันมีบุคคลทั้งหมดกี่คน',
    'มีผู้ป่วยจิตเวชกี่คน',
    'หาผู้เสพในพื้นที่ของฉัน',
    'มีใครบ้างที่ยังไม่ได้รับการเยี่ยมหรือต้องติดตาม',
    'สรุปจำนวนบุคคลแยกตามประเภท',
  ];

  const TYPE_LABEL = { admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่', viewer: 'ผู้ตรวจสอบ' };

  const $ = (sel) => document.querySelector(sel);

  function showLogin() {
    $('#app-screen').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    $('#login-error').classList.add('hidden');
  }

  function showApp() {
    $('#login-screen').classList.remove('active');
    $('#login-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    $('#chat-input').focus();
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...opts, headers });
    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      /* empty body */
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || 'Request failed');
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json;
  }

  function roleLabel(role) {
    return TYPE_LABEL[role] || role;
  }

  function stationLabel(u) {
    return u && u.stationId ? 'สถานี ' + u.stationId : 'ส่วนกลาง';
  }

  function renderUser() {
    const u = state.user;
    if (!u) return;
    $('#user-name').textContent = u.name || u.username;
    $('#user-meta').textContent = roleLabel(u.role) + ' • ' + stationLabel(u);
    $('#model-badge').textContent = state.aiModel;
  }

  function renderAiStatus(available) {
    state.aiAvailable = available;
    const el = $('#ai-status');
    if (available === true) {
      el.textContent = '● Local AI พร้อมใช้งาน';
      el.className = 'ai-status status-ok';
    } else if (available === false) {
      el.textContent = '○ Local AI ไม่พร้อมใช้งาน';
      el.className = 'ai-status status-down';
    } else {
      el.textContent = 'กำลังตรวจสอบ Local AI…';
      el.className = 'ai-status status-unknown';
    }
  }

  async function loadAiStatus() {
    try {
      const json = await api('/api/ai/status');
      state.aiModel = json.model || state.aiModel;
      renderAiStatus(json.available);
      renderUser();
    } catch (_) {
      renderAiStatus(false);
    }
  }

  function scrollToBottom() {
    const box = $('#chat-messages');
    box.scrollTop = box.scrollHeight;
  }

  function renderEmptyState() {
    const box = $('#chat-messages');
    box.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const h2 = document.createElement('h2');
    h2.textContent = 'ถามอะไรก็ได้เกี่ยวกับข้อมูลธานีพิทักษ์';
    const p = document.createElement('p');
    p.textContent = 'ตัวอย่างคำถามที่ถามได้';
    const list = document.createElement('div');
    list.className = 'suggest-list';
    for (const q of SUGGESTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'suggest-btn';
      btn.textContent = q;
      btn.addEventListener('click', () => sendMessage(q));
      list.appendChild(btn);
    }
    empty.appendChild(h2);
    empty.appendChild(p);
    empty.appendChild(list);
    box.appendChild(empty);
  }

  function removeTypingIndicator() {
    const existing = document.querySelector('#typing-row');
    if (existing) existing.remove();
  }

  function showTypingIndicator() {
    removeTypingIndicator();
    const box = $('#chat-messages');
    const row = document.createElement('div');
    row.className = 'typing-row';
    row.id = 'typing-row';
    const sp = document.createElement('div');
    sp.className = 'spinner';
    const txt = document.createElement('span');
    txt.textContent = 'AI กำลังตรวจสอบข้อมูล...';
    row.appendChild(sp);
    row.appendChild(txt);
    box.appendChild(row);
    scrollToBottom();
  }

  function appendMessage(role, text, options = {}) {
    removeTypingIndicator();
    const box = $('#chat-messages');
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-assistant');
    if (options.error) wrap.classList.add('msg-error');

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    wrap.appendChild(time);

    box.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function setBusy(busy) {
    state.sending = busy;
    $('#send-btn').disabled = busy;
  }

  async function messageForError(err) {
    const status = err && err.status;
    if (status === 401) {
      state.token = null;
      localStorage.removeItem(TOKEN_KEY);
      showLogin();
      return 'กรุณาเข้าสู่ระบบใหม่';
    }
    const code = err && err.json && err.json.code;
    if (code === 'AI_UNAVAILABLE' || code === 'AI_MAX_TOOL_ITERATIONS') {
      return 'ไม่สามารถเชื่อมต่อ Local AI ได้ในขณะนี้';
    }
    if (code === 'FORBIDDEN_FIELD') {
      return 'คำขอนี้ไม่ได้รับอนุญาต';
    }
    return 'เกิดข้อผิดพลาด กรุณาลองใหม่';
  }

  function sendMessage(overrideText) {
    const message = (overrideText !== undefined ? overrideText : $('#chat-input').value || '').trim();
    if (!message || state.sending) return;

    const box = $('#chat-messages');
    if (box.querySelector('.empty-state')) {
      box.innerHTML = '';
    }

    appendMessage('user', message);
    $('#chat-input').value = '';
    autoResizeInput();

    setBusy(true);
    showTypingIndicator();

    let settled = false;
    const watchdog = setTimeout(() => {
      settled = true;
      removeTypingIndicator();
      setBusy(false);
      appendMessage('assistant', 'AI ใช้เวลาประมวลผลนานเกินไป กรุณาลองอีกครั้ง', { error: true });
    }, CLIENT_TIMEOUT_MS);

    api('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
      .then((json) => {
        if (settled) return;
        clearTimeout(watchdog);
        settled = true;
        removeTypingIndicator();
        const wrap = appendMessage('assistant', json.answer || '');

        const toolNames = (Array.isArray(json.toolsUsed) ? json.toolsUsed : [])
          .map((t) => (t && t.name ? t.name : t))
          .filter(Boolean);
        if (toolNames.length) {
          const tools = document.createElement('div');
          tools.className = 'msg-tools';
          tools.textContent = 'ตรวจสอบข้อมูลจาก: ' + toolNames.join(', ');
          wrap.insertBefore(tools, wrap.querySelector('.msg-time'));
        }

        const rt = json.meta && json.meta.responseTimeMs;
        if (typeof rt === 'number' && rt >= 0) {
          const seconds = (rt / 1000).toFixed(1);
          const perf = document.createElement('div');
          perf.className = 'msg-tools';
          perf.textContent = 'ประมวลผลด้วย Local AI • ' + seconds + ' วินาที';
          wrap.appendChild(perf);
        }
        scrollToBottom();
      })
      .catch(async (err) => {
        if (settled) return;
        clearTimeout(watchdog);
        settled = true;
        removeTypingIndicator();
        const msg = await messageForError(err);
        appendMessage('assistant', msg, { error: true });
      })
      .finally(() => {
        settled = true;
        setBusy(false);
        $('#chat-input').focus();
      });
  }

  function autoResizeInput() {
    const el = $('#chat-input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  async function bootstrap() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#login-error').classList.add('hidden');
      try {
        const json = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            username: $('#username').value.trim(),
            password: $('#password').value,
          }),
        });
        state.token = json.token;
        localStorage.setItem(TOKEN_KEY, json.token);
        state.user = json.user;
        renderUser();
        showApp();
        renderEmptyState();
        loadAiStatus();
      } catch (err) {
        const box = $('#login-error');
        box.textContent = err.message || 'เข้าสู่ระบบล้มเหลว';
        box.classList.remove('hidden');
      }
    });

    $('#logout-btn').addEventListener('click', () => {
      state.token = null;
      state.user = null;
      localStorage.removeItem(TOKEN_KEY);
      showLogin();
    });

    $('#send-btn').addEventListener('click', () => sendMessage());
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $('#chat-input').addEventListener('input', autoResizeInput);
    $('#clear-btn').addEventListener('click', () => renderEmptyState());

    if (state.token) {
      try {
        const json = await api('/api/auth/me');
        state.user = json.user;
        renderUser();
        showApp();
        renderEmptyState();
        loadAiStatus();
        return;
      } catch (_) {
        localStorage.removeItem(TOKEN_KEY);
        state.token = null;
      }
    }
    showLogin();
  }

  bootstrap();
})();