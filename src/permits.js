// Building permits page
(() => {
  const D = DATA.permits; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const GEO = NOLA.GEO, HU = DATA.geo.hu || [], NC = D.cats.length, NL = D.lu.length;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const CCOL = ['var(--s1)', 'var(--s2)', 'var(--s8)', 'var(--s3)', 'var(--s5)', 'var(--s4)', 'var(--s7)', 'var(--s6)', 'var(--muted)'];
  const POINTS = [0, 2, 3]; // new construction, demolition, solar and EV chargers: mapped permit by permit
  const lastLabel = NOLA.isoDate(D.last).replace(/, \d+$/, ''), YEAR = +D.last.slice(0, 4), partialYear = y => y === YEAR && !D.last.endsWith('-12-31');
  const win0 = new Date(D.winStart + 'T00:00:00Z'), dayISO = d => new Date(+win0 + d * 864e5).toISOString().slice(0, 10), dayDate = d => NOLA.isoDate(dayISO(d));
  const MIN_HU = 500, perHU = (n, i) => HU[i] >= MIN_HU ? 1000 * n / HU[i] : null;

  const H = NOLA.hashState();
  const st = { nb: H.nb != null ? +H.nb : -1, cat: H.cat != null ? +H.cat : -1, lu: H.lu != null ? +H.lu : -1, basis: H.basis === 'hu' ? 'hu' : 'n' };
  if (!(st.nb >= -1 && st.nb < 72)) st.nb = -1;
  if (!(st.cat >= -1 && st.cat < NC)) st.cat = -1;
  if (!(st.lu >= -1 && st.lu < NL)) st.lu = -1;
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);

  // per neighborhood, past 12 months: nbc[nb] = [cat, landUse, n, ...]
  const nbc = D.nbc.map(a => { const o = []; for (let i = 0; i < a.length; i += 3) o.push(a.slice(i, i + 3)); return o; });
  const countOf = (nb, cat = st.cat, lu = st.lu) => d3.sum(nbc[nb].filter(([c, l]) => (cat < 0 || c === cat) && (lu < 0 || l === lu)), a => a[2]);
  const val = i => st.basis === 'hu' ? perHU(countOf(i), i) : countOf(i);
  const pts = D.pts.map(p => ({ x: p[0], y: p[1], cat: p[2], nb: p[3], lu: p[4], day: p[5] }));
  const dots = () => POINTS.includes(st.cat);
  const keyLabel = () => (st.cat >= 0 ? D.cats[st.cat] : 'Permits') + ', past 12 months' + (st.basis === 'hu' && !dots() ? ' per 1,000 homes' : '');

  // ---------- map ----------
  let m, dotG;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const nbs = st.nb >= 0 ? [st.nb] : d3.range(72);
    NOLA.flist(NOLA.fsec(panel, 'Permit type', st.cat >= 0 ? ['Show all', () => set('cat', -1)] : null),
      D.cats.map((c, k) => ({ key: k, name: c, sub: POINTS.includes(k) ? 'Mapped permit by permit' : null, color: CCOL[k], count: d3.sum(nbs, nb => countOf(nb, k, st.lu)) })), { pressed: k => st.cat === k, onClick: toggle('cat') });
    NOLA.flist(NOLA.fsec(panel, 'Land use', st.lu >= 0 ? ['Show all', () => set('lu', -1)] : null),
      D.lu.map((l, k) => ({ key: k, name: l, color: 'var(--ink2)', count: d3.sum(nbs, nb => countOf(nb, st.cat, k)) })), { pressed: k => st.lu === k, onClick: toggle('lu') });
    // the smaller permit types are mapped permit by permit on the plain map; the rest shade neighborhoods
    const ml = plot.querySelector('.maplegend');
    let leg = null;
    if (dots()) NOLA.fsec(panel, keyLabel()).insertAdjacentHTML('beforeend', NOLA.legendHTML([[CCOL[st.cat], 'One permit', 1]]));
    else {
      NOLA.seg(NOLA.fsec(panel, 'Count'), [['n', 'Total'], ['hu', 'Per 1,000 homes']], st.basis, v => set('basis', v));
      leg = document.createElement('div'); leg.className = 'legend'; NOLA.fsec(panel, keyLabel()).appendChild(leg);
    }
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of building permits by neighborhood', tip: mapTip });
      dotG = m.layer.append('g'); m.lastNb = -1;
      m.onZoom(k => dotG.selectAll('circle').attr('r', 4 / Math.sqrt(k)).attr('stroke-width', 1.2 / Math.sqrt(k)));
      plot.insertAdjacentHTML('beforeend', '<div class="maplegend"></div>');
    }
    const mlg = ml || plot.querySelector('.maplegend');
    if (dots()) { m.setFill(() => null); mlg.innerHTML = `<div class="mlh">${keyLabel()}</div>` + NOLA.legendHTML([[CCOL[st.cat], 'One permit', 1]]).replace('class="legend"', 'class="legend" style="margin:0"'); }
    else {
      const cl = NOLA.classes(d3.range(72).map(val));
      m.setFill(i => cl.color(val(i)));
      const none = d3.range(72).some(i => val(i) == null) ? `Under ${MIN_HU} homes` : null, lf = v => st.basis === 'hu' ? NOLA.fmtRate(v) : NOLA.short(v);
      NOLA.stepLegend(leg, cl, lf, none); NOLA.stepLegend(mlg, cl, lf, none);
      mlg.insertAdjacentHTML('afterbegin', `<div class="mlh">${keyLabel()}${st.lu >= 0 ? ' · ' + D.lu[st.lu] : ''}</div>`);
    }
    const k = m.k(), shown = dots() ? pts.filter(p => p.cat === st.cat && (st.lu < 0 || p.lu === st.lu) && (st.nb < 0 || p.nb === st.nb)) : [];
    dotG.selectAll('circle').data(shown).join('circle').attr('cx', p => p.x).attr('cy', p => p.y).attr('r', 4 / Math.sqrt(k))
      .attr('fill', CCOL[Math.max(0, st.cat)]).attr('stroke', 'var(--surface)').attr('stroke-width', 1.2 / Math.sqrt(k))
      .on('mousemove', (ev, p) => tip.show(`<b>${D.cats[p.cat]}</b>` + row('Issued', dayDate(p.day)) + row('Land use', D.lu[p.lu]) + row('Neighborhood', nbName(p.nb)), ev)).on('mouseleave', tip.hide);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function mapTip(i) {
    const byCat = D.cats.map((c, k) => [k, countOf(i, k, st.lu)]).filter(d => d[1]).sort((a, b) => b[1] - a[1] || D.cats[a[0]].localeCompare(D.cats[b[0]])), r = perHU(countOf(i), i);
    return `<b>${GEO.nb[i].name}</b><div style="color:var(--ink2)">Permits issued, past 12 months${st.lu >= 0 ? ' · ' + D.lu[st.lu].toLowerCase() : ''}</div>`
      + row('All types', fmt(countOf(i, -1, st.lu))) + byCat.slice(0, 6).map(([k, n]) => row(sw(CCOL[k]) + D.cats[k], fmt(n))).join('')
      + row('Housing units (2020)', fmt(HU[i] || 0)) + (r != null ? row((st.cat >= 0 ? D.cats[st.cat] : 'Permits') + ' per 1,000 homes', NOLA.fmtRate(r)) : '');
  }

  // ---------- permits per year ----------
  function drawYears(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.flist(NOLA.fsec(panel, 'Permit type', st.cat >= 0 ? ['Show all', () => set('cat', -1)] : null),
      D.cats.map((c, k) => ({ key: k, name: c, color: CCOL[k], count: d3.sum(D.yr, d => d[k]) })), { pressed: k => st.cat === k, onClick: toggle('cat') });
    plot.innerHTML = '';
    const show = c => st.cat < 0 || c === st.cat, tot = d => d3.sum(d.filter((v, c) => show(c)));
    const f = NOLA.frame(plot, { h: 380, m: { t: 18, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(D.years).range([0, f.iw]).paddingInner(.22);
    const y = d3.scaleLinear().domain([0, (d3.max(D.yr, tot) || 1) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5, d3.format(',~d'));
    D.yr.forEach((d, k) => { let y0 = 0; d.forEach((v, c) => { if (!v || !show(c)) return;
      f.g.append('rect').attr('x', x(D.years[k])).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', CCOL[c]).attr('opacity', partialYear(D.years[k]) ? .45 : 1); y0 += v; }); });
    D.yr.forEach((d, k) => { if (partialYear(D.years[k])) f.g.append('text').attr('class', 'halo').attr('x', x(D.years[k]) + x.bandwidth()).attr('y', y(tot(d)) - 5).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text('to ' + lastLabel); });
    f.g.selectAll('rect.h').data(D.years).join('rect').attr('class', 'h').attr('x', yy => x(yy) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => { const d = D.yr[D.years.indexOf(yy)];
        tip.show(`<b>Issued in ${yy}${partialYear(yy) ? ', through ' + lastLabel : ''}</b>` + (st.cat >= 0 ? `<div style="color:var(--ink2)">${D.cats[st.cat]}</div>` : '') + row('Permits', fmt(tot(d)))
          + (st.cat < 0 ? D.cats.map((c, k) => d[k] ? row(sw(CCOL[k]) + c, fmt(d[k])) : '').join('') : ''), ev); }).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(D.years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => f.iw < 520 ? "'" + String(yy).slice(2) : yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- days from application to permit ----------
  const dayLab = v => v == null ? '—' : v < 1 ? 'under 1 day' : v < 2 ? '1 day' : v < 60 ? Math.round(v) + ' days' : v < 730 ? Math.round(v / 30.4) + ' months' : (v / 365).toFixed(1) + ' years';
  const DAYT = [[0, 1, 7, 30, 90, 365, 1095], ['0', '1 day', '1 wk', '1 mo', '3 mo', '1 yr', '3 yr']];
  function drawDays(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    const li = st.lu >= 0 ? st.lu : NL; // the last entry of each category's list is all land uses
    NOLA.flist(NOLA.fsec(panel, 'Land use', st.lu >= 0 ? ['Show all', () => set('lu', -1)] : null),
      D.lu.map((l, k) => ({ key: k, name: l, color: 'var(--ink2)', count: d3.sum(D.days, r => r[k][0]) })), { pressed: k => st.lu === k, onClick: toggle('lu') });
    NOLA.fsec(panel, 'Key').insertAdjacentHTML('beforeend', NOLA.legendHTML([['var(--ink2)', 'Median', 1], ['transparent;border:2px solid var(--ink2);width:8px;height:8px', 'Slowest 10% take longer than', 1]]).replace('class="legend"', 'class="legend" style="flex-direction:column;gap:6px"'));
    const rows = D.cats.map((c, k) => ({ k, name: c, n: D.days[k][li][0], med: D.days[k][li][1], p90: D.days[k][li][2], on: k === st.cat })).filter(r => r.n)
      .sort((a, b) => (a.med == null) - (b.med == null) || a.med - b.med || a.name.localeCompare(b.name));
    plot.innerHTML = '';
    if (!rows.length) { plot.innerHTML = '<div class="legend">No permits issued in the past 12 months for this land use.</div>'; return; }
    const narrow = (plot.clientWidth || 600) < 600, rh = narrow ? 42 : 30;
    const f = NOLA.frame(plot, { h: 34 + rows.length * rh, m: { t: 4, r: 18, b: 26, l: narrow ? 6 : 230 } });
    const mx = Math.max(30, (d3.max(rows, r => Math.max(r.p90 || 0, r.med || 0)) || 30) * 1.1);
    const x = d3.scaleSymlog().constant(1).domain([0, mx]).range([0, f.iw]);
    const tv = DAYT[0].filter(v => v <= mx);
    f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).tickValues(tv).tickFormat((v, i) => DAYT[1][i]).tickSize(-f.ih)).call(g => g.select('.domain').remove());
    f.g.selectAll('.gridl .tick line').attr('stroke', 'var(--grid)');
    rows.forEach((r, i) => {
      const y0 = i * rh, cy = y0 + rh - (narrow ? 11 : 15), c = CCOL[r.k];
      f.g.append('text').attr('x', narrow ? 0 : -10).attr('y', narrow ? y0 + 13 : cy + 4).attr('text-anchor', narrow ? 'start' : 'end').style('fill', r.on ? 'var(--ink)' : 'var(--ink2)').style('font-weight', r.on ? 650 : null).text(`${r.name} (${fmt(r.n)})`);
      if (r.med == null) f.g.append('text').attr('x', 0).attr('y', cy + 4).style('fill', 'var(--muted)').text('too few to tell');
      else {
        if (r.p90 != null) f.g.append('line').attr('x1', x(r.med)).attr('x2', x(r.p90)).attr('y1', cy).attr('y2', cy).attr('stroke', c).attr('stroke-width', 2).attr('opacity', .5);
        f.g.append('circle').attr('cx', x(r.med)).attr('cy', cy).attr('r', 6).attr('fill', c).attr('stroke', 'var(--surface)').attr('stroke-width', 2);
        if (r.p90 != null) f.g.append('circle').attr('cx', x(r.p90)).attr('cy', cy).attr('r', 6.5).attr('fill', 'none').attr('stroke', c).attr('stroke-width', 2);
      }
      f.g.append('rect').attr('x', narrow ? 0 : -f.m.l).attr('width', f.iw + (narrow ? 0 : f.m.l)).attr('y', y0).attr('height', rh).attr('fill', 'transparent').style('cursor', 'pointer')
        .on('mousemove', ev => tip.show(`<b>${r.name}</b>${st.lu >= 0 ? `<div style="color:var(--ink2)">${D.lu[st.lu]}</div>` : ''}` + row('Issued, past 12 months', fmt(r.n)) + row('Median from application', r.med == null ? 'too few to tell' : dayLab(r.med)) + (r.p90 != null ? row('Slowest 10% took over', dayLab(r.p90)) : ''), ev))
        .on('mouseleave', tip.hide).on('click', () => set('cat', st.cat === r.k ? -1 : r.k));
    });
  }

  // ---------- CSV downloads ----------
  const csvMap = () => dots()
    ? pts.filter(p => p.cat === st.cat && (st.lu < 0 || p.lu === st.lu) && (st.nb < 0 || p.nb === st.nb)).map(p => { const [lon, lat] = NOLA.lonlat(p.x, p.y);
      return { permit_type: D.cats[p.cat], issued: dayISO(p.day), land_use: D.lu[p.lu], neighborhood: nbName(p.nb), lon, lat }; })
    : NOLA.nbList().map(f => Object.assign({ neighborhood: f.name, housing_units_2020: HU[f.idx], land_use: st.lu >= 0 ? D.lu[st.lu] : 'All', permits_past_12_months: countOf(f.idx, -1) },
      ...D.cats.map((c, k) => ({ [c]: countOf(f.idx, k) })),
      { [(st.cat >= 0 ? D.cats[st.cat] : 'permits') + ' per 1,000 homes']: perHU(countOf(f.idx), f.idx) == null ? '' : +perHU(countOf(f.idx), f.idx).toFixed(2) }));
  const csvYears = () => D.yr.map((d, k) => Object.assign({ year: D.years[k], total: d3.sum(d) }, ...D.cats.map((c, j) => ({ [c]: d[j] }))));
  const csvDays = () => D.cats.flatMap((c, k) => [...D.lu, 'All'].map((l, j) => ({ permit_type: c, land_use: l, issued_past_12_months: D.days[k][j][0], median_days: D.days[k][j][1] ?? '', slowest_10pct_days: D.days[k][j][2] ?? '' })));

  const V = NOLA.views([
    { id: 'map', label: () => dots() ? `${D.cats[st.cat]}: permits issued in the past 12 months` : 'Permits issued in the past 12 months, by neighborhood', tab: 'Map of permits', keep: true, draw: drawMap, csv: csvMap,
      file: () => dots() ? 'permits' : 'neighborhoods' },
    { id: 'years', label: 'Permits issued per year', tab: 'Per year', draw: drawYears, csv: csvYears },
    { id: 'days', label: 'Days from application to permit, past 12 months', tab: 'Days to permit', draw: drawDays, csv: csvDays },
  ], { ds: [D.ds, 'Permits'],
       state: () => ({ cat: st.cat >= 0 ? st.cat : null, lu: st.lu >= 0 ? st.lu : null, basis: st.basis !== 'n' ? st.basis : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
