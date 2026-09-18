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
    aiModel: 'scb10x/llama3.1-typhoon2-8b-instruct:latest',
    sending: false,
    mic: 'idle',
    sttAvailable: null,
    selectedPerson: null,
    conversationTopic: null,
    pendingSummaryReport: null,
    ordinalItems: null,
    referenceList: null,
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
    if (u?.dataSource === 'real') {
      return [u.stationName || (u.stationId ? 'ไม่พบชื่อสังกัด' : 'ยังไม่ระบุสังกัด'), u.division, u.province && !u.division ? `จังหวัด${u.province}` : null].filter(Boolean).join(' • ');
    }
    return u && u.stationId ? 'สถานี ' + u.stationId : 'ส่วนกลาง';
  }

  function renderUser() {
    const u = state.user;
    if (!u) return;
    $('#user-name').textContent = u.name || u.username;
    $('#user-meta').textContent = (u.roleLabel || roleLabel(u.role)) + ' • ' + stationLabel(u);
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
    p.textContent = 'พิมพ์ภาษาพูดได้เลย กดค้างไมค์เพื่อพูด หรือเลือกตัวอย่างด้านล่าง';
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
    updateSendDisabled();
  }

  function updateSendDisabled() {
    const micBusy = state.mic === 'recording' || state.mic === 'uploading';
    const send = $('#send-btn');
    if (send) send.disabled = state.sending || micBusy;
    const mic = $('#mic-btn');
    if (mic) {
      mic.disabled = state.sending || state.mic === 'uploading';
      mic.setAttribute('aria-pressed', String(state.mic === 'recording'));
    }
  }

  function setMicStatus(text, isError) {
    const el = $('#mic-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', Boolean(isError));
  }

  async function loadSttStatus() {
    if (state.mic === 'recording' || state.mic === 'uploading') return;
    try {
      const json = await api('/api/stt/status');
      state.sttAvailable = json.available === true;
      state.mic = state.sttAvailable ? 'idle' : 'unavailable';
      setMicStatus(state.sttAvailable ? 'กดค้างไมค์เพื่อพูด' : VoiceInput.micErrorMessage('STT_UNAVAILABLE'), !state.sttAvailable);
    } catch (_) {
      state.sttAvailable = false;
      state.mic = 'unavailable';
      setMicStatus(VoiceInput.micErrorMessage('STT_UNAVAILABLE'), true);
    }
    updateSendDisabled();
  }

  const micCtl = { recorder: null, stream: null, chunks: [], timer: null, abort: null, held: false };

  function abortMic() {
    if (micCtl.timer) {
      clearTimeout(micCtl.timer);
      micCtl.timer = null;
    }
    micCtl.held = false;
    if (micCtl.abort) {
      try { micCtl.abort.abort(); } catch (_) { /* ignore */ }
      micCtl.abort = null;
    }
    if (micCtl.recorder && micCtl.recorder.state !== 'inactive') {
      try { micCtl.recorder.stop(); } catch (_) { /* ignore */ }
    }
    micCtl.recorder = null;
    micCtl.chunks = [];
    if (micCtl.stream) {
      micCtl.stream.getTracks().forEach((track) => track.stop());
      micCtl.stream = null;
    }
    if (state.mic === 'recording' || state.mic === 'uploading') {
      state.mic = state.sttAvailable ? 'idle' : 'unavailable';
    }
    updateSendDisabled();
  }

  async function transcribeAudio(blob) {
    const headers = {
      'X-Data-Source': state.dataSource,
      'Content-Type': blob.type || 'audio/webm',
    };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    micCtl.abort = new AbortController();
    const timer = setTimeout(() => micCtl.abort.abort(), 35000);
    try {
      const res = await fetch('/api/stt/transcribe', { method: 'POST', headers, body: blob, signal: micCtl.abort.signal });
      let json = null;
      try { json = await res.json(); } catch (_) { /* empty */ }
      if (!res.ok) {
        const err = new Error((json && json.error) || 'Request failed');
        err.status = res.status;
        err.json = json;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
      micCtl.abort = null;
    }
  }

  async function finishRecording() {
    micCtl.held = false;
    if (state.mic !== 'recording') return;
    if (micCtl.timer) {
      clearTimeout(micCtl.timer);
      micCtl.timer = null;
    }
    const recorder = micCtl.recorder;
    state.mic = 'uploading';
    updateSendDisabled();
    setMicStatus('กำลังแปลงเสียงเป็นข้อความ…', false);
    const blob = await new Promise((resolve) => {
      if (!recorder) return resolve(null);
      recorder.addEventListener('stop', () => {
        resolve(new Blob(micCtl.chunks, { type: recorder.mimeType || 'audio/webm' }));
      }, { once: true });
      try { recorder.stop(); } catch (_) { resolve(null); }
    });
    if (micCtl.stream) {
      micCtl.stream.getTracks().forEach((track) => track.stop());
      micCtl.stream = null;
    }
    micCtl.recorder = null;
    micCtl.chunks = [];
    if (!blob || blob.size < 200) {
      state.mic = 'idle';
      updateSendDisabled();
      setMicStatus(VoiceInput.micErrorMessage('EMPTY_TRANSCRIPT'), true);
      return;
    }
    try {
      const json = await transcribeAudio(blob);
      const text = json && json.transcript;
      if (!text) {
        setMicStatus(VoiceInput.micErrorMessage('EMPTY_TRANSCRIPT'), true);
      } else {
        const input = $('#chat-input');
        input.value = VoiceInput.applyTranscript(input.value, text);
        autoResizeInput();
        input.focus();
        setMicStatus('ตรวจข้อความแล้วกดส่ง', false);
      }
    } catch (err) {
      if (err && err.status === 401) {
        await messageForError(err);
        return;
      }
      const code = err && err.json && err.json.code;
      setMicStatus(VoiceInput.micErrorMessage(code, err && err.status), true);
    }
    state.mic = state.sttAvailable ? 'idle' : 'unavailable';
    updateSendDisabled();
  }

  async function startRecording(event) {
    if (state.sending || state.mic === 'recording' || state.mic === 'uploading') return;
    micCtl.held = true;
    if (state.sttAvailable !== true) {
      setMicStatus('กำลังเชื่อมต่อระบบแปลงเสียง…', false);
      await loadSttStatus();
      if (state.sttAvailable !== true) {
        micCtl.held = false;
        setMicStatus(VoiceInput.micErrorMessage('STT_UNAVAILABLE'), true);
        return;
      }
    }
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicStatus(VoiceInput.micErrorMessage('INSECURE_CONTEXT'), true);
      return;
    }
    if (event && event.currentTarget && event.pointerId != null) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    }
    try {
      micCtl.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      micCtl.held = false;
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      setMicStatus(VoiceInput.micErrorMessage(denied ? 'PERMISSION_DENIED' : 'INSECURE_CONTEXT'), true);
      return;
    }
    if (!micCtl.held) {
      micCtl.stream.getTracks().forEach((track) => track.stop());
      micCtl.stream = null;
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    micCtl.chunks = [];
    micCtl.recorder = mime ? new MediaRecorder(micCtl.stream, { mimeType: mime }) : new MediaRecorder(micCtl.stream);
    micCtl.recorder.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size) micCtl.chunks.push(ev.data);
    });
    micCtl.recorder.start(250);
    state.mic = 'recording';
    updateSendDisabled();
    setMicStatus('กำลังฟัง… ปล่อยปุ่มเมื่อพูดจบ', false);
    micCtl.timer = setTimeout(() => {
      setMicStatus(VoiceInput.micErrorMessage('AUDIO_TOO_LONG'), true);
      finishRecording();
    }, VoiceInput.MAX_SECONDS * 1000);
  }

  function bindMicButton() {
    const btn = $('#mic-btn');
    if (!btn) return;
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    if (window.PointerEvent) {
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        startRecording(e);
      });
      btn.addEventListener('pointerup', () => finishRecording());
      btn.addEventListener('pointercancel', () => finishRecording());
    } else {
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startRecording(e);
      }, { passive: false });
      btn.addEventListener('touchend', () => finishRecording());
    }
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
    abortMic();
    clearSelectedPerson();
    state.conversationTopic = null;
    state.pendingSummaryReport = null;
    state.ordinalItems = null;
    state.referenceList = null;
    renderReferenceListBar();
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

  function renderReferenceListBar() {
    const bar = $('#reference-list-bar');
    const label = $('#reference-list-label');
    const detail = $('#reference-list-detail');
    const reference = state.referenceList;
    if (!reference || !reference.items.length) {
      bar.classList.add('hidden');
      label.textContent = '';
      detail.textContent = '';
      return;
    }
    bar.classList.remove('hidden');
    label.textContent = `กำลังอ้างอิง: ${reference.label}`;
    const children = reference.children || [];
    detail.textContent = `${reference.items.length} รายการ${children.length ? ` • รายการย่อย: ${children.map((item) => `${item.ordinal}. ${item.displayName}`).join(', ')}` : ''}`;
  }

  function selectPerson(raw) {
    const sel = window.ChatContext.normalizeSelectedPerson(raw);
    state.selectedPerson = sel;
    highlightSelectedRow();
    renderSelectedPersonBar();
    return sel;
  }

  function applyPersonSelection(raw, announce) {
    const sel = selectPerson(raw);
    if (!sel) return null;
    if (announce !== false) {
      appendMessage('assistant', 'เลือกแล้ว: ' + sel.displayName + ' — คำถามถัดไปจะดึงข้อมูลคนนี้ เช่น "คนนี้มีประวัติอย่างไร"');
    }
    return sel;
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
    document.querySelectorAll('#chat-messages [data-person-id]').forEach((row) => {
      const id = Number(row.getAttribute('data-person-id'));
      const on = Boolean(state.selectedPerson && id === state.selectedPerson.personId);
      row.classList.toggle('pl-selected', on);
      const btn = row.querySelector('.pl-select-btn');
      if (btn) btn.textContent = on ? 'เลือกแล้ว' : 'เลือก';
    });
  }

  function makeSelectButton(raw) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pc-btn pl-select-btn';
    const sel = window.ChatContext.normalizeSelectedPerson(raw);
    const on = sel && state.selectedPerson && sel.personId === state.selectedPerson.personId;
    btn.textContent = on ? 'เลือกแล้ว' : 'เลือก';
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      applyPersonSelection(raw);
    });
    return btn;
  }

  function hostForPresentation(wrap) {
    if (wrap.classList.contains('msg-overview')) return wrap;
    return wrap.querySelector('.bubble') || wrap;
  }

  function rememberOrdinalItems(items, label) {
    state.ordinalItems = Array.isArray(items) && items.length ? items : null;
    if (!state.ordinalItems) {
      state.referenceList = null;
    } else {
      state.referenceList = { label: label || 'รายการล่าสุด', items: state.ordinalItems, children: [] };
    }
    renderReferenceListBar();
  }

  function recordReferenceChild(item) {
    if (!state.referenceList || !item) return;
    const children = state.referenceList.children || (state.referenceList.children = []);
    if (!children.some((child) => child.ordinal === item.ordinal)) children.push({ ordinal: item.ordinal, displayName: item.displayName || `รายการที่ ${item.ordinal}` });
    renderReferenceListBar();
  }

  function renderReferenceSnapshot() {
    const reference = state.referenceList;
    if (!reference || !reference.items.length) {
      appendMessage('assistant', 'ขณะนี้ไม่มีรายการที่กำลังอ้างอิง');
      return;
    }
    const wrap = appendMessage('assistant', `กำลังอ้างอิง ${reference.label}`);
    const box = document.createElement('div'); box.className = 'person-candidates';
    const list = document.createElement('div'); list.className = 'pc-list';
    reference.items.forEach((item) => {
      const row = document.createElement('div'); row.className = 'pc-row';
      const label = document.createElement('span'); label.textContent = `${item.ordinal}. ${item.displayName || 'ไม่ระบุรายการ'}`;
      row.appendChild(label); list.appendChild(row);
    });
    box.appendChild(list);
    if (reference.children && reference.children.length) {
      const title = document.createElement('div'); title.className = 'pc-title'; title.textContent = 'รายการย่อยที่อ้างถึง'; box.appendChild(title);
      const children = document.createElement('div'); children.className = 'pc-list';
      reference.children.forEach((item) => { const row = document.createElement('div'); row.className = 'pc-row'; const label = document.createElement('span'); label.textContent = `↳ ${item.ordinal}. ${item.displayName}`; row.appendChild(label); children.appendChild(row); });
      box.appendChild(children);
    }
    hostForPresentation(wrap).appendChild(box); scrollToBottom();
  }

  function ordinalPromptForLocation(item) {
    return item && item.followup ? item.followup : null;
  }

  function referenceLabelForPeople(filters, fallback) {
    const type = TYPE_AI_LABEL[filters && filters.person_type];
    const place = filters && (filters.subdistrict ? `ตำบล${filters.subdistrict}` : filters.district ? `อำเภอ${filters.district}` : filters.province ? `จังหวัด${filters.province}` : null);
    return [fallback || 'รายชื่อ', type, place].filter(Boolean).join(' • ');
  }

  function resolveOrdinalReference(message) {
    const ordinal = window.ChatContext.ordinalFromMessage(message);
    if (ordinal === null) return { message };
    const items = state.referenceList && state.referenceList.items;
    if (!items || !items.length) {
      appendMessage('assistant', 'ไม่มีรายการให้เลือก กรุณาขอรายชื่อหรือรายการก่อน');
      return { handled: true };
    }
    const chosen = items.find((item) => item.ordinal === ordinal);
    if (!chosen) {
      appendMessage('assistant', `ไม่มีรายการลำดับที่ ${ordinal} ให้เลือก (รายการล่าสุดมี ${items.length} รายการ)`);
      return { handled: true };
    }
    if (chosen.personId) {
      recordReferenceChild(chosen);
      applyPersonSelection({ personId: chosen.personId, displayName: chosen.displayName }, false);
      return { message: String(message).replace(/(?:ของ\s*)?(?:ลำดับ|อันดับ)\s*(?:ที่)?\s*\d{1,3}/, 'คนนี้') };
    }
    const followup = ordinalPromptForLocation(chosen);
    if (followup) { recordReferenceChild(chosen); return { message: followup }; }
    appendMessage('assistant', `ไม่มีข้อมูลเพิ่มเติมที่เปิดดูได้สำหรับรายการลำดับที่ ${ordinal}`);
    return { handled: true };
  }

  function renderPersonList(wrap, presentation) {
    const ctx = {
      page: presentation.page || 1,
      pageSize: presentation.pageSize || 20,
      total: presentation.total || 0,
      filter: presentation.filters || {},
    };

    const box = document.createElement('div');
    box.className = 'person-list person-candidates';

    const title = document.createElement('div');
    title.className = 'pc-title';
    title.textContent = 'กดเลือก หรือพิมพ์ “ขอข้อมูลเพิ่มเติมของลำดับที่ …”';
    box.appendChild(title);

    const rangeText = document.createElement('div');
    rangeText.className = 'pl-range';
    box.appendChild(rangeText);

    const list = document.createElement('div');
    list.className = 'pc-list';
    box.appendChild(list);

    function normalizeItem(u) {
      return {
        person_id: u.person_id != null ? u.person_id : u.id,
        full_name: u.full_name || ((u.first_name || '') + ' ' + (u.last_name || '')).trim(),
        person_type: u.person_type,
        status: u.status,
        district: u.district,
        subdistrict: u.subdistrict,
      };
    }

    function renderRows(items) {
      list.innerHTML = '';
      const rows = items || [];
      if (!rows.length) {
        rememberOrdinalItems(null);
        const empty = document.createElement('div');
        empty.className = 'pc-empty';
        empty.textContent = 'ไม่มีข้อมูล';
        list.appendChild(empty);
        return;
      }
      const ordinalItems = [];
      rows.forEach((raw, index) => {
        const item = normalizeItem(raw);
        if (!item.person_id) return;
        const ordinal = (ctx.page - 1) * ctx.pageSize + index + 1;
        ordinalItems.push({ ordinal, personId: item.person_id, displayName: item.full_name || 'ไม่ระบุชื่อ' });
        const row = document.createElement('div');
        row.className = 'pc-row';
        row.setAttribute('data-person-id', String(item.person_id));
        if (isSelectedRow(item)) row.classList.add('pl-selected');
        const info = document.createElement('div');
        info.className = 'pc-info';
        const name = document.createElement('span');
        name.className = 'pc-name';
        name.textContent = `${ordinal}. ${item.full_name || 'ไม่ระบุชื่อ'}`;
        const tag = document.createElement('span');
        tag.className = 'pc-tag';
        tag.textContent = [TYPE_AI_LABEL[item.person_type] || item.person_type, item.subdistrict || item.district].filter(Boolean).join(' • ');
        info.append(name, tag);
        row.append(info, makeSelectButton({ personId: item.person_id, displayName: item.full_name }));
        list.appendChild(row);
      });
      rememberOrdinalItems(ordinalItems, referenceLabelForPeople(ctx.filter, 'รายชื่อที่แสดง'));
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

    function applyListFilters(qp) {
      if (ctx.filter.person_type) qp.set('person_type', ctx.filter.person_type);
      if (ctx.filter.status) qp.set('status', ctx.filter.status);
      if (ctx.filter.province) qp.set('province', ctx.filter.province);
      if (ctx.filter.district) qp.set('district', ctx.filter.district);
      if (ctx.filter.subdistrict) qp.set('subdistrict', ctx.filter.subdistrict);
      if (ctx.filter.station) qp.set('station', ctx.filter.station);
      if (ctx.filter.query) qp.set('search', ctx.filter.query);
    }

    async function fetchPage(page) {
      const qp = new URLSearchParams();
      qp.set('limit', String(ctx.pageSize));
      applyListFilters(qp);
      let path;
      if (state.dataSource === 'real') {
        qp.set('page', String(page));
        path = '/api/people?' + qp.toString();
      } else {
        qp.set('offset', String((page - 1) * ctx.pageSize));
        path = '/api/persons?' + qp.toString();
      }
      try {
        const json = await api(path);
        const rows = json.data || [];
        ctx.page = page;
        if (json.meta && typeof json.meta.total === 'number') ctx.total = json.meta.total;
        renderRows(rows);
        updateRange();
      } catch (_) {
        rangeText.textContent = 'โหลดหน้านี้ไม่สำเร็จ กรุณาลองใหม่ (รายชื่อหน้าเดิมยังอยู่)';
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

    if (Array.isArray(presentation.items)) {
      renderRows(presentation.items);
      if (presentation.items.length === 1) {
        const only = normalizeItem(presentation.items[0]);
        selectPerson({ personId: only.person_id, displayName: only.full_name });
      }
    }
    updateRange();

    hostForPresentation(wrap).appendChild(box);
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
    const ordinalItems = [];
    for (const [index, c] of candidates.entries()) {
      ordinalItems.push({ ordinal: index + 1, personId: c.personId, displayName: c.displayName || 'ไม่ระบุชื่อ' });
      const row = document.createElement('div');
      row.className = 'pc-row';
      row.setAttribute('data-person-id', String(c.personId));
      const info = document.createElement('div');
      info.className = 'pc-info';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'pc-name';
      nameSpan.textContent = `${index + 1}. ${c.displayName || ''}`;
      const tagSpan = document.createElement('span');
      tagSpan.className = 'pc-tag';
      const pType = TYPE_AI_LABEL[c.personType] || c.personType || '';
      const sType = STATUS_AI_LABEL[c.status] || c.status || '';
      tagSpan.textContent = pType + (pType && sType ? ' • ' : '') + sType;
      info.appendChild(nameSpan);
      info.appendChild(tagSpan);
      row.appendChild(info);
      row.appendChild(makeSelectButton({ personId: c.personId, displayName: c.displayName }));
      list.appendChild(row);
    }
    rememberOrdinalItems(ordinalItems, 'รายชื่อที่ชื่อซ้ำ');
    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pc-empty';
      empty.textContent = 'ไม่พบผู้ที่ตรงกัน';
      list.appendChild(empty);
    }
    box.appendChild(list);
    hostForPresentation(wrap).appendChild(box);
    return box;
  }

  function renderMonitoring(wrap, presentation) {
    const box=document.createElement('div');box.className='person-candidates';
    const items=presentation.items||[];
    const ordinalItems=[];
    for(const [index, person] of items.entries()) {
      ordinalItems.push({ordinal:index+1,personId:person.personId,displayName:person.displayName||'ไม่ระบุชื่อ'});
      const row=document.createElement('div');row.className='pc-row';
      row.setAttribute('data-person-id', String(person.personId));
      const label=document.createElement('span');label.textContent=`${index+1}. ${person.displayName} • ${person.level}`;
      row.append(label, makeSelectButton({personId:person.personId,displayName:person.displayName}));
      box.appendChild(row);
    }
    rememberOrdinalItems(ordinalItems, 'รายชื่อเฝ้าระวัง/เสี่ยงสูง');
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
    hostForPresentation(wrap).appendChild(box);
  }

  function renderMonitoringLocationSummary(wrap, presentation) {
    const groupBy = (presentation.filters || {}).group_by;
    const label = { province: 'จังหวัด', station: 'สภ.', district: 'อำเภอ', subdistrict: 'ตำบล' }[groupBy] || 'พื้นที่';
    const box = document.createElement('div'); box.className = 'person-candidates';
    const ordinalItems=[];
    for (const [index, item] of (presentation.locationSummary || []).entries()) {
      const row = document.createElement('div'); row.className = 'pc-row';
      const locationName = String(item.name || '').startsWith(label) ? item.name : label + item.name;
      const info = document.createElement('span'); info.textContent = `${index + 1}. ${locationName} • ${item.count} คน`;
      const type=TYPE_AI_LABEL[(presentation.filters || {}).person_types?.[0]] || 'บุคคล';
      const level=(presentation.filters || {}).level === 'high' ? 'เสี่ยงสูง' : (presentation.filters || {}).level === 'watch' ? 'เฝ้าระวัง' : '';
      ordinalItems.push({ordinal:index+1,displayName:locationName,followup:`ขอรายชื่อ${type}ใน${locationName}${level?`ที่${level}`:''}`});
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pc-btn'; button.textContent = 'ดูรายชื่อ';
      button.addEventListener('click', () => sendMessage(`${TYPE_AI_LABEL[(presentation.filters || {}).person_types?.[0]] || 'บุคคล'} ใน${locationName} ที่${(presentation.filters || {}).level === 'high' ? 'เสี่ยงสูง' : 'ต้องเฝ้าระวัง'}มีใครบ้าง`));
      row.append(info, button); box.appendChild(row);
    }
    rememberOrdinalItems(ordinalItems, `รายการ${label}เฝ้าระวัง/เสี่ยงสูง`);
    wrap.appendChild(box);
  }

  function renderLocationSummary(wrap, presentation) {
    const groupBy=presentation.groupBy || 'subdistrict';
    const label={province:'จังหวัด',station:'สภ.',district:'อำเภอ',subdistrict:'ตำบล'}[groupBy] || 'พื้นที่';
    const filters=presentation.filters || {};
    const type=TYPE_AI_LABEL[filters.person_type] || 'บุคคล';
    const box=document.createElement('div');box.className='person-candidates';
    const ordinalItems=[];
    for(const [index,item] of (presentation.items || []).entries()) {
      const locationName=String(item.name||'').startsWith(label)?item.name:label+item.name;
      const row=document.createElement('div');row.className='pc-row';
      const info=document.createElement('span');info.textContent=`${index+1}. ${locationName} • ${item.count||0} คน`;
      const button=document.createElement('button');button.type='button';button.className='pc-btn';button.textContent='ดูรายชื่อ';
      const followup=`ขอรายชื่อ${type}ใน${locationName}`;
      button.addEventListener('click',()=>sendMessage(followup));
      ordinalItems.push({ordinal:index+1,displayName:locationName,followup});
      row.append(info,button);box.appendChild(row);
    }
    rememberOrdinalItems(ordinalItems, `รายการ${label}`);
    hostForPresentation(wrap).appendChild(box);
  }

  function renderOverview(wrap, presentation) {
    const box = document.createElement('section');
    box.className = 'overview-card';
    const hero = document.createElement('header'); hero.className = 'overview-hero';
    const eyebrow = document.createElement('span'); eyebrow.className = 'overview-eyebrow'; eyebrow.textContent = 'สรุปข้อมูลภาพรวม';
    const title = document.createElement('h2'); title.textContent = presentation.scopeLabel || 'พื้นที่ที่มีสิทธิ์เข้าถึง';
    const note = document.createElement('p'); note.textContent = 'ข้อมูลตามขอบเขตสิทธิ์ของบัญชี • อ้างอิงข้อมูลปัจจุบัน';
    hero.append(eyebrow, title, note); box.appendChild(hero);

    const metrics = document.createElement('div'); metrics.className = 'overview-metrics';
    const metricRows = [
      ['บุคคลเป้าหมาย', presentation.total || 0, 'คน', 'total'],
      ['เสี่ยงสูง', presentation.highRisk || 0, 'คน', 'high'],
      ['เฝ้าระวัง', presentation.watch || 0, 'คน', 'watch'],
      ['ปกติ / ไม่เข้าเกณฑ์สี', Math.max(0, (presentation.total || 0) - (presentation.highRisk || 0) - (presentation.watch || 0)), 'คน', 'normal'],
    ];
    for (const [label, value, unit, tone] of metricRows) {
      const metric = document.createElement('div'); metric.className = `overview-metric ${tone}`;
      const labelEl = document.createElement('span'); labelEl.textContent = label;
      const valueEl = document.createElement('strong'); valueEl.textContent = value;
      const unitEl = document.createElement('small'); unitEl.textContent = unit;
      metric.append(labelEl, valueEl, unitEl); metrics.appendChild(metric);
    }
    box.appendChild(metrics);

    const types = document.createElement('section'); types.className = 'overview-types';
    const typesTitle = document.createElement('h3'); typesTitle.textContent = 'จำแนกตามประเภทบุคคล'; types.appendChild(typesTitle);
    const typeGrid = document.createElement('div'); typeGrid.className = 'overview-type-grid';
    for (const item of (presentation.byType || [])) {
      const cell = document.createElement('div'); cell.className = 'overview-type-cell';
      const label = document.createElement('span'); label.textContent = item.label;
      const count = document.createElement('strong'); count.textContent = `${item.count} คน`;
      cell.append(label, count); typeGrid.appendChild(cell);
    }
    types.appendChild(typeGrid); box.appendChild(types);

    const label = presentation.groupBy === 'station' ? 'สภ.' : 'ตำบล';
    const rankings = document.createElement('div'); rankings.className = 'overview-rankings';
    for (const [heading, items, tone] of [[`5 อันดับ${label}มากที่สุด`, presentation.top, 'top'], [`5 อันดับ${label}น้อยที่สุด`, presentation.bottom, 'bottom']]) {
      const section = document.createElement('section'); section.className = `overview-ranking ${tone}`;
      const h = document.createElement('h3'); h.textContent = heading; section.appendChild(h);
      if (!items || !items.length) {
        const empty = document.createElement('div'); empty.className = 'overview-empty'; empty.textContent = `ไม่มี${label}ที่มีรายการให้จัดอันดับ`; section.appendChild(empty);
      } else {
        items.forEach((item, index) => {
          const row = document.createElement('div'); row.className = 'overview-rank-row';
          const rank = document.createElement('span'); rank.className = 'overview-rank-number'; rank.textContent = index + 1;
          const name = document.createElement('span'); name.className = 'overview-rank-name'; name.textContent = `${label}${item.name}`;
          const count = document.createElement('strong'); count.textContent = `${item.count} คน`;
          row.append(rank, name, count); section.appendChild(row);
        });
      }
      rankings.appendChild(section);
    }
    box.appendChild(rankings);
    const disclaimer = document.createElement('p'); disclaimer.className = 'overview-disclaimer';
    disclaimer.textContent = 'เสี่ยงสูงและเฝ้าระวังอ้างอิงผลเยี่ยมล่าสุดและรายงานผู้ดูแล ไม่ใช่การวินิจฉัยหรือการทำนาย';
    box.appendChild(disclaimer);
    hostForPresentation(wrap).appendChild(box);
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
    create.addEventListener('click', () => downloadReport('pdf'));
    const excel = document.createElement('button');
    excel.type = 'button'; excel.className = 'suggest-btn'; excel.textContent = 'สร้างรายงาน Excel';
    excel.addEventListener('click', () => downloadReport('xlsx'));
    const dismiss = document.createElement('button');
    dismiss.type = 'button'; dismiss.className = 'suggest-btn'; dismiss.textContent = 'ไม่ต้องการรายงาน';
    dismiss.addEventListener('click', () => { state.pendingSummaryReport = null; appendMessage('assistant', 'รับทราบ จะไม่สร้างรายงาน'); });
    box.append(create, excel, dismiss);
    const items = presentation.items || [];
    if (presentation.includeList && items.length) {
      const title = document.createElement('div');
      title.className = 'pc-title';
      title.textContent = 'รายชื่อ — กดเลือกเพื่อถามข้อมูลคนนั้นต่อ';
      box.appendChild(title);
      const ordinalItems=[];
      for (const [index, item] of items.entries()) {
        const personId = item.person_id || item.personId;
        if (!personId) continue;
        const row = document.createElement('div');
        row.className = 'pc-row';
        row.setAttribute('data-person-id', String(personId));
        const info = document.createElement('span');
        info.textContent = `${index + 1}. ${item.full_name}` + (item.level ? ' • ' + item.level : '');
        row.append(info, makeSelectButton({ personId, displayName: item.full_name }));
        box.appendChild(row);
        ordinalItems.push({ordinal:index+1,personId,displayName:item.full_name||'ไม่ระบุชื่อ'});
      }
      rememberOrdinalItems(ordinalItems, referenceLabelForPeople(presentation.filters || {}, 'รายชื่อจากสรุป'));
    }
    wrap.appendChild(box);
  }

  function isPdfAffirmative(message) {
    return /^(?:1|ได้|ได้ครับ|ได้ค่ะ|ใช่|ใช่ครับ|ใช่ค่ะ|เอา|เอาเลย|สร้างเลย|ทำเลย|ต้องการ|ใช่สร้าง|สร้าง pdf|สร้างpdf)$/iu.test(String(message || '').trim());
  }
  function isPdfNegative(message) {
    return /^(?:2|ไม่|ไม่เอา|ไม่ต้อง|ไม่ต้องการ|ยังไม่)$/u.test(String(message || '').trim());
  }
  function renderReportOffer(wrap, presentation) {
    state.pendingSummaryReport = presentation.reportRequest || null;
    const box = document.createElement('div');
    box.className = 'person-candidates';
    const title = document.createElement('div');
    title.className = 'pc-title';
    title.textContent = presentation.confirm ? 'ต้องการสร้างรายงานของรายการหรือภาพรวมล่าสุดหรือไม่?' : 'ดาวน์โหลดรายงานตามสิทธิ์บัญชีนี้';
    box.appendChild(title);
    const formats = presentation.formats || ['pdf', 'xlsx'];
    if (formats.includes('pdf')) {
      const pdfBtn = document.createElement('button');
      pdfBtn.type = 'button'; pdfBtn.className = 'suggest-btn'; pdfBtn.textContent = presentation.confirm ? '1. ใช่ — สร้าง PDF' : 'ดาวน์โหลด PDF';
      pdfBtn.addEventListener('click', () => downloadReport('pdf', presentation.reportRequest));
      box.appendChild(pdfBtn);
    }
    if (formats.includes('xlsx')) {
      const xlsBtn = document.createElement('button');
      xlsBtn.type = 'button'; xlsBtn.className = 'suggest-btn'; xlsBtn.textContent = 'ดาวน์โหลด Excel';
      xlsBtn.addEventListener('click', () => downloadReport('xlsx', presentation.reportRequest));
      box.appendChild(xlsBtn);
    }
    if (presentation.confirm) {
      const noBtn=document.createElement('button');noBtn.type='button';noBtn.className='suggest-btn';noBtn.textContent='2. ไม่ — ระบุรายงานใหม่';
      noBtn.addEventListener('click',()=>{state.pendingSummaryReport=null;appendMessage('assistant','ต้องการสร้างรายงาน PDF หรือ Excel ของข้อมูลใดครับ? เช่น “รายงานผู้เสพในตำบลโพนสูง”');});box.appendChild(noBtn);
    }
    hostForPresentation(wrap).appendChild(box);
    if (presentation.auto === 'pdf') downloadReport('pdf', presentation.reportRequest);
    if (presentation.auto === 'xlsx') downloadReport('xlsx', presentation.reportRequest);
  }
  async function downloadReport(kind, reportRequest) {
    const requestBody = reportRequest || state.pendingSummaryReport;
    if (!requestBody || state.sending) return;
    setBusy(true);
    const isExcel = kind === 'xlsx';
    try {
      const response = await fetch(isExcel ? '/api/reports/summary.xlsx' : '/api/reports/summary.pdf', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json', 'X-Data-Source': state.dataSource },
        body: JSON.stringify({ reportRequest: requestBody }),
      });
      if (!response.ok) throw new Error('สร้างรายงานไม่สำเร็จ');
      const url = URL.createObjectURL(await response.blob());
      const wrap = appendMessage('assistant', isExcel ? 'สร้างรายงาน Excel แล้ว' : 'สร้างรายงาน PDF แล้ว');
      const link = document.createElement('a');
      link.href = url;
      link.download = isExcel ? 'thanipitak-summary.xlsx' : 'thanipitak-summary.pdf';
      link.textContent = isExcel ? 'ดาวน์โหลดรายงาน Excel' : 'ดาวน์โหลดรายงาน PDF';
      link.className = 'suggest-btn';
      wrap.querySelector('.bubble').appendChild(document.createElement('br'));
      wrap.querySelector('.bubble').appendChild(link);
      link.click();
    } catch (_) {
      appendMessage('assistant', 'สร้างรายงานไม่สำเร็จ กรุณาลองใหม่', { error: true });
    } finally {
      setBusy(false);
      $('#chat-input').focus();
    }
  }
  async function createSummaryPdf() {
    return downloadReport('pdf');
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
    const personId = p.id || p.person_id;
    if (personId) {
      box.setAttribute('data-person-id', String(personId));
      const action = document.createElement('div');
      action.className = 'pc-row';
      action.setAttribute('data-person-id', String(personId));
      const who = document.createElement('span');
      who.className = 'pc-name';
      who.textContent = name;
      action.append(who, makeSelectButton({ personId, displayName: name }));
      box.appendChild(action);
      selectPerson({ personId, displayName: name });
    }
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
    hostForPresentation(wrap).appendChild(box);
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
    if (code === 'REAL_ACCESS_DENIED') {
      return 'บัญชีนี้ไม่มีสิทธิ์อ่านข้อมูลจริงในขอบเขตที่ร้องขอ';
    }
    if (code === 'REAL_UNAVAILABLE') {
      return 'เชื่อมต่อข้อมูลจริงไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง';
    }
    if (code === 'REAL_DATA_UNVERIFIABLE') {
      return 'ข้อมูลจริงตอบกลับไม่ครบหรือกำลังเปลี่ยนแปลง จึงยังสรุปผลไม่ได้';
    }
    if (code === 'REAL_READ_FAILED') {
      return 'ไม่สามารถอ่านข้อมูลจริงได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง';
    }
    return 'เกิดข้อผิดพลาด กรุณาลองใหม่';
  }

  function sendMessage(overrideText) {
    if (state.mic === 'recording' || state.mic === 'uploading') return;
    let message = (overrideText !== undefined ? overrideText : $('#chat-input').value || '').trim();
    if (!message || state.sending) return;

    if (window.ChatContext.isReferenceListQuestion(message)) {
      appendMessage('user', message);
      if (/บุคคล/.test(message) && state.selectedPerson) appendMessage('assistant', `กำลังอ้างอิงบุคคล: ${state.selectedPerson.displayName}`);
      else renderReferenceSnapshot();
      $('#chat-input').value = '';
      autoResizeInput();
      return;
    }

    const ordinalResolution = resolveOrdinalReference(message);
    if (ordinalResolution.handled) return;
    message = ordinalResolution.message.trim();

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
      appendMessage('assistant', 'ต้องการสร้างรายงาน PDF หรือ Excel ของข้อมูลใดครับ? เช่น “รายงานผู้เสพในตำบลโพนสูง”');
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
      body: JSON.stringify(window.ChatContext.buildChatBody(message, state.selectedPerson, state.conversationTopic)),
    })
      .then((json) => {
        if (settled) return;
        clearTimeout(watchdog);
        settled = true;
        removeTypingIndicator();
        if (json.conversation && json.conversation.topic) {
          state.conversationTopic = json.conversation.topic;
        } else if (json.presentation && json.presentation.filters && json.presentation.filters.person_type) {
          state.conversationTopic = window.ChatContext.sanitizeTopic({
            person_type: json.presentation.filters.person_type,
            province: json.presentation.filters.province,
            district: json.presentation.filters.district,
            subdistrict: json.presentation.filters.subdistrict,
            station: json.presentation.filters.station,
          });
        }

        const isOverview = json.presentation && json.presentation.type === 'overview';
        const wrap = appendMessage('assistant', isOverview ? '' : (json.answer || ''));
        if (isOverview) {
          wrap.classList.add('msg-overview');
          wrap.querySelector('.bubble')?.remove();
        }

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
        if (json.presentation && json.presentation.type === 'location_summary') renderLocationSummary(wrap,json.presentation);
        if (json.presentation && json.presentation.type === 'overview') renderOverview(wrap,json.presentation);
        if (json.presentation && json.presentation.type === 'summary_choices') renderSummaryChoices(wrap, json.presentation);
        if (json.presentation && json.presentation.type === 'summary_result') renderSummaryResult(wrap, json.presentation);
        if (json.presentation && json.presentation.type === 'report_offer') renderReportOffer(wrap, json.presentation);

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
        loadSttStatus();
      } catch (err) {
        const box = $('#login-error');
        box.textContent = err.message || 'เข้าสู่ระบบล้มเหลว';
        box.classList.remove('hidden');
      }
    });

    $('#logout-btn').addEventListener('click', () => {
      abortMic();
      state.token = null;
      state.user = null;
      localStorage.removeItem(TOKEN_KEY);
      clearSelectedPerson();
      state.conversationTopic = null;
      state.ordinalItems = null;
      state.referenceList = null;
      renderReferenceListBar();
      showLogin();
    });

    bindMicButton();
    setInterval(() => {
      if (state.token && state.sttAvailable !== true && state.mic !== 'recording' && state.mic !== 'uploading') {
        loadSttStatus();
      }
    }, 10000);
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
        loadSttStatus();
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
