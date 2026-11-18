// Shared helpers for the NOLA open data pages
const NOLA = (() => {
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const S = i => `var(--s${i + 1})`;
  const fmt = d3.format(',');
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';

  // ---------- tooltip ----------
  const tipEl = document.createElement('div');
  tipEl.className = 'tip'; document.body.appendChild(tipEl);
  const tip = {
    show(html, ev) {
      tipEl.innerHTML = html; tipEl.style.opacity = 1;
      const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      let x = ev.clientX + 14, y = ev.clientY + 14;
      if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
      if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
      tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
    },
    hide() { tipEl.style.opacity = 0; }
  };
  const row = (k, v) => `<div class="r"><span>${k}</span><span>${v}</span></div>`;

  // ---------- geography ----------
  const decode = r => { const o = []; let x = 0, y = 0; for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; o.push([x, y]); } return o; };
  const pathOf = rings => rings.map(r => 'M' + decode(r).map(p => p.join(',')).join('L') + 'Z').join('');
  const title = s => s.toLowerCase().replace(/(^|[\s\-\/.(&])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bMcdonogh\b/, 'McDonogh').replace(/\bB\. W\./, 'B.W.').replace(/\bSt\.\s+/g, 'St. ').replace(/\bDev\b/, 'Development');
  let GEO = null;
  function setGeo(g) {
    GEO = g;
    GEO.nb.forEach(f => { f.d = pathOf(f.r); f.name = title(f.n); });
    GEO.pd.forEach(f => { f.d = pathOf(f.r); });
  }

  // map(el, opts) -> {svg, layer, zoomTo, setFill, k()}
  function map(el, o) {
    const W = 1000, H = o.height || 640;
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', o.label || 'Map of New Orleans');
    const root = svg.append('g');
    const base = root.append('g');
    const nbSel = base.selectAll('path').data(GEO.nb).join('path').attr('class', 'nbpath' + (o.tip ? ' hot' : '')).attr('d', f => f.d);
    if (o.districts) root.append('g').selectAll('path').data(GEO.pd).join('path').attr('d', f => f.d)
      .attr('fill', 'none').attr('stroke', 'var(--ink2)').attr('stroke-width', 1.4).attr('vector-effect', 'non-scaling-stroke').attr('opacity', .55).style('pointer-events', 'none');
    const layer = root.append('g');
    const labG = root.append('g').style('pointer-events', 'none');
    (o.labels || []).forEach(nm => { const f = GEO.nb.find(f => f.n === nm); if (!f) return; const ring = decode(f.r[0]); const c = d3.polygonCentroid(ring);
      labG.append('text').attr('class', 'halo maplab').attr('x', c[0]).attr('y', c[1]).attr('text-anchor', 'middle').style('fill', 'var(--ink2)').style('font-size', '11px').text(f.name); });
    if (o.tip) nbSel.on('mousemove', (ev, f) => tip.show(o.tip(GEO.nb.indexOf(f)), ev)).on('mouseleave', tip.hide);
    let k = 1; const listeners = [];
    const zoom = d3.zoom().scaleExtent([0.6, 14]).on('zoom', ev => { root.attr('transform', ev.transform); k = ev.transform.k; labG.selectAll('text').style('font-size', (11 / k) + 'px').style('stroke-width', (4 / k) + 'px'); listeners.forEach(f => f(k)); });
    svg.call(zoom).on('dblclick.zoom', null);
    function zoomTo([x0, y0, x1, y1], dur = 0) {
      const s = Math.min(W / (x1 - x0), H / (y1 - y0));
      const t = d3.zoomIdentity.translate(W / 2, H / 2).scale(s).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      (dur ? svg.transition().duration(dur) : svg).call(zoom.transform, t);
    }
    zoomTo(o.extent || [-70, 130, 2110, 1730]);
    return {
      svg, layer, nbSel, zoomTo, k: () => k, onZoom: f => listeners.push(f),
      setFill(fn) { nbSel.attr('fill', (f, i) => fn(i) || null).style('fill', (f, i) => fn(i) || null); }
    };
  }
  // map control buttons
  function mapButtons(el, m, views) {
    const d = document.createElement('div'); d.className = 'row zoomhint';
    d.innerHTML = 'Scroll or pinch to zoom, drag to pan. ';
    views.forEach(([label, ext]) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.onclick = () => m.zoomTo(ext, 450); d.appendChild(b); });
    el.appendChild(d);
  }

  // sequential color for a value in [0,1]
  const SEQ = ['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7'];
  const seqVar = t => `var(${SEQ[Math.max(0, Math.min(6, Math.floor(t * 7)))]})`;
  function seqLegend(el, breaks, fmtf, label) {
    el.innerHTML = `<span>${label}</span>` + SEQ.map((s, i) => `<span><i style="background:var(${s})"></i>${i === 0 ? fmtf(breaks[0]) : i === 6 ? fmtf(breaks[1]) + '+' : ''}</span>`).join('');
  }

  // ---------- small chart helpers ----------
  function frame(el, { h = 260, m = { t: 12, r: 16, b: 28, l: 44 } } = {}) {
    const W = el.clientWidth || 600;
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${h}`);
    return { svg, W, H: h, m, iw: W - m.l - m.r, ih: h - m.t - m.b, g: svg.append('g').attr('transform', `translate(${m.l},${m.t})`) };
  }
  function yGrid(f, y, ticks = 4, tf = d3.format('~s')) {
    f.g.append('g').attr('class', 'gridl').call(d3.axisLeft(y).ticks(ticks).tickSize(-f.iw).tickFormat(tf)).call(g => g.select('.domain').remove()).call(g => g.selectAll('text').attr('x', -6));
    f.g.selectAll('.gridl .tick line').attr('stroke', 'var(--grid)');
  }
  function chips(el, items, onSel, { multi = false, sel = null } = {}) {
    el.innerHTML = '';
    let cur = sel;
    items.forEach((it, i) => {
      const b = document.createElement('button'); b.className = 'chip'; b.type = 'button';
      b.innerHTML = (it.color ? `<i style="background:${it.color}"></i>` : '') + it.label;
      b.onclick = () => { cur = it.value; [...el.children].forEach(c => c.classList.remove('on')); b.classList.add('on'); onSel(it.value); };
      if (it.value === sel) b.classList.add('on');
      el.appendChild(b);
    });
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // the calendar year a page covers; day-of-year (doy) values count from Jan 1 of it
  let YEAR = new Date().getFullYear();
  const setYear = y => { YEAR = y; };
  const doyTime = (d, y = YEAR) => new Date(Date.UTC(y, 0, 1) + d * 864e5);
  const doyDate = (d, y = YEAR) => { const t = doyTime(d, y); return months[t.getUTCMonth()] + ' ' + t.getUTCDate(); };
  const doyMonth = (d, y = YEAR) => doyTime(d, y).getUTCMonth();
  // first doy of each month (only months that start on or before `last`, if given)
  const monthStarts = (y = YEAR, last = 400) => d3.range(12).map(m => (Date.UTC(y, m, 1) - Date.UTC(y, 0, 1)) / 864e5).filter(d => d <= last);
  // 'YYYY-MM-DD' -> 'Nov 18, 2026'
  const isoDate = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return `${months[m - 1]} ${d}, ${y}`; };
  // plain-language share: .33 -> 'about a third'
  function share(p) {
    const named = [[1 / 4, 'about a quarter'], [1 / 3, 'about a third'], [1 / 2, 'about half'], [2 / 3, 'about two-thirds'], [3 / 4, 'about three-quarters']];
    const hit = named.find(([v]) => Math.abs(p - v) < 0.025);
    return hit ? hit[1] : `about ${Math.round(p * 100)}%`;
  }
  const numWord = n => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] || fmt(n);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const setText = (id, s) => { const el = document.getElementById(id); if (el) el.textContent = s; };
  const setHTML = (id, s) => { const el = document.getElementById(id); if (el) el.innerHTML = s; };

  return { css, S, fmt, pct, tip, row, setGeo, get GEO() { return GEO; }, map, mapButtons, seqVar, seqLegend, frame, yGrid, chips, months, monthsLong,
    setYear, get YEAR() { return YEAR; }, doyTime, doyDate, doyMonth, monthStarts, isoDate, share, numWord, cap, setText, setHTML, title };
})();
