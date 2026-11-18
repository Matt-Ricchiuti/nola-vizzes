// NOPD drone flights page
(() => {
  const D = DATA.drone; NOLA.setGeo(DATA.geo);
  const YEAR = D.year || 2026; NOLA.setYear(YEAR);
  const { fmt, tip, row } = NOLA;
  const CATS = [
    { n: 'Call for service', codes: [0] },
    { n: 'Event overwatch', codes: [1] },
    { n: 'Investigation & tactical', codes: [5] },
    { n: 'Scene reconstruction', codes: [3] },
    { n: 'Search & rescue', codes: [4] },
    { n: 'Barricade & patrol checks', codes: [6] },
    { n: 'Training, test & other', codes: [2, 7] },
    { n: 'Not recorded', codes: [8] }];
  CATS.forEach((c, i) => c.color = i < 7 ? NOLA.S(i) : 'var(--none)');
  const catOf = code => CATS.findIndex(c => c.codes.includes(code));
  // Oct 13, 2026: new drones and daily dispatch flights from fixed launch points begin.
  // DFR is that day as a day-of-year; 0 for later years (no before/after split).
  const DFR = Math.max(0, Math.round((Date.UTC(2026, 9, 13) - Date.UTC(YEAR, 0, 1)) / 864e5));
  const SPLIT = DFR > 0;
  const dfrLabel = NOLA.doyDate(DFR);

  // UTC -> Central. Daylight time: second Sunday in March 08:00 UTC to first Sunday in November 07:00 UTC.
  const sunday = (m, n) => { const wd = new Date(Date.UTC(YEAR, m, 1)).getUTCDay(); return 1 + (7 - wd) % 7 + 7 * (n - 1); };
  const hOf = (m, d, hr) => (Date.UTC(YEAR, m, d, hr) - Date.UTC(YEAR, 0, 1)) / 36e5;
  const dstOn = hOf(2, sunday(2, 2), 8), dstOff = hOf(10, sunday(10, 1), 7);
  const flights = D.recs.map(r => {
    const h = r[0] * 24 + r[1];
    const l = h - ((h >= dstOn && h < dstOff) ? 5 : 6);
    return { day: Math.floor(l / 24), hr: l - 24 * Math.floor(l / 24), dur: r[2], cat: catOf(r[3]), drone: r[4], nb: r[5], x: r[6], y: r[7], ev: r[8], hasLoc: !!(r[6] || r[7]) };
  }).filter(f => f.day >= 0); // just after midnight UTC on Jan 1 is still Dec 31 locally
  const LAST = d3.max(flights, f => f.day);
  const mStarts = NOLA.monthStarts(YEAR, LAST);
  const med = a => d3.median(a, f => f.dur) / 60;
  const hrLab = h => { h = h % 24; return h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'; };
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;

  // ---------- filters ----------
  const st = { cat: -1, period: 'all' };
  const inPeriod = f => st.period === 'all' || (st.period === 'early' ? f.day < DFR : f.day >= DFR);
  const pass = f => (st.cat < 0 || f.cat === st.cat) && inPeriod(f);
  NOLA.chips(document.getElementById('catChips'), [{ label: 'All purposes', value: -1 }, ...CATS.map((c, i) => ({ label: c.n, value: i, color: c.color }))], v => { st.cat = v; V.refresh(); }, { sel: -1 });
  if (SPLIT) NOLA.chips(document.getElementById('perChips'), [{ label: 'Whole year', value: 'all' }, { label: `Jan 1 – ${NOLA.doyDate(DFR - 1)}`, value: 'early' }, { label: `Since ${dfrLabel}`, value: 'late' }], v => { st.period = v; V.refresh(); }, { sel: 'all' });
  else document.getElementById('perChips').remove();

  // ---------- flights per week ----------
  function drawWeek(el) {
    el.innerHTML = '<div></div>'; // the purpose filter buttons double as the color key
    const nW = Math.floor(LAST / 7) + 1;
    const weeks = d3.range(nW).map(() => CATS.map(() => 0));
    flights.forEach(f => weeks[Math.floor(f.day / 7)][f.cat]++);
    const tl = NOLA.frame(el.lastChild, { h: 300, m: { t: 34, r: 12, b: 28, l: 36 } });
    const xw = d3.scaleBand().domain(d3.range(nW)).range([0, tl.iw]).paddingInner(0.18);
    const yw = d3.scaleLinear().domain([0, d3.max(weeks, w => d3.sum(w)) * 1.05]).range([tl.ih, 0]).nice();
    NOLA.yGrid(tl, yw, 4, d3.format('d'));
    const segs = [];
    weeks.forEach((w, wi) => { let y0 = 0; w.forEach((v, ci) => { if (v) segs.push({ wi, ci, y0, y1: y0 + v }); y0 += v; }); });
    tl.g.append('g').selectAll('rect').data(segs).join('rect')
      .attr('x', d => xw(d.wi)).attr('width', xw.bandwidth()).attr('y', d => yw(d.y1) + 1).attr('height', d => Math.max(0.5, yw(d.y0) - yw(d.y1) - 1))
      .attr('fill', d => CATS[d.ci].color).attr('rx', 1.5).attr('opacity', d => st.cat < 0 || d.ci === st.cat ? 1 : .18);
    tl.g.append('g').selectAll('rect').data(weeks).join('rect').attr('x', (d, i) => xw(i) - 1).attr('width', xw.step()).attr('height', tl.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, w) => tip.show(`<b>Week of ${NOLA.doyDate(weeks.indexOf(w) * 7)}</b>` + row('Flights', d3.sum(w)) + CATS.map((c, ci) => w[ci] ? row(sw(c.color) + c.n, w[ci]) : '').join(''), ev))
      .on('mouseleave', tip.hide);
    tl.g.append('g').selectAll('text').data(mStarts).join('text').attr('x', d => xw(Math.floor(d / 7))).attr('y', tl.ih + 18).text((d, i) => NOLA.months[i]);
    tl.g.append('line').attr('x1', 0).attr('x2', tl.iw).attr('y1', tl.ih).attr('y2', tl.ih).attr('stroke', 'var(--axis)');
    // labels: busiest week of each big event (4+ tagged flights) and the Oct 13 shift, in two rows; ones that don't fit are skipped
    const EVN = { 1: 'Mardi Gras', 2: 'French Quarter Fest', 3: 'Jazz Fest', 4: 'Essence', 7: 'Southern Decadence' };
    const ann = [];
    Object.entries(EVN).forEach(([code, name]) => {
      const byW = d3.rollup(flights.filter(f => f.ev === +code), v => v.length, f => Math.floor(f.day / 7));
      const top = [...byW].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (top && top[1] >= 4) ann.push([top[0], name, top[0] === 0 ? 'start' : 'middle']);
    });
    ann.sort((a, b) => a[0] - b[0]);
    if (SPLIT && DFR <= LAST) ann.unshift([Math.floor(DFR / 7), `${dfrLabel}: daily dispatch flights begin`, 'end']);
    const ROWS = [-6, -20], used = [[], []];
    ann.forEach(([w, t, anc]) => {
      const top = yw(d3.sum(weeks[w])), cx = xw(w) + xw.bandwidth() / 2;
      const txt = tl.g.append('text').attr('class', 'halo').attr('x', cx + (anc === 'end' ? 4 : anc === 'start' ? -2 : 0)).attr('text-anchor', anc).style('fill', 'var(--ink2)').text(t);
      let bb = txt.node().getBBox();
      if (bb.x + bb.width > tl.iw + tl.m.r) { txt.attr('x', cx + 4).attr('text-anchor', 'end'); bb = txt.node().getBBox(); }
      if (bb.x < -tl.m.l) { txt.attr('x', cx - 2).attr('text-anchor', 'start'); bb = txt.node().getBBox(); }
      const r = [0, 1].find(i => used[i].every(([a, b]) => bb.x + bb.width + 8 < a || bb.x - 8 > b));
      if (r === undefined) { txt.remove(); return; }
      used[r].push([bb.x - 8, bb.x + bb.width + 8]);
      txt.attr('y', ROWS[r]);
      tl.g.append('line').attr('x1', cx).attr('x2', cx).attr('y1', top - 3).attr('y2', ROWS[r] + 3).attr('stroke', 'var(--axis)');
      txt.raise();
    });
  }

  // ---------- launch map ----------
  let m, dots;
  function drawMap(el, first) {
    if (first) {
      el.innerHTML = '<div class="map"></div>';
      m = NOLA.map(el.lastChild, { height: 600, extent: [20, 1080, 760, 1640], label: 'Map of drone launch points',
        labels: ['FRENCH QUARTER', 'CENTRAL BUSINESS DISTRICT', 'LOWER GARDEN DISTRICT', 'MID-CITY', 'ALGIERS POINT', 'GENTILLY TERRACE', 'BYWATER', 'UPTOWN', 'LAKEVIEW'],
        tip: i => `<b>${NOLA.GEO.nb[i].name}</b>` + row('Flights launched here', fmt(flights.filter(f => f.nb === i && pass(f)).length)) });
      NOLA.mapButtons(el.lastChild, m, [['Downtown', [200, 1250, 480, 1480]], ['Core city', [20, 1080, 760, 1640]], ['Whole city', [-70, 130, 2110, 1730]]]);
      dots = m.layer.append('g');
      m.onZoom(k => dots.selectAll('circle').attr('r', d => (3 + Math.sqrt(d.n) * 2.2) / k).attr('stroke-width', 1.5 / k));
    }
    const data = d3.groups(flights.filter(f => f.hasLoc && pass(f)), f => Math.round(f.x / 3) + ',' + Math.round(f.y / 3)).map(([, fs]) => {
      const counts = CATS.map((c, ci) => fs.filter(f => f.cat === ci).length);
      return { fs, x: d3.mean(fs, f => f.x), y: d3.mean(fs, f => f.y), n: fs.length, cat: counts.indexOf(d3.max(counts)), counts };
    }).sort((a, b) => b.n - a.n);
    const k = m.k();
    dots.selectAll('circle').data(data, d => d.x + ',' + d.y).join('circle')
      .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', d => (3 + Math.sqrt(d.n) * 2.2) / k)
      .attr('fill', d => CATS[d.cat].color).attr('fill-opacity', .82).attr('stroke', 'var(--surface)').attr('stroke-width', 1.5 / k)
      .on('mousemove', (ev, d) => {
        const nb = d.fs[0].nb >= 0 ? NOLA.GEO.nb[d.fs[0].nb].name : 'Outside neighborhood boundaries';
        const days = d3.extent(d.fs, f => f.day), dr = [...new Set(d.fs.map(f => D.drones[f.drone]))];
        tip.show(`<b>${nb}</b>` + row('Flights', d.n) + row('Dates', days[0] === days[1] ? NOLA.doyDate(days[0]) : NOLA.doyDate(days[0]) + ' – ' + NOLA.doyDate(days[1]))
          + row('Median flight', Math.round(med(d.fs)) + ' min') + row('Drones', dr.length > 3 ? dr.length : dr.join(', ')) + '<div style="margin-top:4px"></div>'
          + CATS.map((c, ci) => d.counts[ci] ? row(sw(c.color) + c.n, d.counts[ci]) : '').join(''), ev);
      }).on('mouseleave', tip.hide);
  }

  // ---------- flights by purpose ----------
  function drawPurpose(el) {
    const rows = CATS.map((c, ci) => { const fs = flights.filter(f => f.cat === ci && inPeriod(f)); return { c, n: fs.length, h: d3.sum(fs, f => f.dur) / 3600, med: fs.length ? med(fs) : null }; });
    const mx = d3.max(rows, r => r.n) || 1;
    el.innerHTML = `<table><thead><tr><th>Purpose</th><th class="num">Flights</th><th></th><th class="num">Hours</th><th class="num">Median flight</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td>${sw(r.c.color)}${r.c.n}</td><td class="num">${fmt(r.n)}</td><td style="width:30%"><span class="bar" style="width:${100 * r.n / mx}%;background:${r.c.color}"></span></td><td class="num">${r.h.toFixed(1)}</td><td class="num">${r.med == null ? '—' : Math.round(r.med) + ' min'}</td></tr>`).join('') + '</tbody></table>';
  }

  // ---------- hour of day ----------
  function drawHour(el) {
    el.innerHTML = '';
    const fs = flights.filter(pass);
    const hrs = d3.range(24).map(h => fs.filter(f => Math.floor(f.hr) === h).length);
    const f = NOLA.frame(el, { h: 300, m: { t: 10, r: 8, b: 26, l: 34 } });
    const x = d3.scaleBand().domain(d3.range(24)).range([0, f.iw]).paddingInner(.2);
    const y = d3.scaleLinear().domain([0, Math.max(4, d3.max(hrs))]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 4, d3.format('d'));
    f.g.selectAll('rect.b').data(hrs).join('rect').attr('class', 'b').attr('x', (d, i) => x(i)).attr('width', x.bandwidth()).attr('y', d => y(d)).attr('height', d => f.ih - y(d)).attr('fill', st.cat >= 0 ? CATS[st.cat].color : 'var(--s1)').attr('rx', 2);
    f.g.selectAll('rect.h').data(d3.range(24)).join('rect').attr('class', 'h').attr('x', i => x(i)).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, i) => tip.show(`<b>${hrLab(i)} – ${hrLab(i + 1)}</b>` + row('Flights', hrs[i]), ev)).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data([0, 3, 6, 9, 12, 15, 18, 21]).join('text').attr('class', 'x').attr('x', d => x(d) + x.bandwidth() / 2).attr('y', f.ih + 17).attr('text-anchor', 'middle').text(hrLab);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- fleet ----------
  function drawFleet(el) {
    el.innerHTML = '<div></div>'; // the purpose filter buttons double as the color key
    const first = d => d3.min(flights.filter(f => f.drone === d), f => f.day);
    const order = d3.range(D.drones.length).sort((a, b) => first(a) - first(b));
    const f = NOLA.frame(el.lastChild, { h: 34 + order.length * 24, m: { t: 8, r: 10, b: 22, l: 112 } });
    const x = d3.scaleLinear().domain([0, LAST]).range([0, f.iw]);
    const y = d3.scaleBand().domain(order).range([0, f.ih]).paddingInner(.3);
    if (SPLIT) f.g.append('rect').attr('x', x(DFR)).attr('width', f.iw - x(DFR)).attr('height', f.ih).attr('fill', 'var(--chip)');
    order.forEach(d => {
      const fs = flights.filter(fl => fl.drone === d);
      f.g.append('text').attr('x', -8).attr('y', y(d) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text(`X10-${D.drones[d]} · ${fs.length}`);
      f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', y(d) + y.bandwidth() / 2).attr('y2', y(d) + y.bandwidth() / 2).attr('stroke', 'var(--grid)');
      f.g.append('g').selectAll('rect').data(fs).join('rect').attr('x', fl => x(fl.day) - 1).attr('width', 2.5).attr('y', y(d)).attr('height', y.bandwidth()).attr('rx', 1)
        .attr('fill', fl => CATS[fl.cat].color).attr('opacity', fl => pass(fl) ? .9 : .12);
    });
    f.g.append('g').selectAll('text').data(mStarts).join('text').attr('x', d => x(d)).attr('y', f.ih + 16).text((d, i) => NOLA.months[i]);
    f.svg.on('mousemove', ev => {
      const [mx, my] = d3.pointer(ev, f.g.node()); const d = order.find(o => my >= y(o) && my <= y(o) + y.bandwidth()); if (d === undefined) return tip.hide();
      const day = Math.round(x.invert(mx)), fs = flights.filter(fl => fl.drone === d), near = fs.filter(fl => Math.abs(fl.day - day) <= 1), ext = d3.extent(fs, fl => fl.day);
      tip.show(`<b>Drone X10-${D.drones[d]}</b>` + row('Flights', fs.length) + row('First / last', NOLA.doyDate(ext[0]) + ' – ' + NOLA.doyDate(ext[1])) + (near.length ? row('Around ' + NOLA.doyDate(day), near.length + ' flight' + (near.length > 1 ? 's' : '')) : ''), ev);
    }).on('mouseleave', tip.hide);
  }

  const V = NOLA.views([
    { id: 'week', label: 'Flights per week, by purpose', draw: drawWeek },
    { id: 'map', label: 'Launch points', cls: 'card mapp', keep: true, draw: drawMap },
    { id: 'purpose', label: 'Flights by purpose', draw: drawPurpose },
    { id: 'hour', label: 'Takeoffs by hour (Central time)', draw: drawHour },
    { id: 'fleet', label: 'Flights by drone', draw: drawFleet },
  ]);
})();
