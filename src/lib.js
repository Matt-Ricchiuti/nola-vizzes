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
  // ---------- per-resident rates (2020 Census population per neighborhood, GEO.pop) ----------
  // Use only for things residents generate (e.g. calls for service), not for land- or street-based counts.
  const MIN_POP = 1000; // rates for neighborhoods smaller than this swing wildly, so they're left out
  const popOf = i => GEO.pop ? GEO.pop[i] : null;
  const perK = (n, pop) => n != null && pop >= MIN_POP ? 1000 * n / pop : null;
  const fmtRate = v => v == null ? '—' : v >= 100 ? d3.format(',')(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
  const POP_NOTE = '<div class="legend popnote">Per 1,000 residents (2020 Census). Visitors, workers and highway traffic also generate calls, so rates run high where few people live, like the CBD and French Quarter. Neighborhoods under 1,000 residents are left out.</div>';
  // Total / Per 1,000 residents switch
  const basisChips = (el, onSel, sel = 'n') => chips(el, [{ label: 'Total', value: 'n' }, { label: 'Per 1,000 residents', value: 'pc' }], onSel, { sel });
  // ---------- the opening view ----------
  // Every neighborhood is mapped and counted. Maps open on the populated city, leaving out the mostly
  // uninhabited marsh to the east (under 100 residents per square mile: Lake Catherine, Viavant–Venetian Isles),
  // which would otherwise shrink everything else. Zoom out or pick one from the menu to see it.
  const MIN_DENSITY = 100;
  const SQMI = 400 / 2589988; // one map unit is about 20 m
  let FULL = [-70, 130, 2110, 1730];
  const bboxOf = rings => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; rings.forEach(r => decode(r).forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); })); return [x0, y0, x1, y1]; };
  const pad = ([x0, y0, x1, y1], f) => { const dx = (x1 - x0) * f, dy = (y1 - y0) * f; return [x0 - dx, y0 - dy, x1 + dx, y1 + dy]; };
  function setGeo(g) {
    GEO = g;
    GEO.nb.forEach((f, i) => {
      f.idx = i; f.d = pathOf(f.r); f.name = title(f.n); f.bbox = bboxOf(f.r);
      f.sqmi = f.r.reduce((a, r) => a + Math.abs(d3.polygonArea(decode(r))), 0) * SQMI;
      f.skip = !!(g.pop && g.pop[i] / f.sqmi < MIN_DENSITY);
    });
    GEO.pd.forEach(f => { f.d = pathOf(f.r); });
    const kept = GEO.nb.filter(f => !f.skip).map(f => f.bbox);
    FULL = pad([d3.min(kept, b => b[0]), d3.min(kept, b => b[1]), d3.max(kept, b => b[2]), d3.max(kept, b => b[3])], 0.03);
  }
  const shown = i => i >= 0; // a record in neighborhood i appears on maps
  const nbList = () => GEO.nb.slice().sort((a, b) => a.name.localeCompare(b.name));
  // neighborhood picker: <select> with "All neighborhoods" (-1) and every mapped neighborhood
  function nbSelect(el, onSel, sel = -1, label = 'All neighborhoods') {
    el.innerHTML = `<option value="-1">${label}</option>` + nbList().map(f => `<option value="${f.idx}">${f.name}</option>`).join('');
    el.value = sel; el.onchange = () => onSel(+el.value);
  }
  // projected map units -> [lon, lat] (for CSV downloads)
  const lonlat = (x, y) => [+(x / 4830 - 90.14).toFixed(5), +(30.20 - y / 5550).toFixed(5)];

  // map(el, opts) -> {svg, layer, zoomTo, setFill, focus, k()}
  // The map fills el. It keeps clear of an on-map filter panel (o.panel) when fitting, and carries its own
  // zoom controls, scale bar and street-name labels.
  let mapN = 0;
  function map(el, o) {
    el.classList.add('map');
    const W = 1000, H = Math.round(W * (el.clientHeight > 50 ? el.clientHeight / Math.max(1, el.clientWidth) : (o.height || 640) / 1000));
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', o.label || 'Map of New Orleans');
    const root = svg.append('g');
    const base = root.append('g');
    const nbs = GEO.nb;
    const nbSel = base.selectAll('path').data(nbs).join('path').attr('class', 'nbpath' + (o.tip ? ' hot' : '')).attr('d', f => f.d);
    // street base map (City centerlines, in streets.js), clipped to the mapped neighborhoods; local streets fade in as you zoom
    const ST = window.STREETS;
    let localSt = null;
    if (ST) {
      const cid = 'nbclip' + (++mapN);
      root.append('clipPath').attr('id', cid).selectAll('path').data(nbs).join('path').attr('d', f => f.d);
      const sg = root.append('g').attr('clip-path', `url(#${cid})`).append('g').attr('class', 'streets').attr('transform', `scale(${1 / ST.q})`).attr('aria-hidden', 'true');
      localSt = sg.append('path').attr('class', 'st st3').attr('d', ST.d[3]);
      sg.append('path').attr('class', 'st st2').attr('d', ST.d[2]);
      sg.append('path').attr('class', 'st st1').attr('d', ST.d[1]);
      sg.append('path').attr('class', 'st st0').attr('d', ST.d[0]);
    }
    const streetZoom = k => { if (localSt) localSt.style('opacity', Math.max(0.35, Math.min(1, (k - 0.6) / 2.4))); };
    const focusG = root.append('g').style('pointer-events', 'none');
    if (o.districts) root.append('g').selectAll('path').data(GEO.pd).join('path').attr('d', f => f.d)
      .attr('fill', 'none').attr('stroke', 'var(--ink2)').attr('stroke-width', 1.4).attr('vector-effect', 'non-scaling-stroke').attr('opacity', .55).style('pointer-events', 'none');
    const stLabG = root.append('g').attr('aria-hidden', 'true');
    const layer = root.append('g');
    if (o.tip) nbSel.on('mousemove', (ev, f) => tip.show(o.tip(f.idx), ev)).on('mouseleave', tip.hide);

    // ---- street names, placed after each zoom so they never overlap; longer streets first ----
    const SL = ST && ST.lab, q = ST ? ST.q : 1;
    const AN = SL ? SL.a.length / 6 : 0;
    const order = SL ? d3.range(AN).sort((a, b) => SL.a[a * 6 + 5] - SL.a[b * 6 + 5] || SL.a[b * 6 + 3] - SL.a[a * 6 + 3]) : [];
    function layoutLabels() {
      if (!SL) return;
      const t = d3.zoomTransform(svg.node()), k = t.k, placed = [], seen = new Map(), cell = 60, grid = new Map();
      const hit = b => { for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) { const L = grid.get(gx * 9973 + gy); if (L) for (const r of L) if (b[0] < r[2] && b[2] > r[0] && b[1] < r[3] && b[3] > r[1]) return true; } return false; };
      const add = b => { for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) { const key = gx * 9973 + gy; (grid.get(key) || grid.set(key, []).get(key)).push(b); } };
      if (k >= 2) for (const i of order) {
        const b = i * 6, tier = SL.a[b + 5];
        if (tier === 2 && k < 5) continue;
        const [sx, sy] = t.apply([SL.a[b] / q, SL.a[b + 1] / q]);
        if (sx < -40 || sx > W + 40 || sy < -20 || sy > H + 20) continue;
        const name = SL.names[SL.a[b + 4]], fs = tier < 2 ? 11.5 : 10.5, w = name.length * fs * 0.56 + 8;
        if (w > 2 * SL.a[b + 3] / q * k) continue; // the street is too short at this zoom
        const a = SL.a[b + 2] * Math.PI / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)), hw = w / 2, hh = fs / 2 + 2;
        const sh = c > .3 && sn > .3 ? .8 : 1, ex = (hw * c + hh * sn) * sh, ey = (hw * sn + hh * c) * sh, box = [sx - ex, sy - ey, sx + ex, sy + ey];
        if (hit(box)) continue;
        const prev = seen.get(name); if (prev && prev.some(([px, py]) => (px - sx) ** 2 + (py - sy) ** 2 < 260 * 260)) continue;
        add(box); if (prev) prev.push([sx, sy]); else seen.set(name, [[sx, sy]]);
        placed.push({ x: SL.a[b] / q, y: SL.a[b + 1] / q, a: SL.a[b + 2], name, fs, major: tier < 2 });
        if (placed.length > 260) break;
      }
      stLabG.selectAll('text').data(placed).join('text').attr('class', d => 'stlab' + (d.major ? ' major' : ''))
        .attr('transform', d => `translate(${d.x},${d.y}) rotate(${d.a})`).attr('text-anchor', 'middle').attr('dy', '0.35em')
        .style('font-size', d => (d.fs / k) + 'px').style('stroke-width', (3 / k) + 'px').style('fill', 'var(--ink2)').text(d => d.name);
    }

    // ---- zoom, controls, scale bar ----
    let k = 1, lt = 0; const listeners = [];
    const scaleEl = document.createElement('div'); scaleEl.className = 'scalebar'; scaleEl.innerHTML = '<span></span><i></i>'; el.appendChild(scaleEl);
    function drawScale() {
      const pxPerMile = 80.47 * k * (el.clientWidth || W) / W, opts = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]; let m = opts[0];
      for (const v of opts) if (v * pxPerMile <= 110) m = v;
      scaleEl.lastChild.style.width = (m * pxPerMile).toFixed(0) + 'px';
      scaleEl.firstChild.textContent = m < 1 ? (m * 5280 >= 1000 ? m + ' mi' : Math.round(m * 5280) + ' ft') : m + ' mi';
    }
    // the opening view is about k = 0.45; allow zooming out far enough to see the whole parish, east marsh included
    const zoom = d3.zoom().scaleExtent([0.25, 40]).on('zoom', ev => {
      root.attr('transform', ev.transform); k = ev.transform.k; streetZoom(k); drawScale();
      stLabG.selectAll('text').style('font-size', d => (d.fs / k) + 'px').style('stroke-width', (3 / k) + 'px');
      listeners.forEach(f => f(k)); clearTimeout(lt); lt = setTimeout(layoutLabels, 90);
    });
    svg.call(zoom).on('dblclick.zoom', null);
    // fit an extent into the part of the map the filter panel doesn't cover
    const inset = () => { if (!o.panel || getComputedStyle(o.panel).position !== 'absolute' || !o.panel.childElementCount) return 0;
      return (o.panel.offsetWidth + 24) * W / Math.max(1, el.clientWidth); };
    function zoomTo([x0, y0, x1, y1], dur = 0) {
      const L = inset(), s = Math.min((W - L) / (x1 - x0), H / (y1 - y0)) * 0.96;
      const tr = d3.zoomIdentity.translate(L + (W - L) / 2, H / 2).scale(s).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      (dur ? svg.transition().duration(dur) : svg).call(zoom.transform, tr);
    }
    const home = o.extent || FULL;
    let focused = -1;
    const ctl = document.createElement('div'); ctl.className = 'mapctl';
    [['+', 'Zoom in', () => svg.transition().duration(250).call(zoom.scaleBy, 1.7)], ['−', 'Zoom out', () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.7)],
     ['⤢', 'Reset view', () => api.focus(focused)]].forEach(([t, l, fn]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.title = l; b.setAttribute('aria-label', l); b.onclick = fn; ctl.appendChild(b); });
    el.appendChild(ctl);
    zoomTo(home); drawScale(); layoutLabels();
    const api = {
      svg, layer, nbSel, zoomTo, k: () => k, onZoom: f => listeners.push(f), home,
      setFill(fn) { nbSel.attr('fill', f => fn(f.idx) || null).style('fill', f => fn(f.idx) || null); },
      // outline one neighborhood and zoom to it (-1: clear and go back to the whole mapped city)
      focus(i, dur = 450) {
        focused = i;
        focusG.selectAll('path').data(i >= 0 ? [GEO.nb[i]] : []).join('path').attr('d', f => f.d).attr('class', 'nbfocus');
        zoomTo(i >= 0 ? pad(GEO.nb[i].bbox, 0.25) : home, dur);
      }
    };
    return api;
  }
  // kept for older callers; maps carry their own controls now
  function mapButtons() {}

  // ---------- filters on the chart ----------
  // stage(el, { map }) turns a view's pane into a filter panel + plot area. On maps the panel floats over the map.
  function stage(el, { map: isMap = false, open = false } = {}) {
    el.classList.add('stage', isMap ? 'mapstage' : 'chartstage');
    el.innerHTML = '<div class="fpanel"></div><div class="plot"></div>';
    const panel = el.firstChild;
    if (isMap) { // on phones the map's filters fold away behind a button, so the map shows first
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ftoggle'; b.textContent = 'Filters';
      if (open) b.textContent = 'Hide filters'; else panel.classList.add('collapsed');
      b.onclick = () => { panel.classList.toggle('collapsed'); b.textContent = panel.classList.contains('collapsed') ? 'Filters' : 'Hide filters'; };
      el.insertBefore(b, panel);
    }
    return { panel, plot: el.lastChild };
  }
  // panel section with a small heading and an optional link-style action ("Show all")
  function fsec(panel, title, action) {
    const sec = document.createElement('div'); sec.className = 'fsec';
    sec.innerHTML = `<div class="fsec-h"><span class="eyebrow">${title}</span></div>`;
    if (action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'linkbtn'; b.textContent = action[0]; b.onclick = action[1]; sec.firstChild.appendChild(b); }
    panel.appendChild(sec); return sec;
  }
  // legend-style filter rows: swatch, name (+ sub), proportion bar, count. mode 'pick' (one at a time) or 'toggle' (each on/off)
  function flist(sec, rows, { pressed, onClick, mode = 'pick' }) {
    const ul = document.createElement('ul'); ul.className = 'flist' + (mode === 'toggle' ? ' toggles' : '');
    const mx = Math.max(1, ...rows.map(r => r.count || 0)); let any = false;
    rows.forEach(r => {
      const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
      const on = !!pressed(r.key); if (on) any = true; b.setAttribute('aria-pressed', on);
      const col = r.color || 'var(--muted)';
      b.innerHTML = `<span class="sw" style="background:${col}${r.square ? ';border-radius:3px' : ''}"></span><span class="nm"><span>${r.name}</span>${r.sub ? `<em>${r.sub}</em>` : ''}${r.count != null ? `<span class="fb"><i style="width:${(100 * r.count / mx).toFixed(1)}%;background:${col}"></i></span>` : ''}</span><span class="ct">${r.count != null ? fmt(r.count) : ''}</span>`;
      b.onclick = () => onClick(r.key); li.appendChild(b); ul.appendChild(li);
    });
    if (mode === 'pick' && any) ul.classList.add('filtering');
    sec.appendChild(ul); return ul;
  }
  // segmented switch
  function seg(sec, opts, value, onChange) {
    const d = document.createElement('div'); d.className = 'seg';
    opts.forEach(([v, l]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = l; b.setAttribute('aria-pressed', v === value); b.onclick = () => onChange(v); d.appendChild(b); });
    sec.appendChild(d); return d;
  }
  // neighborhood picker inside a panel section
  function nbPick(sec, value, onSel, label = 'All neighborhoods') {
    const s = document.createElement('select'); s.className = 'fsel'; s.setAttribute('aria-label', 'Neighborhood'); sec.appendChild(s);
    nbSelect(s, onSel, value, label); return s;
  }
  // on phones the panel collapses behind a "Filters" button
  function phoneToggle(panel) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ftoggle'; b.textContent = 'Filters';
    b.onclick = () => panel.classList.toggle('collapsed'); panel.prepend(b);
  }

  // sequential color for a value in [0,1]
  const SEQ = ['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7'];
  const seqVar = t => `var(${SEQ[Math.max(0, Math.min(6, Math.floor(t * 7)))]})`;
  // breaks = [low, high]; the top swatch gets a "+" only when values run past `high` (open = true)
  function seqLegend(el, breaks, fmtf, label, open = true) {
    el.innerHTML = `<span>${label}</span>` + SEQ.map((s, i) => `<span><i style="background:var(${s})"></i>${i === 0 ? fmtf(breaks[0]) : i === 6 ? fmtf(breaks[1]) + (open ? '+' : '') : ''}</span>`).join('');
  }
  // Seven equal-count classes, so each color holds about the same number of areas and differences across most of
  // the city stay visible even when a few places are far above the rest. classes(values) -> { color(v), edges }
  function classes(vals) {
    const v = vals.filter(x => x != null && isFinite(x)).sort(d3.ascending);
    const q = d3.scaleQuantile().domain(v).range(d3.range(7));
    return { color: x => x == null ? 'var(--none)' : `var(${SEQ[q(x)]})`, edges: [v[0], ...q.quantiles(), v[v.length - 1]] };
  }
  // legend for classes(): a stepped bar with the value where each color starts, and a swatch for areas with no value
  function stepLegend(el, edges, fmtf, none) {
    el.innerHTML = '<div class="steps">' + SEQ.map((s, i) => `<span><i style="background:var(${s})"></i><em>${fmtf(edges[i])}</em></span>`).join('')
      + `<span class="end"><em>${fmtf(edges[7])}</em></span></div>` + (none ? `<span class="nonekey"><i style="background:var(--none)"></i>${none}</span>` : '');
  }
  // compact numbers for legends: 950, 1.3k, 12k
  const short = v => v >= 1000 ? d3.format('.2~s')(v).replace('G', 'B') : fmtRate(v);

  // ---------- small chart helpers ----------
  function frame(el, { h = 260, m = { t: 12, r: 16, b: 28, l: 44 } } = {}) {
    const W = Math.max(320, el.clientWidth || 600); // never narrower than a phone, even if drawn while hidden
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
  const doyISO = (d, y = YEAR) => doyTime(d, y).toISOString().slice(0, 10);
  // first doy of each month (only months that start on or before `last`, if given)
  const monthStarts = (y = YEAR, last = 400) => d3.range(12).map(m => (Date.UTC(y, m, 1) - Date.UTC(y, 0, 1)) / 864e5).filter(d => d <= last);
  // month labels for a time axis: every month when there's room, every other month on narrow charts,
  // and never one that would run off the right edge. starts: first doy of each month; x: doy -> px
  const monthTicks = (starts, x, iw) => {
    const step = iw / Math.max(1, starts.length) < 34 ? 2 : 1;
    return starts.map((d, i) => ({ x: x(d), label: months[i], i })).filter(t => t.i % step === 0 && t.x + 22 <= iw);
  };
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

  // ---------- one chart per page ----------
  // views([{ id, label, cls, draw(el, first) }]): the #view dropdown picks a chart, drawn into its own pane in #chart.
  // Filter controls carry data-for="viewId viewId ..." and only show for those charts.
  // The chosen chart is kept in the URL hash, so a link can open a specific chart.
  // The URL hash holds the chart and its filters: #view&key=value&... so a link opens exactly what you see.
  function hashState() {
    const [view, ...kv] = location.hash.slice(1).split('&'), o = { view };
    kv.forEach(p => { const [k, v] = p.split('='); if (k) o[k] = decodeURIComponent(v || ''); });
    return o;
  }
  // views(list, { state, ds }) -- list: [{ id, label, cls, keep, draw(el, first), csv() -> rows, ds: [id, name] }]
  // state() returns the page's filters that differ from their defaults; they're written into the link.
  function views(list, opts = {}) {
    const sel = document.getElementById('view'), host = document.getElementById('chart');
    const bar = sel.parentNode;
    const tools = document.createElement('div'); tools.className = 'tools';
    const linkB = document.createElement('button'); linkB.className = 'btn'; linkB.type = 'button'; linkB.textContent = 'Copy link';
    const csvB = document.createElement('button'); csvB.className = 'btn'; csvB.type = 'button'; csvB.textContent = 'Download CSV';
    tools.append(linkB, csvB); (document.querySelector('.src') || bar).after(tools);
    const panes = {}, drawn = new Set(); let cur = null;
    list.forEach(v => {
      const o = document.createElement('option'); o.value = v.id; o.textContent = v.label; sel.appendChild(o);
      const p = document.createElement('div'); p.className = 'pane ' + (v.cls || 'card'); p.hidden = true; host.appendChild(p); panes[v.id] = p;
    });
    const writeHash = () => {
      const st = opts.state ? opts.state() : {};
      const kv = Object.entries(st).filter(([, v]) => v != null && v !== '').map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
      history.replaceState(null, '', '#' + cur.id + kv);
    };
    // footer "Data:" link goes to the City dataset behind the chart on screen
    const dataLink = document.getElementById('dataLink');
    const setDataLink = () => { const ds = cur.ds || opts.ds; if (!dataLink || !ds) return; dataLink.href = 'https://data.nola.gov/d/' + ds[0]; dataLink.textContent = ds[1] + ' on data.nola.gov'; };
    const draw = () => { cur.draw(panes[cur.id], !drawn.has(cur.id)); drawn.add(cur.id); csvB.hidden = !cur.csv; setDataLink(); writeHash(); };
    function show(id) {
      cur = list.find(v => v.id === id) || list[0]; sel.value = cur.id;
      Object.entries(panes).forEach(([k, p]) => p.hidden = k !== cur.id);
      document.querySelectorAll('[data-for]').forEach(el => el.hidden = !el.dataset.for.split(' ').includes(cur.id));
      tip.hide(); draw();
    }
    sel.onchange = () => show(sel.value);
    // a link with filters opened on this same page (only the hash changes) reloads, so its filters apply;
    // the pages' own jumps between views set a bare view id and keep the current filters
    addEventListener('hashchange', () => {
      const h = hashState(), st = opts.state ? opts.state() : {};
      const want = Object.entries(h).filter(([k]) => k !== 'view'), have = Object.entries(st).filter(([, v]) => v != null && v !== '');
      if (want.length && (want.length !== have.length || want.some(([k, v]) => String(st[k]) !== v))) return location.reload();
      show(h.view);
    });
    let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!cur.keep) draw(); }, 150); });
    linkB.onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); linkB.textContent = 'Link copied'; }
      catch (e) { prompt('Copy this link:', location.href); }
      setTimeout(() => linkB.textContent = 'Copy link', 1600);
    };
    csvB.onclick = () => {
      const rows = cur.csv(); if (!rows || !rows.length) return;
      const keys = Object.keys(rows[0]);
      const cell = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const text = [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
      a.download = `${location.pathname.split('/').pop().replace('.html', '') || 'index'}-${cur.id}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    show(hashState().view);
    return { refresh: draw, get id() { return cur.id; } };
  }
  const legendHTML = items => '<div class="legend">' + items.map(([c, l, round]) => `<span><i style="background:${c}${round ? ';border-radius:50%' : ''}"></i>${l}</span>`).join('') + '</div>';

  return { css, S, fmt, pct, tip, row, setGeo, views, hashState, legendHTML, stage, fsec, flist, seg, nbPick, phoneToggle, popOf, perK, fmtRate, POP_NOTE, basisChips, shown, nbList, nbSelect, lonlat, get FULL() { return FULL; }, get GEO() { return GEO; }, map, mapButtons, seqVar, seqLegend, classes, stepLegend, short, frame, yGrid, chips, months, monthsLong,
    setYear, get YEAR() { return YEAR; }, monthTicks, doyTime, doyDate, doyISO, doyMonth, monthStarts, isoDate, share, numWord, cap, setText, setHTML, title };
})();
