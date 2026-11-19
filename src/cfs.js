// Calls for Service page
(() => {
  const C = DATA.cfs, HIST = DATA.hist; NOLA.setGeo(DATA.geo);
  const YEAR = C.year || 2026; NOLA.setYear(YEAR);
  const { fmt, tip, row } = NOLA;
  const LASTD = NOLA.doyTime(C.last);
  // the current month is left off the monthly chart until the data reaches its last day
  const cutMonth = NOLA.doyTime(C.last + 1).getUTCMonth() !== LASTD.getUTCMonth() ? LASTD.getUTCMonth() + 1 : LASTD.getUTCMonth();
  const mStarts = NOLA.monthStarts(YEAR, C.last);
  // call types whose locations NOPD withholds (medical, mental health) can't be mapped
  const unmappable = k => d3.sum(C.nb, r => r[5][k]) < 0.05 * C.types[k][0];
  const tcase = s => NOLA.title(s).replace(/\(Private\)/, '(private)').replace(/ With /, ' with ').replace(/ For /, ' for ').replace(/ Of /, ' of ');
  const hl = h => { h = h % 24; return h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'; };
  const H = NOLA.hashState();
  // per: which calls-over-time chart shows (month: per month since 2014, day: per day this year)
  const st = { metric: H.metric || 'res', basis: H.basis || 'n', nb: H.nb != null ? +H.nb : -1, show: H.show || 'both', per: H.per === 'day' ? 'day' : 'month' }, nb = C.nb;
  // links from before the two time charts were merged: #daily is now the "Per day" tab of #trend
  if (H.view === 'daily') { st.per = 'day'; history.replaceState(null, '', location.hash.replace(/^#daily/, '#trend')); }
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const showRes = () => st.show !== 'self', showSelf = () => st.show !== 'res';
  // "Who started the call" rows: click one to show it alone, click again for both
  function seriesPanel(panel, totRes, totSelf) {
    panel.innerHTML = '';
    NOLA.flist(NOLA.fsec(panel, 'Who started the call', st.show !== 'both' ? ['Show both', () => { st.show = 'both'; V.refresh(); }] : null),
      [{ key: 'res', name: 'The public', sub: '911 calls, reports, alarms', color: 'var(--s1)', count: totRes }, { key: 'self', name: 'Officers', sub: 'Patrol checks, traffic stops', color: 'var(--s2)', count: totSelf }],
      { pressed: k => st.show === k, onClick: k => { st.show = st.show === k ? 'both' : k; V.refresh(); } });
  }
  const crosshair = (f, x, n, tipFor) => {
    const cross = f.g.append('line').attr('y1', 0).attr('y2', f.ih).attr('stroke', 'var(--axis)').style('opacity', 0);
    f.g.append('rect').attr('width', f.iw).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', ev => { const i = Math.max(0, Math.min(n - 1, Math.round(x.invert(d3.pointer(ev)[0])))); cross.attr('x1', x(i)).attr('x2', x(i)).style('opacity', 1); tip.show(tipFor(i), ev); })
      .on('mouseleave', () => { cross.style('opacity', 0); tip.hide(); });
  };

  // ---------- calls over time: per month since 2014, or per day this year (tabs) ----------
  function drawTime(pane, first) {
    const { panel, plot } = staged(pane, first); plot.innerHTML = '';
    (st.per === 'day' ? drawDaily : drawTrend)(panel, plot);
    NOLA.ftabs(panel, [['month', 'Per month'], ['day', `Per day, ${YEAR}`]], st.per, v => { st.per = v; V.refresh(); });
  }
  function drawTrend(panel, plot) {
    const pts = []; Object.keys(HIST).sort().forEach(y => HIST[y].forEach((v, m) => { if (!(+y === YEAR && m >= cutMonth)) pts.push({ y: +y, m, i: pts.length, res: v[0], self: v[1] }); }));
    seriesPanel(panel, d3.sum(pts, p => p.res), d3.sum(pts, p => p.self));
    const f = NOLA.frame(plot, { h: 380, m: { t: 16, r: 16, b: 28, l: 44 } });
    const x = d3.scaleLinear().domain([0, pts.length - 1]).range([0, f.iw]);
    const y = d3.scaleLinear().domain([0, d3.max(pts, p => Math.max(p.res, p.self)) * 1.08]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 4);
    [['res', 'var(--s1)'], ['self', 'var(--s2)']].filter(([k]) => k === 'res' ? showRes() : showSelf()).forEach(([k, col]) =>
      f.g.append('path').datum(pts).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('d', d3.line().x(d => x(d.i)).y(d => y(d[k])).curve(d3.curveMonotoneX)));
    const avg = (a, b) => d3.mean(pts.filter(p => p.y >= a && p.y <= b), p => p.res);
    if (showRes()) [[2014, 2019], [2024, YEAR]].forEach(([a, b]) => {
      const v = avg(a, b), i0 = pts.find(p => p.y === a).i, i1 = d3.max(pts.filter(p => p.y <= b), p => p.i);
      f.g.append('line').attr('x1', x(i0)).attr('x2', x(i1)).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', 'var(--ink2)').attr('opacity', .7);
      const right = b === YEAR; // the recent band sits at the right edge, so right-align its label
      f.g.append('text').attr('class', 'halo').attr('x', right ? x(i1) - 2 : x(i0) + 4).attr('text-anchor', right ? 'end' : 'start').attr('y', y(v) + 16).style('fill', 'var(--ink)').text(`${a}–${b.toString().slice(2)} avg ${fmt(Math.round(v / 100) * 100)}/mo`);
    });
    const step = f.iw < 500 ? 3 : 1;
    f.g.append('g').selectAll('text').data(pts.filter(p => p.m === 0 && (p.y - 2014) % step === 0)).join('text').attr('x', d => x(d.i)).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(d => d.y);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
    crosshair(f, x, pts.length, i => { const p = pts[i]; return `<b>${NOLA.months[p.m]} ${p.y}</b>` + row('From the public', fmt(p.res)) + row('Started by officers', fmt(p.self)); });
  }

  function drawDaily(panel, plot) {
    seriesPanel(panel, d3.sum(C.daily, d => d[0]), d3.sum(C.daily, d => d[1]));
    const n = C.daily.length;
    const roll = k => C.daily.map((d, i) => i < 6 ? null : d3.mean(C.daily.slice(i - 6, i + 1), v => v[k]));
    const r0 = roll(0), r1 = roll(1);
    const f = NOLA.frame(plot, { h: 380, m: { t: 18, r: 16, b: 28, l: 40 } });
    const x = d3.scaleLinear().domain([0, n - 1]).range([0, f.iw]);
    const y = d3.scaleLinear().domain([0, d3.max(C.daily, d => Math.max(d[0], d[1])) * 1.06]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 4, d3.format('d'));
    [[0, 'var(--s1)', r0], [1, 'var(--s2)', r1]].filter(([k]) => k ? showSelf() : showRes()).forEach(([k, col, r]) => {
      f.g.append('g').selectAll('circle').data(C.daily).join('circle').attr('cx', (d, i) => x(i)).attr('cy', d => y(d[k])).attr('r', 1.4).attr('fill', col).attr('opacity', .35);
      f.g.append('path').datum(r).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('d', d3.line().defined(v => v != null).x((v, i) => x(i)).y(v => y(v)));
    });
    // Mardi Gras: busiest day in the week before Fat Tuesday (47 days before Easter)
    const easter = (Y => { const a = Y % 19, b = Math.floor(Y / 100), c = Y % 100, d = Math.floor(b / 4), e = b % 4, g = Math.floor((8 * b + 13) / 25),
      h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 19 * l) / 433);
      const mo = Math.floor((h + l - 7 * m + 90) / 25), da = (h + l - 7 * m + 33 * mo + 19) % 32; return (Date.UTC(Y, mo - 1, da) - Date.UTC(Y, 0, 1)) / 864e5; })(YEAR);
    const fat = easter - 47;
    if (fat <= C.last && showRes()) {
      const pk = d3.range(Math.max(0, fat - 6), fat + 1).reduce((a, b) => C.daily[b][0] > C.daily[a][0] ? b : a);
      f.g.append('text').attr('class', 'halo').attr('x', x(pk) + 6).attr('y', y(C.daily[pk][0]) + 4).style('fill', 'var(--ink2)').text('Mardi Gras');
    }
    f.g.append('g').selectAll('text').data(NOLA.monthTicks(mStarts, x, f.iw)).join('text').attr('x', d => d.x).attr('y', f.ih + 18).text(d => d.label);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
    crosshair(f, x, n, i => `<b>${NOLA.doyDate(i)}</b>` + row('From the public', fmt(C.daily[i][0])) + row('Started by officers', fmt(C.daily[i][1])) + (r0[i] ? row('7-day avg, public', Math.round(r0[i])) : ''));
  }

  // ---------- weekday x hour ----------
  function drawHeat(pane, first) {
    const { panel, plot } = staged(pane, first); panel.innerHTML = ''; plot.innerHTML = '<div></div>'; const el = plot;
    const legSec = NOLA.fsec(panel, 'Calls from the public'), leg = document.createElement('div'); leg.className = 'legend'; legSec.appendChild(leg);
    const order = [1, 2, 3, 4, 5, 6, 0], names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const f = NOLA.frame(el.lastChild, { h: 340, m: { t: 6, r: 8, b: 24, l: 36 } });
    const x = d3.scaleBand().domain(d3.range(24)).range([0, f.iw]).paddingInner(.08);
    const y = d3.scaleBand().domain(order).range([0, f.ih]).paddingInner(.1);
    const mx = d3.max(C.heat.flat()), mn = d3.min(C.heat.flat()), wks = (C.last + 1) / 7;
    order.forEach(d => C.heat[d].forEach((v, h) => {
      f.g.append('rect').attr('x', x(h)).attr('y', y(d)).attr('width', x.bandwidth()).attr('height', y.bandwidth()).attr('rx', 3).style('fill', NOLA.seqVar((v - mn) / (mx - mn + 1)))
        .on('mousemove', ev => tip.show(`<b>${names[d]}, ${hl(h)}–${hl(h + 1)}</b>` + row('Calls from the public', fmt(v)) + row('Per week (avg)', Math.round(v / wks)), ev)).on('mouseleave', tip.hide);
    }));
    order.forEach(d => f.g.append('text').attr('x', -6).attr('y', y(d) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').text(names[d]));
    [0, 6, 12, 18].forEach(h => f.g.append('text').attr('x', x(h)).attr('y', f.ih + 16).text(hl(h)));
    NOLA.seqLegend(leg, [mn, mx], v => fmt(v), '', false);
  }

  // ---------- call types table ----------
  let sortK = 1, sortDir = -1;
  const cols = [['Call type', r => r.name, 0], ['Calls', r => r.n, 1], ['Started by officers', r => r.selfP, 1], ['Median arrival, public calls', r => r.med, 1], ['Gone on arrival', r => r.goaP, 1], ['Report filed', r => r.rtfP, 1]];
  const rows = C.TOP.map((t, k) => { const v = C.types[k]; return { k, name: tcase(t), n: v[0], selfP: v[1] / v[0], med: v[2], goaP: v[4] / v[0], rtfP: v[5] / v[0] }; });
  function drawTypes(pane, first) {
    const { panel, plot } = staged(pane, first); const el = plot; panel.innerHTML = '';
    NOLA.flist(NOLA.fsec(panel, 'Sort by'), cols.slice(1).map((c, j) => ({ key: j + 1, name: c[0], color: 'var(--s1)' })),
      { pressed: i => sortK === i, onClick: i => { sortDir = sortK === i ? -sortDir : -1; sortK = i; V.refresh(); } });
    const sorted = rows.slice().sort((a, b) => { const A = cols[sortK][1](a), B = cols[sortK][1](b); return (A == null) - (B == null) || (A < B ? -1 : A > B ? 1 : 0) * sortDir; });
    const mx = d3.max(rows, r => r.n), p = v => Math.round(100 * v) + '%';
    el.innerHTML = '<div style="overflow-x:auto"><table class="static"><thead><tr>' + cols.map((c, i) => `<th data-i="${i}" class="${c[2] ? 'num' : ''}">${c[0]}${i === sortK ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('') + '</tr></thead><tbody>' +
      sorted.map(r => `<tr><td>${r.name}</td><td class="num"><span class="bar" style="width:${50 * r.n / mx}px;margin-right:6px"></span>${fmt(r.n)}</td><td class="num">${p(r.selfP)}</td><td class="num">${r.med == null ? '—' : r.med < 1 ? '<1 min' : Math.round(r.med) + ' min'}</td><td class="num">${p(r.goaP)}</td><td class="num">${p(r.rtfP)}</td></tr>`).join('') + '</tbody></table></div>';
    el.querySelectorAll('th').forEach(th => th.onclick = () => { const i = +th.dataset.i; sortDir = sortK === i ? -sortDir : (i ? -1 : 1); sortK = i; V.refresh(); });
  }

  // ---------- neighborhood map ----------

  const isTime = () => st.metric === 'r2' || st.metric === 'r1';
  const rawVal = i => { const r = nb[i], mt = st.metric;
    if (mt === 'res') return r[0]; if (mt === 'self') return r[1];
    if (mt === 'r2') return r[4] >= 30 ? r[2] : null; if (mt === 'r1') return r[3];
    return r[5][+mt.slice(1)]; };
  const perRes = () => st.basis === 'pc' && !isTime(); // counts can be shown per 1,000 residents; arrival times can't
  const metricVal = i => perRes() ? NOLA.perK(rawVal(i), NOLA.popOf(i)) : rawVal(i);
  const metricLabel = () => (({ res: 'Calls from the public', self: 'Calls started by officers', r2: 'Median minutes to arrive, emergency', r1: 'Median minutes to arrive, non-emergency' })[st.metric] || (tcase(C.TOP[+st.metric.slice(1)]) + ' calls')) + (perRes() ? ' per 1,000 residents' : '');
  if (!['res', 'self', 'r1', 'r2'].includes(st.metric) && !(/^t\d+$/.test(st.metric) && !unmappable(+st.metric.slice(1)))) st.metric = 'res';
  function mapPanel(panel) {
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Find a neighborhood'), st.nb, v => { st.nb = v; V.refresh(); });
    const MEAS = [['res', 'Calls from the public', 'var(--s1)', d3.sum(nb, r => r[0])], ['self', 'Calls started by officers', 'var(--s2)', d3.sum(nb, r => r[1])],
      ['r2', 'Arrival time, emergency', 'var(--s3)', null], ['r1', 'Arrival time, non-emergency', 'var(--s4)', null]];
    const ms = NOLA.fsec(panel, 'Shade by');
    NOLA.flist(ms, MEAS.map(([key, name, color, count]) => ({ key, name, color, count, sub: count == null ? 'median minutes' : null })),
      { pressed: k => st.metric === k, onClick: k => { st.metric = k; V.refresh(); } });
    const ts = document.createElement('select'); ts.className = 'fsel'; ts.setAttribute('aria-label', 'Call type');
    ts.innerHTML = '<option value="">Or one call type…</option>' + C.TOP.map((t, k) => unmappable(k) ? '' : `<option value="t${k}">${tcase(t)}</option>`).join('');
    ts.value = st.metric.startsWith('t') ? st.metric : ''; ts.onchange = () => { st.metric = ts.value || 'res'; V.refresh(); }; ms.appendChild(ts);
    const ls = NOLA.fsec(panel, isTime() ? 'Legend · minutes' : 'Legend'), leg = document.createElement('div'); leg.className = 'legend'; ls.appendChild(leg);
    if (perRes()) ls.insertAdjacentHTML('beforeend', NOLA.POP_NOTE);
    return leg;
  }
  let m;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true), leg = mapPanel(panel);
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of calls by neighborhood',
        tip: i => { const r = nb[i];
          const pop = NOLA.popOf(i), rate = NOLA.perK(r[0], pop);
          return `<b>${NOLA.GEO.nb[i].name}</b>` + (st.metric.startsWith('t') ? row(metricLabel(), perRes() ? NOLA.fmtRate(metricVal(i)) : fmt(rawVal(i))) : '') + row('Calls from the public', fmt(r[0])) + row('Started by officers', fmt(r[1]))
            + row('Residents (2020)', pop == null ? '—' : fmt(pop)) + (rate != null ? row('Public calls per 1,000 residents', NOLA.fmtRate(rate)) : '')
            + row('Median arrival, emergency', r[4] >= 30 ? r[2] + ' min' : 'too few calls') + row('Median arrival, non-emergency', r[3] == null ? '—' : r[3] + ' min'); } });
      m.lastNb = -1;
    }
    NOLA.mapChecks(plot, [!isTime() && { key: 'per', label: 'Per 1k residents', checked: st.basis === 'pc', onChange: on => { st.basis = on ? 'pc' : 'n'; V.refresh(); } }]);
    // seven equal-count classes: each shade holds about ten neighborhoods
    const cl = NOLA.classes(nb.map((r, i) => metricVal(i)));
    m.setFill(i => cl.color(metricVal(i)));
    const none = nb.some((r, i) => metricVal(i) == null) ? (perRes() ? 'Under 1,000 residents' : isTime() ? 'Too few calls' : 'No data') : null;
    const lf = v => isTime() ? v.toFixed(1) : NOLA.short(v);
    NOLA.stepLegend(leg, cl.edges, lf, none);
    // on phones the panel folds away, so the map carries its own copy of the legend
    if (first) plot.insertAdjacentHTML('beforeend', '<div class="maplegend"></div>');
    NOLA.stepLegend(plot.querySelector('.maplegend'), cl.edges, lf, none);
    plot.querySelector('.maplegend').insertAdjacentHTML('afterbegin', `<div class="mlh">${metricLabel()}${isTime() ? ' (min)' : ''}</div>`);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }

  // ---------- arrival time by district ----------
  function drawDist(pane, first) {
    const { panel, plot } = staged(pane, first); plot.innerHTML = '<div></div>'; const el = plot;
    panel.innerHTML = ''; NOLA.fsec(panel, 'Key').insertAdjacentHTML('beforeend', NOLA.legendHTML([['var(--s1)', 'Emergency, median', 1], ['transparent;border:2px solid var(--s1);width:8px;height:8px', 'Emergency, slowest 10%', 1], ['var(--s2)', 'Non-emergency, median', 1]]).replace('class="legend"', 'class="legend" style="flex-direction:column;gap:6px"'));
    const ds = C.pd.slice().sort((a, b) => a[3] - b[3]);
    const f = NOLA.frame(el.lastChild, { h: 40 + ds.length * 34, m: { t: 10, r: 20, b: 28, l: 84 } });
    const x = d3.scaleLinear().domain([0, d3.max(ds, d => d[4]) * 1.08]).range([0, f.iw]).nice();
    const y = d3.scaleBand().domain(ds.map(d => d[0])).range([0, f.ih]).paddingInner(.3);
    f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).ticks(6).tickSize(-f.ih).tickFormat(v => v + ' min')).call(g => g.select('.domain').remove());
    f.g.selectAll('.gridl .tick line').attr('stroke', 'var(--grid)');
    ds.forEach(d => {
      const cy = y(d[0]) + y.bandwidth() / 2;
      f.g.append('text').attr('x', -8).attr('y', cy + 4).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text(`District ${d[0]}`);
      f.g.append('line').attr('x1', x(d[3])).attr('x2', x(d[4])).attr('y1', cy).attr('y2', cy).attr('stroke', 'var(--s1)').attr('stroke-width', 2).attr('opacity', .5);
      f.g.append('circle').attr('cx', x(d[5])).attr('cy', cy).attr('r', 5).attr('fill', 'var(--s2)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);
      f.g.append('circle').attr('cx', x(d[3])).attr('cy', cy).attr('r', 6).attr('fill', 'var(--s1)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);
      // the slowest-10% ring goes on top, hollow, so it stays visible when it lands on another marker
      f.g.append('circle').attr('cx', x(d[4])).attr('cy', cy).attr('r', 6.5).attr('fill', 'none').attr('stroke', 'var(--s1)').attr('stroke-width', 2);
      f.g.append('rect').attr('width', f.iw).attr('y', y(d[0]) - 4).attr('height', y.bandwidth() + 8).attr('fill', 'transparent')
        .on('mousemove', ev => tip.show(`<b>NOPD District ${d[0]}</b>` + row('Calls from the public', fmt(d[1])) + row('Started by officers', fmt(d[2])) + row('Emergency: median arrival', d[3] + ' min') + row('Emergency: 1 in 10 waits over', Math.round(d[4]) + ' min') + row('Non-emergency: median', Math.round(d[5]) + ' min'), ev)).on('mouseleave', tip.hide);
    });
  }

  // ---------- CSV downloads ----------
  const hrsLab = h => String(h).padStart(2, '0') + ':00';
  const csvTrend = () => { const o = []; Object.keys(HIST).sort().forEach(y => HIST[y].forEach((v, m) => { if (!(+y === YEAR && m >= cutMonth)) o.push({ month: `${y}-${String(m + 1).padStart(2, '0')}`, from_public: v[0], started_by_officers: v[1] }); })); return o; };
  const csvDaily = () => C.daily.map((d, i) => ({ date: NOLA.doyISO(i), from_public: d[0], started_by_officers: d[1] }));
  const csvHeat = () => { const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], o = []; C.heat.forEach((r, d) => r.forEach((v, h) => o.push({ weekday: names[d], hour: hrsLab(h), calls_from_public: v }))); return o; };
  const csvTypes = () => rows.map(r => ({ call_type: r.name, calls: r.n, pct_started_by_officers: Math.round(100 * r.selfP), median_arrival_public_calls_min: r.med == null ? '' : r.med, pct_gone_on_arrival: Math.round(100 * r.goaP), pct_report_filed: Math.round(100 * r.rtfP) }));
  const csvMap = () => NOLA.nbList().map(f => { const r = nb[f.idx], pop = NOLA.popOf(f.idx);
    return Object.assign({ neighborhood: f.name, residents_2020: pop, from_public: r[0], started_by_officers: r[1], public_per_1000_residents: NOLA.perK(r[0], pop) == null ? '' : +NOLA.perK(r[0], pop).toFixed(1),
      median_arrival_emergency_min: r[4] >= 30 ? r[2] : '', median_arrival_nonemergency_min: r[3] == null ? '' : r[3] }, ...C.TOP.map((t, k) => unmappable(k) ? {} : { [tcase(t)]: r[5][k] })); });
  const csvDist = () => C.pd.map(d => ({ district: d[0], from_public: d[1], started_by_officers: d[2], emergency_median_min: d[3], emergency_90th_pct_min: d[4], nonemergency_median_min: d[5] }));

  const V = NOLA.views([
    { id: 'map', label: 'Calls by neighborhood', keep: true, draw: drawMap, csv: csvMap },
    { id: 'trend', label: 'Calls over time', draw: drawTime, csv: () => st.per === 'day' ? csvDaily() : csvTrend(), file: () => st.per === 'day' ? 'daily' : 'trend' },
    { id: 'heat', label: 'Calls by weekday and hour', draw: drawHeat, csv: csvHeat },
    { id: 'types', label: 'Call types', draw: drawTypes, csv: csvTypes },
    { id: 'dist', label: 'Officer arrival time by police district', draw: drawDist, csv: csvDist },
  ], { ds: [C.ds || 'es9j-6y5d', `Calls for Service ${YEAR}`],
       state: () => ({ show: st.show !== 'both' ? st.show : null, per: st.per !== 'month' ? st.per : null, metric: st.metric !== 'res' ? st.metric : null, basis: st.basis !== 'n' ? st.basis : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
