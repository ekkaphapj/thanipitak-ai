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
    voiceMode: false,
    tutorial: { active: false, step: 0, lastAdvanced: false },
  };

  const VOICE_CLIPS = {
    hello: 'voice-hello.mp3',
    greeting: 'voice-greeting-2.mp3',
    howToUse: 'voice-how-to-use.mp3',
    acknowledge: 'voice-acknowledge.mp3',
    notClear: 'voice-not-clear.mp3',
    answerQuestion: 'voice-answer-question.mp3',
    introduce: 'voice-introduce.mp3',
    notUnderstood: 'voice-not-understand-question.mp3',
    finished: 'voice-finish-job.mp3',
  };
  let activeVoiceAudio = null;
  let activeVoiceStop = null;

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

  function isUsageGuideQuestion(message) {
    const text = String(message || '').replace(/\s+/g, '');
    return /(?:วิธ[ีิ]ใช้|วิธีการใช้|สอน(?:การ)?ใช้งาน?(?:ให้)?หน่อย|สอนใช้หน่อย|ใช้ยังไง|ต้องถามอะไรได้บ้าง|ทำยังไง(?:ต่อ)?|ทำไง(?:ต่อ)?|สั่งยังไง|ขอวิธีใช้|ไม่เข้าใจ(?:วิธีใช้)?|ทำไม่เป็น|ช่วย(?:สอน|บอกวิธี|หน่อย))/u.test(text);
  }

  const TUTORIAL_STEPS = [
    {
      title: 'ดูภาพรวมก่อน',
      prompt: 'ขอภาพรวม สภ.',
      hint: 'ระบบจะสรุปจำนวนบุคคลเป้าหมาย ประเภท สีความเสี่ยง และอันดับพื้นที่',
      matches: /(?:ขอ)?ภาพรวม/u,
    },
    {
      title: 'ขอรายชื่อ',
      prompt: 'ขอรายชื่อผู้เสพ',
      hint: 'ลองขอรายชื่อประเภทใดก็ได้ แล้วระบบจะแสดงลำดับกำกับทุกรายการ',
      matches: /(?:ขอ)?รายชื่อ.*(?:ผู้เสพ|ผู้ค้า|จิตเวช|ผู้พ้นโทษ|บุคคล|ทั้งหมด)/u,
    },
    {
      title: 'เลือกรายการตามลำดับ',
      prompt: 'เลือกคนที่ 1',
      hint: 'เลือกได้ด้วยคำว่า เลือกคนที่, เลือกรายการที่ หรือ เลือกลำดับที่',
      matches: /เลือก(?:คน|รายการ|ลำดับ)?ที่?\s*(?:1|๑|หนึ่ง)/u,
    },
    {
      title: 'ขอข้อมูลของรายการที่เลือก',
      prompt: 'ขอข้อมูลคนที่ 1',
      hint: 'หลังเลือกแล้ว จะถามว่า “คนนี้มีประวัติอย่างไร” ก็ได้',
      matches: /(?:ขอ)?ข้อมูล(?:คน|รายการ)?ที่?\s*(?:1|๑|หนึ่ง)|คนนี้.*(?:ข้อมูล|ประวัติ)|ประวัติ.*คนนี้/u,
    },
    {
      title: 'วิเคราะห์ข้อมูลภาพรวม',
      prompt: 'วิเคราะห์ภาระงาน',
      hint: 'ยังลอง “เปรียบเทียบพื้นที่” หรือ “ตรวจคุณภาพข้อมูล” ได้ด้วย',
      matches: /(?:วิเคราะห์ภาระงาน|เปรียบเทียบพื้นที่|ตรวจคุณภาพข้อมูล|วิเคราะห์ผลการดำเนินงาน)/u,
    },
  ];

  function tutorialSpeechFor(step) {
    if (!step) return 'ทำแบบฝึกหัดครบแล้วค่ะ ตอนนี้ลองถามด้วยภาษาพูดตามงานจริงได้เลย';
    return `แบบฝึกหัดข้อ ${state.tutorial.step + 1} ${step.title} ค่ะ ลองพูดหรือพิมพ์ว่า ${step.prompt}`;
  }

  function speakTutorial(text) {
    if (!state.voiceMode || !('speechSynthesis' in window)) return Promise.resolve();
    stopVoiceAudio();
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'th-TH';
      utterance.rate = 0.93;
      utterance.onend = utterance.onerror = () => { setMascotSpeaking(false); resolve(); };
      activeVoiceStop = () => { window.speechSynthesis.cancel(); setMascotSpeaking(false); resolve(); };
      setMascotSpeaking(true);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  function renderTutorialStep({ completed = false } = {}) {
    const step = TUTORIAL_STEPS[state.tutorial.step];
    const wrap = appendMessage('assistant', '');
    wrap.classList.add('msg-tutorial');
    wrap.querySelector('.bubble')?.remove();
    const card = document.createElement('section');
    card.className = 'tutorial-card';
    const head = document.createElement('div');
    head.className = 'tutorial-head';
    const finished = !step;
    head.innerHTML = `<span class="tutorial-kicker">${finished ? 'เรียนจบแล้ว' : `แบบฝึกหัด ${state.tutorial.step + 1} / ${TUTORIAL_STEPS.length}`}</span><h2>${finished ? 'พร้อมใช้งานแล้ว' : step.title}</h2><p>${finished ? 'คุณสามารถดูภาพรวม ขอรายชื่อ เลือกรายการ วิเคราะห์ข้อมูล และขอรายงานได้ตามสิทธิ์ของบัญชี' : step.hint}</p>`;
    const body = document.createElement('div');
    body.className = 'tutorial-body';
    if (!finished) {
      const status = document.createElement('span');
      status.className = completed ? 'tutorial-complete' : 'tutorial-status';
      status.textContent = completed ? '✓ ทำข้อนี้แล้ว — ไปข้อถัดไป' : 'ลองทำตามคำสั่งนี้';
      const prompt = document.createElement('code'); prompt.textContent = step.prompt;
      const tryButton = document.createElement('button');
      tryButton.type = 'button'; tryButton.className = 'suggest-btn'; tryButton.textContent = 'ใช้คำสั่งนี้';
      tryButton.addEventListener('click', () => sendMessage(step.prompt));
      body.append(status, prompt, tryButton);
    } else {
      const restart = document.createElement('button');
      restart.type = 'button'; restart.className = 'suggest-btn'; restart.textContent = 'เริ่มแบบฝึกหัดใหม่';
      restart.addEventListener('click', startTutorial);
      body.appendChild(restart);
    }
    card.append(head, body);
    wrap.insertBefore(card, wrap.querySelector('.msg-time'));
    scrollToBottom();
    return step;
  }

  function startTutorial() {
    state.tutorial = { active: true, step: 0, lastAdvanced: false };
    const step = renderTutorialStep();
    if (state.voiceMode) speakTutorial(tutorialSpeechFor(step));
  }

  function renderTutorialOffer() {
    const wrap = appendMessage('assistant', '');
    wrap.classList.add('msg-tutorial');
    wrap.querySelector('.bubble')?.remove();
    const card = document.createElement('section');
    card.className = 'tutorial-card tutorial-offer';
    card.innerHTML = '<div class="tutorial-head"><span class="tutorial-kicker">ช่วยเริ่มต้นใช้งาน</span><h2>ต้องการให้สอนการใช้งานหรือไม่?</h2><p>มีแบบฝึกหัดให้ลองทีละคำสั่ง ทั้งพิมพ์และพูด พร้อมตัวอย่างคำถามที่ใช้ได้จริง</p></div>';
    const choices = document.createElement('div'); choices.className = 'tutorial-choices';
    const start = document.createElement('button'); start.type = 'button'; start.className = 'suggest-btn'; start.textContent = '1. เริ่มแบบฝึกหัด'; start.addEventListener('click', startTutorial);
    const guide = document.createElement('button'); guide.type = 'button'; guide.className = 'suggest-btn'; guide.textContent = '2. ดูคำสั่งที่ใช้ได้'; guide.addEventListener('click', renderUsageGuide);
    const no = document.createElement('button'); no.type = 'button'; no.className = 'suggest-btn'; no.textContent = '3. ไม่ใช่'; no.addEventListener('click', () => appendMessage('assistant', 'ได้เลยค่ะ ลองบอกสิ่งที่ต้องการค้นหาหรือสรุปข้อมูลได้ทันที'));
    choices.append(start, guide, no); card.appendChild(choices);
    wrap.insertBefore(card, wrap.querySelector('.msg-time'));
    scrollToBottom();
    if (state.voiceMode) speakTutorial('ต้องการให้สอนการใช้งานหรือไม่คะ ลองพูดว่า เริ่มแบบฝึกหัด หรือ ดูคำสั่งที่ใช้ได้');
  }

  function completeTutorialStep(message) {
    if (!state.tutorial.active) return false;
    const step = TUTORIAL_STEPS[state.tutorial.step];
    if (!step || !step.matches.test(String(message || ''))) return false;
    if (state.tutorial.step === 2 && !(state.referenceList && state.referenceList.items.length)) return false;
    if (state.tutorial.step === 3 && !state.selectedPerson) return false;
    state.tutorial.step += 1;
    state.tutorial.lastAdvanced = true;
    renderTutorialStep({ completed: true });
    return true;
  }

  function renderUsageGuide() {
    const wrap = appendMessage('assistant', '');
    wrap.classList.add('msg-usage-guide');
    wrap.querySelector('.bubble')?.remove();
    const card = document.createElement('section');
    card.className = 'usage-guide-card';
    const head = document.createElement('div');
    head.className = 'usage-guide-head';
    head.innerHTML = '<span class="usage-guide-kicker">คู่มือด่วน</span><h2>ใช้งานผู้ช่วยเอไอธานีพิทักษ์อย่างไร</h2><p>ถามด้วยภาษาพูดได้เลย ระบบจะแสดงเฉพาะข้อมูลในสิทธิ์ของผู้ใช้</p>';
    const grid = document.createElement('div');
    grid.className = 'usage-guide-grid';
    const sections = [
      ['ดูภาพรวม', ['“ขอภาพรวม สภ.”', '“ขอภาพรวมผู้เสพ ตำบลโพนสูง”']],
      ['ขอรายชื่อและเลือกคน', ['“ขอรายชื่อผู้เสพ”', '“เลือกคนที่ 2” หรือ “ขอข้อมูลคนที่สอง”']],
      ['ติดตามรายการเดิม', ['“กำลังอ้างอิงรายการไหน”', '“ยกเลิกการเลือก”']],
      ['รายงาน', ['“ทำเป็น PDF” หรือ “ทำเป็น Excel”', 'ระบบจะถามยืนยันก่อนสร้างรายงาน']],
      ['สั่งด้วยเสียง', ['กด “ผู้ช่วยเอไอธานีพิทักษ์”', 'กดค้างปุ่มไมค์ พูดจบแล้วปล่อยปุ่ม']],
      ['ข้อควรทราบ', ['ไม่ต้องพิมพ์ข้อมูลอ่อนไหวเกินจำเป็น', 'หากยังไม่แน่ใจ ระบบจะถามให้ระบุเพิ่ม']],
    ];
    for (const [title, items] of sections) {
      const section = document.createElement('div');
      section.className = 'usage-guide-section';
      const h3 = document.createElement('h3'); h3.textContent = title;
      const list = document.createElement('ul');
      for (const item of items) { const li = document.createElement('li'); li.textContent = item; list.appendChild(li); }
      section.append(h3, list); grid.appendChild(section);
    }
    const examples = document.createElement('div');
    examples.className = 'usage-guide-examples';
    const title = document.createElement('strong'); title.textContent = 'ลองถามได้ทันที'; examples.appendChild(title);
    for (const prompt of ['ขอภาพรวม สภ.', 'ขอรายชื่อผู้เสพ', 'ผู้ป่วยจิตเวชที่เสี่ยงสูงมีใครบ้าง']) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'suggest-btn'; button.textContent = prompt;
      button.addEventListener('click', () => sendMessage(prompt)); examples.appendChild(button);
    }
    card.append(head, grid, examples);
    wrap.insertBefore(card, wrap.querySelector('.msg-time'));
    scrollToBottom();
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
    box.querySelector('.empty-state')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-assistant');
    if (state.voiceMode && role === 'assistant') wrap.classList.add('voice-result-reveal');
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
      mic.classList.toggle('is-processing', state.mic === 'uploading' || state.sending);
      mic.setAttribute('aria-busy', String(state.mic === 'uploading' || state.sending));
    }
    const voiceButton = $('#voice-assistant-btn');
    if (voiceButton) voiceButton.disabled = state.sending;
  }

  function setMicStatus(text, isError, working = false) {
    const el = $('#mic-status');
    if (!el) return;
    el.textContent = text || '';
    const dock = $('#voice-command-status');
    if (dock) {
      dock.classList.toggle('is-error', Boolean(isError));
      dock.classList.toggle('is-working', Boolean(working));
    }
  }

  function setMascotSpeaking(speaking) {
    $('#voice-speaker')?.classList.toggle('is-speaking', Boolean(speaking));
  }

  function stopVoiceAudio() {
    if (activeVoiceAudio) {
      activeVoiceAudio.pause();
      activeVoiceAudio.currentTime = 0;
    }
    if (activeVoiceStop) activeVoiceStop();
    activeVoiceAudio = null;
    activeVoiceStop = null;
    setMascotSpeaking(false);
  }

  function playVoiceClip(name) {
    const source = VOICE_CLIPS[name];
    if (!source || !state.voiceMode) return Promise.resolve();
    stopVoiceAudio();
    return new Promise((resolve) => {
      const audio = new Audio(source);
      activeVoiceAudio = audio;
      let completed = false;
      const done = () => {
        if (completed) return;
        completed = true;
        if (activeVoiceAudio === audio) activeVoiceAudio = null;
        if (activeVoiceStop === done) activeVoiceStop = null;
        setMascotSpeaking(false);
        resolve();
      };
      activeVoiceStop = done;
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      setMascotSpeaking(true);
      audio.play().catch(done);
    });
  }

  async function playVoiceSequence(names) {
    for (const name of names) await playVoiceClip(name);
  }

  async function openVoiceAssistant() {
    if (state.sending) return;
    state.voiceMode = true;
    $('#voice-assistant-panel').classList.remove('hidden');
    document.body.classList.add('voice-mode-open');
    setMicStatus(state.sttAvailable === false ? VoiceInput.micErrorMessage('STT_UNAVAILABLE') : 'พร้อมรับคำสั่งแล้ว • กดค้างปุ่มไมค์เพื่อพูด', state.sttAvailable === false);
    const greeted = sessionStorage.getItem('tp_voice_assistant_greeted') === '1';
    if (greeted) await playVoiceSequence(['howToUse']);
    else {
      sessionStorage.setItem('tp_voice_assistant_greeted', '1');
      await playVoiceSequence(['hello', 'greeting', 'howToUse']);
    }
  }

  function closeVoiceAssistant() {
    abortMic();
    stopVoiceAudio();
    state.voiceMode = false;
    $('#voice-assistant-panel').classList.add('hidden');
    document.body.classList.remove('voice-mode-open');
    $('#chat-input').focus();
  }

  function answerNeedsFollowup(json) {
    const answer = String((json && json.answer) || '');
    const type = json && json.presentation && json.presentation.type;
    return type === 'summary_choices' || type === 'person_candidates' || type === 'report_offer' || /(?:กรุณาระบุ|กรุณาเลือก|ขอรายละเอียด|ต้องการ.+หรือไม่)/u.test(answer);
  }

  function answerIsNotUnderstood(json) {
    return /(?:ไม่เข้าใจ|ยังสรุปไม่ได้|ไม่พบคำสั่ง)/u.test(String((json && json.answer) || ''));
  }

  function isVoiceIntroduction(message) {
    const text = String(message || '').replace(/\s+/g, '');
    return /(?:คุณ|เธอ)คือใคร|(?:ช่วย)?แนะนำตัว(?:หน่อย)?/u.test(text);
  }

  function finishVoiceTurn(json, message) {
    if (!state.voiceMode) return Promise.resolve();
    if (state.tutorial.active && state.tutorial.lastAdvanced) {
      state.tutorial.lastAdvanced = false;
      return speakTutorial(tutorialSpeechFor(TUTORIAL_STEPS[state.tutorial.step])).finally(() => {
        if (state.voiceMode && state.mic !== 'recording' && state.mic !== 'uploading' && !state.sending) setMicStatus('พร้อมรับคำสั่งต่อไป', false);
      });
    }
    let clip = 'finished';
    if (isVoiceIntroduction(message)) clip = 'introduce';
    else if (answerNeedsFollowup(json)) clip = 'answerQuestion';
    else if (answerIsNotUnderstood(json)) clip = 'notUnderstood';
    return playVoiceClip(clip).finally(() => {
      if (state.voiceMode && state.mic !== 'recording' && state.mic !== 'uploading' && !state.sending) {
        setMicStatus('พร้อมรับคำสั่งต่อไป', false);
      }
    });
  }

  async function loadSttStatus() {
    if (state.mic === 'recording' || state.mic === 'uploading') return;
    try {
      const json = await api('/api/stt/status');
      state.sttAvailable = json.available === true;
      state.mic = state.sttAvailable ? 'idle' : 'unavailable';
      setMicStatus(state.sttAvailable ? 'พร้อมรับคำสั่งแล้ว • กดค้างปุ่มไมค์เพื่อพูด' : VoiceInput.micErrorMessage('STT_UNAVAILABLE'), !state.sttAvailable);
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
    setMicStatus('กำลังแปลงเสียงเป็นข้อความ…', false, true);
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
      playVoiceClip('notClear');
      return;
    }
    // Begin the acknowledgement as soon as speech capture ends. Transcription
    // proceeds concurrently, so the officer is not left waiting in silence.
    const acknowledgement = state.voiceMode ? playVoiceClip('acknowledge') : Promise.resolve();
    let autoSendMessage = null;
    try {
      const json = await transcribeAudio(blob);
      const text = json && json.transcript;
      if (!text) {
        setMicStatus(VoiceInput.micErrorMessage('EMPTY_TRANSCRIPT'), true);
        playVoiceClip('notClear');
      } else {
        const input = $('#chat-input');
        const typedBeforeTranscript = input.value.trim();
        // Voice mode is a turn-based interface. A completed spoken command
        // replaces any leftover transient text from the prior voice turn so
        // ordinal selection and the following spoken question never combine.
        if (state.voiceMode) input.value = '';
        input.value = VoiceInput.applyTranscript(input.value, text);
        autoResizeInput();
        // Send a clean voice turn immediately. Never silently combine a
        // transcript with text the user had already typed.
        if (typedBeforeTranscript && !state.voiceMode) {
          if (!state.voiceMode) input.focus();
          setMicStatus(state.voiceMode
            ? 'พบข้อความที่พิมพ์ค้างอยู่ • ปิดโหมดเสียงเพื่อกลับไปตรวจและส่งข้อความเดิม'
            : 'พบข้อความที่พิมพ์ค้างอยู่ กรุณาตรวจแล้วกดส่ง', false);
        } else {
          autoSendMessage = String(text).trim();
        }
      }
    } catch (err) {
      if (err && err.status === 401) {
        await messageForError(err);
        return;
      }
      const code = err && err.json && err.json.code;
      setMicStatus(VoiceInput.micErrorMessage(code, err && err.status), true);
      if (code === 'EMPTY_TRANSCRIPT' || code === 'STT_LOW_CONFIDENCE') playVoiceClip('notClear');
    }
    state.mic = state.sttAvailable ? 'idle' : 'unavailable';
    updateSendDisabled();
    if (autoSendMessage) {
      setMicStatus('รับคำสั่งแล้ว กำลังประมวลผลคำสั่ง…', false, true);
      await acknowledgement;
      sendMessage(autoSendMessage, { voice: true });
    }
  }

  async function startRecording(event) {
    if (state.sending || state.mic === 'recording' || state.mic === 'uploading') return;
    // A user who starts speaking may interrupt the introduction or completion cue.
    stopVoiceAudio();
    micCtl.held = true;
    if (state.sttAvailable !== true) {
      setMicStatus('กำลังเชื่อมต่อระบบแปลงเสียง…', false, true);
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
    setMicStatus('กำลังฟัง… ปล่อยปุ่มเมื่อพูดจบ', false, true);
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
    const command = window.ChatContext.ordinalCommandFromMessage(message);
    if (!command) return { message };
    const { ordinal } = command;
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
      applyPersonSelection({ personId: chosen.personId, displayName: chosen.displayName }, command.action === 'select');
      if (command.action === 'select') return { handled: true };
      return { message: String(message).replace(command.matchedText, 'คนนี้') };
    }
    const followup = ordinalPromptForLocation(chosen);
    if (followup) {
      recordReferenceChild(chosen);
      if (command.action === 'select') appendMessage('assistant', `เลือกแล้ว: ${chosen.displayName} — กำลังเปิดรายการที่เกี่ยวข้อง`);
      return { message: followup };
    }
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
      button.addEventListener('click', () => {
        // Only the server may request this local selection reset; person IDs
        // are still re-authorized by the backend for every later request.
        if (choice.clearSelection) clearSelectedPerson();
        sendMessage(choice.message);
      });
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

  function sendMessage(overrideText, options = {}) {
    if (state.mic === 'recording' || state.mic === 'uploading') return;
    let message = (overrideText !== undefined ? overrideText : $('#chat-input').value || '').trim();
    if (!message || state.sending) return;
    const voiceTurn = options.voice === true;
    // A voice transcript is only a transport buffer. Clear it before any
    // local command path can return early (for example “เลือกคนที่ 18”).
    if (voiceTurn) clearChatInput();

    const compactMessage = message.replace(/\s+/g, '');
    if (/(?:เริ่ม|สอน).*แบบฝึกหัด/u.test(compactMessage)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      autoResizeInput();
      startTutorial();
      return;
    }
    if (/(?:ดู|บอก).*(?:คำสั่ง|ตัวอย่าง)/u.test(compactMessage) && /(?:ใช้|สั่ง|ได้)/u.test(compactMessage)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      autoResizeInput();
      renderUsageGuide();
      return;
    }
    if (state.tutorial.active && /(?:ทำ(?:ยัง)?ไงต่อ|ต่อไป|ทวน(?:ข้อ|คำสั่ง)?|ย้ำ(?:ข้อ|คำสั่ง)?)/u.test(compactMessage)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      autoResizeInput();
      const step = renderTutorialStep();
      if (voiceTurn) speakTutorial(tutorialSpeechFor(step));
      return;
    }
    if (isUsageGuideQuestion(message)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      autoResizeInput();
      renderTutorialOffer();
      return;
    }

    completeTutorialStep(message);

    if (window.ChatContext.isReferenceListQuestion(message)) {
      appendMessage('user', message);
      if (/บุคคล/.test(message) && state.selectedPerson) appendMessage('assistant', `กำลังอ้างอิงบุคคล: ${state.selectedPerson.displayName}`);
      else renderReferenceSnapshot();
      $('#chat-input').value = '';
      autoResizeInput();
      finishVoiceTurn();
      return;
    }

    if (window.ChatContext.isClearSelectionCommand(message)) {
      appendMessage('user', message);
      const hadSelection = Boolean(state.selectedPerson);
      clearSelectedPerson();
      appendMessage('assistant', hadSelection ? 'ยกเลิกการเลือกแล้ว' : 'ขณะนี้ยังไม่ได้เลือกบุคคลหรือรายการ');
      $('#chat-input').value = '';
      autoResizeInput();
      finishVoiceTurn(null, message);
      return;
    }

    const ordinalResolution = resolveOrdinalReference(message);
    if (ordinalResolution.handled) { finishVoiceTurn(); return; }
    message = ordinalResolution.message.trim();

    if (isStartOverCommand(message)) {
      resetConversation();
      finishVoiceTurn();
      return;
    }

    if (state.pendingSummaryReport && isPdfAffirmative(message)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      createSummaryPdf();
      finishVoiceTurn();
      return;
    }
    if (state.pendingSummaryReport && isPdfNegative(message)) {
      appendMessage('user', message);
      $('#chat-input').value = '';
      state.pendingSummaryReport = null;
      appendMessage('assistant', 'ต้องการสร้างรายงาน PDF หรือ Excel ของข้อมูลใดครับ? เช่น “รายงานผู้เสพในตำบลโพนสูง”');
      finishVoiceTurn({ answer: 'กรุณาระบุข้อมูลสำหรับรายงาน' });
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
    if (voiceTurn) setMicStatus('กำลังประมวลผลคำสั่ง…', false, true);
    showTypingIndicator();

    let settled = false;
    const watchdog = setTimeout(() => {
      settled = true;
      removeTypingIndicator();
      setBusy(false);
      appendMessage('assistant', 'AI ใช้เวลาประมวลผลนานเกินไป กรุณาลองอีกครั้ง', { error: true });
      if (voiceTurn) {
        setMicStatus('ใช้เวลาประมวลผลนานเกินไป กรุณาลองใหม่', true);
        playVoiceClip('notUnderstood');
      }
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
        if (voiceTurn) finishVoiceTurn(json, message);
      })
      .catch(async (err) => {
        if (settled) return;
        clearTimeout(watchdog);
        settled = true;
        removeTypingIndicator();
        const msg = await messageForError(err);
        appendMessage('assistant', msg, { error: true });
        if (voiceTurn) {
          setMicStatus('ประมวลผลคำสั่งไม่สำเร็จ กรุณาลองใหม่', true);
          playVoiceClip('notUnderstood');
        }
      })
      .finally(() => {
        settled = true;
        setBusy(false);
        if (!state.voiceMode) $('#chat-input').focus();
      });
  }

  function autoResizeInput() {
    const el = $('#chat-input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function clearChatInput() {
    const input = $('#chat-input');
    if (!input) return;
    input.value = '';
    autoResizeInput();
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
    $('#voice-assistant-btn').addEventListener('click', () => { openVoiceAssistant(); });
    $('#voice-assistant-close').addEventListener('click', closeVoiceAssistant);
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
