(function () {
  'use strict';

  const TOKEN_KEY = 'tp_token';
  const SOURCE_KEY = 'tp_data_source';
  const CLIENT_TIMEOUT_MS = 180000;

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    dataSource: localStorage.getItem(SOURCE_KEY) === 'real' ? 'real' : 'test',
    user: null,
    aiAvailable: null,
    aiModel: 'qwen3.5:9b',
    sending: false,
    selectedPerson: null,
    pendingSummaryReport: null,
  };

  const SUGGESTIONS = [
    'มีใครบ้างที่ต้องเฝ้าระวัง พร้อมเหตุผล',
    'ผู้ป่วยจิตเวชที่เสี่ยงสูงมีใครบ้าง เพราะอะไร',
    'ผู้เสพคนไหนต้องจับตา',
    'ผู้พ้นโทษที่เสี่ยงสูงมีใครบ้าง',
    'ในพื้นที่ของฉันมีบุคคลทั้งหมดกี่คน',
    'มีผู้ป่วยจิตเวชกี่คน',
    'หาผู้เสพในพื้นที่ของฉัน',
    'มีใครบ้างที่ยังไม่ได้รับการเยี่ยมหรือต้องติดตาม',
    'สรุปจำนวนบุคคลแยกตามประเภท',
  ];

  const TYPE_LABEL = { admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่', viewer: 'ผู้ตรวจสอบ' };
  const TYPE_AI_LABEL = { psychiatric: 'จิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' };
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
    $('#source-test').setAttribute('aria-pressed', String(state.dataSource === 'test'));
    $('#source-real').setAttribute('aria-pressed', String(state.dataSource === 'real'));
    $('#source-status').textContent = state.dataSource === 'real' ? 'ข้อมูลจริง • อ่านทะเบียนตามสิทธิ์ผู้ใช้ • รายงานและเฝ้าระวังยังไม่เปิดใช้' : 'ข้อมูลสังเคราะห์สำหรับทดลองใช้งาน';
    $('#login-screen').classList.remove('active');
    $('#login-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    $('#chat-input').focus();
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    headers['X-Data-Source'] = state.dataSource;
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
    h2.textContent = 'วันนี้ต้องการทราบข้อมูลอะไร?';
    const p = document.createElement('p');
    p.textContent = 'พิมพ์ภาษาพูดได้เลย หรือเลือกตัวอย่างด้านล่างเพื่อเริ่มต้น';
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

  function isStartOverCommand(message) {
    const text = String(message == null ? '' : message)
      .replace(/[?？!！.。]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(?:นะครับ|นะคะ|ครับผม|ครับ|ค่ะ|คะ)$/g, '')
      .trim();
    return text === 'เริ่มใหม่';
  }

  function resetConversation() {
    clearSelectedPerson();
    state.pendingSummaryReport = null;
    removeTypingIndicator();
    $('#chat-input').value = '';
    autoResizeInput();
    renderEmptyState();
    $('#chat-input').focus();
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

  function renderPersonCandidates(wrap, presentation) {
    const box = document.createElement('div');
    box.className = 'person-candidates';
    const title = document.createElement('div');
    title.className = 'pc-title';
    title.textContent = 'เลือกบุคคลที่ต้องการ (พบหลายคนชื่อตรงกัน)';
    box.appendChild(title);
    const list = document.createElement('div');
    list.className = 'pc-list';
    const candidates = (presentation && presentation.candidates) || [];
    for (const c of candidates) {
      const row = document.createElement('div');
      row.className = 'pc-row';
      const info = document.createElement('div');
      info.className = 'pc-info';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'pc-name';
      nameSpan.textContent = c.displayName || '';
      const tagSpan = document.createElement('span');
      tagSpan.className = 'pc-tag';
      const pType = TYPE_AI_LABEL[c.personType] || c.personType || '';
      const sType = STATUS_AI_LABEL[c.status] || c.status || '';
      tagSpan.textContent = pType + (pType && sType ? ' • ' : '') + sType;
      info.appendChild(nameSpan);
      info.appendChild(tagSpan);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pc-btn';
      btn.textContent = 'เลือก';
      btn.addEventListener('click', () => {
        selectPerson({ personId: c.personId, displayName: c.displayName });
        appendMessage('assistant', 'เลือกแล้ว: ' + c.displayName + ' — พิมพ์คำถามต่อ เช่น "คนนี้มีประวัติอย่างไร"');
      });
      row.appendChild(info);
      row.appendChild(btn);
      list.appendChild(row);
    }
    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pc-empty';
      empty.textContent = 'ไม่พบผู้ที่ตรงกัน';
      list.appendChild(empty);
    }
    box.appendChild(list);
    wrap.appendChild(box);
    return box;
  }

  function renderMonitoring(wrap, presentation) {
    const box=document.createElement('div');box.className='person-candidates';
    const items=presentation.items||[];
    for(const person of items) {
      const row=document.createElement('div');row.className='pc-row';
      const label=document.createElement('span');label.textContent=`${person.displayName} • ${person.level}`;
      const btn=document.createElement('button');btn.type='button';btn.className='pc-btn';btn.textContent='เลือกบุคคล';
      btn.addEventListener('click',()=>selectPerson({personId:person.personId,displayName:person.displayName}));
      row.append(label,btn);box.appendChild(row);
    }
    // A one-person result is unambiguous. Keep it as the chat context so a
    // natural follow-up such as “เพราะอะไร” answers that person directly.
    if (items.length === 1) {
      const person = items[0];
      selectPerson({ personId: person.personId, displayName: person.displayName });
    }
    if(presentation.total>presentation.page* presentation.pageSize){
      const next=document.createElement('button');next.type='button';next.className='suggest-btn';next.textContent='ถามหน้าถัดไป';
      next.addEventListener('click',()=>{
        const f=presentation.filters||{};
        const types=(f.person_types||[]).map(t=>t==='psychiatric'&&f.psychiatric_subtype?(f.psychiatric_subtype==='drug'?'จิตเวชยาเสพติด':'จิตเวชอื่นๆ'):TYPE_AI_LABEL[t]||t).join(' และ ')+(f.most_wanted?' Most Wanted':'');
        $('#chat-input').value=`${types} ${f.level==='high'?'เสี่ยงสูง':f.level==='watch'?'เฉพาะเฝ้าระวัง':'เฝ้าระวังหรือเสี่ยงสูง'} มีใครบ้าง หน้า ${presentation.page+1}`;
        $('#chat-input').focus();
      });box.appendChild(next);
    }
    wrap.appendChild(box);
  }

  function renderMonitoringLocationSummary(wrap, presentation) {
    const groupBy = (presentation.filters || {}).group_by;
    const label = { province: 'จังหวัด', station: 'สภ.', district: 'อำเภอ', subdistrict: 'ตำบล' }[groupBy] || 'พื้นที่';
    const box = document.createElement('div'); box.className = 'person-candidates';
    for (const item of (presentation.locationSummary || [])) {
      const row = document.createElement('div'); row.className = 'pc-row';
      const locationName = String(item.name || '').startsWith(label) ? item.name : label + item.name;
      const info = document.createElement('span'); info.textContent = `${locationName} • ${item.count} คน`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pc-btn'; button.textContent = 'ดูรายชื่อ';
      button.addEventListener('click', () => sendMessage(`${TYPE_AI_LABEL[(presentation.filters || {}).person_types?.[0]] || 'บุคคล'} ใน${locationName} ที่${(presentation.filters || {}).level === 'high' ? 'เสี่ยงสูง' : 'ต้องเฝ้าระวัง'}มีใครบ้าง`));
      row.append(info, button); box.appendChild(row);
    }
    wrap.appendChild(box);
  }

  function renderSummaryChoices(wrap, presentation) {
    const box = document.createElement('div');
    box.className = 'person-candidates';
    const title = document.createElement('div');
    title.className = 'pc-title';
    title.textContent = 'เลือกสิ่งที่ต้องการสรุป';
    box.appendChild(title);
    for (const choice of (presentation.choices || [])) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'suggest-btn'; button.textContent = choice.label;
      button.addEventListener('click', () => sendMessage(choice.message));
      box.appendChild(button);
    }
    const locations = presentation.locations || {};
    const groups = [
      ['สภ.', 'stations', (value) => `สรุปจำนวนบุคคลใน สภ.${value}`],
      ['อำเภอ', 'districts', (value) => `สรุปจำนวนบุคคลในอำเภอ${value}`],
      ['ตำบล', 'subdistricts', (value) => `สรุปจำนวนบุคคลในตำบล${value}`],
    ];
    for (const [label, key, messageFor] of groups) {
      const values = locations[key] || [];
      if (!values.length) continue;
      const select = document.createElement('select');
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = `เลือก${label}`; select.appendChild(placeholder);
      for (const value of values) {
        const option = document.createElement('option'); option.value = value; option.textContent = value; select.appendChild(option);
      }
      select.addEventListener('change', () => { if (select.value) sendMessage(messageFor(select.value)); });
      box.appendChild(select);
    }
    wrap.appendChild(box);
  }

  function renderSummaryResult(wrap, presentation) {
    state.pendingSummaryReport = presentation.reportRequest || null;
    const box = document.createElement('div');
    box.className = 'person-candidates';
    const create = document.createElement('button');
    create.type = 'button'; create.className = 'suggest-btn'; create.textContent = 'สร้างรายงาน PDF';
    create.addEventListener('click', () => createSummaryPdf());
    const dismiss = document.createElement('button');
    dismiss.type = 'button'; dismiss.className = 'suggest-btn'; dismiss.textContent = 'ไม่ต้องการรายงาน';
    dismiss.addEventListener('click', () => { state.pendingSummaryReport = null; appendMessage('assistant', 'รับทราบ จะไม่สร้างรายงาน PDF'); });
    box.append(create, dismiss); wrap.appendChild(box);
  }

  function isPdfAffirmative(message) {
    return /^(?:ได้|ได้ครับ|ได้ค่ะ|ใช่|ใช่ครับ|ใช่ค่ะ|เอา|เอาเลย|สร้างเลย|ทำเลย)$/u.test(String(message || '').trim());
  }
  function isPdfNegative(message) {
    return /^(?:ไม่|ไม่เอา|ไม่ต้อง|ไม่ต้องการ|ยังไม่)$/u.test(String(message || '').trim());
  }
  async function createSummaryPdf() {
    const reportRequest = state.pendingSummaryReport;
    if (!reportRequest || state.sending) return;
    setBusy(true);
    try {
      const response = await fetch('/api/reports/summary.pdf', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json', 'X-Data-Source': state.dataSource },
        body: JSON.stringify({ reportRequest }),
      });
      if (!response.ok) throw new Error('สร้างรายงานไม่สำเร็จ');
      const url = URL.createObjectURL(await response.blob());
      const wrap = appendMessage('assistant', 'สร้างรายงาน PDF แล้ว');
      const link = document.createElement('a');
      link.href = url; link.download = 'thanipitak-summary.pdf'; link.textContent = 'ดาวน์โหลดรายงาน PDF';
      link.className = 'suggest-btn'; wrap.querySelector('.bubble').appendChild(document.createElement('br')); wrap.querySelector('.bubble').appendChild(link);
      state.pendingSummaryReport = null;
    } catch (_) {
      appendMessage('assistant', 'สร้างรายงาน PDF ไม่สำเร็จ กรุณาลองใหม่', { error: true });
    } finally {
      setBusy(false);
      $('#chat-input').focus();
    }
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
      ['ประเภท', p.type_name || TYPE_AI_LABEL[p.person_type] || p.person_type || '-'],
      ['สถานะ', p.registry_status ? `สีทะเบียน ${p.registry_status}${p.custody_status?' / '+p.custody_status:''}` : p.custody_status || STATUS_AI_LABEL[p.status] || p.status || '-'],
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

    if (isStartOverCommand(message)) {
      resetConversation();
      return;
    }

    if (state.pendingSummaryReport && isPdfAffirmative(message)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      createSummaryPdf();
      return;
    }
    if (state.pendingSummaryReport && isPdfNegative(message)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      state.pendingSummaryReport = null;
      appendMessage('assistant', 'รับทราบ จะไม่สร้างรายงาน PDF');
      return;
    }
    state.pendingSummaryReport = null;

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
        if (json.presentation && json.presentation.type === 'person_candidates') {
          renderPersonCandidates(wrap, json.presentation);
        }
        if (json.presentation && json.presentation.type === 'monitoring_list') renderMonitoring(wrap,json.presentation);
        if (json.presentation && json.presentation.type === 'monitoring_location_summary') renderMonitoringLocationSummary(wrap,json.presentation);
        if (json.presentation && json.presentation.type === 'summary_choices') renderSummaryChoices(wrap, json.presentation);
        if (json.presentation && json.presentation.type === 'summary_result') renderSummaryResult(wrap, json.presentation);

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
    $('#login-source').value = state.dataSource;
    const updateLoginHint = () => {
      $('#login-source-hint').textContent = $('#login-source').value === 'real' ? 'ใช้ชื่อผู้ใช้และรหัส PIN ของระบบธานีพิทักษ์จริง' : 'ใช้บัญชีในฐานข้อมูลทดสอบ เช่น station1_off';
    };
    updateLoginHint();
    $('#login-source').addEventListener('change', () => {
      state.dataSource = $('#login-source').value;
      state.token = null; state.user = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.setItem(SOURCE_KEY, state.dataSource);
      $('#password').value = '';
      $('#login-error').classList.add('hidden');
      resetConversation(); updateLoginHint();
    });
    $('#mobile-logout').addEventListener('click', () => $('#logout-btn').click());
    $('#source-real').addEventListener('click', () => {
      $('#logout-btn').click(); $('#login-source').value = 'real'; $('#login-source').dispatchEvent(new Event('change'));
    });
    $('#source-test').addEventListener('click', () => {
      $('#logout-btn').click(); $('#login-source').value = 'test'; $('#login-source').dispatchEvent(new Event('change'));
    });
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
      resetConversation();
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
