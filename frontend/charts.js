(function () {
  'use strict';
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function render(host, data) {
    const labels = Array.isArray(data.labels) ? data.labels : [];
    const values = Array.isArray(data.values) ? data.values : [];
    if (labels.length !== values.length || values.some(v => !Number.isSafeInteger(v) || v < 0)) return;
    const box = el('section', 'chat-chart');
    const head = el('header', 'chart-head');
    const heading = el('div');
    heading.append(el('small', 'chart-source', data.dataSource === 'real' ? 'ข้อมูลจริง • อ่านอย่างเดียว' : 'ข้อมูลทดสอบ'), el('h3', '', data.title));
    head.append(heading, el('strong', 'chart-total', `${data.total} ${data.unit}`));
    box.append(head);
    if (data.from) box.append(el('p', 'chart-period', `${data.windowLabel || ''} • ${data.from} ถึง ${data.to}`));
    if (data.areaLabel) box.append(el('p', 'chart-period', data.areaLabel));
    const controls = el('div', 'chart-controls');
    const plot = el('div', 'chart-plot');
    const tableWrap = el('div', 'chart-table-wrap');
    tableWrap.hidden = true;
    const table = el('table', 'chart-table');
    table.append(el('caption', '', data.title));
    const thead = el('thead'); const header = el('tr');
    header.append(el('th', '', data.from ? 'เดือน' : 'ประเภท / สภ.'), el('th', '', `จำนวน (${data.unit})`)); thead.append(header); table.append(thead);
    const body = el('tbody');
    labels.forEach((label, i) => { const tr = el('tr'); const th = el('th', '', label); th.scope = 'row'; tr.append(th, el('td', '', String(values[i]))); body.append(tr); });
    const totalRow = el('tr'); totalRow.append(el('th', '', 'รวม'), el('td', '', String(data.total))); body.append(totalRow); table.append(body); tableWrap.append(table);
    const buttons = [];
    function show(kind) {
      plot.replaceChildren(); tableWrap.hidden = kind !== 'table'; plot.hidden = kind === 'table';
      buttons.forEach(([button, value]) => button.setAttribute('aria-pressed', String(value === kind)));
      if (kind === 'table') return;
      if (!labels.length) { plot.append(el('p', '', 'ไม่มีข้อมูลในขอบเขตที่ร้องขอ')); return; }
      const max = Math.max(1, ...values);
      if (kind === 'bar') {
        labels.forEach((label, i) => {
          const row = el('div', 'chart-bar-row');
          row.append(el('span', 'chart-bar-label', label));
          const track = el('div', 'chart-bar-track'); const bar = el('span', 'chart-bar'); bar.style.width = `${values[i] / max * 100}%`; track.append(bar);
          row.append(track, el('strong', 'chart-bar-value', String(values[i]))); row.title = `${label}: ${values[i]} ${data.unit}`; plot.append(row);
        });
      } else {
        const width = Math.max(600, labels.length * 90); const height = 300; const left = 50; const top = 25; const base = 225;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.style.minWidth = `${width}px`; svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${data.title} หน่วย${data.unit}`);
        function s(tag, attrs, text) { const node = document.createElementNS(svg.namespaceURI, tag); Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value)); if (text !== undefined) node.textContent = text; svg.append(node); return node; }
        const ceiling = Math.max(4, Math.ceil(max / 4) * 4);
        for (let i = 0; i <= 4; i++) { const y = base - i / 4 * (base - top); s('line', { x1: left, y1: y, x2: width - 35, y2: y, stroke: '#cbd5e1' }); s('text', { x: left - 8, y: y + 5, 'text-anchor': 'end', fill: '#64748b', 'font-size': 13 }, String(ceiling * i / 4)); }
        const x = i => labels.length === 1 ? (width + left) / 2 : left + 25 + i * (width - left - 85) / (labels.length - 1);
        const y = value => base - value / ceiling * (base - top);
        s('polyline', { points: values.map((value, i) => `${x(i)},${y(value)}`).join(' '), fill: 'none', stroke: '#2563eb', 'stroke-width': 3 });
        values.forEach((value, i) => {
          const dot = s('circle', { cx: x(i), cy: y(value), r: 5, fill: '#2563eb' });
          const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${labels[i]}: ${value} ${data.unit}`; dot.append(title);
          s('text', { x: x(i), y: y(value) - 12, 'text-anchor': 'middle', fill: '#1e40af', 'font-size': 14 }, String(value));
          s('text', { x: x(i), y: base + 27, 'text-anchor': 'middle', fill: '#475569', 'font-size': 12 }, labels[i].replace(/ (\d{4})$/, ''));
          s('text', { x: x(i), y: base + 45, 'text-anchor': 'middle', fill: '#64748b', 'font-size': 12 }, labels[i].match(/ (\d{4})$/)?.[1] || '');
        });
        plot.append(svg);
      }
    }
    for (const [kind, label] of [['bar', 'กราฟแท่ง'], ...(data.from ? [['line', 'กราฟเส้น']] : []), ['table', 'ตารางข้อมูล']]) {
      const button = el('button', '', label); button.type = 'button'; button.addEventListener('click', () => show(kind)); controls.append(button); buttons.push([button, kind]);
    }
    box.append(controls, plot, tableWrap);
    if (data.total === 0) box.append(el('p', 'chart-period', data.from ? 'ไม่มีบันทึกการตรวจเยี่ยมในช่วงนี้' : 'ไม่พบบุคคลเป้าหมายในขอบเขตนี้'));
    if (data.note) box.append(el('p', 'chart-period', data.note));
    box.append(el('small', 'chart-asof', `อ่านข้อมูลเมื่อ ${new Date(data.asOf).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`));
    host.append(box); show(data.chartType === 'line' ? 'line' : 'bar');
    return box;
  }
  window.ThaniCharts = { render };
})();
