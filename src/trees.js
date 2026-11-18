// Street trees page. The map is drawn on a canvas (106k points is too many for SVG).
(() => {
  const D = DATA.trees;
  const { fmt, tip, row } = NOLA;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COS = Math.cos(29.97 * Math.PI / 180);
  const N = D.x.length;
  // world coordinates: degrees, x scaled by cos(latitude), y grows southward
  const wx = new Float32Array(N), wy = new Float32Array(N);
  for (let i = 0; i < N; i++) { wx[i] = D.x[i] * 1e-5 * COS; wy[i] = -D.y[i] * 1e-5; }
  const toW = (lon, lat) => [(lon - D.lon0) * COS, -(lat - D.lat0)];

  // ---------- species groups: top 9, stumps, everything else ----------
  const TOP_COLORS = ['#d9418c', '#3a9a5b', '#c46a28', '#c23a3a', '#178f8f', '#7a68d8', '#d4a017', '#7f9a2e', '#3f7fd6'];
  const stumpIdx = D.species.findIndex(s => s[0] === 'Stump');
  const groups = [];
  for (let i = 0, ti = 0; i < D.species.length && groups.length < 9; i++) { if (i === stumpIdx) continue; groups.push({ name: D.species[i][0], sp: [i], color: TOP_COLORS[ti++], on: true }); }
  const topSet = new Set(groups.map(g => g.sp[0]));
  groups.push({ name: 'Stump', sp: [stumpIdx], colorVar: '--t-stump', on: true });
  groups.push({ name: 'All other species', sp: D.species.map((_, i) => i).filter(i => !topSet.has(i) && i !== stumpIdx), colorVar: '--t-other', on: true });
  const spGroup = new Int16Array(D.species.length);
  groups.forEach((g, gi) => g.sp.forEach(s => spGroup[s] = gi));
  groups.forEach(g => g.count = 0);
  for (let i = 0; i < N; i++) groups[spGroup[D.s[i]]].count++;
  groups.forEach(g => { g.idx = new Uint32Array(g.count); g.fill = 0; });
  for (let i = 0; i < N; i++) { const g = groups[spGroup[D.s[i]]]; g.idx[g.fill++] = i; }
  const drawOrder = [groups.length - 1, groups.length - 2, ...groups.slice(0, 9).map((_, i) => i)]; // rarer on top

  // ---------- neighborhoods ----------
  const hoods = D.hoods.map(h => {
    const p = new Path2D(); let best = null, bestA = -1;
    for (const poly of h.p) {
      for (const ring of poly) { ring.forEach(([lo, la], k) => { const [x, y] = toW(lo, la); k ? p.lineTo(x, y) : p.moveTo(x, y); }); p.closePath(); }
      const r = poly[0]; let a = 0, cx = 0, cy = 0, minx = 1e9, maxx = -1e9;
      for (let k = 0; k < r.length - 1; k++) { const [x0, y0] = toW(...r[k]), [x1, y1] = toW(...r[k + 1]); const c = x0 * y1 - x1 * y0; a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c; minx = Math.min(minx, x0); maxx = Math.max(maxx, x0); }
      if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = { x: cx / (3 * a), y: cy / (3 * a), w: maxx - minx }; }
    }
    return { name: h.n, path: p, c: best, n: 0, sp: new Map() };
  });
  for (let i = 0; i < N; i++) { const h = D.h[i]; if (h < 0) continue; const H = hoods[h]; H.n++; H.sp.set(D.s[i], (H.sp.get(D.s[i]) || 0) + 1); }
  const shapePath = (geoms, close) => { const p = new Path2D(); for (const g of geoms) for (const part of g) {
    if (close) { for (const ring of part) { ring.forEach(([lo, la], k) => { const [x, y] = toW(lo, la); k ? p.lineTo(x, y) : p.moveTo(x, y); }); p.closePath(); } }
    else part.forEach(([lo, la], k) => { const [x, y] = toW(lo, la); k ? p.lineTo(x, y) : p.moveTo(x, y); }); } return p; };
  const landPath = shapePath(D.land, true), lakePath = shapePath(D.lakes, true), waterPath = shapePath(D.water, true);

  // ---------- streets: the shared City centerline base map (streets.js), converted to this map's coordinates ----------
  const roadPaths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()]; // 0 freeway, 1 arterial, 2 local, 3 ramp
  const ST = window.STREETS;
  if (ST) {
    // shared grid: X = (lon + 90.14) * 4830 * q, Y = (30.20 - lat) * 5550 * q
    // so x' = (lon - lon0) * COS and y' = -(lat - lat0), matching toW()
    const M = new DOMMatrix([COS / (ST.q * 4830), 0, 0, 1 / (ST.q * 5550), (-90.14 - D.lon0) * COS, -(30.20 - D.lat0)]);
    [[0, 0], [2, 1], [3, 2], [1, 3]].forEach(([from, to]) => roadPaths[to].addPath(new Path2D(ST.d[from]), M));
  }
  // street-name labels: [x, y, angle, half-length, name index, tier] per anchor
  const AN = D.anchors.length / 6;
  const anX = new Float32Array(AN), anY = new Float32Array(AN), anA = new Float32Array(AN), anH = new Float32Array(AN), anN = new Uint16Array(AN), anT = new Uint8Array(AN);
  for (let i = 0; i < AN; i++) { const b = i * 6; anX[i] = D.anchors[b] * 1e-5 * COS; anY[i] = -D.anchors[b + 1] * 1e-5; anA[i] = -D.anchors[b + 2] * Math.PI / 180; anH[i] = D.anchors[b + 3]; anN[i] = D.anchors[b + 4]; anT[i] = D.anchors[b + 5]; }
  const anOrder = [...Array(AN).keys()].sort((a, b) => anT[a] - anT[b] || anH[b] - anH[a]);
  const widthCache = new Map();

  // ---------- spatial grid for hover ----------
  const CELL = 0.0012; let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (let i = 0; i < N; i++) { if (wx[i] < gx0) gx0 = wx[i]; if (wx[i] > gx1) gx1 = wx[i]; if (wy[i] < gy0) gy0 = wy[i]; if (wy[i] > gy1) gy1 = wy[i]; }
  const GW = Math.ceil((gx1 - gx0) / CELL) + 1, GH = Math.ceil((gy1 - gy0) / CELL) + 1;
  const cellStart = new Uint32Array(GW * GH + 1), cellOf = new Uint32Array(N);
  for (let i = 0; i < N; i++) { const c = Math.floor((wy[i] - gy0) / CELL) * GW + Math.floor((wx[i] - gx0) / CELL); cellOf[i] = c; cellStart[c + 1]++; }
  for (let c = 0; c < GW * GH; c++) cellStart[c + 1] += cellStart[c];
  const cellItems = new Uint32Array(N); { const f = cellStart.slice(); for (let i = 0; i < N; i++) cellItems[f[cellOf[i]]++] = i; }

  // ---------- filters: species search (map + neighborhoods), group toggles (map) ----------
  let selSp = -1;
  const isVisible = i => selSp >= 0 ? D.s[i] === selSp : groups[spGroup[D.s[i]]].on;
  const labelOf = s => `${s[0]} (${s[1]})`;
  const byLabel = new Map(D.species.map((s, i) => [labelOf(s).toLowerCase(), i]));
  const dl = document.getElementById('spList');
  D.species.forEach(s => { const o = document.createElement('option'); o.value = labelOf(s); dl.appendChild(o); });
  const q = document.getElementById('q'), qClear = document.getElementById('qClear');
  function pick() {
    const v = q.value.trim().toLowerCase(); if (!v) return clearSel();
    let i = byLabel.has(v) ? byLabel.get(v) : D.species.findIndex(s => s[0].toLowerCase() === v || s[1].toLowerCase() === v);
    if (i < 0) { const m = D.species.map((s, k) => k).filter(k => labelOf(D.species[k]).toLowerCase().includes(v)); if (m.length === 1) i = m[0]; }
    if (i < 0) return;
    selSp = i; q.value = labelOf(D.species[i]); qClear.hidden = false; V.refresh();
  }
  function clearSel() { selSp = -1; q.value = ''; qClear.hidden = true; V.refresh(); }
  q.addEventListener('change', pick); q.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); if (e.key === 'Escape') clearSel(); });
  qClear.onclick = clearSel;
  const gchips = document.getElementById('groupChips');
  function buildChips() {
    gchips.innerHTML = '';
    groups.forEach(g => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (g.on ? ' on' : '');
      b.innerHTML = `<i style="background:${g.color}"></i>${esc(g.name)}`;
      b.onclick = () => { if (selSp >= 0) { selSp = -1; q.value = ''; qClear.hidden = true; } g.on = !g.on; buildChips(); req(); };
      gchips.appendChild(b);
    });
    const all = document.createElement('button'); all.type = 'button'; all.className = 'chip';
    const allOn = groups.every(g => g.on); all.textContent = allOn ? 'Hide all' : 'Show all';
    all.onclick = () => { groups.forEach(g => g.on = !allOn); buildChips(); req(); };
    gchips.appendChild(all);
  }

  // ---------- canvas map ----------
  let cv, ctx, W = 0, H = 0, DPR = 1, view = { s: 1, tx: 0, ty: 0 }, C = {}, raf = 0, hoverHood = -1, hoverTree = -1;
  const req = () => { if (cv && !raf) raf = requestAnimationFrame(draw); };
  function fit() {
    const pad = 16, w = W - 2 * pad, h = H - 2 * pad, s = Math.min(w / (gx1 - gx0), h / (gy1 - gy0));
    view.s = s; view.tx = pad + (w - (gx1 - gx0) * s) / 2 - gx0 * s; view.ty = pad + (h - (gy1 - gy0) * s) / 2 - gy0 * s;
  }
  function resize() { DPR = Math.min(devicePixelRatio || 1, 2); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * DPR; cv.height = H * DPR; }
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['water', 't-land', 't-hood', 'landline', 't-hood-hi', 't-dim', 'ink', 'ink2', 'muted', 'surface', 'road', 'road-major', 'road-fwy']) C[k] = cs.getPropertyValue('--' + k).trim();
    groups.forEach(g => { if (g.colorVar) g.color = cs.getPropertyValue(g.colorVar).trim(); });
  }
  function draw() {
    raf = 0; const s = view.s;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.fillStyle = C.water; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(DPR * s, 0, 0, DPR * s, DPR * view.tx, DPR * view.ty);
    ctx.fillStyle = C['t-land']; ctx.fill(landPath, 'evenodd');
    ctx.fillStyle = C.water; ctx.fill(lakePath, 'evenodd');
    ctx.fillStyle = C['t-hood']; hoods.forEach(h => ctx.fill(h.path));
    if (hoverHood >= 0) { ctx.fillStyle = C['t-hood-hi']; ctx.fill(hoods[hoverHood].path); }
    ctx.fillStyle = C.water; ctx.fill(waterPath);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    { const base = Math.max(0.5, Math.min(4, s * 0.00003));
      ctx.strokeStyle = C.road; ctx.lineWidth = Math.max(0.4, base * Math.min(1, s / 12000)) / s; ctx.stroke(roadPaths[2]);
      ctx.strokeStyle = C['road-major']; ctx.lineWidth = Math.max(0.7, base * 1.6) / s; ctx.stroke(roadPaths[3]); ctx.stroke(roadPaths[1]);
      ctx.strokeStyle = C['road-fwy']; ctx.lineWidth = Math.max(1.2, base * 2.4) / s; ctx.stroke(roadPaths[0]); }
    ctx.strokeStyle = C.landline; ctx.lineWidth = 1 / s; hoods.forEach(h => ctx.stroke(h.path));
    if (hoverHood >= 0) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5 / s; ctx.stroke(hoods[hoverHood].path); }
    // trees
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const r = Math.max(0.75, Math.min(5, s * 0.000045));
    const vx0 = -view.tx / s - 10 / s, vx1 = (W - view.tx) / s + 10 / s, vy0 = -view.ty / s - 10 / s, vy1 = (H - view.ty) / s + 10 / s;
    const cull = s > 8000, circles = r >= 2;
    const plot = (idx, color, test) => { ctx.fillStyle = color; ctx.beginPath(); let any = false;
      for (let k = 0; k < idx.length; k++) { const i = idx[k]; if (test && !test(i)) continue; const x = wx[i], y = wy[i];
        if (cull && (x < vx0 || x > vx1 || y < vy0 || y > vy1)) continue;
        const px = x * s + view.tx, py = y * s + view.ty;
        if (circles) { ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, 6.2832); } else ctx.rect(px - r, py - r, r * 2, r * 2); any = true; }
      if (any) ctx.fill(); };
    if (selSp >= 0) {
      for (const gi of drawOrder) plot(groups[gi].idx, C['t-dim'], i => D.s[i] !== selSp);
      const g = groups[spGroup[selSp]], col = spGroup[selSp] < 9 ? g.color : (selSp === stumpIdx ? g.color : TOP_COLORS[0]), big = Math.max(r * 1.6, 1.6);
      ctx.fillStyle = col; ctx.beginPath();
      for (const i of g.idx) { if (D.s[i] !== selSp) continue; const px = wx[i] * s + view.tx, py = wy[i] * s + view.ty; ctx.moveTo(px + big, py); ctx.arc(px, py, big, 0, 6.2832); }
      ctx.fill();
    } else for (const gi of drawOrder) { const g = groups[gi]; if (g.on) plot(g.idx, g.color); }
    drawLabels(s);
    if (hoverTree >= 0) { const px = wx[hoverTree] * s + view.tx, py = wy[hoverTree] * s + view.ty; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, Math.max(r, 2) + 3, 0, 6.2832); ctx.stroke(); }
  }
  function drawLabels(s) {
    const ff = getComputedStyle(document.body).fontFamily, cell = 64, grid = new Map(), pad = 3;
    const hit = (x0, y0, x1, y1) => { for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
      const L = grid.get(gx * 4096 + gy); if (L) for (const b of L) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return true; } return false; };
    const add = (x0, y0, x1, y1) => { for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
      const k = gx * 4096 + gy; let L = grid.get(k); if (!L) grid.set(k, L = []); L.push([x0, y0, x1, y1]); } };
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    if (s > 9000 && s < 90000) {
      ctx.font = `600 ${s > 30000 ? 12 : 11}px ${ff}`; ctx.lineWidth = 3; ctx.strokeStyle = C['t-hood']; ctx.fillStyle = C.muted;
      hoods.forEach(h => { if (!h.c || h.c.w * s < 70) return; const x = h.c.x * s + view.tx, y = h.c.y * s + view.ty; if (x < -50 || x > W + 50 || y < -20 || y > H + 20) return;
        const t = h.name.toUpperCase(), w = ctx.measureText(t).width, b = [x - w / 2 - pad, y - 9, x + w / 2 + pad, y + 9]; if (hit(...b)) return; add(...b);
        ctx.strokeText(t, x, y); ctx.fillText(t, x, y); });
    }
    if (s < 13000) return;
    const maxTier = s >= 42000 ? 2 : 1, ppm = s / 111320, seen = new Map(); let placed = 0;
    for (const i of anOrder) {
      const t = anT[i]; if (t > maxTier) break;
      const x = anX[i] * s + view.tx, y = anY[i] * s + view.ty; if (x < -60 || x > W + 60 || y < -30 || y > H + 30) continue;
      const fs = t < 2 ? 12 : 11.5, fw = t < 2 ? 600 : 500, name = D.roadNames[anN[i]], key = fw + '|' + name;
      let w = widthCache.get(key); if (w === undefined) { ctx.font = `${fw} ${fs}px ${ff}`; w = ctx.measureText(name).width; widthCache.set(key, w); }
      if (w + 10 > 2 * anH[i] * ppm) continue;
      const a = anA[i], c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)), hw = w / 2 + pad, hh = fs / 2 + 2, ex = hw * c + hh * sn, ey = hw * sn + hh * c;
      const k = (c > 0.3 && sn > 0.3) ? 0.82 : 1, b = [x - ex * k, y - ey * k, x + ex * k, y + ey * k];
      if (hit(...b)) continue;
      const prev = seen.get(name); if (prev && prev.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < 300 * 300)) continue;
      add(...b); if (prev) prev.push([x, y]); else seen.set(name, [[x, y]]);
      ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.font = `${fw} ${fs}px ${ff}`;
      ctx.lineWidth = 3.2; ctx.strokeStyle = C['t-hood']; ctx.strokeText(name, 0, 0.5); ctx.fillStyle = C.ink2; ctx.fillText(name, 0, 0.5); ctx.restore();
      if (++placed > 450) break;
    }
  }
  function nearestTree(x, y, maxPx) {
    const wxp = (x - view.tx) / view.s, wyp = (y - view.ty) / view.s, rad = maxPx / view.s;
    const c0 = Math.floor((wxp - rad - gx0) / CELL), c1 = Math.floor((wxp + rad - gx0) / CELL), r0 = Math.floor((wyp - rad - gy0) / CELL), r1 = Math.floor((wyp + rad - gy0) / CELL);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 400) return -1;
    let best = -1, bd = rad * rad;
    for (let r = Math.max(0, r0); r <= Math.min(GH - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(GW - 1, c1); c++) {
      const cell = r * GW + c;
      for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) { const i = cellItems[k]; if (!isVisible(i)) continue; const d = (wx[i] - wxp) ** 2 + (wy[i] - wyp) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  }
  function hover(ev, x, y, tap) {
    const t = view.s > 4000 ? nearestTree(x, y, tap ? 12 : 7) : -1;
    ctx.setTransform(view.s, 0, 0, view.s, view.tx, view.ty);
    let hh = -1; for (let k = 0; k < hoods.length; k++) if (ctx.isPointInPath(hoods[k].path, x, y)) { hh = k; break; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (t !== hoverTree || hh !== hoverHood) { hoverTree = t; hoverHood = hh; req(); }
    if (t >= 0) {
      const sp = D.species[D.s[t]];
      tip.show(`<b>${esc(sp[0])}</b><div style="color:var(--ink2)"><i>${esc(sp[1])}</i></div>` + (D.near[t] >= 0 ? row('Near', esc(D.roadNames[D.near[t]])) : '') + (D.h[t] >= 0 ? row('Neighborhood', esc(hoods[D.h[t]].name)) : ''), ev);
    } else if (hh >= 0) {
      const H = hoods[hh], top = [...H.sp].sort((a, b) => b[1] - a[1]).slice(0, 4);
      tip.show(`<b>${esc(H.name)}</b>` + row('Trees', fmt(H.n)) + row('Species', H.sp.size) + '<div style="margin-top:4px"></div>' + top.map(([s, c]) => row(esc(D.species[s][0]), fmt(c))).join(''), ev);
    } else tip.hide();
  }
  function initMap(el) {
    el.innerHTML = '<canvas class="tmap" aria-label="Map of street trees in New Orleans, colored by species"></canvas><div class="row zoomhint"></div>';
    cv = el.firstChild; ctx = cv.getContext('2d');
    const zoomAt = (f, x, y) => { const ns = Math.max(1500, Math.min(600000, view.s * f)); f = ns / view.s; view.tx = x - (x - view.tx) * f; view.ty = y - (y - view.ty) * f; view.s = ns; req(); };
    [['Zoom in', () => zoomAt(1.8, W / 2, H / 2)], ['Zoom out', () => zoomAt(1 / 1.8, W / 2, H / 2)], ['Whole city', () => { fit(); req(); }]].forEach(([l, fn]) => {
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = l; b.onclick = fn; el.lastChild.appendChild(b); });
    const pointers = new Map(); let last = null, pinch = null, moved = false;
    cv.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY); }, { passive: false });
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); moved = false;
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; }
      last = { x: e.offsetX, y: e.offsetY }; cv.classList.add('drag'); });
    cv.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) { hover(e, e.offsetX, e.offsetY); return; }
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pointers.size === 2 && pinch) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        view.tx += cx - pinch.cx; view.ty += cy - pinch.cy; zoomAt(d / pinch.d, cx, cy); pinch = { d, cx, cy }; moved = true; return; }
      const dx = e.offsetX - last.x, dy = e.offsetY - last.y; if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      view.tx += dx; view.ty += dy; last = { x: e.offsetX, y: e.offsetY }; tip.hide(); req(); });
    const endPtr = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) cv.classList.remove('drag');
      if (pointers.size === 1) { const p = [...pointers.values()][0]; last = { x: p.x, y: p.y }; }
      if (!moved && e.type === 'pointerup') hover(e, e.offsetX, e.offsetY, true); };
    cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { tip.hide(); if (hoverHood >= 0 || hoverTree >= 0) { hoverHood = -1; hoverTree = -1; req(); } } });
    cv.addEventListener('dblclick', e => zoomAt(2, e.offsetX, e.offsetY));
    addEventListener('resize', () => { if (!cv.offsetParent) return; const ow = W, oh = H; resize(); view.tx += (W - ow) / 2; view.ty += (H - oh) / 2; req(); });
    const reTheme = () => { readColors(); buildChips(); req(); };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reTheme);
    new MutationObserver(reTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    resize(); fit(); readColors(); buildChips();
  }
  function drawMap(el, first) {
    if (first) initMap(el);
    else if (W !== cv.clientWidth || H !== cv.clientHeight) { resize(); fit(); }
    draw();
  }

  // ---------- bar charts ----------
  function hbars(el, items, { color = 'var(--s1)', label = 'Trees' } = {}) {
    el.innerHTML = '';
    const f = NOLA.frame(el, { h: 24 + items.length * 20, m: { t: 4, r: 56, b: 20, l: Math.min(230, el.clientWidth * 0.42) } });
    const x = d3.scaleLinear().domain([0, d3.max(items, d => d.v) || 1]).range([0, f.iw]);
    const y = d3.scaleBand().domain(items.map((d, i) => i)).range([0, f.ih]).paddingInner(.25);
    f.g.selectAll('rect.b').data(items).join('rect').attr('class', 'b').attr('x', 0).attr('y', (d, i) => y(i)).attr('width', d => Math.max(1, x(d.v))).attr('height', y.bandwidth()).attr('rx', 2).attr('fill', d => d.color || color);
    f.g.selectAll('text.l').data(items).join('text').attr('class', 'l').attr('x', -8).attr('y', (d, i) => y(i) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').style('fill', 'var(--ink2)')
      .text(d => d.name.length > 34 ? d.name.slice(0, 33) + '…' : d.name);
    f.g.selectAll('text.v').data(items).join('text').attr('class', 'v').attr('x', d => x(d.v) + 5).attr('y', (d, i) => y(i) + y.bandwidth() / 2 + 4).text(d => fmt(d.v));
    f.g.selectAll('rect.h').data(items).join('rect').attr('class', 'h').attr('x', -f.m.l).attr('y', (d, i) => y(i) - 2).attr('width', f.iw + f.m.l).attr('height', y.step()).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(`<b>${esc(d.name)}</b>` + (d.sub ? `<div style="color:var(--ink2)"><i>${esc(d.sub)}</i></div>` : '') + row(label, fmt(d.v)) + (d.extra || ''), ev)).on('mouseleave', tip.hide);
  }
  function drawSpecies(el) {
    const items = D.species.map((s, i) => ({ name: s[0], sub: s[1], v: s[2], i })).sort((a, b) => b.v - a.v).slice(0, 30)
      .map(d => ({ ...d, color: groups[spGroup[d.i]].color, extra: row('Share of all trees', (100 * d.v / N).toFixed(1) + '%') }));
    hbars(el, items);
  }
  function drawHoods(el) {
    const items = hoods.map((h, hi) => ({ name: h.name, v: selSp >= 0 ? (h.sp.get(selSp) || 0) : h.n, extra: selSp >= 0 ? row('All trees', fmt(h.n)) : row('Species', h.sp.size) }))
      .filter(d => d.v > 0).sort((a, b) => b.v - a.v);
    const col = selSp >= 0 ? (spGroup[selSp] < 9 ? groups[spGroup[selSp]].color : TOP_COLORS[0]) : 'var(--s3)';
    hbars(el, items, { color: col, label: selSp >= 0 ? D.species[selSp][0] : 'Trees' });
  }

  const V = NOLA.views([
    { id: 'map', label: 'Map of every tree', cls: 'card mapp', keep: true, draw: drawMap },
    { id: 'species', label: 'Most common species', draw: drawSpecies },
    { id: 'hoods', label: 'Trees by neighborhood', draw: drawHoods },
  ]);
})();
