// Calls for Service page
(() => {
  const C = DATA.cfs, HIST = DATA.hist; NOLA.setGeo(DATA.geo);
  const YEAR = C.year || 2026; NOLA.setYear(YEAR);
  const { fmt, tip, row, setText } = NOLA;
  const LASTD = NOLA.doyTime(C.last);
  // the current month is left off monthly charts until the data reaches its last day
  const lastMonthComplete = NOLA.doyTime(C.last + 1).getUTCMonth() !== LASTD.getUTCMonth();
  const cutMonth = lastMonthComplete ? LASTD.getUTCMonth() + 1 : LASTD.getUTCMonth(); // first month left off
  const mStarts = NOLA.monthStarts(YEAR, C.last);
  // call types whose locations NOPD withholds (medical, mental health) can't be mapped
  const unmappable = k => d3.sum(C.nb, r => r[5][k]) < 0.05 * C.types[k][0];
  const p2s = C.mResp.map(m => m[0]).filter(v => v != null);
  const tcase = s => NOLA.title(s).replace(/\(Private\)/, '(private)').replace(/ With /, ' with ').replace(/ For /, ' for ').replace(/ Of /, ' of ');
  const resTot = d3.sum(C.daily, d => d[0]), selfTot = d3.sum(C.daily, d => d[1]);

  document.getElementById('tiles').innerHTML = [
    [fmt(resTot + selfTot), `calls logged, Jan 1 – ${NOLA.doyDate(C.last)}`],
    [fmt(resTot), `started by the public (${Math.round(100 * resTot / (resTot + selfTot))}%)`],
    [fmt(selfTot), 'started by officers (patrol checks, traffic stops)'],
    (() => { const lo = d3.min(p2s), hi = d3.max(p2s);
      return [`~${Math.round(d3.median(p2s))} min`, 'median time for an officer to arrive at an emergency (priority 2) call, ' + (hi - lo <= 1.5 ? 'every month this year' : `month by month this year (${Math.round(lo)}–${Math.round(hi)} min)`)]; })()
  ].map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  // ---------- long trend ----------
  (function () {
    const el = document.getElementById('trend');
    const pts = []; Object.keys(HIST).sort().forEach(y => HIST[y].forEach((v, m) => { if (+y === YEAR && m >= cutMonth) return; pts.push({ y: +y, m, i: pts.length, res: v[0], self: v[1] }); }));
    const f = NOLA.frame(el, { h: 300, m: { t: 16, r: 120, b: 28, l: 44 } });
    const x = d3.scaleLinear().domain([0, pts.length - 1]).range([0, f.iw]);
    const y = d3.scaleLinear().domain([0, d3.max(pts, p => Math.max(p.res, p.self)) * 1.08]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 4);
    const ser = [['res', 'From the public', 'var(--s1)'], ['self', 'Started by officers', 'var(--s2)']];
    ser.forEach(([k, lab, col]) => {
      f.g.append('path').datum(pts).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('d', d3.line().x(d => x(d.i)).y(d => y(d[k])).curve(d3.curveMonotoneX));
      const last = pts[pts.length - 1];
      f.g.append('text').attr('x', f.iw + 8).attr('y', y(last[k]) + 4).style('fill', 'var(--ink2)').text(lab);
    });
    // baseline bands
    const avg = (a, b) => d3.mean(pts.filter(p => p.y >= a && p.y <= b), p => p.res);
    [[2014, 2019], [2024, YEAR]].forEach(([a, b]) => {
      const v = avg(a, b), i0 = pts.find(p => p.y === a).i, i1 = d3.max(pts.filter(p => p.y <= b), p => p.i);
      f.g.append('line').attr('x1', x(i0)).attr('x2', x(i1)).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', 'var(--ink2)').attr('stroke-width', 1).attr('opacity', .7);
      f.g.append('text').attr('class', 'halo').attr('x', x(i0) + 4).attr('y', y(v) + 16).style('fill', 'var(--ink)').text(`${a}–${b.toString().slice(2)} avg: ${fmt(Math.round(v / 100) * 100)}/mo`);
    });
    f.g.append('g').selectAll('text').data(pts.filter(p => p.m === 0)).join('text').attr('x', d => x(d.i)).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(d => d.y);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
    const cross = f.g.append('line').attr('y1', 0).attr('y2', f.ih).attr('stroke', 'var(--axis)').style('opacity', 0);
    f.g.append('rect').attr('width', f.iw).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', ev => { const i = Math.round(x.invert(d3.pointer(ev)[0])); const p = pts[Math.max(0, Math.min(pts.length - 1, i))]; cross.attr('x1', x(p.i)).attr('x2', x(p.i)).style('opacity', 1); tip.show(`<b>${NOLA.months[p.m]} ${p.y}</b>` + row('From the public', fmt(p.res)) + row('Started by officers', fmt(p.self)), ev); })
      .on('mouseleave', () => { cross.style('opacity', 0); tip.hide(); });
  })();

  // ---------- 2026 daily ----------
  (function () {
    const el = document.getElementById('daily');
    const n = C.daily.length;
    const roll = k => C.daily.map((d, i) => i < 6 ? null : d3.mean(C.daily.slice(i - 6, i + 1), v => v[k]));
    const r0 = roll(0), r1 = roll(1);
    const f = NOLA.frame(el, { h: 260, m: { t: 18, r: 16, b: 28, l: 40 } });
    const x = d3.scaleLinear().domain([0, n - 1]).range([0, f.iw]);
    const y = d3.scaleLinear().domain([0, d3.max(C.daily, d => Math.max(d[0], d[1])) * 1.06]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 4, d3.format('d'));
    [[0, 'var(--s1)'], [1, 'var(--s2)']].forEach(([k, col]) => {
      f.g.append('g').selectAll('circle').data(C.daily).join('circle').attr('cx', (d, i) => x(i)).attr('cy', d => y(d[k])).attr('r', 1.4).attr('fill', col).attr('opacity', .35);
      f.g.append('path').datum(k ? r1 : r0).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('d', d3.line().defined(v => v != null).x((v, i) => x(i)).y(v => y(v)));
    });
    // label the Mardi Gras peak: busiest day in the week before Fat Tuesday (47 days before Easter)
    const easter = (Y => { const a = Y % 19, b = Math.floor(Y / 100), c = Y % 100, d = Math.floor(b / 4), e = b % 4, g = Math.floor((8 * b + 13) / 25),
      h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 19 * l) / 433);
      const mo = Math.floor((h + l - 7 * m + 90) / 25), da = (h + l - 7 * m + 33 * mo + 19) % 32; return (Date.UTC(Y, mo - 1, da) - Date.UTC(Y, 0, 1)) / 864e5; })(YEAR);
    const fat = easter - 47;
    if (fat <= C.last) {
      const win = d3.range(Math.max(0, fat - 6), fat + 1);
      const pk = win.reduce((a, b) => C.daily[b][0] > C.daily[a][0] ? b : a);
      f.g.append('text').attr('class', 'halo').attr('x', x(pk) + 6).attr('y', y(C.daily[pk][0]) + 4).style('fill', 'var(--ink2)').text('Mardi Gras weekend');
    }
    f.g.append('g').selectAll('text').data(mStarts).join('text').attr('x', d => x(d)).attr('y', f.ih + 18).text((d, i) => NOLA.months[i]);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
    const cross = f.g.append('line').attr('y1', 0).attr('y2', f.ih).attr('stroke', 'var(--axis)').style('opacity', 0);
    f.g.append('rect').attr('width', f.iw).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', ev => { const i = Math.max(0, Math.min(n - 1, Math.round(x.invert(d3.pointer(ev)[0])))); cross.attr('x1', x(i)).attr('x2', x(i)).style('opacity', 1); const d = C.daily[i];
        tip.show(`<b>${NOLA.doyDate(i)}</b>` + row('From the public', fmt(d[0])) + row('Started by officers', fmt(d[1])) + (r0[i] ? row('7-day avg, public', Math.round(r0[i])) : ''), ev); })
      .on('mouseleave', () => { cross.style('opacity', 0); tip.hide(); });
  })();

  // ---------- heatmap ----------
  (function () {
    const el = document.getElementById('heat');
    const order = [1, 2, 3, 4, 5, 6, 0], names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const f = NOLA.frame(el, { h: 230, m: { t: 6, r: 8, b: 24, l: 36 } });
    const x = d3.scaleBand().domain(d3.range(24)).range([0, f.iw]).paddingInner(.08);
    const y = d3.scaleBand().domain(order).range([0, f.ih]).paddingInner(.1);
    const mx = d3.max(C.heat.flat()), mn = d3.min(C.heat.flat());
    order.forEach(d => C.heat[d].forEach((v, h) => {
      f.g.append('rect').attr('x', x(h)).attr('y', y(d)).attr('width', x.bandwidth()).attr('height', y.bandwidth()).attr('rx', 3)
        .style('fill', NOLA.seqVar((v - mn) / (mx - mn + 1)))
        .on('mousemove', ev => tip.show(`<b>${names[d]}, ${hl(h)}–${hl(h + 1)}</b>` + row('Calls from the public', fmt(v)) + row('Per week (avg)', Math.round(v / ((C.last + 1) / 7))), ev)).on('mouseleave', tip.hide);
    }));
    order.forEach(d => f.g.append('text').attr('x', -6).attr('y', y(d) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').text(names[d]));
    [0, 6, 12, 18].forEach(h => f.g.append('text').attr('x', x(h)).attr('y', f.ih + 16).text(hl(h)));
    NOLA.seqLegend(document.getElementById('heatLeg'), [mn, mx], v => fmt(v), 'Fewer calls');
    document.getElementById('heatLeg').insertAdjacentHTML('beforeend', '<span>More calls</span>');
  })();
  function hl(h) { h = h % 24; return h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'; }

  // ---------- map + table state ----------
  const st = { metric: 'res' };
  const nb = C.nb;
  const metricVal = (i, mt = st.metric) => {
    const r = nb[i];
    if (mt === 'res') return r[0]; if (mt === 'self') return r[1];
    if (mt === 'r2') return r[4] >= 30 ? r[2] : null; if (mt === 'r1') return r[3];
    if (mt.startsWith('t')) return r[5][+mt.slice(1)];
  };
  const isTime = () => st.metric === 'r2' || st.metric === 'r1';
  const metricLabel = () => ({ res: 'Calls from the public', self: 'Calls started by officers', r2: 'Median minutes to arrive, emergency calls', r1: 'Median minutes to arrive, non-emergency calls' })[st.metric] || (tcase(C.TOP[+st.metric.slice(1)]) + ' calls');
  const sel = document.getElementById('metric');
  sel.innerHTML = [['res', 'Calls from the public'], ['self', 'Calls started by officers'], ['r2', 'Response time: emergency (P2)'], ['r1', 'Response time: non-emergency (P1)']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('') +
    '<optgroup label="Call type">' + C.TOP.map((t, k) => unmappable(k) ? '' : `<option value="t${k}">${tcase(t)}</option>`).join('') + '</optgroup>';
  sel.onchange = () => { st.metric = sel.value; drawMap(); drawTable(); };

  const mapEl = document.getElementById('map');
  const m = NOLA.map(mapEl, { height: 560, extent: [-70, 700, 1250, 1730], districts: false, label: 'Choropleth of calls by neighborhood',
    tip: i => { const r = nb[i]; const v = metricVal(i);
      return `<b>${NOLA.GEO.nb[i].name}</b>` + (st.metric.startsWith('t') ? row(metricLabel(), fmt(v)) : '') + row('Calls from the public', fmt(r[0])) + row('Started by officers', fmt(r[1])) + row('Median arrival, emergency', r[4] >= 30 ? r[2] + ' min' : 'too few calls') + row('Median arrival, non-emergency', r[3] == null ? '—' : Math.round(r[3]) + ' min'); } });
  NOLA.mapButtons(mapEl, m, [['Core city', [-70, 950, 800, 1680]], ['Whole city', [-70, 130, 2110, 1730]]]);
  function drawMap() {
    const vals = nb.map((r, i) => metricVal(i)).filter(v => v != null);
    const lo = isTime() ? d3.quantile(vals.slice().sort(d3.ascending), .05) : 0;
    const hi = d3.quantile(vals.slice().sort(d3.ascending), .95);
    m.setFill(i => { const v = metricVal(i); return v == null ? 'var(--none)' : NOLA.seqVar((v - lo) / (hi - lo)); });
    NOLA.seqLegend(document.getElementById('mapLeg'), [lo, hi], v => isTime() ? Math.round(v) + ' min' : fmt(Math.round(v)), metricLabel() + ':');
  }

  // ---------- table ----------
  let sortK = 1, sortDir = -1;
  const cols = [['Call type', r => r.name, 0], ['Calls', r => r.n, 1], ['Started by officers', r => r.selfP, 1], ['Median arrival', r => r.med, 1], ['Gone on arrival', r => r.goaP, 1], ['Report filed', r => r.rtfP, 1]];
  const rows = C.TOP.map((t, k) => { const v = C.types[k]; const res = v[0] - v[1]; return { k, name: tcase(t), n: v[0], selfP: v[1] / v[0], med: v[2], p90: v[3], goaP: v[4] / v[0], rtfP: v[5] / v[0], pri: v[6] }; });
  function drawTable() {
    const sorted = rows.slice().sort((a, b) => { const A = cols[sortK][1](a), B = cols[sortK][1](b); return (A == null) - (B == null) || (A < B ? -1 : A > B ? 1 : 0) * sortDir; });
    const mx = d3.max(rows, r => r.n);
    const p = v => Math.round(100 * v) + '%';
    document.getElementById('ttable').innerHTML = '<thead><tr>' + cols.map((c, i) => `<th data-i="${i}" class="${c[2] ? 'num' : ''}">${c[0]}${i === sortK ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('') + '</tr></thead><tbody>' +
      sorted.map(r => `<tr data-k="${r.k}" class="${st.metric === 't' + r.k ? 'sel' : ''}"><td>${r.name}</td><td class="num"><span class="bar" style="width:${50 * r.n / mx}px;margin-right:6px"></span>${fmt(r.n)}</td><td class="num">${p(r.selfP)}</td><td class="num">${r.med == null ? '—' : r.med < 1 ? '<1 min' : Math.round(r.med) + ' min'}</td><td class="num">${p(r.goaP)}</td><td class="num">${p(r.rtfP)}</td></tr>`).join('') + '</tbody>';
    document.querySelectorAll('#ttable th').forEach(th => th.onclick = () => { const i = +th.dataset.i; sortDir = sortK === i ? -sortDir : (i ? -1 : 1); sortK = i; drawTable(); });
    document.querySelectorAll('#ttable tbody tr').forEach(tr => tr.onclick = () => { const k = +tr.dataset.k; if (unmappable(k)) return; st.metric = 't' + k; sel.value = st.metric; drawMap(); drawTable(); document.getElementById('mapSec').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  // ---------- districts ----------
  (function () {
    const el = document.getElementById('dist');
    const ds = C.pd.slice().sort((a, b) => a[3] - b[3]);
    const f = NOLA.frame(el, { h: 40 + ds.length * 30, m: { t: 10, r: 20, b: 28, l: 84 } });
    const x = d3.scaleLinear().domain([0, d3.max(ds, d => d[4]) * 1.08]).range([0, f.iw]).nice();
    const y = d3.scaleBand().domain(ds.map(d => d[0])).range([0, f.ih]).paddingInner(.3);
    f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).ticks(6).tickSize(-f.ih).tickFormat(v => v + ' min')).call(g => g.select('.domain').remove());
    f.g.selectAll('.gridl .tick line').attr('stroke', 'var(--grid)');
    ds.forEach(d => {
      const cy = y(d[0]) + y.bandwidth() / 2;
      f.g.append('text').attr('x', -8).attr('y', cy + 4).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text(`District ${d[0]}`);
      f.g.append('line').attr('x1', x(d[3])).attr('x2', x(d[4])).attr('y1', cy).attr('y2', cy).attr('stroke', 'var(--s1)').attr('stroke-width', 2).attr('opacity', .5);
      f.g.append('circle').attr('cx', x(d[4])).attr('cy', cy).attr('r', 5).attr('fill', 'var(--surface)').attr('stroke', 'var(--s1)').attr('stroke-width', 2);
      f.g.append('circle').attr('cx', x(d[5])).attr('cy', cy).attr('r', 5).attr('fill', 'var(--s2)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);
      f.g.append('circle').attr('cx', x(d[3])).attr('cy', cy).attr('r', 6).attr('fill', 'var(--s1)').attr('stroke', 'var(--surface)').attr('stroke-width', 2);
      f.g.append('rect').attr('x', 0).attr('width', f.iw).attr('y', y(d[0]) - 4).attr('height', y.bandwidth() + 8).attr('fill', 'transparent')
        .on('mousemove', ev => tip.show(`<b>NOPD District ${d[0]}</b>` + row('Calls from the public', fmt(d[1])) + row('Started by officers', fmt(d[2])) + row('Emergency: median arrival', d[3] + ' min') + row('Emergency: 1 in 10 waits over', Math.round(d[4]) + ' min') + row('Non-emergency: median', Math.round(d[5]) + ' min'), ev)).on('mouseleave', tip.hide);
    });
  })();

  // ---------- sentences that quote the data ----------
  (function copy() {
    const complete = []; Object.keys(HIST).forEach(y => HIST[y].forEach((v, m) => { if (!(+y === YEAR && m >= cutMonth)) complete.push({ y: +y, res: v[0] }); }));
    const avg = (a, b) => d3.mean(complete.filter(p => p.y >= a && p.y <= b), p => p.res);
    const old = avg(2014, 2019), now = avg(YEAR, YEAR), recent = avg(2024, YEAR);
    const drop = 1 - now / old;
    setText('h1', `Calls to NOPD in ${YEAR}: ` + (drop >= 0.05 ? `${NOLA.share(drop)} fewer calls from residents than in the late 2010s`
      : drop <= -0.05 ? `${NOLA.share(-drop)} more calls from residents than in the late 2010s` : 'about as many calls from residents as in the late 2010s'));
    setText('metaThrough', `Through ${NOLA.doyDate(C.last)}, ${YEAR}`);
    setText('trendSub', `Monthly calls since 2014. Calls from the public averaged about ${fmt(Math.round(old / 1000) * 1000)} a month from 2014 to 2019 and about ${fmt(Math.round(recent / 500) * 500)} a month since 2024. Calls started by officers rise and fall with enforcement priorities and staffing.`);
    const bySelf = C.nb.map((r, i) => [i, r[1]]).sort((a, b) => b[1] - a[1]);
    setText('mapSub', `Neighborhoods shaded by the selected measure. Hover over a neighborhood for its numbers. ${NOLA.GEO.nb[bySelf[0][0]].name} and ${NOLA.GEO.nb[bySelf[1][0]].name} log more officer-started calls than anywhere else.`);
    const nl = C.noLoc, nlR = nl >= 10000 ? Math.round(nl / 1000) * 1000 : nl >= 1000 ? Math.round(nl / 100) * 100 : nl;
    setText('noLocNote', `Counts are totals, not per resident, so large or busy neighborhoods like the CBD and French Quarter rank high. NOPD withholds locations for medical and mental-health calls, so those types can't be mapped. About ${fmt(nlR)} calls have no location.`);
    const slow = C.pd.filter(d => d[4] != null).sort((a, b) => b[4] - a[4])[0];
    if (slow) {
      const w = slow[4] >= 60 ? 'more than an hour' : `more than ${Math.round(slow[4])} minutes`;
      setText('distNote', `District 7 (New Orleans East) covers by far the most ground. One in ten emergency calls in District ${slow[0]} waits ${w} for an officer, the longest of any district.`);
    }
    setText('cutNote', cutMonth < 12 && cutMonth <= LASTD.getUTCMonth() ? `${NOLA.monthsLong[cutMonth]} ${YEAR} is left off the trend chart because the month is incomplete.` : '');
  })();

  drawMap(); drawTable();
})();
