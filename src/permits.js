// Building permits page
(() => {
  const D = DATA.permits; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const GEO = NOLA.GEO, HU = DATA.geo.hu || [], NC = D.cats.length, NL = D.lu.length;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const CCOL = ['var(--s1)', 'var(--s2)', 'var(--s8)', 'var(--s3)', 'var(--s5)', 'var(--s4)', 'var(--s7)', 'var(--s6)', 'var(--muted)'];
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

  // ---------- map: a dot per permit issued in the past 12 months (D.dots, from the pipeline) ----------
  // The heatmap (a checkbox on the map) counts the dots shown per neighborhood.
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = NOLA.dotData(D.dots), LASTD = P.dayOf(D.last);
  st.per = ['1', '6', '12'].includes(H.p) ? H.p : '12';
  st.heat = H.heat === '1';
  // historic districts and HDLC landmarks (DATA.hd, from historic.json): optional layers, checkboxes on the map
  const HD = DATA.hd || null;
  st.hd = !!HD && H.hd === '1'; st.lm = !!HD && H.lm === '1';
  const HDF = HD ? HD.d.map(d => ({ ...d })) : [], LMF = HD ? HD.lm.map(([x, y, n, a, ar, dt, des]) => ({ p: [x, y], n, a, ar, dt, des })) : [];
  let inHD = null; // per permit dot: 1 inside a district (worked out the first time the layer is shown)
  const hdTip = f => `<b>${esc(f.n)} historic district</b>` + row('Review', f.c ? 'Full control' : 'Partial control') + (f.j ? row('Commission', esc(f.j)) : '');
  const lmTip = f => `<b>${esc(f.n)}</b><div style="color:var(--ink2)">HDLC landmark${f.des ? '' : ', nominated'}</div>` + (f.a ? row('Address', esc(f.a)) : '')
    + (f.dt ? row('Built', esc(f.dt)) : '') + (f.ar ? row('Architect', esc(f.ar)) : '');
  const okPer = i => NOLA.inPeriod(P.day[i], LASTD, st.per), okCat = i => st.cat < 0 || P.c[i] === st.cat, okLu = i => st.lu < 0 || P.lu[i] === st.lu;
  const okNb = i => st.nb < 0 || P.nb[i] === st.nb;
  // drawn in reverse so the rarer types (listed first) sit on top
  const ORDER = d3.range(NC).reverse(), COLORS = ORDER.map(c => CCOL[c]), cIdx = new Array(NC); ORDER.forEach((c, k) => cIdx[c] = k);
  let nbCnt = new Array(72).fill(0);
  const perL = { 1: 'past month', 6: 'past 6 months', 12: 'past 12 months' };
  const mapLabel = () => `${st.cat >= 0 ? D.cats[st.cat] + ': permits' : 'Permits'} issued in the ${perL[st.per]}`;
  const keyLabel = () => 'Permits shown' + (st.basis === 'hu' ? ' per 1,000 homes' : '') + ', by neighborhood';
  const heatVal = i => st.basis === 'hu' ? perHU(nbCnt[i], i) : nbCnt[i];

  let m;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    const cc = new Array(NC).fill(0), lc = new Array(NL).fill(0); nbCnt = new Array(72).fill(0); let shown = 0;
    for (let i = 0; i < P.n; i++) {
      if (!okPer(i)) continue;
      const a = okCat(i), b = okLu(i), nb = okNb(i);
      if (nb && b) cc[P.c[i]]++;
      if (nb && a) lc[P.lu[i]]++;
      if (a && b) { nbCnt[P.nb[i]]++; if (nb) shown++; }
    }
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    NOLA.periodSeg(NOLA.fsec(panel, 'Issued in the last'), st.per, v => set('per', v), NOLA.PERIODS.slice(0, 3));
    NOLA.flist(NOLA.fsec(panel, `Permit type · ${fmt(shown)} shown`, st.cat >= 0 ? ['Show all', () => set('cat', -1)] : null),
      D.cats.map((c, k) => ({ key: k, name: c, color: CCOL[k], count: cc[k] })), { pressed: k => st.cat === k, onClick: toggle('cat') });
    NOLA.flist(NOLA.fsec(panel, 'Land use', st.lu >= 0 ? ['Show all', () => set('lu', -1)] : null),
      D.lu.map((l, k) => ({ key: k, name: l, color: 'var(--ink2)', count: lc[k] })), { pressed: k => st.lu === k, onClick: toggle('lu') });
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of building permits', tip: mapTip });
      m.lastNb = -1;
    }
    const vis = i => okPer(i) && okCat(i) && okLu(i) && okNb(i);
    m.dots({ x: P.x, y: P.y, n: P.n, colors: COLORS, color: i => cIdx[P.c[i]], visible: vis, r: NOLA.dotR, tip: dotTip });
    if (m.hdOn !== st.hd) { m.overlay('hd', st.hd ? { feats: HDF, q: HD.q, cls: f => 'ovf' + (f.c ? '' : ' lite'), tip: hdTip } : null); m.hdOn = st.hd; }
    if (m.lmOn !== st.lm) { m.overlay('lm', st.lm ? { feats: LMF, q: HD.q, pts: true, r: 3.5, className: 'ovlm', cls: f => f.des ? '' : 'nom', tip: lmTip } : null); m.lmOn = st.lm; }
    if (st.hd || st.lm) {
      const rows = [];
      if (st.hd) {
        if (!inHD) { inHD = new Uint8Array(P.n); for (let i = 0; i < P.n; i++) inHD[i] = m.overlayAt(P.x[i], P.y[i]).some(x => x.ov.feats === HDF) ? 1 : 0; }
        let n = 0; for (let i = 0; i < P.n; i++) if (inHD[i] && vis(i)) n++;
        rows.push(['Full control', 'var(--s7)', ''], ['Partial control', 'color-mix(in srgb,var(--s7) 45%,var(--surface))', ''], ['Permits inside', null, `${fmt(n)} of ${fmt(shown)}`]);
      }
      if (st.lm) rows.push(['Landmark', 'var(--ink)', fmt(LMF.length)]);
      NOLA.kv(NOLA.fsec(panel, st.hd ? 'Historic districts' : 'HDLC landmarks'), rows).classList.add('ovkey');
    }
    NOLA.heatToggle(plot, st.heat, on => set('heat', on), { label: 'Per 1k homes', checked: st.basis === 'hu', onChange: on => set('basis', on ? 'hu' : 'n') },
      HD ? [{ key: 'hd', label: 'Historic districts', checked: st.hd, onChange: on => set('hd', on), title: 'Local historic districts (HDLC and Vieux Carré Commission)' },
        { key: 'lm', label: 'Landmarks', checked: st.lm, onChange: on => set('lm', on), title: 'HDLC landmarks' }] : []);
    const cl = st.heat ? NOLA.classes(d3.range(72).map(heatVal)) : null;
    m.setFill(cl ? i => cl.color(heatVal(i)) : () => null);
    NOLA.heatKey(panel, plot, cl, keyLabel(), NOLA.short, cl && d3.range(72).some(i => heatVal(i) == null) ? `Under ${MIN_HU} homes` : null);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function dotTip(i) {
    const f = P.f[i];
    const h = st.hd ? m.overlayAt(P.x[i], P.y[i]).find(x => x.ov.feats === HDF) : null;
    return `<b>${esc(P.T[P.t[i]])}</b><div style="color:var(--ink2)">${sw(CCOL[P.c[i]])}${D.cats[P.c[i]]}</div>` + NOLA.addrRow(P, i) + row('Issued', NOLA.isoDate(P.iso(P.day[i])))
      + (f >= 0 ? row('Days from application', f === 0 ? 'Same day' : fmt(f)) : '') + row('Land use', D.lu[P.lu[i]]) + row('Neighborhood', nbName(P.nb[i]))
      + (h ? row('Historic district', `${esc(h.f.n)} (${h.f.c ? 'full' : 'partial'})`) : '');
  }
  function mapTip(i) {
    const r = perHU(nbCnt[i], i);
    return `<b>${GEO.nb[i].name}</b>` + row('Permits shown', fmt(nbCnt[i])) + row('Housing units (2020)', fmt(HU[i] || 0)) + (r != null ? row('Per 1,000 homes', NOLA.fmtRate(r)) : '');
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
    const y = d3.scaleLinear().domain([0, Math.max(4, (d3.max(D.yr, tot) || 0) * 1.05)]).range([f.ih, 0]).nice();
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

  const V = NOLA.views([
    { id: 'map', label: mapLabel, tab: 'Map of permits', keep: true, draw: drawMap },
    { id: 'years', label: 'Permits issued per year', tab: 'Per year', draw: drawYears },
    { id: 'days', label: 'Days from application to permit, past 12 months', tab: 'Days to permit', draw: drawDays },
  ], { ds: [D.ds, 'Permits'],
       state: () => ({ cat: st.cat >= 0 ? st.cat : null, lu: st.lu >= 0 ? st.lu : null, basis: st.basis !== 'n' ? st.basis : null, nb: st.nb >= 0 ? st.nb : null,
                       p: st.per !== '12' ? st.per : null, heat: st.heat ? 1 : null, hd: st.hd ? 1 : null, lm: st.lm ? 1 : null }) });
})();
