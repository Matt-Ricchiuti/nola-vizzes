// Short-term rentals page
(() => {
  const D = DATA.str; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const GEO = NOLA.GEO, HU = DATA.geo.hu || [];
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const CAT = [{ n: 'Commercial', c: 'var(--s2)' }, { n: 'Non-commercial', c: 'var(--s1)' },
               { n: 'Exempt lodging', sub: 'Lodging exempt from STR rules', c: 'var(--s7)' }];
  const STATUS = { Issued: 'Issued, still valid', Expired: 'Issued, since expired', Revoked: 'Revoked', Pending: 'Pending', Withdrawn: 'Withdrawn', Denied: 'Denied', Duplicate: 'Duplicate' };
  const SCOL = ['var(--s3)', 'var(--q3)', 'var(--s8)', 'var(--s4)', 'var(--muted)', 'var(--s2)', 'var(--s7)'];
  const GCOL = ['var(--s2)', 'var(--s1)', 'var(--s5)', 'var(--muted)'];
  // the City's license types since 2017, grouped (see STR_GROUPS in fetch.py)
  const GNAME = [['Commercial', null], ['Residential', 'Accessory, residential owner, non-commercial'], ['Temporary', 'Under the 2017 rules'], ['Other or not stated', null]];
  const MIN_HU = 500; // rates for neighborhoods with fewer homes than this swing wildly, so they're left out
  const perHU = (n, i) => HU[i] >= MIN_HU ? 100 * n / HU[i] : null;
  const lastLabel = NOLA.isoDate(D.last).replace(/, \d+$/, ''), YEAR = +D.last.slice(0, 4);

  const H = NOLA.hashState();
  const st = { nb: H.nb != null ? +H.nb : -1, cats: H.cats != null ? H.cats.split('').map(Number).filter(c => c < 3) : [0, 1, 2],
               view: H.mapview === 'shade' ? 'shade' : 'dots', basis: H.basis === 'hu' ? 'hu' : 'n', group: H.group != null ? +H.group : -1 };
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const catOn = c => st.cats.includes(c);
  const toggleCat = c => set('cats', catOn(c) ? (st.cats.length > 1 ? st.cats.filter(x => x !== c) : st.cats) : [...st.cats, c].sort());

  // ---------- active licenses ----------
  const pts = D.pts.map(p => ({ x: p[0], y: p[1], cat: p[2], nb: p[3], beds: p[4] }));
  const byNb = d3.range(72).map(() => [0, 0, 0]), bedsNb = d3.range(72).map(() => [0, 0, 0]);
  pts.forEach(p => { if (p.nb >= 0) { byNb[p.nb][p.cat]++; bedsNb[p.nb][p.cat] += p.beds; } });
  const cnt = i => d3.sum(st.cats, c => byNb[i][c]);
  const val = i => st.basis === 'hu' ? perHU(cnt(i), i) : cnt(i);
  let m, dotG;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    NOLA.ftabs(panel, [['dots', 'Each license'], ['shade', 'By neighborhood']], st.view, v => set('view', v));
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const inNb = p => st.nb < 0 || p.nb === st.nb;
    NOLA.flist(NOLA.fsec(panel, `Active licenses · ${fmt(pts.filter(p => inNb(p) && catOn(p.cat)).length)}`),
      CAT.map((c, k) => ({ key: k, name: c.n, sub: c.sub, color: c.c, count: pts.filter(p => p.cat === k && inNb(p)).length })), { pressed: catOn, onClick: toggleCat, mode: 'toggle' });
    let leg = null;
    if (st.view === 'shade') {
      NOLA.seg(NOLA.fsec(panel, 'Count'), [['n', 'Total'], ['hu', 'Per 100 homes']], st.basis, v => set('basis', v));
      const ls = NOLA.fsec(panel, 'Legend'); leg = document.createElement('div'); leg.className = 'legend'; ls.appendChild(leg);
      if (st.basis === 'hu') ls.insertAdjacentHTML('beforeend', '<div class="legend popnote">Per 100 homes (2020 Census housing units)</div>');
    }
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of short-term rental licenses', tip: mapTip });
      dotG = m.layer.append('g'); m.lastNb = -1;
      m.onZoom(k => dotG.selectAll('circle').attr('r', 3.2 / Math.sqrt(k)).attr('stroke-width', .8 / Math.sqrt(k)));
      plot.insertAdjacentHTML('beforeend', '<div class="maplegend"></div>');
    }
    const ml = plot.querySelector('.maplegend');
    if (st.view === 'shade') {
      const cl = NOLA.classes(d3.range(72).map(val));
      m.setFill(i => cl.color(val(i)));
      const none = d3.range(72).some(i => val(i) == null) ? `Under ${MIN_HU} homes` : null, lf = v => st.basis === 'hu' ? (+v).toFixed(1) : NOLA.short(v);
      NOLA.stepLegend(leg, cl.edges, lf, none); NOLA.stepLegend(ml, cl.edges, lf, none);
      ml.insertAdjacentHTML('afterbegin', `<div class="mlh">Licenses${st.basis === 'hu' ? ' per 100 homes' : ''}</div>`);
      ml.hidden = false;
    } else { m.setFill(() => null); ml.hidden = true; }
    const k = m.k();
    dotG.selectAll('circle').data(st.view === 'dots' ? pts.filter(p => catOn(p.cat) && (p.x || p.y)) : [], p => p.x + ',' + p.y + ',' + p.cat).join('circle')
      .attr('cx', p => p.x).attr('cy', p => p.y).attr('r', 3.2 / Math.sqrt(k)).attr('fill', p => CAT[p.cat].c).attr('fill-opacity', .85)
      .attr('stroke', 'var(--surface)').attr('stroke-width', .8 / Math.sqrt(k)).style('pointer-events', 'none');
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function mapTip(i) {
    const n = byNb[i], tot = cnt(i), r = perHU(tot, i);
    return `<b>${GEO.nb[i].name}</b>` + CAT.map((c, k) => row(sw(c.c) + c.n, fmt(n[k]))).join('') + row('Bedrooms licensed', fmt(d3.sum(st.cats, c => bedsNb[i][c])))
      + row('Housing units (2020)', fmt(HU[i] || 0)) + (r != null ? row('Selected licenses per 100 homes', r.toFixed(1)) : '');
  }

  // ---------- non-commercial licenses ----------
  const NC = D.nc, ncRows = NC.rows.map(r => ({ nb: r[0], b: r[1], whole: r[2], beds: r[3], op: r[4], st: r[5] }));
  const shortB = s => s.replace(/ \(Residential and Business Uses in Same Building\)/, ' (home and business)').replace('Two-Family (Double)', 'Two-family (double)').replace('Single Family Home', 'Single-family home')
    .replace('Three-Family', 'Three-family').replace('Four-Family', 'Four-family').replace('More than Four Families', 'Five or more units').replace('Mixed Use', 'Mixed use');
  const WH = [['Part of the home', 'var(--s3)'], ['Whole unit', 'var(--s1)'], ['Not stated', 'var(--muted)']];
  function drawNC(pane, first) {
    const { panel, plot } = staged(pane, first);
    const rs = ncRows.filter(r => st.nb < 0 || r.nb === st.nb);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const kv = (title, items) => NOLA.fsec(panel, title).insertAdjacentHTML('beforeend', '<div class="srages">' + items.map(([l, c, n]) => `<span>${c ? `<i style="background:${c}"></i>` : '<i></i>'}${l}<b>${fmt(n)}</b></span>`).join('') + '</div>');
    kv(`Rented as · ${fmt(rs.length)} licenses`, WH.map(([l, c], w) => [l, c, rs.filter(r => r.whole === w).length]).filter(d => d[2]));
    kv('Run by', NC.OP.map((o, k) => [o === 'Operator/Property Manager' ? 'Operator or property manager' : o === 'Agent for Service' ? 'Agent' : o, null, rs.filter(r => r.op === k).length]));
    kv('Bedrooms rented', d3.range(1, 4).map(b => [b + (b === 1 ? ' bedroom' : ' bedrooms'), null, rs.filter(r => r.beds === b).length]).filter(d => d[2]));
    plot.innerHTML = '';
    const rows = NC.B.map((b, k) => ({ k, name: shortB(b), a: [0, 1, 2].map(w => rs.filter(r => r.b === k && r.whole === w).length) })).map(r => Object.assign(r, { n: d3.sum(r.a) })).filter(r => r.n);
    if (!rows.length) { plot.innerHTML = `<div class="legend">No non-commercial licenses in ${nbName(st.nb)}.</div>`; return; }
    const narrow = (plot.clientWidth || 600) < 600, rh = narrow ? 42 : 34;
    const f = NOLA.frame(plot, { h: 30 + rows.length * rh, m: { t: 4, r: 40, b: 24, l: narrow ? 6 : 210 } });
    const x = d3.scaleLinear().domain([0, d3.max(rows, r => r.n) * 1.05]).range([0, f.iw]).nice();
    f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).ticks(5).tickSize(-f.ih)).call(g => g.select('.domain').remove());
    f.g.selectAll('.gridl .tick line').attr('stroke', 'var(--grid)');
    rows.forEach((r, i) => {
      const y0 = i * rh, cy = y0 + rh - (narrow ? 11 : 17);
      f.g.append('text').attr('x', narrow ? 0 : -10).attr('y', narrow ? y0 + 13 : cy + 4).attr('text-anchor', narrow ? 'start' : 'end').style('fill', 'var(--ink2)').text(r.name);
      let x0 = 0; r.a.forEach((v, w) => { if (!v) return; f.g.append('rect').attr('x', x(x0)).attr('width', Math.max(.5, x(x0 + v) - x(x0) - .5)).attr('y', cy - 8).attr('height', 16).attr('fill', WH[w][1]); x0 += v; });
      f.g.append('text').attr('x', x(r.n) + 6).attr('y', cy + 4).style('fill', 'var(--ink2)').text(fmt(r.n));
      f.g.append('rect').attr('x', narrow ? 0 : -f.m.l).attr('width', f.iw + (narrow ? 0 : f.m.l)).attr('y', y0).attr('height', rh).attr('fill', 'transparent')
        .on('mousemove', ev => tip.show(`<b>${r.name}</b>${st.nb >= 0 ? `<div style="color:var(--ink2)">${nbName(st.nb)}</div>` : ''}` + row('Licenses', fmt(r.n)) + WH.map(([l, c], w) => r.a[w] ? row(sw(c) + l, fmt(r.a[w])) : '').join(''), ev)).on('mouseleave', tip.hide);
    });
  }

  // ---------- applications per year ----------
  const nbApps = D.nby.map(a => { const o = []; for (let i = 0; i < a.length; i += 4) o.push(a.slice(i, i + 4)); return o; });
  const appCounts = () => { // [year][status] for the chosen group and neighborhood
    const out = D.years.map(() => D.status.map(() => 0));
    if (st.nb >= 0) nbApps[st.nb].forEach(([k, g, s, n]) => { if (st.group < 0 || g === st.group) out[k][s] += n; });
    else D.yr.forEach((gs, k) => gs.forEach((ss, g) => { if (st.group < 0 || g === st.group) ss.forEach((n, s) => out[k][s] += n); }));
    return out;
  };
  function drawApps(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const gCount = g => st.nb >= 0 ? d3.sum(nbApps[st.nb].filter(a => a[1] === g), a => a[3]) : d3.sum(D.yr, gs => d3.sum(gs[g]));
    NOLA.flist(NOLA.fsec(panel, 'License type', st.group >= 0 ? ['Show all', () => set('group', -1)] : null),
      D.groups.map((g, k) => ({ key: k, name: GNAME[k][0], sub: GNAME[k][1], color: GCOL[k], count: gCount(k) })), { pressed: k => st.group === k, onClick: k => set('group', st.group === k ? -1 : k) });
    const data = appCounts();
    NOLA.fsec(panel, 'Outcome').insertAdjacentHTML('beforeend', '<div class="srages">' + D.status.map((s, k) => `<span><i style="background:${SCOL[k]}"></i>${STATUS[s] || s}<b>${fmt(d3.sum(data, d => d[k]))}</b></span>`).join('') + '</div>');
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 380, m: { t: 18, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(D.years).range([0, f.iw]).paddingInner(.22);
    const y = d3.scaleLinear().domain([0, (d3.max(data, d => d3.sum(d)) || 1) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5, d3.format(','));
    const partial = k => D.years[k] === YEAR && !D.last.endsWith('-12-31');
    data.forEach((d, k) => { let y0 = 0; d.forEach((v, s) => { if (!v) return;
      f.g.append('rect').attr('x', x(D.years[k])).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', SCOL[s]).attr('opacity', partial(k) ? .55 : 1); y0 += v; }); });
    data.forEach((d, k) => { if (partial(k)) f.g.append('text').attr('class', 'halo').attr('x', x(D.years[k]) + x.bandwidth()).attr('y', y(d3.sum(d)) - 5).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text('to ' + lastLabel); });
    f.g.selectAll('rect.h').data(D.years).join('rect').attr('class', 'h').attr('x', yy => x(yy) - 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => { const k = D.years.indexOf(yy), d = data[k];
        tip.show(`<b>Applied in ${yy}${partial(k) ? ', through ' + lastLabel : ''}</b>` + (st.group >= 0 ? `<div style="color:var(--ink2)">${GNAME[st.group][0]}</div>` : '') + row('Applications', fmt(d3.sum(d))) + D.status.map((s, j) => d[j] ? row(sw(SCOL[j]) + (STATUS[s] || s), fmt(d[j])) : '').join(''), ev); }).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(D.years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => f.iw < 420 ? "'" + String(yy).slice(2) : yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  const V = NOLA.views([
    { id: 'map', label: 'Active short-term rental licenses', keep: true, draw: drawMap, ds: [D.ds[0], 'Active Short-Term Rental Licenses'] },
    { id: 'noncommercial', label: 'Non-commercial licenses, by type of building', tab: 'Non-commercial Licenses', draw: drawNC, ds: [D.ds[2], 'Non-Commercial Short-Term Rental Licenses'] },
    { id: 'applications', label: 'Permit applications per year, by outcome', tab: 'Permit applications', draw: drawApps, ds: [D.ds[1], 'Short-Term Rental Permit Applications'] },
  ], { ds: [D.ds[0], 'Active Short-Term Rental Licenses'],
       state: () => ({ mapview: st.view !== 'dots' ? st.view : null, cats: st.cats.length < 3 ? st.cats.join('') : null, basis: st.basis !== 'n' ? st.basis : null,
                       group: st.group >= 0 ? st.group : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
