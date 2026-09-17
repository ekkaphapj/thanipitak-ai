(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('tp_token') || null,
    user: null,
    view: 'dashboard',
    page: 1,
    limit: 50,
    followupPage: 1,
    detailPersonId: null,
    activeTab: 'visits',
  };

  const TYPE_LABEL = { psychiatric: 'จิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' };
  const STATUS_LABEL = {
    registered: 'ลงทะเบียนแล้ว',
    active: 'อยู่ระหว่างดูแล',
    followup: 'ต้องติดตาม',
    completed: 'เสร็จสิ้น',
  };
  const RESULT_LABEL = {
    normal: 'ปกติ',
    progress: 'มีพัฒนาการ',
    warning: 'ต้องเฝ้าระวัง',
    recovered: 'ฟื้นฟูได้',
    negative: 'ลบ',
    positive: 'บวก',
  };

  const $ = (sel) => document.querySelector(sel);

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
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

  function showLogin() {
    $('#app-screen').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    $('#login-error').classList.add('hidden');
  }

  function showApp() {
    $('#login-screen').classList.remove('active');
    $('#login-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
  }

  function renderUserBadge() {
    const u = state.user;
    $('#user-info').textContent = u ? `${u.name} (${roleLabel(u.role)})` : '';
    $('#station-display').textContent = u && u.stationId ? `สถานี ${u.stationId}` : 'ผู้ดูแลระบบ';
  }

  function roleLabel(role) {
    return { admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่', viewer: 'ผู้ตรวจสอบ' }[role] || role;
  }

  async function loadStatistics() {
    const json = await api('/api/statistics');
    const d = json.data;
    const cards = [
      { label: 'บุคคลทั้งหมด', value: d.total, cls: '' },
      { label: 'ผู้ป่วยจิตเวช', value: d.psychiatric, cls: 'type-psychiatric' },
      { label: 'ผู้เสพ', value: d.drug_user, cls: 'type-drug' },
      { label: 'ผู้ค้า', value: d.dealer, cls: 'type-dealer' },
      { label: 'ผู้พ้นโทษ', value: d.released || 0, cls: 'type-dealer' },
      { label: 'ต้องติดตาม', value: d.followupOverdue, cls: 'type-overdue' },
    ];
    $('#stats-grid').innerHTML = cards
      .map(
        (c) =>
          `<div class="stat-card ${c.cls}"><div class="stat-label">${c.label}</div><div class="stat-value">${c.value.toLocaleString('th-TH')}</div></div>`
      )
      .join('');
  }

  async function loadPersons(extra = {}) {
    const params = new URLSearchParams({
      limit: String(state.limit),
      offset: String((state.page - 1) * state.limit),
      ...extra,
    });
    const search = $('#search-input').value.trim();
    if (search) params.set('search', search);
    const type = $('#filter-type').value;
    const status = $('#filter-status').value;
    if (type) params.set('person_type', type);
    if (status) params.set('status', status);

    const json = await api('/api/persons?' + params.toString());
    const tbody = $('#persons-tbody');
    tbody.innerHTML = json.data.length
      ? json.data.map(personRow).join('')
      : '<tr><td colspan="8" class="empty-note">ไม่พบข้อมูล</td></tr>';

    renderPagination('#pagination', json.meta.total, state.limit, state.page, (p) => {
      state.page = p;
      loadPersons();
    });
  }

  function personRow(p) {
    return `<tr>
      <td>${escapeHtml(p.synthetic_code)}</td>
      <td>${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</td>
      <td><span class="badge badge-${p.person_type}">${TYPE_LABEL[p.person_type] || p.person_type}</span></td>
      <td><span class="badge badge-${p.status}">${STATUS_LABEL[p.status] || p.status}</span></td>
      <td>${escapeHtml(p.district)}</td>
      <td>${escapeHtml(p.subdistrict)}</td>
      <td>${p.last_visit_date || '-'}</td>
      <td><button class="btn btn-primary" data-id="${p.id}" data-action="detail">ดูรายละเอียด</button></td>
    </tr>`;
  }

  async function loadFollowups(extra = {}) {
    const params = new URLSearchParams({
      limit: String(state.limit),
      offset: String((state.followupPage - 1) * state.limit),
      ...extra,
    });
    const json = await api('/api/followups/overdue?' + params.toString());
    const tbody = $('#followups-tbody');
    tbody.innerHTML = json.data.length
      ? json.data.map(detailRow).join('')
      : '<tr><td colspan="7" class="empty-note">ไม่มีรายการที่เกินกำหนด</td></tr>';
    renderPagination('#followups-pagination', json.meta.total, state.limit, state.followupPage, (p) => {
      state.followupPage = p;
      loadFollowups();
    });
  }

  function detailRow(p) {
    return `<tr>
      <td>${escapeHtml(p.synthetic_code)}</td>
      <td>${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</td>
      <td><span class="badge badge-${p.person_type}">${TYPE_LABEL[p.person_type] || p.person_type}</span></td>
      <td><span class="badge badge-${p.status}">${STATUS_LABEL[p.status] || p.status}</span></td>
      <td>${p.interval_days}</td>
      <td>${p.last_visit_date || 'ไม่เคยเข้าเยี่ยม'}</td>
      <td><button class="btn btn-primary" data-id="${p.id}" data-action="detail">ดูรายละเอียด</button></td>
    </tr>`;
  }

  function renderPagination(sel, total, limit, page, onPage) {
    const pages = Math.max(1, Math.ceil(total / limit));
    const el = $(sel);
    if (pages <= 1) {
      el.innerHTML = '';
      return;
    }
    let html = `<button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>&laquo;</button>`;
    const start = Math.max(1, page - 2);
    const end = Math.min(pages, page + 2);
    for (let i = start; i <= end; i++) {
      html += `<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="page-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>&raquo;</button>`;
    el.innerHTML = html;
    el.querySelectorAll('.page-btn').forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => onPage(Number(btn.dataset.page)));
    });
  }

  async function openDetail(personId) {
    state.detailPersonId = personId;
    state.activeTab = 'visits';
    const json = await api('/api/persons/' + personId);
    const p = json.data;
    $('#modal-title').textContent = `${p.synthetic_code} - ${p.first_name} ${p.last_name}`;
    $('#person-info-section').innerHTML = `<div class="person-info-grid">
      ${infoItem('รหัส', p.synthetic_code)}
      ${infoItem('ชื่อ-นามสกุล', `${p.first_name} ${p.last_name}`)}
      ${infoItem('ประเภท', TYPE_LABEL[p.person_type] || p.person_type)}
      ${infoItem('สถานะ', STATUS_LABEL[p.status] || p.status)}
      ${infoItem('อำเภอ', p.district)}
      ${infoItem('ตำบล', p.subdistrict)}
      ${infoItem('สถานี', p.station_id)}
      ${infoItem('เยี่ยมล่าสุด', p.last_visit_date || '-')}
      ${infoItem('ลงทะเบียนเมื่อ', p.created_at ? p.created_at.slice(0, 10) : '-')}
    </div>`;
    $('#modal-overlay').classList.remove('hidden');
    await loadDetailTab('visits');
  }

  function infoItem(label, value) {
    return `<div class="item"><b>${label}</b>${escapeHtml(value)}</div>`;
  }

  async function loadDetailTab(tab) {
    const id = state.detailPersonId;
    document.querySelectorAll('.tab-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
    $('#tab-content-visits').classList.toggle('active', tab === 'visits');
    $('#tab-content-visits').classList.toggle('hidden', tab !== 'visits');
    $('#tab-content-urine-tests').classList.toggle('active', tab === 'urine-tests');
    $('#tab-content-urine-tests').classList.toggle('hidden', tab !== 'urine-tests');

    if (tab === 'visits') {
      const json = await api('/api/persons/' + id + '/visits');
      const rows = json.data;
      $('#tab-content-visits').innerHTML = rows.length
        ? rows
            .map(
              (v) => `<div class="visit-item" style="padding:8px 0;border-bottom:1px solid var(--border)">
                <b>${v.visit_date}</b> - ${RESULT_LABEL[v.result] || v.result}
                ${v.officer_name ? ` <span class="badge badge-registered">${escapeHtml(v.officer_name)}</span>` : ''}
                ${v.note ? `<div style="color:var(--muted)">${escapeHtml(v.note)}</div>` : ''}
              </div>`
            )
            .join('')
        : '<div class="empty-note">ไม่มีประวัติการเยี่ยม</div>';
    } else {
      const json = await api('/api/persons/' + id + '/urine-tests');
      const rows = json.data;
      $('#tab-content-urine-tests').innerHTML = rows.length
        ? rows
            .map(
              (u) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
                <b>${u.test_date}</b> - <span class="badge badge-${u.result}">${RESULT_LABEL[u.result] || u.result}</span>
                ${u.officer_name ? ` <span class="badge badge-registered">${escapeHtml(u.officer_name)}</span>` : ''}
              </div>`
            )
            .join('')
        : '<div class="empty-note">ไม่มีประวัติการตรวจปัสสาวะ</div>';
    }
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.nav-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === view)
    );
    $('#view-dashboard').classList.toggle('active', view === 'dashboard');
    $('#view-dashboard').classList.toggle('hidden', view !== 'dashboard');
    $('#view-followups').classList.toggle('active', view === 'followups');
    $('#view-followups').classList.toggle('hidden', view !== 'followups');
    if (view === 'dashboard') {
      loadStatistics();
      loadPersons();
    } else {
      loadFollowups();
    }
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
        state.user = json.user;
        localStorage.setItem('tp_token', state.token);
        showApp();
        renderUserBadge();
        switchView('dashboard');
      } catch (err) {
        const box = $('#login-error');
        box.textContent = err.message || 'เข้าสู่ระบบล้มเหลว';
        box.classList.remove('hidden');
      }
    });

    $('#logout-btn').addEventListener('click', () => {
      state.token = null;
      state.user = null;
      localStorage.removeItem('tp_token');
      showLogin();
    });

    $('#persons-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="detail"]');
      if (btn) openDetail(btn.dataset.id).catch(showApiError);
    });
    $('#followups-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="detail"]');
      if (btn) openDetail(btn.dataset.id).catch(showApiError);
    });

    let searchTimer = null;
    $('#search-input').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.page = 1;
        loadPersons().catch(showApiError);
      }, 300);
    });
    $('#filter-type').addEventListener('change', () => {
      state.page = 1;
      loadPersons().catch(showApiError);
    });
    $('#filter-status').addEventListener('change', () => {
      state.page = 1;
      loadPersons().catch(showApiError);
    });

    document.querySelectorAll('.nav-btn').forEach((b) =>
      b.addEventListener('click', () => switchView(b.dataset.view))
    );

    const hashView = () => {
      const h = window.location.hash.replace('#', '');
      if (h === 'followups') return 'followups';
      return 'dashboard';
    };
    window.addEventListener('hashchange', () => {
      if (!state.user) return;
      const view = hashView();
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      switchView(view);
    });
    if (window.location.hash && state.token) {
      setTimeout(() => {
        const view = hashView();
        document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
        switchView(view);
      }, 0);
    }

    $('#modal-close').addEventListener('click', () => $('#modal-overlay').classList.add('hidden'));
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) $('#modal-overlay').classList.add('hidden');
    });
    document.querySelectorAll('.tab-btn').forEach((b) =>
      b.addEventListener('click', () => loadDetailTab(b.dataset.tab).catch(showApiError))
    );

    if (state.token) {
      try {
        const json = await api('/api/auth/me');
        state.user = json.user;
        showApp();
        renderUserBadge();
        switchView('dashboard');
        return;
      } catch (_) {
        localStorage.removeItem('tp_token');
        state.token = null;
      }
    }
    showLogin();
  }

  function showApiError(err) {
    if (err.status === 401) {
      state.token = null;
      localStorage.removeItem('tp_token');
      showLogin();
      return;
    }
    console.error(err);
  }

  bootstrap();
})();
