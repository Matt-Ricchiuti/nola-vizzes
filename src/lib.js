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
      x = Math.max(8, x); y = Math.max(8, Math.min(y, innerHeight - h - 8)); // a tall tooltip stays on screen
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
  const fmtRate = v => v == null ? '—' : v === 0 ? '0' : v >= 100 ? d3.format(',')(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
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

  // map(el, opts) -> {svg, layer, zoomTo, setFill, focus, k()}
  // The map fills el. It keeps clear of an on-map filter panel (o.panel) when fitting, and carries its own
  // zoom controls, scale bar and street-name labels.
  // Input: the mouse wheel (or trackpad pinch) zooms and dragging pans; the page never scrolls under the map.
  // On touch screens one finger scrolls the page and two fingers move and zoom the map (see stage()).
  // The map follows its box when the page is resized: one unit is one CSS pixel once the map is over 1000px wide
  // (narrower maps scale down, as before), so text and dots keep their size on wide screens.
  let mapN = 0;
  function map(el, o) {
    el.classList.add('map');
    const dims = () => { const cw = el.clientWidth, ch = el.clientHeight, w = Math.max(1000, Math.round(cw));
      return [w, Math.round(w * (ch > 50 && cw > 0 ? ch / cw : (o.height || 640) / 1000))]; };
    let [W, H] = dims();
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
    // the hovered neighborhood's outline, drawn over the streets and its neighbors' fills (an outline only, so the
    // streets and shading underneath stay visible)
    const hoverP = root.append('path').attr('class', 'nbhover').style('pointer-events', 'none').attr('d', null);
    const focusG = root.append('g').style('pointer-events', 'none');
    if (o.districts) root.append('g').selectAll('path').data(GEO.pd).join('path').attr('d', f => f.d)
      .attr('fill', 'none').attr('stroke', 'var(--ink2)').attr('stroke-width', 1.4).attr('vector-effect', 'non-scaling-stroke').attr('opacity', .55).style('pointer-events', 'none');
    const stLabG = root.append('g').attr('aria-hidden', 'true');
    const layer = root.append('g');
    // o.tip(i) can return nothing (a map whose own marks carry the tooltips): then hovering a neighborhood shows nothing
    const unhover = () => { tip.hide(); hoverP.datum(null).attr('d', null); };
    if (o.tip) nbSel.on('mousemove', (ev, f) => { const h = o.tip(f.idx); if (!h) return unhover(); tip.show(h, ev); if (hoverP.datum() !== f) hoverP.datum(f).attr('d', f.d); })
      .on('mouseleave', unhover);

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
    let k = 1, lt = 0, moved = false, target = null; const listeners = [];
    const scaleEl = document.createElement('div'); scaleEl.className = 'scalebar'; scaleEl.innerHTML = '<span></span><i></i>'; el.appendChild(scaleEl);
    function drawScale() {
      const pxPerMile = 80.47 * k * (el.clientWidth || W) / W, opts = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]; let m = opts[0];
      for (const v of opts) if (v * pxPerMile <= 110) m = v;
      scaleEl.lastChild.style.width = (m * pxPerMile).toFixed(0) + 'px';
      scaleEl.firstChild.textContent = m < 1 ? (m * 5280 >= 1000 ? m + ' mi' : Math.round(m * 5280) + ' ft') : m + ' mi';
    }
    // the opening view is about k = 0.45; allow zooming out far enough to see the whole parish, east marsh included
    const zoom = d3.zoom().scaleExtent([0.25, 40])
      // touch: only two-finger gestures move the map, so one finger still scrolls the page (touch-action in lib.css);
      // in full screen there's no page to scroll, so one finger moves the map too
      .filter(ev => ev.type.startsWith('touch') ? ev.touches.length >= 2 || !!el.closest('.mapfs') : (!ev.ctrlKey || ev.type === 'wheel') && !ev.button)
      .on('zoom', ev => {
        if (ev.sourceEvent) moved = true; // the reader moved the map, so a resize keeps their view instead of refitting
        root.attr('transform', ev.transform); k = ev.transform.k; streetZoom(k); drawScale();
        stLabG.selectAll('text').style('font-size', d => (d.fs / k) + 'px').style('stroke-width', (3 / k) + 'px');
        listeners.forEach(f => f(k)); clearTimeout(lt); lt = setTimeout(layoutLabels, 90);
      });
    svg.call(zoom).on('dblclick.zoom', null);
    // Safari's trackpad pinch arrives as gesture events rather than ctrl+wheel; zoom the map instead of the page
    // (on iPhone/iPad the same events come with two-finger touches, which d3 already handles)
    let gk = 1, touching = false;
    el.addEventListener('touchstart', e => { touching = true; }, { passive: true });
    const untouch = e => { touching = e.touches.length > 0; };
    el.addEventListener('touchend', untouch, { passive: true }); el.addEventListener('touchcancel', untouch, { passive: true });
    el.addEventListener('gesturestart', e => { e.preventDefault(); gk = k; });
    el.addEventListener('gesturechange', e => { e.preventDefault(); if (touching) return; moved = true;
      const r = svg.node().getBoundingClientRect(); svg.call(zoom.scaleTo, gk * e.scale, [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]); });
    // fit an extent into the part of the map the filter panel doesn't cover
    const inset = () => panelInset(o.panel, el.clientWidth) * W / Math.max(1, el.clientWidth);
    function zoomTo(ext, dur = 0) {
      const [x0, y0, x1, y1] = ext; target = ext; moved = false;
      const L = inset(), s = Math.min((W - L) / (x1 - x0), H / (y1 - y0)) * 0.96;
      const tr = d3.zoomIdentity.translate(L + (W - L) / 2, H / 2).scale(s).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      (dur ? svg.transition().duration(dur) : svg).call(zoom.transform, tr);
    }
    const home = o.extent || FULL;
    let focused = -1;
    const by = f => () => { moved = true; svg.transition().duration(250).call(zoom.scaleBy, f); };
    // entering or leaving full screen resizes the map: fit() refits it (or keeps the reader's view) and places labels again
    mapButtons(el, { zoomIn: by(1.7), zoomOut: by(1 / 1.7), reset: () => api.focus(focused), onFull: () => { fit(); drawScale(); layoutLabels(); } });
    zoomTo(home); drawScale(); layoutLabels();
    // follow the map's box (window resizes, the page's scrollbar appearing, rotating a phone): an untouched map is
    // refitted to what it was showing; one the reader has moved keeps its center and scale
    const fit = () => {
      if (!el.clientWidth || !el.clientHeight) return;
      const [nw, nh] = dims(); if (nw === W && nh === H) return;
      const t = d3.zoomTransform(svg.node()), c = t.invert([W / 2, H / 2]);
      W = nw; H = nh; svg.interrupt().attr('viewBox', `0 0 ${W} ${H}`);
      if (!moved && target) zoomTo(target);
      else svg.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(t.k).translate(-c[0], -c[1]));
      drawScale();
    };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(el);
    addEventListener('resize', fit);
    const api = {
      svg, layer, nbSel, zoomTo, k: () => k, onZoom: f => listeners.push(f), home,
      // shade neighborhoods (fn(i) -> a color, or null for the plain land color); on a shaded map the streets are
      // drawn in the page's surface color, so they stay visible over the darkest and lightest shades alike
      setFill(fn) { let any = false; nbSel.each(function (f) { const c = fn(f.idx) || null; if (c) any = true; this.style.fill = c || ''; if (c) this.setAttribute('fill', c); else this.removeAttribute('fill'); }); svg.classed('shaded', any); },
      // outline one neighborhood and zoom to it (-1: clear and go back to the whole mapped city)
      focus(i, dur = 450) {
        focused = i;
        focusG.selectAll('path').data(i >= 0 ? [GEO.nb[i]] : []).join('path').attr('d', f => f.d).attr('class', 'nbfocus');
        zoomTo(i >= 0 ? pad(GEO.nb[i].bbox, 0.25) : home, dur);
      }
    };
    return api;
  }
  // how far (CSS px) the floating filter panel reaches into a map `mapW` px wide, so fits keep clear of it.
  // 0 when the panel isn't floating, is folded away, or covers most of a narrow map (phones in full screen).
  function panelInset(panel, mapW) {
    if (!panel || !panel.childElementCount || getComputedStyle(panel).position !== 'absolute') return 0;
    const w = panel.offsetWidth; return w && w < mapW / 2 ? w + 24 : 0;
  }

  // ---------- map controls: full screen, zoom in, zoom out, reset ----------
  const ico = d => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
  const ICON = {
    full: ico('M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5'),
    exit: ico('M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5'),
    plus: ico('M12 5v14M5 12h14'),
    minus: ico('M5 12h14'),
    reset: ico('M4.6 13.5A7.6 7.6 0 1 0 6.6 6.6M6.6 2.4v4.2h4.2') // circular arrow, back to the opening view
  };
  const D = document, fsElement = () => D.fullscreenElement || D.webkitFullscreenElement || null;
  // mapButtons(host, { zoomIn, zoomOut, reset, onFull(on) }) adds the control stack to a map's box (host) and returns it.
  // Full screen takes the map's whole stage (filter panel, legend, scale bar, controls) with the Fullscreen API, or,
  // where that isn't offered (iPhone Safari) or is refused, a fixed layer over the page with the page's scroll locked.
  // Esc and the browser's own exit keep the button in step. onFull runs once the new size has settled.
  function mapButtons(host, { zoomIn, zoomOut, reset, onFull } = {}) {
    if (!host) return null;
    const box = host.closest('.stage') || host;
    const ctl = D.createElement('div'); ctl.className = 'mapctl';
    const add = (icon, label, fn) => { const b = D.createElement('button'); b.type = 'button'; b.innerHTML = icon; b.title = label; b.setAttribute('aria-label', label); b.onclick = fn; ctl.appendChild(b); return b; };
    let mode = null, sy = 0; // mode: 'api' | 'css' | null
    const fsb = add(ICON.full, 'Full screen', () => (mode ? exit() : enter()));
    fsb.setAttribute('aria-pressed', 'false'); fsb.classList.add('fsbtn');
    if (zoomIn) add(ICON.plus, 'Zoom in', zoomIn);
    if (zoomOut) add(ICON.minus, 'Zoom out', zoomOut);
    if (reset) add(ICON.reset, 'Reset view', reset);
    host.appendChild(ctl);
    const settle = on => { let n = 0; const go = () => { if (onFull) onFull(on); if (++n < 3) requestAnimationFrame(go); }; requestAnimationFrame(go); };
    const onKey = e => { if (e.key === 'Escape' && mode === 'css' && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) { e.preventDefault(); exit(); } };
    function show(on) {
      box.classList.toggle('mapfs', on); box.classList.toggle('mapfs-css', on && mode === 'css');
      D.documentElement.classList.toggle('mapfs-lock', on && mode === 'css');
      fsb.innerHTML = on ? ICON.exit : ICON.full; fsb.setAttribute('aria-pressed', on); fsb.title = on ? 'Exit full screen (Esc)' : 'Full screen';
      // the tooltip has to live inside the full-screen layer to be seen there
      tip.hide(); (on ? box : D.body).appendChild(tipEl);
      if (on) D.addEventListener('keydown', onKey); else { D.removeEventListener('keydown', onKey); mode = null; if (Math.abs(scrollY - sy) > 1) scrollTo(scrollX, sy); }
      settle(on);
    }
    function css() { mode = 'css'; show(true); }
    function enter() {
      sy = scrollY;
      const req = box.requestFullscreen || box.webkitRequestFullscreen;
      if (!(D.fullscreenEnabled || D.webkitFullscreenEnabled) || !req) return css();
      mode = 'api';
      let p; try { p = req.call(box, { navigationUI: 'hide' }); } catch (e) { return css(); }
      if (p && p.catch) p.catch(failed);
      // a browser that neither enters nor refuses (some embedded views leave the request hanging) gets the fallback
      setTimeout(failed, 1200);
    }
    function exit() {
      if (mode === 'api' && fsElement() === box) (D.exitFullscreen || D.webkitExitFullscreen).call(D);
      else if (mode) show(false);
    }
    const changed = () => { const on = fsElement() === box;
      if (on && (mode !== 'api' || !box.classList.contains('mapfs'))) { mode = 'api'; show(true); } // (also a late success after the fallback took over)
      else if (!on && mode === 'api' && box.classList.contains('mapfs')) show(false); };
    const failed = () => { if (mode === 'api' && fsElement() !== box) css(); }; // older Safari reports a refusal by event, not a promise
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(t => D.addEventListener(t, changed));
    ['fullscreenerror', 'webkitfullscreenerror'].forEach(t => D.addEventListener(t, failed));
    return ctl;
  }

  // ---------- filters on the chart ----------
  // stage(el, { map }) turns a view's pane into a filter panel + plot area. On maps the panel floats over the map,
  // and the section holding the map spans the window (see .vsec.wide in lib.css).
  function stage(el, { map: isMap = false, open = false } = {}) {
    el.classList.add('stage', isMap ? 'mapstage' : 'chartstage');
    el.innerHTML = '<div class="fpanel"></div><div class="plot"></div>';
    const panel = el.firstChild, plot = el.lastChild;
    if (isMap) { // on phones the map's filters fold away behind a button, so the map shows first
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ftoggle'; b.textContent = 'Filters';
      if (open) b.textContent = 'Hide filters'; else panel.classList.add('collapsed');
      b.onclick = () => { panel.classList.toggle('collapsed'); b.textContent = panel.classList.contains('collapsed') ? 'Filters' : 'Hide filters'; };
      el.insertBefore(b, panel);
      const sec = el.closest('.vsec'); if (sec) sec.classList.add('wide');
      lockInput(panel, plot);
    }
    return { panel, plot };
  }
  // Keep input over a map in the map. The wheel over the map belongs to the map (each map zooms on it), even at the
  // zoom limits, where it would otherwise fall through and scroll the page. The floating filter panel scrolls itself
  // and stops at its ends instead of handing the scroll on to the page. On touch screens one finger scrolls the page
  // and two fingers move the map (each map does the moving); a one-finger swipe over the map shows a short hint.
  function lockInput(panel, plot) {
    plot.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    panel.addEventListener('wheel', e => {
      if (e.ctrlKey || getComputedStyle(panel).position !== 'absolute') return; // page zoom; phones: the panel is part of the page
      for (let n = e.target; n && n !== panel.parentNode; n = n.parentNode) {
        if (n.nodeType !== 1 || n.scrollHeight <= n.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(n).overflowY)) continue;
        if (e.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return; // this box can still scroll
      }
      e.preventDefault();
    }, { passive: false });
    let y0 = null, two = false, ht = 0;
    plot.addEventListener('touchstart', e => { two = e.touches.length > 1; y0 = two ? null : [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
    plot.addEventListener('touchmove', e => {
      if (two || !y0 || e.touches.length !== 1 || plot.closest('.mapfs')) return; // in full screen one finger moves the map
      const t = e.touches[0]; if (Math.hypot(t.clientX - y0[0], t.clientY - y0[1]) < 12) return; y0 = null;
      let h = plot.querySelector(':scope>.maphint');
      if (!h) { h = document.createElement('div'); h.className = 'maphint'; h.setAttribute('aria-hidden', 'true'); h.textContent = 'Use two fingers to move the map'; plot.appendChild(h); }
      h.classList.add('on'); clearTimeout(ht); ht = setTimeout(() => h.classList.remove('on'), 1400);
    }, { passive: true });
  }
  // the page's scrollbar width, so full-width sections (lib.css) span the window without a sideways scroll
  const setSbw = () => document.documentElement.style.setProperty('--sbw', Math.max(0, innerWidth - document.documentElement.clientWidth) + 'px');
  if (window.ResizeObserver) new ResizeObserver(setSbw).observe(document.documentElement);
  addEventListener('resize', setSbw); setSbw();
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
      b.title = String(r.name).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&') + (r.sub ? ' · ' + String(r.sub).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&') : ''); // the full name, in case it's cut short
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
  // ftabs(panel, [[value, label], ...], value, onChange): a tab row at the very top of a filter panel, for one chart
  // section that switches between closely related charts of the same data (e.g. two maps). Returns the row.
  function ftabs(panel, opts, value, onChange) {
    const d = document.createElement('div'); d.className = 'ftabs' + (opts.length > 3 ? ' grid' : ''); d.setAttribute('role', 'tablist'); // four or more: two per row
    opts.forEach(([v, l]) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = l; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', v === value); b.onclick = () => { if (v !== value) onChange(v); }; d.appendChild(b);
    });
    panel.prepend(d); return d;
  }
  // mapChecks(plot, [{ key, label, checked, disabled, title, onChange(checked) }, ...]): a small box of checkboxes on
  // the map, bottom right just above the scale bar (under the zoom buttons on phones), for map options such as
  // "Per 1k residents". Items that are null or false are left out; an empty list hides the box. Call it on every
  // redraw with the current state: rows are matched by key, so they keep their place (and keyboard focus).
  function mapChecks(plot, items) {
    items = (items || []).filter(Boolean);
    let box = plot.querySelector(':scope>.mapchecks');
    if (!items.length) { if (box) box.hidden = true; return box; }
    if (!box) { box = document.createElement('div'); box.className = 'mapchecks'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Map options'); plot.appendChild(box); }
    box.hidden = false;
    const old = new Map([...box.children].map(l => [l.dataset.key, l]));
    items.forEach(it => {
      let l = old.get(it.key); old.delete(it.key);
      if (!l) { l = document.createElement('label'); l.dataset.key = it.key; l.innerHTML = '<input type="checkbox"><span></span>'; }
      box.appendChild(l); // in the order given
      const cb = l.firstChild; l.lastChild.textContent = it.label;
      cb.checked = !!it.checked; cb.disabled = !!it.disabled; l.classList.toggle('off', !!it.disabled);
      if (it.title) l.title = it.title; else l.removeAttribute('title');
      cb.onchange = () => it.onChange && it.onChange(cb.checked);
    });
    old.forEach(l => l.remove());
    return box;
  }
  // a key that isn't a filter: rows of [label, color (a square swatch; null leaves the space), value] inside a panel
  // section. A color starting with '|' draws a tick mark in that color instead of a square.
  function kv(sec, rows) {
    const d = document.createElement('div'); d.className = 'kvl';
    d.innerHTML = rows.map(([l, c, n]) => `<span>${!c ? '<i></i>' : c[0] === '|' ? `<i class="tick" style="background:${c.slice(1)}"></i>` : `<i style="background:${c}"></i>`}${l}<b>${n}</b></span>`).join('');
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
    el.innerHTML = (label ? `<span>${label}</span>` : '') + `<span>${fmtf(breaks[0])}</span><span style="gap:0">` + SEQ.map(s => `<i style="background:var(${s});border-radius:0"></i>`).join('') + '</span>' + `<span>${fmtf(breaks[1])}${open ? '+' : ''}</span>`;
  }
  // Up to seven equal-count classes, so each color holds about the same number of areas and differences across most
  // of the city stay visible even when a few places are far above the rest. classes(values, { even }) -> { color(v), edges, shades }
  // Class edges are round numbers where that's possible without changing the picture: each edge moves to the roundest
  // nearby number (…, 10, 20, 50, 100, …, or 0.5, 0.2, 0.1 steps) only if that moves at most one area to the next color
  // (and stays well clear of the neighboring edges), so classes stay close to equal-count; otherwise it keeps a finer value. Counts (whole numbers) only get
  // whole-number edges. Edges are what the colors use, so the legend is exact. Classes that would hold nothing are
  // dropped and the rest spread over the full ramp. { even: true } uses evenly spaced round edges instead (d3 ticks).
  const STEPS = d3.range(-3, 7).flatMap(e => [1, 2, 5].map(m => +(m * 10 ** e).toPrecision(1))).sort((a, b) => b - a); // 5e6 … 0.001
  const roundTo = (t, s) => +(Math.round(t / s) * s).toPrecision(12);
  function classes(vals, { even = false } = {}) {
    const v = vals.filter(x => x != null && isFinite(x)).sort(d3.ascending);
    if (!v.length) return { color: () => 'var(--none)', edges: [], shades: [] };
    const lo = v[0], hi = v[v.length - 1], int = v.every(Number.isInteger);
    let th;
    if (even) th = d3.ticks(lo, hi, 7).filter(t => t > lo && t <= hi);
    else {
      th = d3.scaleQuantile().domain(v).range(d3.range(7)).quantiles();
      if (int) th = th.map(Math.ceil); // for whole numbers, x >= t exactly when x >= ceil(t)
      th = [...new Set(th)].filter(t => t > lo && t <= hi);
      // round each edge as far as it can go while at most one area changes color and it stays well inside its neighbors
      const crossing = (a, b) => { const x0 = Math.min(a, b), x1 = Math.max(a, b); return d3.bisectLeft(v, x1) - d3.bisectLeft(v, x0); };
      th = th.map((t, i) => {
        const room = 0.5 * Math.min(t - (i ? th[i - 1] : lo), (i < th.length - 1 ? th[i + 1] : hi) - t);
        const s = STEPS.find(s => { const r = roundTo(t, s); return (!int || s >= 1) && Math.abs(r - t) <= room && crossing(t, r) <= 1; });
        return s ? roundTo(t, s) : t;
      });
    }
    th = [...new Set(th)].filter(t => t > lo && t <= hi).sort(d3.ascending);
    // drop an edge whose class would be empty (merge it into the class below)
    for (let i = th.length - 1; i >= 0; i--) { const top = i < th.length - 1 ? th[i + 1] : Infinity; if (!v.some(x => x >= th[i] && x < top)) th.splice(i, 1); }
    const k = th.length + 1, shades = d3.range(k).map(i => SEQ[k === 1 ? 3 : Math.round(i * 6 / (k - 1))]);
    // the legend's first label: the lowest value, or a round number just under it (nothing lies between the two)
    const room0 = 0.3 * ((th[0] ?? hi) - lo), s0 = STEPS.find(s => (!int || s >= 1) && lo - Math.floor(lo / s) * s <= room0 && Math.floor(lo / s) * s >= 0);
    const first = s0 ? +(Math.floor(lo / s0) * s0).toPrecision(12) : lo;
    return { color: x => x == null ? 'var(--none)' : `var(${shades[d3.bisectRight(th, x)]})`, edges: [first, ...th, hi], shades };
  }
  // legend for classes(): a stepped bar with the value where each color starts (the top one "and up"), and a swatch
  // for areas with no value. cl is what classes() returned (an older caller may pass its seven-class edges array)
  function stepLegend(el, cl, fmtf, none) {
    const edges = Array.isArray(cl) ? cl : cl.edges, shades = Array.isArray(cl) ? SEQ : cl.shades, n = shades.length;
    el.innerHTML = (n ? '<div class="steps">' + shades.map((s, i) => `<span><i style="background:var(${s})"></i><em>${fmtf(edges[i])}${i === n - 1 && n > 1 ? '+' : ''}</em></span>`).join('') + '</div>' : '')
      + (none ? `<span class="nonekey"><i style="background:var(--none)"></i>${none}</span>` : '');
    // labels that would run into each other (a narrow legend): show every other one, always the first and last
    // (checked again once the web fonts have loaded, since they set the labels' widths)
    const ems = [...el.querySelectorAll('.steps em')];
    const thin = () => { const r = ems.map(e => e.getBoundingClientRect());
      if (r.some((b, i) => i && b.width && b.left < r[i - 1].right + 3)) ems.forEach((e, i) => { if (i % 2 && i < ems.length - 1) e.style.visibility = 'hidden'; }); };
    thin(); if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(thin);
  }
  // compact numbers for legends, exact to the value given (class edges are already round): 0, 3, 8.4, 0.05, 950, 1.25k, 12k
  const short = v => v >= 1000 ? d3.format('.3~s')(v).replace('G', 'B') : String(+(+v).toPrecision(4));

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

  // ---------- one subject per page: a row of tabs, one per chart ----------
  // The URL hash holds the open chart and the page's filters: #chartId&key=value&... so a link opens
  // that chart with exactly those filters.
  function hashState() {
    const [view, ...kv] = location.hash.slice(1).split('&'), o = { view };
    kv.forEach(p => { const [k, v] = p.split('='); if (k) o[k] = decodeURIComponent(v || ''); });
    return o;
  }
  // views(list, { state, ds }) -- list: [{ id, label, tab, cls, keep, draw(el, first), ds: [id, name] or () => [id, name] }]
  // A bar at the top of #chart holds a tab per chart (`tab`, or `label`) and Copy link / Download CSV for the open one.
  // Download CSV links to the open chart's City dataset on data.nola.gov (its export is there): the view's `ds`, which
  // can be a function of the filters when one chart switches between datasets, else the page's `opts.ds`.
  // Below it, each chart is its own section (heading `label`, then the chart); only the open one shows.
  // `label` can be a function, for a chart whose subject follows its filters; the heading is set again on each draw
  // (give such a chart a `tab`). Redrawing keeps the filter panel's scroll and the page's, so a click low in a long
  // panel doesn't jump it back to the top.
  // With a single chart there are no tabs: its heading takes their place in the bar.
  // Filters are shared page state: refresh() redraws the open chart, and the others redraw when next opened.
  // state() returns the filters that differ from their defaults; they're written into the link.
  // A page can open a chart with location.hash = 'chartId'.
  function views(list, opts = {}) {
    const host = document.getElementById('chart');
    const panes = {}, secs = {}, tabs = {}, drawn = new Set(), stale = new Set();
    const stateKV = () => {
      const st = opts.state ? opts.state() : {};
      return Object.entries(st).filter(([, v]) => v != null && v !== '').map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
    };
    const h0 = hashState().view;
    let cur = list.find(v => v.id === h0) || list[0];
    const linkFor = () => location.href.split('#')[0] + '#' + cur.id + stateKV();
    const writeHash = () => history.replaceState(null, '', '#' + cur.id + stateKV());
    const btn = t => { const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = t; return b; };
    // the bar: tabs, then the open chart's Copy link / Download CSV
    const bar = document.createElement('div'); bar.className = 'vbar';
    const tabRow = document.createElement('div'); tabRow.className = 'vtabs'; tabRow.setAttribute('role', 'tablist'); tabRow.setAttribute('aria-label', 'Charts');
    const tools = document.createElement('div'); tools.className = 'tools';
    const linkB = btn('Copy link'), csvB = document.createElement('a');
    csvB.className = 'btn'; csvB.textContent = 'Download CSV'; csvB.target = '_blank'; csvB.rel = 'noopener';
    const dsOf = v => (typeof v.ds === 'function' ? v.ds() : v.ds) || opts.ds;
    const setDs = () => { const d = dsOf(cur); csvB.href = 'https://data.nola.gov/d/' + d[0]; csvB.title = `Open the ${d[1]} dataset on data.nola.gov`; };
    linkB.onclick = async () => {
      writeHash(); const url = linkFor();
      try { await navigator.clipboard.writeText(url); linkB.textContent = 'Link copied'; }
      catch (e) { prompt('Copy this link:', url); }
      setTimeout(() => linkB.textContent = 'Copy link', 1600);
    };
    tools.append(linkB, csvB);
    // a page with a single chart has no tabs: the bar holds that chart's heading instead
    const one = list.length === 1;
    if (one) bar.classList.add('one');
    bar.append(one ? document.createElement('h2') : tabRow, tools); host.appendChild(bar);
    const labelOf = v => typeof v.label === 'function' ? v.label() : v.label, heads = {};
    list.forEach(v => {
      const t = document.createElement('button'); t.type = 'button'; t.textContent = v.tab || labelOf(v);
      t.id = 'vt-' + v.id; t.setAttribute('role', 'tab'); t.setAttribute('aria-controls', 'v-' + v.id);
      t.onclick = () => open(v.id); tabRow.appendChild(t); tabs[v.id] = t;
      const sec = document.createElement('section'); sec.className = 'vsec'; sec.id = 'v-' + v.id;
      const h = one ? bar.firstChild : document.createElement('h2'); h.textContent = labelOf(v); heads[v.id] = h;
      const p = document.createElement('div'); p.className = 'pane ' + (v.cls || 'card');
      if (one) { h.id = 'vh-' + v.id; sec.setAttribute('aria-labelledby', h.id); sec.append(p); }
      else {
        sec.setAttribute('role', 'tabpanel'); sec.setAttribute('aria-labelledby', 'vt-' + v.id);
        const head = document.createElement('div'); head.className = 'vsec-h'; head.appendChild(h); sec.append(head, p);
      }
      host.appendChild(sec); panes[v.id] = p; secs[v.id] = sec;
    });
    // footer "Data:" link goes to the page's City dataset
    const dataLink = document.getElementById('dataLink'), ds = opts.ds || (list.find(v => v.ds) || {}).ds;
    if (dataLink && ds) { dataLink.href = 'https://data.nola.gov/d/' + ds[0]; dataLink.textContent = ds[1] + ' on data.nola.gov'; }
    // charts are drawn only while shown (hidden ones have no size); a hidden chart whose filters changed redraws when opened
    // keyboard focus survives a redraw: the control with the same label (or in the same place) takes it back
    const focusKey = el => el.tagName + '|' + (el.getAttribute('aria-label') || (el.querySelector('.nm>span') || el).textContent.trim());
    const focusables = p => [...p.querySelectorAll('button,select,input,[tabindex]')];
    const drawOne = v => {
      const p = panes[v.id], fp = p.querySelector(':scope>.fpanel'), keep = [fp ? fp.scrollTop : 0, scrollX, scrollY];
      const a = document.activeElement, had = a && a !== document.body && p.contains(a) ? [focusKey(a), focusables(p).indexOf(a)] : null;
      if (typeof v.label === 'function') heads[v.id].textContent = v.label();
      v.draw(p, !drawn.has(v.id)); drawn.add(v.id); stale.delete(v.id);
      if (had && !p.contains(document.activeElement)) {
        const fs = focusables(p), t = fs.find(e => focusKey(e) === had[0]) || fs[Math.min(had[1], fs.length - 1)];
        if (t) t.focus({ preventScroll: true });
      }
      if (fp && fp.scrollTop !== keep[0]) fp.scrollTop = keep[0];
      if (scrollY !== keep[2] || scrollX !== keep[1]) scrollTo(keep[1], keep[2]);
    };
    const draw = () => { tip.hide(); list.forEach(v => { if (v !== cur && drawn.has(v.id)) stale.add(v.id); }); drawOne(cur); writeHash(); setDs(); setSbw(); };
    function show(v) {
      cur = v;
      list.forEach(x => { secs[x.id].hidden = x !== v; tabs[x.id].setAttribute('aria-selected', x === v); tabs[x.id].tabIndex = x === v ? 0 : -1; });
      setDs();
      if (!drawn.has(v.id) || stale.has(v.id)) drawOne(v);
      // on phones the tab row scrolls sideways: bring the open tab into view
      const r = tabRow.getBoundingClientRect(), t = tabs[v.id].getBoundingClientRect();
      if (t.left < r.left || t.right > r.right) tabRow.scrollLeft += t.left - r.left - 16;
    }
    function open(id, focusTab) {
      const v = list.find(x => x.id === id); if (!v) return;
      tip.hide(); if (v !== cur || !drawn.has(v.id)) show(v); writeHash();
      if (focusTab) tabs[id].focus();
      if (bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: 'start' }); // jumped here from further down the page
    }
    // arrow keys move between tabs
    tabRow.addEventListener('keydown', ev => {
      const i = list.indexOf(cur), n = list.length;
      const j = ev.key === 'ArrowRight' ? (i + 1) % n : ev.key === 'ArrowLeft' ? (i - 1 + n) % n : ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : -1;
      if (j >= 0) { ev.preventDefault(); open(list[j].id, true); }
    });
    // a link with filters opened on this same page (only the hash changes) reloads, so its filters apply;
    // the pages' own jumps to a chart set a bare chart id and keep the current filters
    addEventListener('hashchange', () => {
      const h = hashState(), st = opts.state ? opts.state() : {};
      const want = Object.entries(h).filter(([k]) => k !== 'view'), have = Object.entries(st).filter(([, v]) => v != null && v !== '');
      if (want.length && (want.length !== have.length || want.some(([k, v]) => String(st[k]) !== v))) return location.reload();
      if (list.some(v => v.id === h.view) && h.view !== cur.id) { list.forEach(x => { if (drawn.has(x.id)) stale.add(x.id); }); open(h.view); } else draw();
    });
    let rt, lastW = innerWidth;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => {
      if (innerWidth === lastW) return; lastW = innerWidth; // phones fire resize on scroll (address bar); only width matters
      list.forEach(v => { if (!v.keep && drawn.has(v.id)) { if (v === cur) drawOne(v); else stale.add(v.id); } });
    }, 150); });
    show(cur); writeHash();
    return { refresh: draw, open, get id() { return cur.id; } };
  }
  const legendHTML = items => '<div class="legend">' + items.map(([c, l, round]) => `<span><i style="background:${c}${round ? ';border-radius:50%' : ''}"></i>${l}</span>`).join('') + '</div>';

  return { css, S, fmt, pct, tip, row, setGeo, views, hashState, legendHTML, stage, fsec, flist, seg, ftabs, nbPick, kv, mapChecks, phoneToggle, popOf, perK, fmtRate, POP_NOTE, basisChips, shown, nbList, nbSelect, get FULL() { return FULL; }, get GEO() { return GEO; }, map, mapButtons, panelInset, seqVar, seqLegend, classes, stepLegend, short, frame, yGrid, chips, months, monthsLong,
    setYear, get YEAR() { return YEAR; }, monthTicks, doyTime, doyDate, doyISO, doyMonth, monthStarts, isoDate, share, numWord, cap, setText, setHTML, title };
})();
