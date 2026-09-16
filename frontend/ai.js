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
    selectedPerson: null,
  };

  const SUGGESTIONS = [
    'ในพื้นที่ของฉันมีบุคคลทั้งหมดกี่คน',
    'มีผู้ป่วยจิตเวชกี่คน',
    'หาผู้เสพในพื้นที่ของฉัน',
    'มีใครบ้างที่ยังไม่ได้รับการเยี่ยมหรือต้องติดตาม',
    'สรุปจำนวนบุคคลแยกตามประเภท',
  ];

  const TYPE_LABEL = { admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่', viewer: 'ผู้ตรวจสอบ' };
  const TYPE_AI_LABEL = { psychiatric: 'จิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า' };
  const STATUS_AI_LABEL = {
    registered: 'ขึ้นทะเบียน',
    active: 'กำลังติดตาม',
    followup: 'ต้องติดตาม',
    completed: 'เสร็จสิ้น',
  };

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

  // -- Selected-person context (STEP 2.5) -----------------------------
  // Selection is only an identifier hint. Only context.personId is sent;
  // the backend re-authorizes every request.

  function renderSelectedPersonBar() {
    const bar = $('#selected-person-bar');
    const label = $('#selected-person-label');
    const text = window.ChatContext.indicatorText(state.selectedPerson);
    if (text) {
      bar.classList.remove('hidden');
      label.textContent = text;
    } else {
      bar.classList.add('hidden');
      label.textContent = '';
    }
  }

  function selectPerson(raw) {
    const sel = window.ChatContext.normalizeSelectedPerson(raw);
    state.selectedPerson = sel;
    highlightSelectedRow();
    renderSelectedPersonBar();
  }

  function clearSelectedPerson() {
    state.selectedPerson = window.ChatContext.clearSelection();
    highlightSelectedRow();
    renderSelectedPersonBar();
  }

  function isSelectedRow(item) {
    if (!state.selectedPerson || !item) return false;
    return item.person_id === state.selectedPerson.personId;
  }

  function highlightSelectedRow() {
    document.querySelectorAll('#chat-messages tr.pl-row').forEach((tr) => {
      const id = Number(tr.getAttribute('data-person-id'));
      const on = state.selectedPerson && id === state.selectedPerson.personId;
      tr.classList.toggle('pl-selected', on);
    });
  }

  function renderPersonList(wrap, presentation) {
    const ctx = {
      page: presentation.page || 1,
      pageSize: presentation.pageSize || 20,
      total: presentation.total || 0,
      filter: presentation.filters || {},
    };

    const box = document.createElement('div');
    box.className = 'person-list';

    const header = document.createElement('div');
    header.className = 'pl-header';
    const rangeText = document.createElement('div');
    rangeText.className = 'pl-range';
    header.appendChild(rangeText);
    box.appendChild(header);

    const table = document.createElement('table');
    table.className = 'pl-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const col of ['ลำดับ', 'ชื่อ', 'ประเภท', 'สถานะ', 'ตำบล']) {
      const th = document.createElement('th');
      th.textContent = col;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    box.appendChild(table);

    function normalizeItem(u) {
      return {
        person_id: u.person_id != null ? u.person_id : u.id,
        full_name: u.full_name || (u.first_name + ' ' + (u.last_name || '')),
        person_type: u.person_type,
        status: u.status,
        district: u.district,
        subdistrict: u.subdistrict,
      };
    }

    function renderRows(items) {
      tbody.innerHTML = '';
      (items || []).forEach((raw, i) => {
        const item = normalizeItem(raw);
        const tr = document.createElement('tr');
        tr.className = 'pl-row';
        tr.setAttribute('data-person-id', String(item.person_id));
        tr.setAttribute('data-person-name', item.full_name);
        tr.title = 'เลือก ' + item.full_name + ' เพื่อสอบถามข้อมูล';
        if (isSelectedRow(item)) tr.classList.add('pl-selected');
        tr.addEventListener('click', () => {
          selectPerson({ personId: item.person_id, displayName: item.full_name });
        });
        const cells = [
          String((ctx.page - 1) * ctx.pageSize + i + 1),
          item.full_name,
          TYPE_AI_LABEL[item.person_type] || item.person_type || '-',
          STATUS_AI_LABEL[item.status] || item.status || '-',
          item.subdistrict || item.district || '-',
        ];
        for (const c of cells) {
          const td = document.createElement('td');
          td.textContent = c;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      if (!items || items.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'ไม่มีข้อมูล';
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    }

    function updateRange() {
      const from = (ctx.page - 1) * ctx.pageSize + 1;
      const to = Math.min(ctx.page * ctx.pageSize, ctx.total);
      rangeText.textContent = 'แสดง ' + from + '-' + to + ' จาก ' + ctx.total + ' คน';
      prev.disabled = ctx.page <= 1;
      next.disabled = ctx.page * ctx.pageSize >= ctx.total;
    }

    const pager = document.createElement('div');
    pager.className = 'pl-pager';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'pl-btn';
    prev.textContent = 'ก่อนหน้า';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'pl-btn';
    next.textContent = 'หน้าถัดไป';

    async function fetchPage(page) {
      ctx.page = page;
      const qp = new URLSearchParams();
      qp.set('limit', String(ctx.pageSize));
      qp.set('offset', String((page - 1) * ctx.pageSize));
      if (ctx.filter.person_type) qp.set('person_type', ctx.filter.person_type);
      if (ctx.filter.status) qp.set('status', ctx.filter.status);
      try {
        const json = await api('/api/persons?' + qp.toString());
        if (json.meta && typeof json.meta.total === 'number') ctx.total = json.meta.total;
        renderRows(json.data || []);
        updateRange();
      } catch (_) {
        ctx.page = page;
        renderRows([]);
        updateRange();
      }
    }

    prev.addEventListener('click', () => {
      if (ctx.page > 1) fetchPage(ctx.page - 1);
    });
    next.addEventListener('click', () => {
      if (ctx.page * ctx.pageSize < ctx.total) fetchPage(ctx.page + 1);
    });

    pager.appendChild(prev);
    pager.appendChild(next);
    box.appendChild(pager);

    if (Array.isArray(presentation.items)) renderRows(presentation.items);
    updateRange();

    wrap.appendChild(box);
    return box;
  }

  const VISIT_RESULT_LABEL = {
    normal: 'ปกติ',
    progress: 'มีพัฒนาการ',
    warning: 'น่าห่วง',
    recovered: 'หายดีแล้ว',
  };
  const URINE_RESULT_LABEL = {
    negative: 'ปกติ (ไม่ม่วง)',
    positive: 'ม่วง (positive)',
  };

  function renderPersonSummary(wrap, presentation) {
    const p = presentation.person || {};
    const visit = presentation.visitSummary || {};
    const urine = presentation.urineSummary || {};
    const followup = presentation.followup || {};

    const name = p.first_name ? p.first_name + ' ' + (p.last_name || '') : '-';
    const latestVisit = visit.latest_visit;
    const latestTest = urine.latest_test;

    const rows = [
      ['ชื่อ', name + (p.synthetic_code ? ' (' + p.synthetic_code + ')' : '')],
      ['ประเภท', TYPE_AI_LABEL[p.person_type] || p.person_type || '-'],
      ['สถานะ', STATUS_AI_LABEL[p.status] || p.status || '-'],
      ['จำนวนครั้งที่เยี่ยม', String(visit.visit_count || 0) + ' ครั้ง'],
      ['เยี่ยมล่าสุด', latestVisit ? latestVisit.date + ' (ผล: ' + (VISIT_RESULT_LABEL[latestVisit.result] || latestVisit.result) + ')' : 'ยังไม่เคยเยี่ยม'],
      ['จำนวนครั้งตรวจปัสสาวะ', String(urine.test_count || 0) + ' ครั้ง'],
      ['ผลบวก (ม่วง)', String(urine.positive_count || 0) + ' ครั้ง'],
      ['ตรวจล่าสุด', latestTest ? latestTest.date + ' (ผล: ' + (URINE_RESULT_LABEL[latestTest.result] || latestTest.result) + ')' : 'ยังไม่เคยตรวจ'],
      ['สถานะการติดตาม', followup.overdue ? 'เลยกำหนดติดตาม' : 'ยังไม่เลยกำหนดติดตาม'],
      ['หมายเหตุล่าสุด', (latestVisit && latestVisit.note) || '-'],
    ];

    const box = document.createElement('div');
    box.className = 'person-summary';
    const title = document.createElement('div');
    title.className = 'ps-title';
    title.textContent = 'สรุปข้อมูลบุคคล';
    box.appendChild(title);
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'ps-row';
      const kd = document.createElement('span');
      kd.className = 'ps-key';
      kd.textContent = k;
      const vd = document.createElement('span');
      vd.className = 'ps-val';
      vd.textContent = v;
      row.appendChild(kd);
      row.appendChild(vd);
      box.appendChild(row);
    }
    wrap.appendChild(box);
    return box;
  }

  async function messageForError(err) {
    const status = err && err.status;
    if (status === 401) {
      state.token = null;
      localStorage.removeItem(TOKEN_KEY);
      clearSelectedPerson();
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
      body: JSON.stringify(window.ChatContext.buildChatBody(message, state.selectedPerson)),
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

        if (json.presentation && json.presentation.type === 'person_list') {
          renderPersonList(wrap, json.presentation);
        }
        if (json.presentation && json.presentation.type === 'person_summary') {
          renderPersonSummary(wrap, json.presentation);
        }

        const rt = json.meta && json.meta.responseTimeMs;
        if (typeof rt === 'number' && rt >= 0) {
          const seconds = (rt / 1000).toFixed(1);
          const perf = document.createElement('div');
          perf.className = 'msg-tools';
          const isFast = !!(json.meta && json.meta.fastPath);
          perf.textContent = isFast
            ? 'ตรวจสอบข้อมูลจากระบบ • ' + seconds + ' วินาที'
            : 'ประมวลผลด้วย Local AI • ' + seconds + ' วินาที';
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
      clearSelectedPerson();
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
    $('#clear-btn').addEventListener('click', () => {
      clearSelectedPerson();
      renderEmptyState();
    });

    $('#clear-selection-btn').addEventListener('click', () => {
      clearSelectedPerson();
    });

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