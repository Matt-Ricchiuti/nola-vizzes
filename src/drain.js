// Drainage page: 311 drainage requests, and the City's catch basins with the cleanings its log records
(() => {
  const DR = DATA.dr, CB = DATA.cb; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA, GEO = NOLA.GEO;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;

  // ---------- requests: one dot per located 311 drainage request since Feb 2019 (DR.dots; see pipeline) ----------
  const R = NOLA.dotData(DR.dots), RN = R.n, G = DR.G, NG = G.length;
  const gColor = g => g === NG - 1 ? 'var(--muted)' : NOLA.S(g);
  const LASTD = R.dayOf(DR.last), lastLabel = NOLA.isoDate(DR.last).replace(/, \d+$/, '');
  const isOpen = i => R.c[i] === -1;
  const PER = [['1', 'Month'], ['6', '6 months'], ['12', 'Year'], ['all', 'Since 2019']];
  const perLabel = { 1: 'in the past month', 6: 'in the past 6 months', 12: 'in the past year', all: 'since Feb 2019' };

  // ---------- basins: one dot per catch basin in the City's inventory (CB.dots) ----------
  // day: the last cleaning the City's log records (the log ends CB.logLast, so this is never "time since cleaned")
  const B = NOLA.dotData(CB.dots), BN = B.n;
  const logEnd = NOLA.isoDate(CB.logLast), logEndShort = logEnd.replace(/, (\d+)$/, ', $1');
  // blues for when the last cleaning was logged (stronger = more recent); orange, not gray, for none, since the gray
  // street lines under the basins would hide gray dots and the map would look cleaner than the log says
  const LC = [['2023 to Jan 2025', 'var(--q6)'], ['2020–2022', 'var(--q4)'], ['2017–2019', 'var(--q2)'], ['None in the log', 'var(--s2)']];
  const y23 = B.dayOf('2023-01-01'), y20 = B.dayOf('2020-01-01');
  const lcOf = Int8Array.from({ length: BN }, (_, i) => B.day[i] < 0 ? 3 : B.day[i] >= y23 ? 0 : B.day[i] >= y20 ? 1 : 2);
  const TL = { Vertical: 'Vertical', Rollover: 'Rollover', CB: 'Not specified (CB)', Inlet: 'Inlet', 'Not recorded': 'Type not recorded' };
  const typeName = t => TL[CB.T[t]] || CB.T[t];
  const nbAll = new Array(72).fill(0); for (let i = 0; i < BN; i++) nbAll[B.nb[i]]++;
  const WC = ['var(--s1)', 'var(--s3)', 'var(--s2)'];   // cleaned, inspected, inaccessible

  // ---------- state (in the link) ----------
  const H = NOLA.hashState();
  const int = (v, lo, hi) => v != null && +v >= lo && +v < hi ? +v : -1;
  const st = { mode: H.m === 'cb' ? 'cb' : 'req', nb: int(H.nb, 0, 72), heat: H.heat === '1', pc: H.pc === '1', sh: H.sh === '1',
               per: ['1', '6', '12', 'all'].includes(H.p) ? H.p : '12', stat: ['open', 'closed'].includes(H.stat) ? H.stat : 'all',
               g: int(H.g, 0, NG), t: int(H.t, 0, CB.T.length), lc: int(H.lc, 0, LC.length) };
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  const okNb = nb => st.nb < 0 || nb === st.nb;
  const reqBase = i => NOLA.inPeriod(R.day[i], LASTD, st.per) && (st.stat === 'all' || (st.stat === 'open') === isOpen(i));
  const reqOk = i => reqBase(i) && (st.g < 0 || R.g[i] === st.g) && okNb(R.nb[i]);
  const cbOk = i => (st.t < 0 || B.t[i] === st.t) && (st.lc < 0 || lcOf[i] === st.lc) && okNb(B.nb[i]);

  const mapLabel = () => st.mode === 'cb' ? `Catch basins, by the last cleaning recorded (the log ends ${logEndShort})`
    : `${st.stat === 'open' ? 'Open drainage requests' : st.stat === 'closed' ? 'Closed drainage requests' : 'Drainage requests'} filed ${perLabel[st.per]}`;

  // ---------- the map ----------
  // closed requests drawn faint, under the open ones; basins drawn oldest record first, the newest on top
  const REQ_COLORS = [...G.map((g, k) => [gColor(k), .4]), ...G.map((g, k) => gColor(k))];
  const CB_COLORS = [LC[3][1], LC[2][1], LC[1][1], LC[0][1]];
  // 80,000 basins: smaller dots than the other maps' while zoomed out, so neighbors overlap less
  const cbR = k => Math.max(.8, Math.min(5, 1.5 * Math.sqrt(k)));
  let m, modeEl, nbCnt = new Array(72).fill(0);
  const heatVal = i => st.mode === 'cb' ? (st.sh ? (nbAll[i] ? nbCnt[i] / nbAll[i] : null) : nbCnt[i])
    : (st.pc ? NOLA.perK(nbCnt[i], NOLA.popOf(i)) : nbCnt[i]);
  const keyLabel = () => st.mode === 'cb' ? (st.sh ? "Share of the neighborhood's basins shown" : 'Basins shown, by neighborhood')
    : 'Requests shown' + (st.pc ? ' per 1,000 residents' : '') + ', by neighborhood';
  const pctf = v => v == null ? '—' : Math.round(v * 100) + '%';

  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    nbCnt = new Array(72).fill(0); let shown = 0;
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    if (st.mode === 'req') {
      const gCnt = new Array(NG).fill(0);
      for (let i = 0; i < RN; i++) {
        if (!reqBase(i)) continue;
        const inNb = okNb(R.nb[i]);
        if (inNb) gCnt[R.g[i]]++;
        if (st.g < 0 || R.g[i] === st.g) { nbCnt[R.nb[i]]++; if (inNb) shown++; }
      }
      NOLA.periodSeg(NOLA.fsec(panel, 'Filed in the last'), st.per, v => set('per', v), PER);
      NOLA.seg(NOLA.fsec(panel, 'Status'), [['all', 'All'], ['open', 'Open'], ['closed', 'Closed']], st.stat, v => set('stat', v));
      // reasons the City no longer uses have no requests in recent periods: listed only when they have some
      NOLA.flist(NOLA.fsec(panel, `Reason · ${fmt(shown)} shown`, st.g >= 0 ? ['Show all', () => set('g', -1)] : null),
        G.map((g, k) => ({ key: k, name: g, color: gColor(k), count: gCnt[k] })).filter(it => it.count || it.key === st.g), { pressed: k => st.g === k, onClick: toggle('g') });
    } else {
      const lCnt = [0, 0, 0, 0], tCnt = new Array(CB.T.length).fill(0);
      for (let i = 0; i < BN; i++) {
        const inNb = okNb(B.nb[i]), okT = st.t < 0 || B.t[i] === st.t, okL = st.lc < 0 || lcOf[i] === st.lc;
        if (inNb && okT) lCnt[lcOf[i]]++;
        if (inNb && okL) tCnt[B.t[i]]++;
        if (okT && okL) { nbCnt[B.nb[i]]++; if (inNb) shown++; }
      }
      NOLA.flist(NOLA.fsec(panel, `Last cleaning recorded · ${fmt(shown)} shown`, st.lc >= 0 ? ['Show all', () => set('lc', -1)] : null),
        LC.map(([l, c], k) => ({ key: k, name: l, color: c, count: lCnt[k] })), { pressed: k => st.lc === k, onClick: toggle('lc') });
      NOLA.flist(NOLA.fsec(panel, 'Type', st.t >= 0 ? ['Show all', () => set('t', -1)] : null),
        CB.T.map((t, k) => ({ key: k, name: typeName(k), color: 'var(--ink2)', count: tCnt[k], square: true })), { pressed: k => st.t === k, onClick: toggle('t') });
    }
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of drainage requests and catch basins', tip: mapTip });
      m.lastNb = -1;
      // the two maps, switched from a pill floating at the top center of the map; the view stays put, so a spot can
      // be compared back and forth
      modeEl = document.createElement('div'); modeEl.className = 'ftabs tmode'; modeEl.setAttribute('role', 'tablist'); modeEl.setAttribute('aria-label', 'Map');
      [['req', 'Drainage requests (311)'], ['cb', 'Catch basins']].forEach(([v, l]) => {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.m = v; b.textContent = l;
        b.onclick = () => { if (st.mode !== v) { tip.hide(); set('mode', v); } }; modeEl.appendChild(b);
      });
      modeEl.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set('mode', st.mode === 'req' ? 'cb' : 'req'); modeEl.querySelector(`[data-m="${st.mode}"]`).focus(); } });
      plot.appendChild(modeEl);
    }
    modeEl.querySelectorAll('button').forEach(b => { const on = b.dataset.m === st.mode; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    if (st.mode === 'req') m.dots({ x: R.x, y: R.y, n: RN, colors: REQ_COLORS, color: i => (isOpen(i) ? NG : 0) + R.g[i], visible: reqOk, r: NOLA.dotR, tip: reqTip });
    else m.dots({ x: B.x, y: B.y, n: BN, colors: CB_COLORS, color: i => 3 - lcOf[i], visible: cbOk, r: cbR, tip: cbTip });
    NOLA.heatToggle(plot, st.heat, on => set('heat', on), st.mode === 'cb'
      ? { label: 'Share of its basins', checked: st.sh, onChange: on => set('sh', on) }
      : { label: 'Per 1k residents', checked: st.pc, onChange: on => set('pc', on) });
    const cl = st.heat ? NOLA.classes(d3.range(72).map(heatVal)) : null;
    m.setFill(cl ? i => cl.color(heatVal(i)) : () => null);
    const none = cl && d3.range(72).some(i => heatVal(i) == null) ? (st.mode === 'cb' ? 'No basins' : 'Under 1,000 residents') : null;
    NOLA.heatKey(panel, plot, cl, keyLabel(), st.mode === 'cb' && st.sh ? pctf : NOLA.short, none);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function reqTip(i) {
    const c = R.c[i], age = LASTD - R.day[i];
    const status = c === -1 ? `Open, ${plural(age, 'day')}` : c === 0 ? 'Closed the same day' : c > 0 ? `Closed after ${plural(c, 'day')}` : 'Closed';
    return `<b>${esc(G[R.g[i]])}</b><div style="color:var(--ink2)">311 drainage request</div>`
      + row('Filed', NOLA.isoDate(R.iso(R.day[i]))) + row('Status', status) + row('Neighborhood', nbName(R.nb[i]));
  }
  function cbTip(i) {
    const d = B.day[i], k = B.k[i];
    return `<b>Catch basin</b><div style="color:var(--ink2)">${esc(typeName(B.t[i]))} · ${esc(CB.S[B.s[i]])}</div>`
      + row('Last cleaning recorded', d < 0 ? 'None in the log' : NOLA.isoDate(B.iso(d)))
      + (k > 1 ? row('Cleanings recorded', fmt(k)) : '')
      + (B.rs[i] >= 0 ? row('Reason given', CB.RS[B.rs[i]]) : '')
      + (B.v[i] >= 0 ? row('Later visit', `${CB.W[B.v[i]]}, ${NOLA.isoDate(B.iso(B.vd[i]))}`) : '')
      + row('Neighborhood', nbName(B.nb[i]));
  }
  function mapTip(i) {
    if (st.mode === 'cb') return `<b>${GEO.nb[i].name}</b>` + row('Basins shown', fmt(nbCnt[i])) + row('All basins here', fmt(nbAll[i]))
      + row('Share', nbAll[i] ? NOLA.pct(nbCnt[i], nbAll[i]) : '—');
    const pop = NOLA.popOf(i), rate = NOLA.perK(nbCnt[i], pop);
    return `<b>${GEO.nb[i].name}</b>` + row('Requests shown', fmt(nbCnt[i])) + row('Residents (2020)', pop == null ? '—' : fmt(pop))
      + (rate != null ? row('Per 1,000 residents', NOLA.fmtRate(rate)) : '');
  }

  // ---------- per year ----------
  // requests: filed per year, split by whether they're closed now; basins: visits the log records per year (citywide)
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
    const step = f.iw < 420 ? 2 : 1;
    f.g.selectAll('text.x').data(years.filter((yy, k) => k % step === 0)).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }
  const Y0 = +DR.start.slice(0, 4), RY = d3.range(Y0, +DR.last.slice(0, 4) + 1);
  const yearOf = new Int16Array(RN); for (let i = 0; i < RN; i++) yearOf[i] = +R.iso(R.day[i]).slice(0, 4);
  function drawYears(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    if (st.mode === 'cb') {
      const tot = CB.W.map((w, s) => d3.sum(CB.yw, r => r[s]));
      NOLA.kv(NOLA.fsec(panel, 'Visits the log records, citywide'), CB.W.map((w, s) => [w, WC[s], fmt(tot[s])]));
      const last = CB.years.length - 1;
      bars(plot, CB.years, CB.yw, WC, k => k === last, k => 'to ' + logEnd.replace(/, \d+$/, ''),
        k => `<b>${CB.years[k]}${k === last ? ', through ' + logEnd.replace(/, \d+$/, '') + ' (the log ends)' : ''}</b>`
          + NOLA.descending(CB.W.map((w, s) => CB.yw[k][s]), CB.W).map(s => row(sw(WC[s]) + CB.W[s], fmt(CB.yw[k][s]))).join(''));
    } else {
      NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
      const gCnt = new Array(NG).fill(0), filed = RY.map(() => 0), open = RY.map(() => 0), days = RY.map(() => []);
      for (let i = 0; i < RN; i++) {
        if (!okNb(R.nb[i])) continue;
        gCnt[R.g[i]]++;
        if (st.g >= 0 && R.g[i] !== st.g) continue;
        const k = yearOf[i] - Y0; filed[k]++;
        if (isOpen(i)) open[k]++; else if (R.c[i] >= 0) days[k].push(R.c[i]);
      }
      NOLA.kv(NOLA.fsec(panel, 'Status now'), [['Closed', 'var(--s1)', fmt(d3.sum(filed) - d3.sum(open))], ['Still open', 'var(--s2)', fmt(d3.sum(open))]]);
      NOLA.flist(NOLA.fsec(panel, 'Reason', st.g >= 0 ? ['Show all', () => set('g', -1)] : null),
        G.map((g, k) => ({ key: k, name: g, color: gColor(k), count: gCnt[k] })), { pressed: k => st.g === k, onClick: toggle('g') });
      const partial = k => k === 0 || k === RY.length - 1;
      bars(plot, RY, RY.map((yy, k) => [filed[k] - open[k], open[k]]), ['var(--s1)', 'var(--s2)'], partial,
        k => k === RY.length - 1 ? 'to ' + lastLabel : 'from Feb',
        k => `<b>${RY[k]}${k === 0 ? ', from February' : k === RY.length - 1 ? ', through ' + lastLabel : ''}</b>`
          + (st.g >= 0 || st.nb >= 0 ? `<div style="color:var(--ink2)">${[st.g >= 0 ? G[st.g] : '', st.nb >= 0 ? nbName(st.nb) : ''].filter(Boolean).join(' · ')}</div>` : '')
          + row('Filed', fmt(filed[k])) + row(sw('var(--s1)') + 'Closed', fmt(filed[k] - open[k])) + row(sw('var(--s2)') + 'Still open', fmt(open[k]))
          + (days[k].length >= 5 ? row('Median days to close', fmt(Math.round(d3.median(days[k])))) : ''));
    }
    // the same choice as the map's switch, at the top of the panel
    NOLA.ftabs(panel, [['req', 'Requests (311)'], ['cb', 'Basin work']], st.mode, v => set('mode', v));
  }

  const V = NOLA.views([
    { id: 'map', label: mapLabel, tab: 'Map', keep: true, draw: drawMap },
    { id: 'years', label: () => st.mode === 'cb' ? `Catch basin work recorded per year (the log ends ${logEndShort})` : 'Drainage requests per year, by status now', tab: 'Per year', draw: drawYears },
  ], { ds: [DR.ds, '311 OPCD Calls'],
       state: () => ({ m: st.mode === 'cb' ? 'cb' : null, nb: st.nb >= 0 ? st.nb : null, heat: st.heat ? 1 : null, pc: st.pc ? 1 : null, sh: st.sh ? 1 : null,
                       p: st.per !== '12' ? st.per : null, stat: st.stat !== 'all' ? st.stat : null, g: st.g >= 0 ? st.g : null,
                       t: st.t >= 0 ? st.t : null, lc: st.lc >= 0 ? st.lc : null }) });
})();
