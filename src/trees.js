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

  // ---------- coverage: same rule as the other maps (neighborhoods under 100 residents per sq mi are left out) ----------
  NOLA.setGeo(DATA.geo);
  const normN = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const geoSkip = new Map(NOLA.GEO.nb.map(f => [normN(f.n), f.skip]));
  const hoodSkip = D.hoods.map(h => { const k = normN(h.n); return geoSkip.get(k) ?? [...geoSkip].some(([g, sk]) => sk && g.startsWith(k)); });
  const valid = new Uint8Array(N);
  for (let i = 0; i < N; i++) valid[i] = D.h[i] >= 0 && !hoodSkip[D.h[i]] ? 1 : 0;

  // ---------- species groups: top 9, stumps, everything else ----------
  const TOP_COLORS = ['#d9418c', '#3a9a5b', '#c46a28', '#c23a3a', '#178f8f', '#7a68d8', '#d4a017', '#7f9a2e', '#3f7fd6'];
  const stumpIdx = D.species.findIndex(s => s[0] === 'Stump');
  const groups = [];
  for (let i = 0, ti = 0; i < D.species.length && groups.length < 9; i++) { if (i === stumpIdx) continue; groups.push({ name: D.species[i][0], bot: D.species[i][1], sp: [i], color: TOP_COLORS[ti++], on: true }); }
  const topSet = new Set(groups.map(g => g.sp[0]));
  groups.push({ name: 'Stump', bot: 'Removed tree, stump on record', sp: [stumpIdx], colorVar: '--t-stump', on: true });
  const otherSp = D.species.map((_, i) => i).filter(i => !topSet.has(i) && i !== stumpIdx);
  groups.push({ name: 'All other species', bot: otherSp.length + ' species', sp: otherSp, colorVar: '--t-other', on: true });
  const spGroup = new Int16Array(D.species.length);
  groups.forEach((g, gi) => g.sp.forEach(s => spGroup[s] = gi));
  groups.forEach(g => g.count = 0);
  for (let i = 0; i < N; i++) if (valid[i]) groups[spGroup[D.s[i]]].count++;
  groups.forEach(g => { g.idx = new Uint32Array(g.count); g.fill = 0; });
  for (let i = 0; i < N; i++) if (valid[i]) { const g = groups[spGroup[D.s[i]]]; g.idx[g.fill++] = i; }
  const drawOrder = [groups.length - 1, groups.length - 2, ...groups.slice(0, 9).map((_, i) => i)]; // rarer on top

  // ---------- neighborhoods ----------
  const hoods = D.hoods.map((h, hi) => {
    const p = new Path2D(); let best = null, bestA = -1, area = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    for (const poly of h.p) {
      poly.forEach((ring, ri) => { const pts = ring.map(([lo, la]) => toW(lo, la)); pts.forEach(([x, y], k) => k ? p.lineTo(x, y) : p.moveTo(x, y)); p.closePath();
        area += (ri ? -1 : 1) * Math.abs(d3.polygonArea(pts));
        if (!ri) pts.forEach(([x, y]) => { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }); });
      const r = poly[0].map(([lo, la]) => toW(lo, la)), a = Math.abs(d3.polygonArea(r));
      if (a > bestA) { bestA = a; const c = d3.polygonCentroid(r); best = { x: c[0], y: c[1], w: d3.max(r, q => q[0]) - d3.min(r, q => q[0]) }; }
    }
    return { name: h.n, path: p, c: best, n: 0, sp: new Map(), sqmi: area * 69.05 * 69.05, bbox: [bx0, by0, bx1, by1], skip: hoodSkip[hi] };
  });
  for (let i = 0; i < N; i++) { if (!valid[i]) continue; const H = hoods[D.h[i]]; H.n++; H.sp.set(D.s[i], (H.sp.get(D.s[i]) || 0) + 1); }
  hoods.forEach(h => h.dens = h.sqmi > 0 ? h.n / h.sqmi : 0);
  const densHi = d3.quantile(hoods.filter(h => !h.skip).map(h => h.dens).sort(d3.ascending), .95);
  const hoodList = hoods.map((h, i) => [h, i]).filter(([h]) => !h.skip).sort((a, b) => a[0].name.localeCompare(b[0].name));
  const shapePath = geoms => { const p = new Path2D(); for (const g of geoms) for (const part of g) for (const ring of part) { ring.forEach(([lo, la], k) => { const [x, y] = toW(lo, la); k ? p.lineTo(x, y) : p.moveTo(x, y); }); p.closePath(); } return p; };
  const landPath = shapePath(D.land), lakePath = shapePath(D.lakes), waterPath = shapePath(D.water);

  // ---------- green spaces (c: 0 neutral ground, 1 park, 2 cemetery, 3 nature area, 4 undeveloped lot) ----------
  // in the data, meta.n is the space's name; here nm is the name and n the number of inventoried trees in it
  const GS = D.gs.meta.map((m, i) => {
    const arr = D.gs.polys[i], p = new Path2D(); let k = 0; const nr = arr[k++]; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let r = 0; r < nr; r++) { const n = arr[k++]; let qx = arr[k++], qy = arr[k++];
      for (let j = 0; j < n; j++) { if (j) { qx += arr[k++]; qy += arr[k++]; } const X = qx * 1e-5 * COS, Y = -qy * 1e-5; j ? p.lineTo(X, Y) : p.moveTo(X, Y); x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); }
      p.closePath(); }
    return { c: m.c, u: m.u, own: m.own, a: m.a, nm: m.n || '', path: p, bb: [x0, y0, x1, y1], lx: m.lx * 1e-5 * COS, ly: -m.ly * 1e-5, ww: m.w * 1e-5 * COS, n: 0, sp: new Map() };
  });
  const GCAT = [
    { name: 'Neutral grounds', short: 'Neutral ground', fill: 't-park', on: true, minS: 7000 },
    { name: 'Parks', short: 'Park', fill: 't-park', on: true, minS: 0 },
    { name: 'Cemeteries', short: 'Cemetery', fill: 't-cem', on: true, minS: 0 },
    { name: 'Nature areas', short: 'Nature area', fill: 't-wild', on: true, minS: 0 },
    { name: 'Undeveloped lots', short: 'Undeveloped lot', fill: 't-lot', on: false, minS: 0 }];
  GCAT.forEach(c => { c.path = new Path2D(); c.spaces = 0; });
  GS.forEach(g => { GCAT[g.c].path.addPath(g.path); GCAT[g.c].spaces++; });
  for (let i = 0; i < N; i++) { const k = D.tg[i]; if (k < 0 || !valid[i]) continue; const g = GS[k]; g.n++; g.sp.set(D.s[i], (g.sp.get(D.s[i]) || 0) + 1); }
  const gsName = g => g.nm || 'Unnamed ' + GCAT[g.c].short.toLowerCase();
  const gsLabelOrder = GS.map((g, i) => i).filter(i => GS[i].nm && GS[i].c !== 0 && (GS[i].n > 0 || GS[i].a > 20000) && (GS[i].n || GS[i].c !== 4)).sort((a, b) => GS[b].a - GS[a].a);
  // where each tree grows: 0 along streets, 1 neutral ground, 2 park, 3 other green space
  const tset = new Uint8Array(N); for (let i = 0; i < N; i++) { const k = D.tg[i]; tset[i] = k < 0 ? 0 : GS[k].c === 0 ? 1 : GS[k].c === 1 ? 2 : 3; }
  const SETTINGS = [{ name: 'Along streets', sub: 'Easements and tree pits', sw: 'road-fwy' }, { name: 'Neutral grounds', sub: 'Mapped medians', sw: 't-park-line' },
    { name: 'Parks', sub: 'Parks, squares, golf courses', sw: 't-park-line' }, { name: 'Other green space', sub: 'Cemeteries, nature areas, lots', sw: 't-cem' }];
  const acres = g => g.a * 1e-10 * (111320 * COS) * 111320 / 4046.86;

  // ---------- street names (from the inventory's street export) and the shared City street map ----------
  const AN = D.anchors.length / 6;
  const anX = new Float32Array(AN), anY = new Float32Array(AN), anA = new Float32Array(AN), anH = new Float32Array(AN), anN = new Uint16Array(AN), anT = new Uint8Array(AN);
  for (let i = 0; i < AN; i++) { const b = i * 6; anX[i] = D.anchors[b] * 1e-5 * COS; anY[i] = -D.anchors[b + 1] * 1e-5; anA[i] = -D.anchors[b + 2] * Math.PI / 180; anH[i] = D.anchors[b + 3]; anN[i] = D.anchors[b + 4]; anT[i] = D.anchors[b + 5]; }
  const anOrder = [...Array(AN).keys()].sort((a, b) => anT[a] - anT[b] || anH[b] - anH[a]);
  const widthCache = new Map();
  const roadPaths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()]; // 0 freeway, 1 arterial, 2 local, 3 ramp
  const ST = window.STREETS;
  if (ST) {
    const M = new DOMMatrix([COS / (ST.q * 4830), 0, 0, 1 / (ST.q * 5550), (-90.14 - D.lon0) * COS, -(30.20 - D.lat0)]);
    [[0, 0], [2, 1], [3, 2], [1, 3]].forEach(([from, to]) => roadPaths[to].addPath(new Path2D(ST.d[from]), M));
  }

  // ---------- spatial grid for hover ----------
  const CELL = 0.0012; let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (let i = 0; i < N; i++) { if (!valid[i]) continue; if (wx[i] < gx0) gx0 = wx[i]; if (wx[i] > gx1) gx1 = wx[i]; if (wy[i] < gy0) gy0 = wy[i]; if (wy[i] > gy1) gy1 = wy[i]; }
  const GW = Math.ceil((gx1 - gx0) / CELL) + 1, GH = Math.ceil((gy1 - gy0) / CELL) + 1;
  const cellStart = new Uint32Array(GW * GH + 1), cellOf = new Uint32Array(N);
  for (let i = 0; i < N; i++) { const c = Math.max(0, Math.min(GW * GH - 1, Math.floor((wy[i] - gy0) / CELL) * GW + Math.floor((wx[i] - gx0) / CELL))); cellOf[i] = c; cellStart[c + 1]++; }
  for (let c = 0; c < GW * GH; c++) cellStart[c + 1] += cellStart[c];
  const cellItems = new Uint32Array(N); { const f = cellStart.slice(); for (let i = 0; i < N; i++) cellItems[f[cellOf[i]]++] = i; }

  // ---------- state (kept in the link) ----------
  const H0 = NOLA.hashState();
  let selSp = H0.sp != null ? +H0.sp : -1, selNb = H0.nb != null ? +H0.nb : -1, setF = H0.set != null ? +H0.set : -1, dens = H0.dens === '1';
  const inNb = i => selNb < 0 || D.h[i] === selNb;
  const setOk = i => setF < 0 || tset[i] === setF;
  const isVisible = i => valid[i] && inNb(i) && setOk(i) && (selSp >= 0 ? D.s[i] === selSp : groups[spGroup[D.s[i]]].on);
  const refresh = () => V.refresh();

  // ---------- panel sections ----------
  const labelOf = s => `${s[0]} (${s[1]})`;
  const byLabel = new Map(D.species.map((s, i) => [labelOf(s).toLowerCase(), i]));
  const dl = document.createElement('datalist'); dl.id = 'spList'; document.body.appendChild(dl);
  D.species.forEach(s => { const o = document.createElement('option'); o.value = labelOf(s); dl.appendChild(o); });
  let cv = null;
  function nbSection(panel) {
    const s = document.createElement('select'); s.className = 'fsel'; s.setAttribute('aria-label', 'Neighborhood');
    s.innerHTML = '<option value="-1">All neighborhoods</option>' + hoodList.map(([h, i]) => `<option value="${i}">${esc(h.name)}</option>`).join('');
    s.value = selNb; s.onchange = () => { selNb = +s.value; refresh(); };
    NOLA.fsec(panel, 'Neighborhood').appendChild(s);
  }
  function findSection(panel) {
    const sec = NOLA.fsec(panel, 'Find a species', selSp >= 0 ? ['Clear', () => { selSp = -1; refresh(); }] : null);
    sec.insertAdjacentHTML('beforeend', '<div class="find"><input list="spList" placeholder="e.g. Sweet Olive, Ginkgo…" autocomplete="off" aria-label="Find a species"></div>');
    const q = sec.querySelector('input'); if (selSp >= 0) q.value = labelOf(D.species[selSp]);
    const pick = () => { const v = q.value.trim().toLowerCase(); if (!v) { selSp = -1; return refresh(); }
      let i = byLabel.has(v) ? byLabel.get(v) : D.species.findIndex(s => s[0].toLowerCase() === v || s[1].toLowerCase() === v);
      if (i < 0) { const m = D.species.map((s, k) => k).filter(k => labelOf(D.species[k]).toLowerCase().includes(v)); if (m.length === 1) i = m[0]; }
      if (i >= 0) { selSp = i; refresh(); } };
    q.addEventListener('change', pick); q.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); if (e.key === 'Escape') { selSp = -1; refresh(); } });
  }
  function settingSection(panel) {
    const cnt = [0, 0, 0, 0]; for (let i = 0; i < N; i++) if (valid[i] && inNb(i) && (selSp < 0 || D.s[i] === selSp)) cnt[tset[i]]++;
    NOLA.flist(NOLA.fsec(panel, 'Where the trees grow', setF >= 0 ? ['Show all', () => { setF = -1; refresh(); }] : null),
      SETTINGS.map((s, i) => ({ key: i, name: s.name, sub: s.sub, color: C[s.sw], count: cnt[i], square: true })),
      { pressed: i => setF === i, onClick: i => { setF = setF === i ? -1 : i; refresh(); } });
  }
  function layerSection(panel) {
    NOLA.flist(NOLA.fsec(panel, 'Green space layers'), GCAT.map((c, i) => ({ key: i, name: c.name, color: C[c.fill], square: true, sub: i === 0 ? 'Drawn once you zoom in' : null })),
      { mode: 'toggle', pressed: i => GCAT[i].on, onClick: i => { GCAT[i].on = !GCAT[i].on; refresh(); } });
  }
  function speciesSection(panel) {
    if (selNb >= 0) { // the chosen neighborhood's own top species; click one to highlight it on the map
      const cnt = new Map(); for (const g of groups) for (const i of g.idx) if (D.h[i] === selNb && setOk(i)) cnt.set(D.s[i], (cnt.get(D.s[i]) || 0) + 1);
      const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const colorOf = sp => spGroup[sp] < 9 || sp === stumpIdx ? groups[spGroup[sp]].color : C['t-other'];
      NOLA.flist(NOLA.fsec(panel, 'Most common in ' + esc(hoods[selNb].name), selSp >= 0 ? ['Show all', () => { selSp = -1; refresh(); }] : null),
        top.map(([sp, c]) => ({ key: sp, name: esc(D.species[sp][0]), sub: esc(D.species[sp][1]), color: colorOf(sp), count: c })),
        { pressed: sp => selSp === sp, onClick: sp => { selSp = selSp === sp ? -1 : sp; refresh(); } });
      if (!top.length) panel.lastChild.insertAdjacentHTML('beforeend', '<div class="legend">No inventoried trees here.</div>');
      return;
    }
    const allOn = groups.every(g => g.on);
    const cnt = groups.map(() => 0); groups.forEach((g, gi) => { for (const i of g.idx) if (inNb(i) && setOk(i)) cnt[gi]++; });
    NOLA.flist(NOLA.fsec(panel, 'Most common', [allOn ? 'Hide all' : 'Show all', () => { groups.forEach(g => g.on = !allOn); selSp = -1; refresh(); }]),
      groups.map((g, i) => ({ key: i, name: g.name, sub: g.bot, color: g.color, count: cnt[i] })),
      { mode: 'toggle', pressed: i => groups[i].on && selSp < 0, onClick: i => { selSp = -1; groups[i].on = !groups[i].on; refresh(); } });
  }
  function shadeSection(panel) {
    const sec = NOLA.fsec(panel, 'Neighborhood shading');
    NOLA.seg(sec, [[0, 'None'], [1, 'Trees per sq. mi.']], dens ? 1 : 0, v => { dens = !!v; refresh(); });
    if (dens) { const l = document.createElement('div'); l.className = 'legend'; sec.appendChild(l); NOLA.seqLegend(l, [0, densHi], v => fmt(Math.round(v)), ''); }
  }

  // ---------- canvas map ----------
  let ctx, panelEl, W = 0, H = 0, DPR = 1, view = { s: 1, tx: 0, ty: 0 }, C = {}, raf = 0, hoverHood = -1, hoverTree = -1, hoverGS = -1, scaleEl = null;
  const req = () => { if (cv && !raf) raf = requestAnimationFrame(draw); };
  const insetL = () => (panelEl && getComputedStyle(panelEl).position === 'absolute') ? panelEl.offsetWidth + 24 : 0;
  function fitBox([x0, y0, x1, y1], padPx) {
    const L = insetL(), w = W - L - 2 * padPx, h = H - 2 * padPx, s = Math.min(w / (x1 - x0), h / (y1 - y0));
    view.s = s; view.tx = L + padPx + (w - (x1 - x0) * s) / 2 - x0 * s; view.ty = padPx + (h - (y1 - y0) * s) / 2 - y0 * s;
  }
  function zoomToHood() { if (selNb < 0) fitBox([gx0, gy0, gx1, gy1], 16); else fitBox(hoods[selNb].bbox, 40); req(); }
  function resize() { DPR = Math.min(devicePixelRatio || 1, 2); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * DPR; cv.height = H * DPR; }
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['water', 't-land', 't-hood', 'landline', 't-dim', 'ink', 'ink2', 'muted', 'surface', 'road', 'road-major', 'road-fwy', 't-park', 't-park-line', 't-wild', 't-cem', 't-lot', 't-park-ink', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'])
      C[k] = cs.getPropertyValue('--' + k).trim();
    groups.forEach(g => { if (g.colorVar) g.color = cs.getPropertyValue(g.colorVar).trim(); });
  }
  function draw() {
    raf = 0; const s = view.s;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.fillStyle = C.water; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(DPR * s, 0, 0, DPR * s, DPR * view.tx, DPR * view.ty);
    ctx.fillStyle = C['t-land']; ctx.fill(landPath, 'evenodd');
    ctx.fillStyle = C.water; ctx.fill(lakePath, 'evenodd');
    if (dens) hoods.forEach(h => { if (h.skip) return; ctx.fillStyle = C['q' + (1 + Math.max(0, Math.min(6, Math.floor(h.dens / densHi * 7))))]; ctx.fill(h.path); });
    else { ctx.fillStyle = C['t-hood']; hoods.forEach(h => { if (!h.skip) ctx.fill(h.path); }); }
    GCAT.forEach(c => { if (c.on && s >= c.minS) { ctx.fillStyle = C[c.fill]; ctx.fill(c.path); } });
    if (s > 6000) { ctx.strokeStyle = C['t-park-line']; ctx.lineWidth = 0.8 / s; GCAT.forEach((c, ci) => { if (c.on && s >= c.minS && ci !== 4) ctx.stroke(c.path); }); }
    ctx.fillStyle = C.water; ctx.fill(waterPath);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    { const base = Math.max(0.5, Math.min(4, s * 0.00003));
      ctx.strokeStyle = C.road; ctx.lineWidth = Math.max(0.4, base * Math.min(1, s / 12000)) / s; ctx.stroke(roadPaths[2]);
      ctx.strokeStyle = C['road-major']; ctx.lineWidth = Math.max(0.7, base * 1.6) / s; ctx.stroke(roadPaths[3]); ctx.stroke(roadPaths[1]);
      ctx.strokeStyle = C['road-fwy']; ctx.lineWidth = Math.max(1.2, base * 2.4) / s; ctx.stroke(roadPaths[0]); }
    ctx.strokeStyle = C.landline; ctx.lineWidth = 1 / s; hoods.forEach(h => { if (!h.skip) ctx.stroke(h.path); });
    if (hoverGS >= 0) { ctx.strokeStyle = C['t-park-ink']; ctx.lineWidth = 2 / s; ctx.stroke(GS[hoverGS].path); }
    // hover is an outline only, so streets and shading underneath stay visible
    if (hoverHood >= 0) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5 / s; ctx.stroke(hoods[hoverHood].path); }
    if (selNb >= 0) { ctx.strokeStyle = C.ink; ctx.lineWidth = 2.4 / s; ctx.stroke(hoods[selNb].path); }
    // trees
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const r = Math.max(0.75, Math.min(5, s * 0.000045));
    const vx0 = -view.tx / s - 10 / s, vx1 = (W - view.tx) / s + 10 / s, vy0 = -view.ty / s - 10 / s, vy1 = (H - view.ty) / s + 10 / s;
    const cull = s > 8000, circles = r >= 2;
    const plot = (idx, color, test, rad = r) => { ctx.fillStyle = color; ctx.beginPath(); let any = false;
      for (let k = 0; k < idx.length; k++) { const i = idx[k]; if (test && !test(i)) continue; const x = wx[i], y = wy[i];
        if (cull && (x < vx0 || x > vx1 || y < vy0 || y > vy1)) continue;
        const px = x * s + view.tx, py = y * s + view.ty;
        if (circles || rad > r) { ctx.moveTo(px + rad, py); ctx.arc(px, py, rad, 0, 6.2832); } else ctx.rect(px - rad, py - rad, rad * 2, rad * 2); any = true; }
      if (any) ctx.fill(); };
    const pass = i => inNb(i) && setOk(i);
    if (selSp >= 0) {
      for (const gi of drawOrder) plot(groups[gi].idx, C['t-dim'], i => !(D.s[i] === selSp && pass(i)));
      const g = groups[spGroup[selSp]], col = spGroup[selSp] < 9 || selSp === stumpIdx ? g.color : TOP_COLORS[0];
      plot(g.idx, col, i => D.s[i] === selSp && pass(i), Math.max(r * 1.6, 1.6));
    } else {
      const filtering = selNb >= 0 || setF >= 0;
      if (filtering) for (const gi of drawOrder) if (groups[gi].on) plot(groups[gi].idx, C['t-dim'], i => !pass(i));
      for (const gi of drawOrder) { const g = groups[gi]; if (g.on) plot(g.idx, g.color, filtering ? pass : null); }
    }
    drawLabels(s);
    if (hoverTree >= 0) { const px = wx[hoverTree] * s + view.tx, py = wy[hoverTree] * s + view.ty; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, Math.max(r, 2) + 3, 0, 6.2832); ctx.stroke(); }
    drawScale();
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
      hoods.forEach(h => { if (h.skip || !h.c || h.c.w * s < 70) return; const x = h.c.x * s + view.tx, y = h.c.y * s + view.ty; if (x < -50 || x > W + 50 || y < -20 || y > H + 20) return;
        const t = h.name.toUpperCase(), w = ctx.measureText(t).width, b = [x - w / 2 - pad, y - 9, x + w / 2 + pad, y + 9]; if (hit(...b)) return; add(...b);
        ctx.strokeText(t, x, y); ctx.fillText(t, x, y); });
    }
    if (s > 6000) { // park and green space names
      ctx.font = `italic 500 ${s > 30000 ? 12 : 11.5}px ${ff}`; ctx.lineWidth = 3; ctx.strokeStyle = C['t-hood']; ctx.fillStyle = C['t-park-ink']; let np = 0;
      for (const i of gsLabelOrder) { const g = GS[i]; if (!GCAT[g.c].on) continue;
        const x = g.lx * s + view.tx, y = g.ly * s + view.ty; if (x < -80 || x > W + 80 || y < -20 || y > H + 20) continue;
        const w = ctx.measureText(g.nm).width; if (g.ww * s < w * 0.7) continue;
        const b = [x - w / 2 - pad, y - 9, x + w / 2 + pad, y + 9]; if (hit(...b)) continue; add(...b); ctx.strokeText(g.nm, x, y); ctx.fillText(g.nm, x, y); if (++np > 60) break; }
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
  function drawScale() {
    if (!scaleEl) return;
    const pxPerMile = view.s / 69.05, opts = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]; let m = opts[0];
    for (const o of opts) if (o * pxPerMile <= 110) m = o;
    scaleEl.lastChild.style.width = (m * pxPerMile).toFixed(0) + 'px';
    scaleEl.firstChild.textContent = m < 1 ? (m * 5280 >= 1000 ? m + ' mi' : Math.round(m * 5280) + ' ft') : m + ' mi';
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
  const topSp = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([sp, c]) => row(esc(D.species[sp][0]), fmt(c))).join('');
  function hover(ev, x, y, tap) {
    const t = view.s > 4000 ? nearestTree(x, y, tap ? 12 : 7) : -1;
    ctx.setTransform(view.s, 0, 0, view.s, view.tx, view.ty);
    const wxp = (x - view.tx) / view.s, wyp = (y - view.ty) / view.s;
    let gh = -1;
    if (view.s > 6000) for (let k = 0; k < GS.length; k++) { const g = GS[k], c = GCAT[g.c]; if (!c.on || view.s < c.minS) continue;
      if (wxp < g.bb[0] || wxp > g.bb[2] || wyp < g.bb[1] || wyp > g.bb[3]) continue; if (ctx.isPointInPath(g.path, x, y)) { gh = k; break; } }
    let hh = -1; for (let k = 0; k < hoods.length; k++) if (!hoods[k].skip && ctx.isPointInPath(hoods[k].path, x, y)) { hh = k; break; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (t !== hoverTree || hh !== hoverHood || gh !== hoverGS) { hoverTree = t; hoverHood = hh; hoverGS = gh; req(); }
    if (t >= 0) {
      const sp = D.species[D.s[t]], st = D.near[t] >= 0 ? D.roadNames[D.near[t]] : '', gk = D.tg[t];
      const where = gk >= 0 ? (GS[gk].c === 0 ? 'Neutral ground' + (st ? ' on ' + st : '') : 'In ' + (GS[gk].nm || GCAT[GS[gk].c].short.toLowerCase())) : (st ? 'Near ' + st : '');
      tip.show(`<b>${esc(sp[0])}</b><div style="color:var(--ink2)"><i>${esc(sp[1])}</i></div>` + (where ? row('Where', esc(where)) : '') + (D.h[t] >= 0 ? row('Neighborhood', esc(hoods[D.h[t]].name)) : ''), ev);
    } else if (gh >= 0) {
      const g = GS[gh], a = acres(g);
      tip.show(`<b>${esc(gsName(g))}</b><div style="color:var(--ink2)">${esc(g.u)}${g.own ? ' · ' + esc(g.own) : ''}</div>` + row('Acres', a < 1 ? a.toFixed(2) : fmt(Math.round(a))) + row('Trees', fmt(g.n)) + (g.n ? '<div style="margin-top:4px"></div>' + topSp(g.sp, 4) : ''), ev);
    } else if (hh >= 0) {
      const Hd = hoods[hh];
      tip.show(`<b>${esc(Hd.name)}</b>` + row('Trees', fmt(Hd.n)) + row('Per sq. mi.', fmt(Math.round(Hd.dens))) + row('Species', Hd.sp.size) + '<div style="margin-top:4px"></div>' + topSp(Hd.sp, 4), ev);
    } else tip.hide();
  }
  // left-click a neighborhood to select it (the "Most common" list follows); click it again, or outside any neighborhood, to clear.
  // A click doesn't move the map; choosing from the Neighborhood menu zooms to it.
  function clickHood(x, y) {
    ctx.setTransform(view.s, 0, 0, view.s, view.tx, view.ty);
    let hh = -1; for (let k = 0; k < hoods.length; k++) if (!hoods[k].skip && ctx.isPointInPath(hoods[k].path, x, y)) { hh = k; break; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    selNb = hh < 0 || hh === selNb ? -1 : hh;
    lastNb = selNb; // already where we want to be: no zoom
    refresh();
  }
  function initMap(plot) {
    plot.innerHTML = '<canvas class="tmap" aria-label="Map of street trees in New Orleans, colored by species"></canvas><div class="scalebar"><span></span><i></i></div><div class="mapctl"></div>';
    cv = plot.querySelector('canvas'); ctx = cv.getContext('2d'); scaleEl = plot.querySelector('.scalebar');
    const zoomAt = (f, x, y) => { const ns = Math.max(1500, Math.min(600000, view.s * f)); f = ns / view.s; view.tx = x - (x - view.tx) * f; view.ty = y - (y - view.ty) * f; view.s = ns; req(); };
    const ctl = plot.querySelector('.mapctl');
    [['+', 'Zoom in', () => zoomAt(1.8, (insetL() + W) / 2, H / 2)], ['−', 'Zoom out', () => zoomAt(1 / 1.8, (insetL() + W) / 2, H / 2)], ['⤢', 'Reset view', () => zoomToHood()]].forEach(([t, l, fn]) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.title = l; b.setAttribute('aria-label', l); b.onclick = fn; ctl.appendChild(b); });
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
      if (!moved && e.type === 'pointerup') { if (e.button === 0) clickHood(e.offsetX, e.offsetY); hover(e, e.offsetX, e.offsetY, true); } };
    cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { tip.hide(); if (hoverHood >= 0 || hoverTree >= 0 || hoverGS >= 0) { hoverHood = hoverTree = hoverGS = -1; req(); } } });
    cv.addEventListener('dblclick', e => zoomAt(2, e.offsetX, e.offsetY));
    addEventListener('resize', () => { if (!cv.offsetParent) return; const ow = W, oh = H; resize(); view.tx += (W - ow) / 2; view.ty += (H - oh) / 2; req(); });
    const reTheme = () => { readColors(); refresh(); };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reTheme);
    new MutationObserver(reTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    resize(); zoomToHood();
  }
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  let lastNb;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true); panelEl = panel;
    panel.innerHTML = '';
    nbSection(panel); findSection(panel); settingSection(panel); speciesSection(panel); layerSection(panel); shadeSection(panel);
    if (first) { initMap(plot); lastNb = selNb; }
    else if (W !== cv.clientWidth || H !== cv.clientHeight) { resize(); zoomToHood(); }
    if (lastNb !== selNb) { zoomToHood(); lastNb = selNb; }
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
      .style('cursor', d => d.onClick ? 'pointer' : null)
      .on('mousemove', (ev, d) => tip.show(`<b>${esc(d.name)}</b>` + (d.sub ? `<div style="color:var(--ink2)"><i>${esc(d.sub)}</i></div>` : '') + row(label, fmt(d.v)) + (d.extra || ''), ev)).on('mouseleave', tip.hide)
      .on('click', (ev, d) => { if (d.onClick) { tip.hide(); d.onClick(); } });
  }
  function drawSpecies(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = ''; nbSection(panel); settingSection(panel);
    const cnt = new Map(); let tot = 0;
    for (let i = 0; i < N; i++) if (valid[i] && inNb(i) && setOk(i)) { cnt.set(D.s[i], (cnt.get(D.s[i]) || 0) + 1); tot++; }
    const items = [...cnt].map(([i, v]) => ({ name: D.species[i][0], sub: D.species[i][1], v, i })).sort((a, b) => b.v - a.v).slice(0, 30)
      .map(d => ({ ...d, color: groups[spGroup[d.i]].color, extra: row('Share', (100 * d.v / tot).toFixed(1) + '%'), onClick: () => { selSp = d.i; location.hash = 'map'; } }));
    hbars(plot, items);
  }
  function drawHoods(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = ''; findSection(panel); settingSection(panel);
    NOLA.seg(NOLA.fsec(panel, 'Count'), [[0, 'Trees'], [1, 'Trees per sq. mi.']], dens ? 1 : 0, v => { dens = !!v; refresh(); });
    const cnt = hoods.map(() => 0); for (let i = 0; i < N; i++) if (valid[i] && setOk(i) && (selSp < 0 || D.s[i] === selSp)) cnt[D.h[i]]++;
    const items = hoodList.map(([h, hi]) => { const n = cnt[hi], v = dens ? Math.round(n / h.sqmi) : n;
      return { name: h.name, v, color: hi === selNb ? 'var(--ink)' : null, extra: (dens ? row('Trees', fmt(n)) : row('Per sq. mi.', fmt(Math.round(n / h.sqmi)))) + row('All trees here', fmt(h.n)),
        onClick: () => { selNb = hi; location.hash = 'map'; } }; }).filter(d => d.v > 0).sort((a, b) => b.v - a.v);
    const col = selSp >= 0 ? (spGroup[selSp] < 9 ? groups[spGroup[selSp]].color : TOP_COLORS[0]) : 'var(--s3)';
    hbars(plot, items, { color: col, label: (selSp >= 0 ? D.species[selSp][0] : 'Trees') + (dens ? ' per sq. mi.' : '') });
  }

  // ---------- CSV downloads ----------
  const ll = i => [+(D.x[i] * 1e-5 + D.lon0).toFixed(6), +(D.y[i] * 1e-5 + D.lat0).toFixed(6)];
  const csvMap = () => { const o = []; for (let i = 0; i < N; i++) if (isVisible(i)) { const [lon, lat] = ll(i), sp = D.species[D.s[i]], gk = D.tg[i];
    o.push({ species: sp[0], botanical_name: sp[1], neighborhood: hoods[D.h[i]].name, setting: SETTINGS[tset[i]].name, green_space: gk >= 0 ? GS[gk].nm : '', near_street: D.near[i] >= 0 ? D.roadNames[D.near[i]] : '', lon, lat }); } return o; };
  const csvSpecies = () => { const cnt = new Map(); for (let i = 0; i < N; i++) if (valid[i] && inNb(i) && setOk(i)) cnt.set(D.s[i], (cnt.get(D.s[i]) || 0) + 1);
    return [...cnt].sort((a, b) => b[1] - a[1]).map(([i, v]) => ({ species: D.species[i][0], botanical_name: D.species[i][1], trees: v })); };
  const csvHoods = () => hoodList.map(([h]) => ({ neighborhood: h.name, trees: h.n, sq_mi: +h.sqmi.toFixed(2), trees_per_sq_mi: Math.round(h.n / h.sqmi), species_count: h.sp.size }));

  readColors();
  const V = NOLA.views([
    { id: 'map', label: 'Map of every tree', keep: true, draw: drawMap, csv: csvMap },
    { id: 'species', label: 'Most common species', draw: drawSpecies, csv: csvSpecies },
    { id: 'hoods', label: 'Trees by neighborhood', draw: drawHoods, csv: csvHoods },
  ], { ds: ['3tyj-9x33', 'Tree Location'],
       state: () => ({ sp: selSp >= 0 ? selSp : null, nb: selNb >= 0 ? selNb : null, set: setF >= 0 ? setF : null, dens: dens ? 1 : null }) });
})();
