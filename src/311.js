// 311 service requests page
(() => {
  const D = DATA.sr; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const NT = D.T.length, GEO = NOLA.GEO;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const byName = (a, b) => a.localeCompare(b);
  // the seven most-requested types get a color; the rest share gray
  const tColor = t => t < 7 ? NOLA.S(t) : 'var(--muted)';
  const lastISO = D.last, lastLabel = NOLA.isoDate(lastISO).replace(/, \d+$/, '');
  const AGE_L = ['Under 30 days', '30–89 days', '90 days to 1 year', '1–2 years', 'Over 2 years'];
  const AGE_C = ['var(--q2)', 'var(--q3)', 'var(--q4)', 'var(--q5)', 'var(--q7)'];

  const H = NOLA.hashState();
  const st = { nb: H.nb != null ? +H.nb : -1, type: H.type != null ? +H.type : -1, reason: H.reason != null ? +H.reason : -1,
               measure: H.measure === 'open' ? 'open' : 'made', basis: H.basis === 'pc' ? 'pc' : 'n' };
  if (!(st.nb >= -1 && st.nb < 72)) st.nb = -1;
  if (!(st.type >= -1 && st.type < NT)) st.type = -1;
  if (!(st.reason >= 0) || !D.R[st.reason] || D.R[st.reason][0] !== st.type) st.reason = -1;
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; if (k === 'type') st.reason = -1; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  const reasonName = r => D.R[r][1] === 'Other' ? `Other ${D.T[D.R[r][0]].toLowerCase().replace(/ requests?$/, '')} requests` : D.R[r][1];
  // reasons apply to requests made in the past 12 months; open requests are counted by type only
  const rsn = () => st.measure === 'made' ? st.reason : -1;

  // ---------- the map: a dot per request ----------
  // Dots: every request filed in the past 12 months, and every request still open, of any age (D.dots, from the
  // pipeline). The "Filed" tab filters by when it was filed (the past month, 6 months or year) and its status; "Open now"
  // by how long it has been open. The heatmap (a checkbox on the map) counts the dots shown per neighborhood.
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = NOLA.dotData(D.dots), PN = P.n;
  const pType = Int16Array.from(P.r, r => P.R[r][0]);
  const LASTD = P.dayOf(D.last), WIN0 = P.dayOf(D.winStart);
  const ageOf = i => LASTD - P.day[i];
  const ageBucket = i => { const a = ageOf(i); return a < 30 ? 0 : a < 90 ? 1 : a < 365 ? 2 : a < 730 ? 3 : 4; };
  st.per = ['1', '6', '12'].includes(H.p) ? H.p : '1';
  st.stat = ['open', 'closed'].includes(H.stat) ? H.stat : 'all';
  st.age = H.age != null && +H.age >= 0 && +H.age < 5 ? +H.age : -1;
  st.heat = H.heat === '1';
  const isOpen = i => P.c[i] === -1;
  // the filters, apart from type, reason and neighborhood
  const base = i => st.measure === 'open' ? isOpen(i) && (st.age < 0 || ageBucket(i) === st.age)
    : P.day[i] >= WIN0 && NOLA.inPeriod(P.day[i], LASTD, st.per) && (st.stat === 'all' || (st.stat === 'open') === isOpen(i));
  const okType = i => st.type < 0 || pType[i] === st.type, okReason = i => rsn() < 0 || P.r[i] === st.reason;
  const okNb = i => st.nb < 0 || P.nb[i] === st.nb;
  const visible = i => base(i) && okType(i) && okReason(i) && okNb(i);
  // colors: one per named type, gray for the rest; closed requests drawn fainter, under the open ones
  const COLORS = [['var(--muted)', .45], ...d3.range(7).map(t => [tColor(t), .45]), 'var(--muted)', ...d3.range(7).map(t => tColor(t))];
  const colorOf = i => (isOpen(i) ? 8 : 0) + (pType[i] < 7 ? 1 + pType[i] : 0);
  let nbCnt = new Array(72).fill(0);
  const filterName = () => rsn() >= 0 ? reasonName(st.reason) : st.type >= 0 ? D.T[st.type] : '';
  const perLabel = { 1: 'month', 6: '6 months', 12: 'year' };
  const mapLabel = () => st.measure === 'open' ? 'Open requests' : `Requests filed in the past ${perLabel[st.per]}`;
  const keyLabel = () => (st.measure === 'open' ? 'Open requests' : 'Requests shown') + (st.basis === 'pc' ? ' per 1,000 residents' : '') + ', by neighborhood';
  const heatVal = i => st.basis === 'pc' ? NOLA.perK(nbCnt[i], NOLA.popOf(i)) : nbCnt[i];

  let m;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    // counts under the current filters: per type, per reason, per age, and per neighborhood (for the heatmap)
    const tCnt = new Array(NT).fill(0), rCnt = new Array(P.R.length).fill(0), aCnt = [0, 0, 0, 0, 0];
    nbCnt = new Array(72).fill(0); let shown = 0;
    for (let i = 0; i < PN; i++) {
      const b = base(i), ty = okType(i), rs = okReason(i), nb = okNb(i);
      if (b && nb) { tCnt[pType[i]]++; if (ty) rCnt[P.r[i]]++; }
      if (b && ty && rs) { nbCnt[P.nb[i]]++; if (nb) shown++; }
      if (st.measure === 'open' && isOpen(i) && ty && rs && nb) aCnt[ageBucket(i)]++;
    }
    NOLA.ftabs(panel, [['made', 'Filed'], ['open', 'Open now']], st.measure, v => set('measure', v));
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    if (st.nb >= 0) yearsMini(NOLA.fsec(panel, 'Requests per year' + (st.type >= 0 ? ' · ' + D.T[st.type] : '')), st.nb);
    if (st.measure === 'made') {
      NOLA.periodSeg(NOLA.fsec(panel, 'Filed in the last'), st.per, v => set('per', v), NOLA.PERIODS.slice(0, 3));
      NOLA.seg(NOLA.fsec(panel, 'Status'), [['all', 'All'], ['open', 'Open'], ['closed', 'Closed']], st.stat, v => set('stat', v));
    } else {
      NOLA.flist(NOLA.fsec(panel, 'Open for', st.age >= 0 ? ['Any time', () => set('age', -1)] : null),
        AGE_L.map((l, a) => ({ key: a, name: l, color: AGE_C[a], count: aCnt[a], square: true })), { pressed: a => st.age === a, onClick: toggle('age') });
    }
    NOLA.flist(NOLA.fsec(panel, `Request type · ${fmt(shown)} shown`, st.type >= 0 ? ['Show all', () => set('type', -1)] : null),
      D.T.map((t, k) => ({ key: k, name: t, color: tColor(k), count: tCnt[k] })), { pressed: k => st.type === k, onClick: toggle('type') });
    if (st.type >= 0 && st.measure === 'made') {
      const rs = D.R.map((r, k) => k).filter(k => D.R[k][0] === st.type);
      if (rs.length > 1) NOLA.flist(NOLA.fsec(panel, 'Reason', st.reason >= 0 ? ['Any reason', () => set('reason', -1)] : null),
        rs.map(k => ({ key: k, name: reasonName(k), color: tColor(st.type), count: rCnt[k] })),
        { pressed: k => st.reason === k, onClick: toggle('reason') });
    }
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of 311 requests', tip: mapTip });
      m.lastNb = -1;
    }
    m.dots({ x: P.x, y: P.y, n: PN, colors: COLORS, color: colorOf, visible, r: NOLA.dotR, tip: dotTip });
    NOLA.heatToggle(plot, st.heat, on => set('heat', on), { label: 'Per 1k residents', checked: st.basis === 'pc', onChange: on => set('basis', on ? 'pc' : 'n') });
    const cl = st.heat ? NOLA.classes(d3.range(72).map(heatVal)) : null;
    m.setFill(cl ? i => cl.color(heatVal(i)) : () => null);
    NOLA.heatKey(panel, plot, cl, keyLabel(), NOLA.short, cl && d3.range(72).some(i => heatVal(i) == null) ? 'Under 1,000 residents' : null);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function dotTip(i) {
    const c = P.c[i], rn = P.R[P.r[i]][1];
    const status = c === -1 ? `Open, ${fmt(ageOf(i))} day${ageOf(i) === 1 ? '' : 's'}` : c === 0 ? 'Closed the same day' : c > 0 ? `Closed after ${fmt(c)} day${c === 1 ? '' : 's'}` : 'Closed';
    return `<b>${esc(D.T[pType[i]])}</b><div style="color:var(--ink2)">${esc(rn === 'Other' ? 'Other reason' : rn)}</div>`
      + row('Filed', NOLA.isoDate(P.iso(P.day[i]))) + row('Status', status) + row('Neighborhood', nbName(P.nb[i]));
  }
  function mapTip(i) {
    const pop = NOLA.popOf(i), rate = NOLA.perK(nbCnt[i], pop);
    return `<b>${GEO.nb[i].name}</b><div style="color:var(--ink2)">${filterName() || (st.measure === 'open' ? 'Open requests' : 'All requests')}</div>`
      + row(st.measure === 'open' ? 'Open requests shown' : 'Requests shown', fmt(nbCnt[i]))
      + row('Residents (2020)', pop == null ? '—' : fmt(pop)) + (rate != null ? row('Per 1,000 residents', NOLA.fmtRate(rate)) : '');
  }
  // small yearly bar chart for the chosen neighborhood, inside the map panel
  function yearsMini(sec, nb) {
    const box = document.createElement('div'); box.className = 'srmini'; sec.appendChild(box);
    const vals = D.years.map((y, k) => st.type >= 0 ? D.nby[nb][k][st.type] : d3.sum(D.nby[nb][k]));
    const f = NOLA.frame(box, { h: 96, m: { t: 14, r: 2, b: 16, l: 2 } });
    const x = d3.scaleBand().domain(D.years).range([0, f.iw]).paddingInner(.2), y = d3.scaleLinear().domain([0, d3.max(vals) || 1]).range([f.ih, 0]);
    const partial = k => k === D.years.length - 1 || (k === 0 && D.start.slice(5) !== '01');
    const yrLabel = k => `${D.years[k]}${k === D.years.length - 1 ? ', through ' + lastLabel : k === 0 && partial(0) ? ', from ' + NOLA.months[+D.start.slice(5) - 1] : ''}`;
    f.g.selectAll('rect').data(vals).join('rect').attr('x', (v, k) => x(D.years[k])).attr('width', x.bandwidth()).attr('y', v => y(v)).attr('height', v => f.ih - y(v))
      .attr('rx', 1.5).attr('fill', st.type >= 0 ? tColor(st.type) : 'var(--s1)').attr('opacity', (v, k) => partial(k) ? .45 : 1);
    f.g.selectAll('rect.h').data(vals).join('rect').attr('class', 'h').attr('x', (v, k) => x(D.years[k]) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('height', f.ih + f.m.t).attr('y', -f.m.t).attr('fill', 'transparent')
      .on('mousemove', (ev, v) => { const k = ev.currentTarget.__k; tip.show(`<b>${yrLabel(k)}</b>` + row('Requests', fmt(v)), ev); }).on('mouseleave', tip.hide)
      .each(function (v, k) { this.__k = k; });
    f.g.selectAll('text.v').data(vals).join('text').attr('class', 'v').attr('x', (v, k) => x(D.years[k]) + x.bandwidth() / 2).attr('y', v => y(v) - 3).attr('text-anchor', 'middle').style('font-size', '9.5px').style('pointer-events', 'none').text(v => NOLA.short(v));
    f.g.selectAll('text.x').data(D.years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 12).attr('text-anchor', 'middle').style('font-size', '9.5px').text(yy => "'" + String(yy).slice(2));
  }

  // ---------- requests per month ----------
  const mon = D.mon.map((a, k) => { const y = +D.start.slice(0, 4) + Math.floor((+D.start.slice(5) - 1 + k) / 12), mo = (+D.start.slice(5) - 1 + k) % 12; return { k, y, mo, a }; });
  const isMonthEnd = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.getUTCDate() === 1; };
  function drawMonthly(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.flist(NOLA.fsec(panel, 'Request type', st.type >= 0 ? ['Show all', () => set('type', -1)] : null),
      D.T.map((t, k) => ({ key: k, name: t, color: tColor(k), count: d3.sum(mon, d => d.a[k]) })), { pressed: k => st.type === k, onClick: toggle('type') });
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 380, m: { t: 14, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(mon.map(d => d.k)).range([0, f.iw]).paddingInner(.15);
    const show = t => st.type < 0 || t === st.type;
    const tot = d => d3.sum(d.a.filter((v, t) => show(t)));
    const y = d3.scaleLinear().domain([0, Math.max(4, (d3.max(mon, tot) || 0) * 1.05)]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5);
    const partial = d => d.k === mon.length - 1 && !isMonthEnd(lastISO);
    // stack: the colored types at the bottom, the gray ones on top
    const order = d3.range(NT).filter(show);
    mon.forEach(d => { let y0 = 0; order.forEach(t => { const v = d.a[t]; if (!v) return;
      f.g.append('rect').attr('x', x(d.k)).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', tColor(t)).attr('opacity', partial(d) ? .45 : 1); y0 += v; }); });
    f.g.selectAll('rect.h').data(mon).join('rect').attr('class', 'h').attr('x', d => x(d.k)).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(`<b>${NOLA.monthsLong[d.mo]} ${d.y}${partial(d) ? ', through ' + lastLabel : ''}</b>` + (st.type >= 0 ? `<div style="color:var(--ink2)">${D.T[st.type]}</div>` : '') + row('Requests', fmt(tot(d)))
        + (st.type < 0 ? d3.range(NT).filter(t => d.a[t]).sort((a, b) => d.a[b] - d.a[a] || byName(D.T[a], D.T[b])).slice(0, 8).map(t => row(sw(tColor(t)) + D.T[t], fmt(d.a[t]))).join('') : ''), ev)).on('mouseleave', tip.hide);
    const step = f.iw < 500 ? 2 : 1;
    f.g.selectAll('text.x').data(mon.filter(d => d.mo === 0 && d.y % step === 0)).join('text').attr('class', 'x').attr('x', d => x(d.k)).attr('y', f.ih + 18).text(d => d.y);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- rows: label + a mark per row (the time-to-close and open-requests charts) ----------
  const dayLab = v => v == null ? '—' : v < 1 ? 'under 1 day' : v < 2 ? '1 day' : v < 60 ? Math.round(v) + ' days' : v < 730 ? Math.round(v / 30.4) + ' months' : (v / 365).toFixed(1) + ' years';
  function rowsChart(plot, rows, { mark, scale, ticks, tipFor, onClick }) {
    plot.innerHTML = '';
    const narrow = (plot.clientWidth || 600) < 600, rh = narrow ? 42 : 30;
    const f = NOLA.frame(plot, { h: 34 + rows.length * rh, m: { t: 4, r: 18, b: 26, l: narrow ? 6 : 250 } });
    const x = scale.range([0, f.iw]);
    f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).tickValues(ticks[0]).tickFormat((v, i) => ticks[1][i]).tickSize(-f.ih)).call(g => g.select('.domain').remove());
    f.g.selectAll('.gridl .tick line').attr('stroke', 'var(--grid)');
    rows.forEach((r, i) => {
      const y0 = i * rh, cy = y0 + rh - (narrow ? 11 : 15);
      const lab = f.g.append('text').attr('x', narrow ? 0 : -10).attr('y', narrow ? y0 + 13 : cy + 4).attr('text-anchor', narrow ? 'start' : 'end')
        .style('fill', r.on ? 'var(--ink)' : 'var(--ink2)').style('font-weight', r.on ? 650 : null).text(r.name + (r.n != null ? ` (${fmt(r.n)})` : ''));
      const maxW = narrow ? f.iw : 240, node = lab.node();
      while (node.getComputedTextLength && node.getComputedTextLength() > maxW && node.textContent.length > 8) node.textContent = node.textContent.slice(0, -4) + '…';
      mark(f.g, r, cy, x);
      f.g.append('rect').attr('x', narrow ? 0 : -f.m.l).attr('width', f.iw + (narrow ? 0 : f.m.l)).attr('y', y0).attr('height', rh).attr('fill', 'transparent').style('cursor', onClick && r.key != null ? 'pointer' : null)
        .on('mousemove', ev => tip.show(tipFor(r), ev)).on('mouseleave', tip.hide).on('click', () => onClick && r.key != null && onClick(r.key));
    });
  }

  // ---------- time to close ----------
  const DAYT = [[0, 1, 7, 30, 90, 365, 1095], ['0', '1 day', '1 wk', '1 mo', '3 mo', '1 yr', '3 yr']];
  function drawClose(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    NOLA.flist(NOLA.fsec(panel, 'Request type', st.type >= 0 ? ['Show all', () => set('type', -1)] : null),
      D.T.map((t, k) => ({ key: k, name: t, color: tColor(k), count: st.nb >= 0 ? D.closeNb[st.nb][k][0] : D.closeT[k][0] })), { pressed: k => st.type === k, onClick: toggle('type') });
    NOLA.fsec(panel, 'Key').insertAdjacentHTML('beforeend', NOLA.legendHTML([['var(--ink2)', 'Median', 1], ['transparent;border:2px solid var(--ink2);width:8px;height:8px', 'Slowest 10% take longer than', 1]]).replace('class="legend"', 'class="legend" style="flex-direction:column;gap:6px"'));
    let rows;
    if (st.nb >= 0) rows = D.T.map((t, k) => ({ key: k, name: t, n: D.closeNb[st.nb][k][0], med: D.closeNb[st.nb][k][1], p90: null, on: k === st.type, t: k }));
    else if (st.type >= 0) rows = [{ key: st.type, name: 'All ' + D.T[st.type].toLowerCase(), n: D.closeT[st.type][0], med: D.closeT[st.type][1], p90: D.closeT[st.type][2], on: true, t: st.type }]
      .concat(D.R.map((r, k) => k).filter(k => D.R[k][0] === st.type).map(k => ({ key: null, name: reasonName(k), n: D.closeR[k][0], med: D.closeR[k][1], p90: D.closeR[k][2], t: st.type })));
    else rows = D.T.map((t, k) => ({ key: k, name: t, n: D.closeT[k][0], med: D.closeT[k][1], p90: D.closeT[k][2], t: k }));
    rows = rows.filter(r => r.n > 0).sort((a, b) => (b.on === true) - (a.on === true) || (a.med == null) - (b.med == null) || a.med - b.med || byName(a.name, b.name));
    if (!rows.length) { plot.innerHTML = `<div class="legend">No requests closed in the past 12 months${st.nb >= 0 ? ' in ' + nbName(st.nb) : ''}.</div>`; return; }
    const mx = Math.max(30, (d3.max(rows, r => Math.max(r.p90 || 0, r.med || 0)) || 0) * 1.1);
    rowsChart(plot, rows, {
      scale: d3.scaleSymlog().constant(1).domain([0, mx]),
      ticks: [DAYT[0].filter(v => v <= mx), DAYT[1]],
      mark: (g, r, cy, x) => {
        if (r.med == null) { g.append('text').attr('x', 0).attr('y', cy + 4).style('fill', 'var(--muted)').text('too few to tell'); return; }
        if (r.p90 != null) g.append('line').attr('x1', x(r.med)).attr('x2', x(r.p90)).attr('y1', cy).attr('y2', cy).attr('stroke', tColor(r.t)).attr('stroke-width', 2).attr('opacity', .5);
        g.append('circle').attr('cx', x(r.med)).attr('cy', cy).attr('r', 6).attr('fill', tColor(r.t)).attr('stroke', 'var(--surface)').attr('stroke-width', 2);
        if (r.p90 != null) g.append('circle').attr('cx', x(r.p90)).attr('cy', cy).attr('r', 6.5).attr('fill', 'none').attr('stroke', tColor(r.t)).attr('stroke-width', 2);
      },
      tipFor: r => `<b>${r.name}</b>${st.nb >= 0 ? `<div style="color:var(--ink2)">${nbName(st.nb)}</div>` : ''}` + row('Closed in the past 12 months', fmt(r.n)) + row('Median time to close', r.med == null ? 'too few to tell' : dayLab(r.med)) + (r.p90 != null ? row('Slowest 10% took over', dayLab(r.p90)) : ''),
      onClick: k => set('type', st.type === k ? -1 : k),
    });
  }

  // ---------- open requests by age ----------
  function drawOpen(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const A = D.openAge[st.nb >= 0 ? st.nb : 72], sel = st.type >= 0 ? [A[st.type]] : A;
    NOLA.kv(NOLA.fsec(panel, `Open for · ${st.type >= 0 ? D.T[st.type] : 'all types'}`, st.type >= 0 ? ['Show all', () => set('type', -1)] : null),
      [...AGE_L.map((l, a) => [l, AGE_C[a], fmt(d3.sum(sel, r => r[a]))]), ['Total', null, fmt(d3.sum(sel, r => d3.sum(r)))]]);
    const rows = D.T.map((t, k) => ({ key: k, name: t, a: A[k], n: d3.sum(A[k]), on: k === st.type })).filter(r => r.n).sort((a, b) => b.n - a.n || byName(a.name, b.name));
    if (!rows.length) { plot.innerHTML = `<div class="legend">No open requests${st.nb >= 0 ? ' in ' + nbName(st.nb) : ''}.</div>`; return; }
    const mx = d3.max(rows, r => r.n) || 1, sc = d3.scaleLinear().domain([0, Math.max(4, mx * 1.08)]).nice();
    rowsChart(plot, rows, {
      scale: sc, ticks: (() => { const t = sc.ticks(5); return [t, t.map(v => NOLA.short(v))]; })(),
      mark: (g, r, cy, x) => { let x0 = 0; r.a.forEach((v, a) => { if (!v) return; g.append('rect').attr('x', x(x0)).attr('width', Math.max(.5, x(x0 + v) - x(x0) - .5)).attr('y', cy - 7).attr('height', 14).attr('fill', AGE_C[a]).attr('opacity', st.type < 0 || r.on ? 1 : .45); x0 += v; }); },
      tipFor: r => `<b>${r.name}</b><div style="color:var(--ink2)">Open requests${st.nb >= 0 ? ', ' + nbName(st.nb) : ''}</div>` + row('Total', fmt(r.n)) + AGE_L.map((l, a) => row(sw(AGE_C[a]) + l, fmt(r.a[a]))).join(''),
      onClick: k => set('type', st.type === k ? -1 : k),
    });
  }

  const V = NOLA.views([
    { id: 'map', label: mapLabel, tab: 'Map of requests', keep: true, draw: drawMap },
    { id: 'monthly', label: 'Requests per month', draw: drawMonthly },
    { id: 'close', label: 'Time to close, requests closed in the past 12 months', tab: 'Time to close', draw: drawClose },
    { id: 'open', label: 'Open requests, by how long they have been open', tab: 'Open requests', draw: drawOpen },
  ], { ds: [D.ds, '311 OPCD Calls'],
       state: () => ({ measure: st.measure !== 'made' ? st.measure : null, type: st.type >= 0 ? st.type : null, reason: st.reason >= 0 ? st.reason : null,
                       basis: st.basis !== 'n' ? st.basis : null, nb: st.nb >= 0 ? st.nb : null,
                       p: st.per !== '1' ? st.per : null, stat: st.stat !== 'all' ? st.stat : null, age: st.age >= 0 ? st.age : null, heat: st.heat ? 1 : null }) });
})();
