// NOPD drone flights page
(() => {
  const D = DATA.drone; NOLA.setGeo(DATA.geo);
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
  const EV = ['', 'Mardi Gras', 'French Quarter Fest', 'Jazz Fest', 'Essence Fest', 'Saints game', 'Super Sunday / second line', 'Southern Decadence', 'Street takeover'];
  const DFR = 285; // first day of the fixed-launch-point era (Oct 13)

  // UTC -> Central
  const flights = D.recs.map(r => {
    const h = r[0] * 24 + r[1];
    const off = (h >= 66 * 24 + 8 && h < 304 * 24 + 7) ? 5 : 6;
    const l = h - off;
    return { day: Math.floor(l / 24), hr: l - 24 * Math.floor(l / 24), dur: r[2], cat: catOf(r[3]), drone: r[4], nb: r[5], x: r[6], y: r[7], ev: r[8], inferred: r[9], hasLoc: !!(r[6] || r[7]) };
  });
  const st = { cat: -1, period: 'all' };
  const pass = f => (st.cat < 0 || f.cat === st.cat) && (st.period === 'all' || (st.period === 'early' ? f.day < DFR : f.day >= DFR));

  // ---------- tiles ----------
  const tot = flights.length, hrs = d3.sum(flights, f => f.dur) / 3600;
  const late = flights.filter(f => f.day >= DFR);
  const med = a => d3.median(a, f => f.dur) / 60;
  document.getElementById('tiles').innerHTML = [
    [fmt(tot), 'flights logged, Jan 1 – Nov 5'],
    [Math.round(hrs) + ' hrs', 'total time in the air'],
    [fmt(late.length), `flights since Oct 13 (${Math.round(100 * late.length / tot)}% of the year)`],
    [D.drones.length, 'Skydio X10 drones in the log']
  ].map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  // ---------- filters ----------
  const catChips = document.getElementById('catChips');
  NOLA.chips(catChips, [{ label: 'All purposes', value: -1 }, ...CATS.map((c, i) => ({ label: c.n, value: i, color: c.color }))], v => { st.cat = v; redraw(); }, { sel: -1 });
  NOLA.chips(document.getElementById('perChips'), [{ label: 'Whole year', value: 'all' }, { label: 'Jan 1 – Oct 12', value: 'early' }, { label: 'Since Oct 13', value: 'late' }], v => { st.period = v; redraw(); }, { sel: 'all' });
  document.getElementById('legend').innerHTML = CATS.map(c => `<span><i style="background:${c.color}"></i>${c.n}</span>`).join('');

  // ---------- weekly timeline (stacked) ----------
  const nW = Math.ceil(313 / 7);
  const weeks = d3.range(nW).map(w => { const a = CATS.map(() => 0); flights.forEach(f => { if (Math.floor(f.day / 7) === w) a[f.cat]++; }); return a; });
  const tl = NOLA.frame(document.getElementById('timeline'), { h: 280, m: { t: 34, r: 12, b: 28, l: 36 } });
  const xw = d3.scaleBand().domain(d3.range(nW)).range([0, tl.iw]).paddingInner(0.18);
  const yw = d3.scaleLinear().domain([0, d3.max(weeks, w => d3.sum(w)) * 1.05]).range([tl.ih, 0]).nice();
  NOLA.yGrid(tl, yw, 4, d3.format('d'));
  const segs = [];
  weeks.forEach((w, wi) => { let y0 = 0; w.forEach((v, ci) => { if (v) { segs.push({ wi, ci, v, y0, y1: y0 + v }); } y0 += v; }); });
  const segSel = tl.g.append('g').selectAll('rect').data(segs).join('rect')
    .attr('x', d => xw(d.wi)).attr('width', xw.bandwidth())
    .attr('y', d => yw(d.y1) + 1).attr('height', d => Math.max(0.5, yw(d.y0) - yw(d.y1) - 1))
    .attr('fill', d => CATS[d.ci].color).attr('rx', 1.5);
  // hover target per week
  tl.g.append('g').selectAll('rect').data(weeks).join('rect').attr('x', (d, i) => xw(i) - 1).attr('width', xw.step()).attr('y', 0).attr('height', tl.ih).attr('fill', 'transparent')
    .on('mousemove', (ev, w) => { const i = weeks.indexOf(w); tip.show(`<b>Week of ${NOLA.doyDate(i * 7)}</b>` + row('Flights', d3.sum(w)) + CATS.map((c, ci) => w[ci] ? row(`<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c.color}"></i> ${c.n}`, w[ci]) : '').join(''), ev); })
    .on('mouseleave', tip.hide);
  // month axis
  const mStarts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304];
  tl.g.append('g').selectAll('text').data(mStarts).join('text').attr('x', d => xw(Math.floor(d / 7))).attr('y', tl.ih + 18).text((d, i) => NOLA.months[i]);
  tl.g.append('line').attr('x1', 0).attr('x2', tl.iw).attr('y1', tl.ih).attr('y2', tl.ih).attr('stroke', 'var(--axis)');
  // annotations
  const ann = [[0, 'New Year\'s', -6, 'start'], [Math.floor(45 / 7), 'Mardi Gras', -20, 'middle'], [Math.floor(105 / 7), 'French Quarter Fest', -6, 'middle'], [Math.floor(183 / 7), 'Essence', -20, 'middle'], [Math.floor(247 / 7), 'Southern Decadence', -6, 'middle'], [Math.floor(DFR / 7), 'Oct 13: new drones, daily dispatch flights', -20, 'end']];
  ann.forEach(([w, t, ly, anc]) => {
    const top = yw(d3.sum(weeks[w])), cx = xw(w) + xw.bandwidth() / 2;
    tl.g.append('line').attr('x1', cx).attr('x2', cx).attr('y1', top - 3).attr('y2', ly + 3).attr('stroke', 'var(--axis)');
    tl.g.append('text').attr('class', 'halo').attr('x', cx + (anc === 'end' ? 4 : anc === 'start' ? -2 : 0)).attr('y', ly).attr('text-anchor', anc).style('fill', 'var(--ink2)').text(t);
  });

  // ---------- map ----------
  const mapEl = document.getElementById('map');
  const m = NOLA.map(mapEl, { height: 600, extent: [20, 1080, 760, 1640], label: 'Map of drone launch points', labels: ['FRENCH QUARTER', 'CENTRAL BUSINESS DISTRICT', 'LOWER GARDEN DISTRICT', 'MID-CITY', 'ALGIERS POINT', 'GENTILLY TERRACE', 'BYWATER', 'UPTOWN', 'LAKEVIEW'], tip: i => `<b>${NOLA.GEO.nb[i].name}</b>` + row('Flights launched here', fmt(flights.filter(f => f.nb === i && pass(f)).length)) });
  NOLA.mapButtons(mapEl, m, [['Downtown', [200, 1250, 480, 1480]], ['Core city', [20, 1080, 760, 1640]], ['Whole city', [-70, 130, 2110, 1730]]]);
  const dots = m.layer.append('g');
  function drawMap() {
    const groups = d3.groups(flights.filter(f => f.hasLoc && pass(f)), f => Math.round(f.x / 3) + ',' + Math.round(f.y / 3));
    const data = groups.map(([key, fs]) => {
      const counts = CATS.map((c, ci) => fs.filter(f => f.cat === ci).length);
      return { fs, x: d3.mean(fs, f => f.x), y: d3.mean(fs, f => f.y), n: fs.length, cat: counts.indexOf(d3.max(counts)), counts };
    }).sort((a, b) => b.n - a.n);
    const k = m.k();
    dots.selectAll('circle').data(data, d => d.x + ',' + d.y).join('circle')
      .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', d => (3 + Math.sqrt(d.n) * 2.2) / k)
      .attr('fill', d => CATS[d.cat].color).attr('fill-opacity', .82).attr('stroke', 'var(--surface)').attr('stroke-width', 1.5 / k)
      .on('mousemove', (ev, d) => {
        const nb = d.fs[0].nb >= 0 ? NOLA.GEO.nb[d.fs[0].nb].name : 'Outside neighborhood boundaries';
        const days = d3.extent(d.fs, f => f.day); const dr = [...new Set(d.fs.map(f => D.drones[f.drone]))];
        tip.show(`<b>${nb}</b>` + row('Flights', d.n) + row('Dates', days[0] === days[1] ? NOLA.doyDate(days[0]) : NOLA.doyDate(days[0]) + ' – ' + NOLA.doyDate(days[1])) + row('Median flight', Math.round(med(d.fs)) + ' min') + row('Drones', dr.length > 3 ? dr.length : dr.join(', ')) + '<div style="margin-top:4px"></div>' + CATS.map((c, ci) => d.counts[ci] ? row(c.n, d.counts[ci]) : '').join(''), ev);
      }).on('mouseleave', tip.hide);
  }
  m.onZoom(k => dots.selectAll('circle').attr('r', d => (3 + Math.sqrt(d.n) * 2.2) / k).attr('stroke-width', 1.5 / k));

  // ---------- hour of day ----------
  const hourEl = document.getElementById('hours');
  function drawHours() {
    hourEl.innerHTML = '';
    const fs = flights.filter(pass);
    const hrs = d3.range(24).map(h => fs.filter(f => Math.floor(f.hr) === h).length);
    const f = NOLA.frame(hourEl, { h: 220, m: { t: 10, r: 8, b: 26, l: 32 } });
    const x = d3.scaleBand().domain(d3.range(24)).range([0, f.iw]).paddingInner(.2);
    const y = d3.scaleLinear().domain([0, Math.max(4, d3.max(hrs))]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 4, d3.format('d'));
    f.g.selectAll('rect.b').data(hrs).join('rect').attr('class', 'b').attr('x', (d, i) => x(i)).attr('width', x.bandwidth()).attr('y', d => y(d)).attr('height', d => f.ih - y(d)).attr('fill', st.cat >= 0 ? CATS[st.cat].color : 'var(--s1)').attr('rx', 2);
    f.g.selectAll('rect.h').data(d3.range(24)).join('rect').attr('class', 'h').attr('x', i => x(i)).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, i) => tip.show(`<b>${hrLab(i)} – ${hrLab(i + 1)}</b>` + row('Flights', hrs[i]), ev)).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data([0, 6, 12, 18, 23]).join('text').attr('class', 'x').attr('x', d => x(d) + x.bandwidth() / 2).attr('y', f.ih + 17).attr('text-anchor', 'middle').text(d => hrLab(d));
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }
  const hrLab = h => { h = h % 24; return h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'; };

  // ---------- fleet strip ----------
  const fleetEl = document.getElementById('fleet');
  function drawFleet() {
    fleetEl.innerHTML = '';
    const order = d3.range(D.drones.length).sort((a, b) => d3.min(flights.filter(f => f.drone === a), f => f.day) - d3.min(flights.filter(f => f.drone === b), f => f.day));
    const f = NOLA.frame(fleetEl, { h: 30 + order.length * 22, m: { t: 6, r: 10, b: 22, l: 120 } });
    const x = d3.scaleLinear().domain([0, 313]).range([0, f.iw]);
    const y = d3.scaleBand().domain(order).range([0, f.ih]).paddingInner(.3);
    f.g.append('rect').attr('x', x(DFR)).attr('width', f.iw - x(DFR)).attr('y', 0).attr('height', f.ih).attr('fill', 'var(--chip)');
    order.forEach(d => {
      const fs = flights.filter(fl => fl.drone === d);
      f.g.append('text').attr('x', -8).attr('y', y(d) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text(`X10-${D.drones[d]} · ${fs.length}`);
      f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', y(d) + y.bandwidth() / 2).attr('y2', y(d) + y.bandwidth() / 2).attr('stroke', 'var(--grid)');
      f.g.append('g').selectAll('rect').data(fs).join('rect').attr('x', fl => x(fl.day) - 1).attr('width', 2.5).attr('y', y(d)).attr('height', y.bandwidth()).attr('rx', 1)
        .attr('fill', fl => CATS[fl.cat].color).attr('opacity', fl => pass(fl) ? .9 : .12);
    });
    f.g.append('g').selectAll('text').data(mStarts).join('text').attr('x', d => x(d)).attr('y', f.ih + 16).text((d, i) => NOLA.months[i]);
    f.g.append('text').attr('x', x(DFR) + 4).attr('y', 10).style('fill', 'var(--ink2)').text('since Oct 13');
    f.svg.on('mousemove', ev => {
      const [mx, my] = d3.pointer(ev, f.g.node()); const d = order.find(o => my >= y(o) && my <= y(o) + y.bandwidth()); if (d === undefined) return tip.hide();
      const day = Math.round(x.invert(mx)); const fs = flights.filter(fl => fl.drone === d); const near = fs.filter(fl => Math.abs(fl.day - day) <= 1);
      const ext = d3.extent(fs, fl => fl.day);
      tip.show(`<b>Drone X10-${D.drones[d]}</b>` + row('Flights', fs.length) + row('First / last', NOLA.doyDate(ext[0]) + ' – ' + NOLA.doyDate(ext[1])) + (near.length ? row('Around ' + NOLA.doyDate(day), near.length + ' flight' + (near.length > 1 ? 's' : '')) : ''), ev);
    }).on('mouseleave', tip.hide);
  }

  // ---------- purpose table ----------
  function drawTable() {
    const rows = CATS.map((c, ci) => { const fs = flights.filter(f => f.cat === ci && (st.period === 'all' || (st.period === 'early' ? f.day < DFR : f.day >= DFR))); return { c, ci, n: fs.length, h: d3.sum(fs, f => f.dur) / 3600, med: fs.length ? med(fs) : null }; });
    const tot = d3.sum(rows, r => r.n); const mx = d3.max(rows, r => r.n);
    document.getElementById('ptable').innerHTML = `<thead><tr><th>Purpose</th><th class="num">Flights</th><th></th><th class="num">Hours</th><th class="num">Median flight</th></tr></thead><tbody>` +
      rows.map(r => `<tr data-c="${r.ci}" class="${st.cat === r.ci ? 'sel' : ''}"><td><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${r.c.color};margin-right:6px"></i>${r.c.n}</td><td class="num">${r.n}</td><td style="width:28%"><span class="bar" style="width:${100 * r.n / mx}%;background:${r.c.color}"></span></td><td class="num">${r.h.toFixed(1)}</td><td class="num">${r.med == null ? '—' : Math.round(r.med) + ' min'}</td></tr>`).join('') + `</tbody>`;
    document.querySelectorAll('#ptable tbody tr').forEach(tr => tr.onclick = () => { const c = +tr.dataset.c; st.cat = st.cat === c ? -1 : c; [...catChips.children].forEach((b, i) => b.classList.toggle('on', i === st.cat + 1)); redraw(); });
  }

  function redraw() {
    segSel.attr('opacity', d => st.cat < 0 || d.ci === st.cat ? 1 : .18);
    drawMap(); drawHours(); drawFleet(); drawTable();
  }
  redraw();
  addEventListener('resize', () => { drawHours(); drawFleet(); });
})();
