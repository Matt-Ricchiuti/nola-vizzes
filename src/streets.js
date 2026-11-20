// Streets page: 311 street and streetlight requests, and the City's road, sewer and water work, block by block.
// (This is the page's script; site/streets.js is the street base map every map shares, built from data/streets.json.)
(() => {
  const SQ = DATA.sq, RW = DATA.rw; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA, GEO = NOLA.GEO;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
  const muted = s => `<div style="color:var(--ink2)">${s}</div>`;

  // ---------- requests: one dot per located 311 street or streetlight request since Feb 2019 (SQ.dots; see pipeline) ----------
  const R = NOLA.dotData(SQ.dots), RN = R.n, G = SQ.G, NG = G.length, LIGHTS = SQ.lights;
  const GC = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s5)', 'var(--s7)', 'var(--s8)', 'var(--s4)', 'var(--s6)', 'var(--muted)'];
  const gColor = g => GC[g] || 'var(--muted)';
  const LASTD = R.dayOf(SQ.last), lastLabel = NOLA.isoDate(SQ.last).replace(/, \d+$/, '');
  const isOpen = i => R.c[i] === -1, isRoad = i => R.g[i] < LIGHTS;
  const PER = [['1', 'Month'], ['6', '6 months'], ['12', 'Year'], ['all', 'Since 2019']];
  const perLabel = { 1: 'in the past month', 6: 'in the past 6 months', 12: 'in the past year', all: 'since Feb 2019' };

  // ---------- road work: one dot per street segment in the City's DPW (paving) and SWB (sewer, water) project lists ----------
  // A segment can be in both lists (paving and the lines under it): ph is its paving phase, ss its sewer/water phase.
  const W = NOLA.dotData(RW.dots), WN = W.n, PH = RW.phases, P = RW.P;
  const PC = ['var(--s2)', 'var(--s1)', 'var(--s3)', 'var(--muted)'];          // under construction, planned, complete, not stated
  const PHC = [[PC[3], .7], [PC[2], .55], PC[1], PC[0]];                         // drawn: not stated, complete, planned, under construction on top
  const WK = [['all', 'All'], ['road', 'Paving'], ['sw', 'Sewer & water']];
  const hasRoad = i => W.ct[i] >= 0, hasSw = i => W.sk[i] >= 0;
  const both = (a, b) => a < 0 ? b : b < 0 ? a : Math.min(a, b);   // the earlier stage: work still to come shows over work done
  const phaseOf = (i, wk) => wk === 'road' ? W.ph[i] : wk === 'sw' ? W.ss[i] : both(W.ph[i], W.ss[i]);
  const segsOf = new Int32Array(P.length); for (let i = 0; i < WN; i++) { if (W.p[i] >= 0) segsOf[W.p[i]]++; if (W.sp[i] >= 0 && W.sp[i] !== W.p[i]) segsOf[W.sp[i]]++; }
  const projName = k => P[k][1] ? esc(P[k][1]) : `Project ${esc(P[k][0])}`;
  const money = v => v >= 1e6 ? '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + ' million' : '$' + fmt(v);
  const when = s => !s ? 'TBD' : /^\d{4}-/.test(s) ? NOLA.isoDate(s) : s;

  // ---------- what's near what: City work within NEAR map units (about 60 m, half a block) of each request ----------
  const NEAR = 3, NEAR_M = 60, cellOf = (x, y) => Math.floor(x / NEAR) * 100000 + Math.floor(y / NEAR);
  const grid = (n, X, Y, ok) => { const g = new Map(); for (let i = 0; i < n; i++) if (ok(i)) { const c = cellOf(X[i], Y[i]); (g.get(c) || g.set(c, []).get(c)).push(i); } return g; };
  const around = (g, x, y, fn) => { const cx = Math.floor(x / NEAR), cy = Math.floor(y / NEAR);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) (g.get((cx + dx) * 100000 + cy + dy) || []).forEach(fn); };
  const WG = grid(WN, W.x, W.y, () => true);
  // per road request: the nearest segment with work planned or under way, else the nearest with any work; its kind
  // (0 planned or under way, 1 finished or undated only, 2 none in the City's lists; -1 streetlights, not matched)
  const NK = [['Planned or under way', 'var(--s1)'], ['Finished or undated only', 'var(--s3)'], [`None within ${NEAR_M} m`, 'var(--muted)']];
  const nearSeg = new Int32Array(RN).fill(-1), nearKind = new Int8Array(RN).fill(-1), nearDist = new Float32Array(RN);
  for (let i = 0; i < RN; i++) {
    if (!isRoad(i)) continue;
    let best = -1, bd = NEAR, act = false;
    around(WG, R.x[i], R.y[i], j => {
      const d = Math.hypot(W.x[j] - R.x[i], W.y[j] - R.y[i]); if (d > NEAR) return;
      const a = phaseOf(j, 'all') <= 1;
      if ((a && !act) || (a === act && d < bd)) { best = j; bd = d; act = a; }
    });
    nearSeg[i] = best; nearKind[i] = best < 0 ? 2 : act ? 0 : 1; nearDist[i] = bd;
  }
  // open road requests by segment, for the segment tooltips (built when first needed)
  let OG = null;
  const openNear = j => { if (!OG) OG = grid(RN, R.x, R.y, i => isOpen(i) && isRoad(i));
    let n = 0; around(OG, W.x[j], W.y[j], i => { if (Math.hypot(W.x[j] - R.x[i], W.y[j] - R.y[i]) <= NEAR) n++; }); return n; };

  // ---------- state (in the link) ----------
  const H = NOLA.hashState();
  const int = (v, lo, hi) => v != null && +v >= lo && +v < hi ? +v : -1;
  const st = { mode: H.m === 'rw' ? 'rw' : 'req', nb: int(H.nb, 0, 72), heat: H.heat === '1', pc: H.pc === '1',
               per: ['1', '6', '12', 'all'].includes(H.p) ? H.p : '12', stat: ['open', 'closed'].includes(H.stat) ? H.stat : 'all',
               kind: ['light', 'all'].includes(H.k) ? H.k : 'road', g: int(H.g, 0, NG), nk: int(H.nk, 0, NK.length), ph: int(H.ph, 0, PH.length),
               wk: ['road', 'sw'].includes(H.wk) ? H.wk : 'all', ct: int(H.ct, 0, RW.CT.length) };
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  const okNb = nb => st.nb < 0 || nb === st.nb;
  // streetlight outages are half of all requests, so street and streetlight requests are shown apart by default
  const KIND = [['road', 'Streets'], ['light', 'Streetlights'], ['all', 'Both']];
  const kindOk = g => st.kind === 'all' || (st.kind === 'road') === (g < LIGHTS);
  const setKind = v => { if (st.g >= 0 && !(v === 'all' || (v === 'road') === (st.g < LIGHTS))) st.g = -1; if (v === 'light') st.nk = -1; set('kind', v); };
  const reqBase = i => kindOk(R.g[i]) && NOLA.inPeriod(R.day[i], LASTD, st.per) && (st.stat === 'all' || (st.stat === 'open') === isOpen(i));
  const okG = i => st.g < 0 || R.g[i] === st.g, okNk = i => st.nk < 0 || nearKind[i] === st.nk;
  const reqOk = i => reqBase(i) && okG(i) && okNk(i) && okNb(R.nb[i]);
  const inWork = i => st.wk === 'road' ? hasRoad(i) : st.wk === 'sw' ? hasSw(i) : true;
  const okCt = i => st.ct < 0 || W.ct[i] === st.ct;
  const rwOk = i => inWork(i) && okCt(i) && (st.ph < 0 || phaseOf(i, st.wk) === st.ph) && okNb(W.nb[i]);

  const kindLabel = () => ({ road: 'street', light: 'streetlight', all: 'street and streetlight' })[st.kind];
  const mapLabel = () => st.mode === 'rw' ? 'City road, sewer and water work, by phase (one dot per block)'
    : NOLA.cap(`${st.stat === 'open' ? 'open ' : st.stat === 'closed' ? 'closed ' : ''}${kindLabel()} requests filed ${perLabel[st.per]}`);

  // ---------- the map ----------
  // closed requests drawn faint, under the open ones
  const REQ_COLORS = [...G.map((g, k) => [gColor(k), .4]), ...G.map((g, k) => gColor(k))];
  let m, modeEl, nbCnt = new Array(72).fill(0);
  const heatVal = i => st.mode === 'req' && st.pc ? NOLA.perK(nbCnt[i], NOLA.popOf(i)) : nbCnt[i];
  const keyLabel = () => st.mode === 'rw' ? 'Blocks shown, by neighborhood' : 'Requests shown' + (st.pc ? ' per 1,000 residents' : '') + ', by neighborhood';

  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    nbCnt = new Array(72).fill(0); let shown = 0;
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    if (st.mode === 'req') {
      const gCnt = new Array(NG).fill(0), kCnt = [0, 0, 0];
      for (let i = 0; i < RN; i++) {
        if (!reqBase(i)) continue;
        const inNb = okNb(R.nb[i]);
        if (inNb && okNk(i)) gCnt[R.g[i]]++;
        if (inNb && okG(i) && nearKind[i] >= 0) kCnt[nearKind[i]]++;
        if (okG(i) && okNk(i)) { nbCnt[R.nb[i]]++; if (inNb) shown++; }
      }
      NOLA.seg(NOLA.fsec(panel, 'Requests about'), KIND, st.kind, setKind);
      NOLA.periodSeg(NOLA.fsec(panel, 'Filed in the last'), st.per, v => set('per', v), PER);
      NOLA.seg(NOLA.fsec(panel, 'Status'), [['all', 'All'], ['open', 'Open'], ['closed', 'Closed']], st.stat, v => set('stat', v));
      NOLA.flist(NOLA.fsec(panel, `Reason · ${fmt(shown)} shown`, st.g >= 0 ? ['Show all', () => set('g', -1)] : null),
        G.map((g, k) => ({ key: k, name: g, color: gColor(k), count: gCnt[k] })).filter(it => kindOk(it.key)), { pressed: k => st.g === k, onClick: toggle('g') });
      if (st.kind !== 'light') NOLA.flist(NOLA.fsec(panel, `City work within ${NEAR_M} m${st.kind === 'all' ? ' (street requests)' : ''}`, st.nk >= 0 ? ['Show all', () => set('nk', -1)] : null),
        NK.map(([l, c], k) => ({ key: k, name: l, color: c, count: kCnt[k], square: true })), { pressed: k => st.nk === k, onClick: toggle('nk') });
    } else {
      const pCnt = [0, 0, 0, 0], cCnt = new Array(RW.CT.length).fill(0), projs = new Set();
      for (let i = 0; i < WN; i++) {
        if (!inWork(i)) continue;
        const inNb = okNb(W.nb[i]), ph = phaseOf(i, st.wk), okP = st.ph < 0 || ph === st.ph;
        if (inNb && okCt(i) && ph >= 0) pCnt[ph]++;
        if (inNb && okP && W.ct[i] >= 0) cCnt[W.ct[i]]++;
        if (okCt(i) && okP) { nbCnt[W.nb[i]]++; if (inNb) { shown++; if (st.wk !== 'sw' && W.p[i] >= 0) projs.add(W.p[i]); if (st.wk !== 'road' && W.sp[i] >= 0) projs.add(W.sp[i]); } }
      }
      NOLA.seg(NOLA.fsec(panel, 'Work'), WK, st.wk, v => { st.ct = v === 'sw' ? -1 : st.ct; set('wk', v); });
      NOLA.flist(NOLA.fsec(panel, `Phase · ${fmt(shown)} blocks, ${plural(projs.size, 'project')}`, st.ph >= 0 ? ['Show all', () => set('ph', -1)] : null),
        PH.map((l, k) => ({ key: k, name: l, color: PC[k], count: pCnt[k] })), { pressed: k => st.ph === k, onClick: toggle('ph') });
      if (st.wk !== 'sw') NOLA.flist(NOLA.fsec(panel, 'Paving work', st.ct >= 0 ? ['Show all', () => set('ct', -1)] : null),
        RW.CT.map((t, k) => ({ key: k, name: esc(t), color: 'var(--ink2)', count: cCnt[k], square: true })).filter(it => it.count || it.key === st.ct), { pressed: k => st.ct === k, onClick: toggle('ct') });
    }
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of street requests and City road work', tip: mapTip });
      m.lastNb = -1;
      // the two maps, switched from a pill floating at the top center of the map; the view stays put, so a block can
      // be compared back and forth
      modeEl = document.createElement('div'); modeEl.className = 'ftabs tmode'; modeEl.setAttribute('role', 'tablist'); modeEl.setAttribute('aria-label', 'Map');
      [['req', 'Street requests (311)'], ['rw', 'Road work']].forEach(([v, l]) => {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.m = v; b.textContent = l;
        b.onclick = () => { if (st.mode !== v) { tip.hide(); set('mode', v); } }; modeEl.appendChild(b);
      });
      modeEl.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set('mode', st.mode === 'req' ? 'rw' : 'req'); modeEl.querySelector(`[data-m="${st.mode}"]`).focus(); } });
      plot.appendChild(modeEl);
    }
    modeEl.querySelectorAll('button').forEach(b => { const on = b.dataset.m === st.mode; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    if (st.mode === 'req') m.dots({ x: R.x, y: R.y, n: RN, colors: REQ_COLORS, color: i => (isOpen(i) ? NG : 0) + R.g[i], visible: reqOk, r: NOLA.dotR, tip: reqTip });
    else m.dots({ x: W.x, y: W.y, n: WN, colors: PHC, color: i => 3 - Math.max(0, phaseOf(i, st.wk)), visible: rwOk, r: NOLA.dotR, tip: rwTip });
    NOLA.heatToggle(plot, st.heat, on => set('heat', on), st.mode === 'rw' ? null : { label: 'Per 1k residents', checked: st.pc, onChange: on => set('pc', on) });
    const cl = st.heat ? NOLA.classes(d3.range(72).map(heatVal)) : null;
    m.setFill(cl ? i => cl.color(heatVal(i)) : () => null);
    const none = cl && d3.range(72).some(i => heatVal(i) == null) ? 'Under 1,000 residents' : null;
    NOLA.heatKey(panel, plot, cl, keyLabel(), NOLA.short, none);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function reqTip(i) {
    const c = R.c[i], age = LASTD - R.day[i], g = R.g[i];
    const status = c === -1 ? `Open, ${plural(age, 'day')}` : c === 0 ? 'Closed the same day' : c > 0 ? `Closed after ${plural(c, 'day')}` : 'Closed';
    let work = '';
    if (isRoad(i)) {
      const j = nearSeg[i];
      if (j < 0) work = row('City work nearby', `None within ${NEAR_M} m`);
      else {
        const k = W.p[j] >= 0 ? W.p[j] : W.sp[j], ph = phaseOf(j, 'all');
        work = row('City work nearby', `${sw(PC[Math.max(0, ph)])}${PH[Math.max(0, ph)]}, about ${Math.max(10, Math.round(nearDist[i] * 20 / 10) * 10)} m away`)
          + (k >= 0 ? row('Project', projName(k)) : '');
      }
    }
    return `<b>${esc(G[g])}</b>${muted(`311 ${g < LIGHTS ? 'street' : 'streetlight'} request`)}`
      + row('Filed', NOLA.isoDate(R.iso(R.day[i]))) + row('Status', status) + row('Neighborhood', nbName(R.nb[i])) + work;
  }
  function rwTip(i) {
    const k = W.p[i] >= 0 ? W.p[i] : W.sp[i], p = k >= 0 ? P[k] : null, on = openNear(i);
    const phs = v => v >= 0 ? sw(PC[v]) + PH[v] : '—';
    let h = p ? `<b>${projName(k)}</b>${muted(`A block of project ${esc(p[0])}${segsOf[k] > 1 ? ` (${fmt(segsOf[k])} blocks)` : ''}`)}`
      : `<b>Sewer and water work</b>${muted('No project id in the City\'s list')}`;
    if (hasRoad(i)) h += row('Paving', `${esc(RW.CT[W.ct[i]])}`) + row('Paving phase', phs(W.ph[i]));
    if (hasSw(i)) h += row('Sewer & water', esc(RW.ST[W.st[i]])) + row(hasRoad(i) ? 'Sewer & water phase' : 'Phase', phs(W.ss[i]))
      + (W.sp[i] >= 0 && W.sp[i] !== W.p[i] && W.p[i] >= 0 ? row('Sewer & water project', esc(P[W.sp[i]][0])) : '');
    if (p) {
      if (p[3]) h += row('Program', esc(p[3]));
      if (p[6] || p[7]) h += row('Start – end', `${when(p[6])} – ${when(p[7])}`);
      if (p[4]) h += row('Contractor', esc(p[4]));
      if (p[5]) h += row('Project total', money(p[5]) + ' <span style="color:var(--ink2)">(whole project)</span>');
    }
    return h + row('Neighborhood', nbName(W.nb[i])) + row(`Open road requests within ${NEAR_M} m`, fmt(on));
  }
  function mapTip(i) {
    if (st.mode === 'rw') return `<b>${GEO.nb[i].name}</b>` + row('Blocks shown', fmt(nbCnt[i]));
    const pop = NOLA.popOf(i), rate = NOLA.perK(nbCnt[i], pop);
    return `<b>${GEO.nb[i].name}</b>` + row('Requests shown', fmt(nbCnt[i])) + row('Residents (2020)', pop == null ? '—' : fmt(pop))
      + (rate != null ? row('Per 1,000 residents', NOLA.fmtRate(rate)) : '');
  }

  // ---------- per year ----------
  // requests: filed per year, split by whether they're closed now; road work: projects by the year they end
  function bars(plot, years, stacks, colors, partial, partLabel, tipFor) {
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 380, m: { t: 14, r: 10, b: 28, l: 48 } });
    const x = d3.scaleBand().domain(years).range([0, f.iw]).paddingInner(.22);
    const tot = k => d3.sum(stacks[k]);
    const y = d3.scaleLinear().domain([0, Math.max(4, (d3.max(years, (yy, k) => tot(k)) || 0) * 1.05)]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5);
    years.forEach((yy, k) => { let y0 = 0; stacks[k].forEach((v, s) => { if (!v) return;
      f.g.append('rect').attr('x', x(yy)).attr('width', x.bandwidth()).attr('y', y(y0 + v) + 1).attr('height', Math.max(.5, y(y0) - y(y0 + v) - 1))
        .attr('fill', colors[s]).attr('rx', 1.5).attr('opacity', partial(k) ? .45 : 1); y0 += v; }); });
    years.forEach((yy, k) => { if (partial(k) && partLabel(k)) f.g.append('text').attr('class', 'halo').attr('x', x(yy) + x.bandwidth() / 2).attr('y', y(tot(k)) - 5)
      .attr('text-anchor', 'middle').style('fill', 'var(--ink2)').style('font-size', '11px').text(partLabel(k)); });
    f.g.selectAll('rect.h').data(years).join('rect').attr('class', 'h').attr('x', yy => x(yy) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => tip.show(tipFor(years.indexOf(yy)), ev)).on('mouseleave', tip.hide);
    const step = f.iw < 420 ? (years.length > 14 ? 4 : 2) : years.length > 16 ? 2 : 1;
    f.g.selectAll('text.x').data(years.filter((yy, k) => k % step === 0)).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }
  const Y0 = +SQ.start.slice(0, 4), RY = d3.range(Y0, +SQ.last.slice(0, 4) + 1);
  const yearOf = new Int16Array(RN); for (let i = 0; i < RN; i++) yearOf[i] = +R.iso(R.day[i]).slice(0, 4);
  const thisYear = +SQ.last.slice(0, 4);
  function drawYears(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    if (st.mode === 'rw') {
      // projects (not blocks), by the year their end date falls in; the phase is the one most of their blocks give
      const ys = P.filter(p => p[8]).map(p => p[8]), YS = d3.range(d3.min(ys), d3.max(ys) + 1);
      const cnt = YS.map(() => [0, 0, 0, 0]), noDate = [0, 0, 0, 0];
      P.forEach(p => { if (p[8]) cnt[p[8] - YS[0]][p[2]]++; else noDate[p[2]]++; });
      const order = [2, 0, 1, 3];   // complete at the bottom, then under construction, planned
      NOLA.kv(NOLA.fsec(panel, 'Projects, by phase'), order.map(k => [PH[k], PC[k], fmt(RW.projects[k])]));
      NOLA.kv(NOLA.fsec(panel, 'No end date given'), order.filter(k => noDate[k]).map(k => [PH[k], PC[k], fmt(noDate[k])]));
      bars(plot, YS, cnt.map(c => order.map(k => c[k])), order.map(k => PC[k]), k => YS[k] >= thisYear, k => YS[k] > thisYear && d3.sum(cnt[k]) ? 'due' : '',
        k => `<b>${YS[k]}</b>${muted(YS[k] > thisYear ? 'Projects due to end this year' : YS[k] === thisYear ? 'Projects that ended or are due to end' : 'Projects that ended this year')}`
          + order.map(s => cnt[k][s] ? row(sw(PC[s]) + PH[s], fmt(cnt[k][s])) : '').join(''));
    } else {
      NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
      NOLA.seg(NOLA.fsec(panel, 'Requests about'), KIND, st.kind, setKind);
      const gCnt = new Array(NG).fill(0), filed = RY.map(() => 0), open = RY.map(() => 0), days = RY.map(() => []);
      for (let i = 0; i < RN; i++) {
        if (!okNb(R.nb[i]) || !kindOk(R.g[i])) continue;
        gCnt[R.g[i]]++;
        if (!okG(i)) continue;
        const k = yearOf[i] - Y0; filed[k]++;
        if (isOpen(i)) open[k]++; else if (R.c[i] >= 0) days[k].push(R.c[i]);
      }
      NOLA.kv(NOLA.fsec(panel, 'Status now'), [['Closed', 'var(--s1)', fmt(d3.sum(filed) - d3.sum(open))], ['Still open', 'var(--s2)', fmt(d3.sum(open))]]);
      NOLA.flist(NOLA.fsec(panel, 'Reason', st.g >= 0 ? ['Show all', () => set('g', -1)] : null),
        G.map((g, k) => ({ key: k, name: g, color: gColor(k), count: gCnt[k] })).filter(it => kindOk(it.key)), { pressed: k => st.g === k, onClick: toggle('g') });
      const partial = k => k === 0 || k === RY.length - 1;
      bars(plot, RY, RY.map((yy, k) => [filed[k] - open[k], open[k]]), ['var(--s1)', 'var(--s2)'], partial,
        k => k === RY.length - 1 ? 'to ' + lastLabel : 'from Feb',
        k => `<b>${RY[k]}${k === 0 ? ', from February' : k === RY.length - 1 ? ', through ' + lastLabel : ''}</b>`
          + (st.g >= 0 || st.nb >= 0 ? muted([st.g >= 0 ? G[st.g] : '', st.nb >= 0 ? nbName(st.nb) : ''].filter(Boolean).join(' · ')) : '')
          + row('Filed', fmt(filed[k])) + row(sw('var(--s1)') + 'Closed', fmt(filed[k] - open[k])) + row(sw('var(--s2)') + 'Still open', fmt(open[k]))
          + (days[k].length >= 5 ? row('Median days to close', fmt(Math.round(d3.median(days[k])))) : ''));
    }
    // the same choice as the map's switch, at the top of the panel
    NOLA.ftabs(panel, [['req', 'Requests (311)'], ['rw', 'Road work']], st.mode, v => set('mode', v));
  }

  const V = NOLA.views([
    { id: 'map', label: mapLabel, tab: 'Map', keep: true, draw: drawMap },
    { id: 'years', label: () => st.mode === 'rw' ? 'Road work projects by the year they end' : NOLA.cap(`${kindLabel()} requests per year, by status now`), tab: 'Per year', draw: drawYears },
  ], { ds: [SQ.ds, '311 OPCD Calls'],
       state: () => ({ m: st.mode === 'rw' ? 'rw' : null, k: st.kind !== 'road' ? st.kind : null, nb: st.nb >= 0 ? st.nb : null, heat: st.heat ? 1 : null, pc: st.pc ? 1 : null,
                       p: st.per !== '12' ? st.per : null, stat: st.stat !== 'all' ? st.stat : null, g: st.g >= 0 ? st.g : null,
                       nk: st.nk >= 0 ? st.nk : null, ph: st.ph >= 0 ? st.ph : null, wk: st.wk !== 'all' ? st.wk : null, ct: st.ct >= 0 ? st.ct : null }) });
})();
