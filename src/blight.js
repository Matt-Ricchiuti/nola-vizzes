// Blight and code enforcement page
(() => {
  const D = DATA.ce; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const GEO = NOLA.GEO, HU = DATA.geo.hu || [];
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const lastLabel = NOLA.isoDate(D.last).replace(/, \d+$/, ''), YEAR = +D.last.slice(0, 4), partialYear = y => y === YEAR && !D.last.endsWith('-12-31');
  const STAGE = D.stages.map(s => ({ '1 - Inspection': 'Inspection', '2 - Title Research': 'Title research', '3 - Hearing': 'Hearing', '4 - Judgment': 'Judgment', '5 - In Compliance': 'In compliance', 'X - Processing': 'Processing' })[s] || s);
  const STAGE_C = ['var(--s1)', 'var(--s7)', 'var(--s4)', 'var(--s2)', 'var(--s3)', 'var(--muted)'];
  const AGE_L = ['Under 90 days', '90 days to 1 year', '1–2 years', '2–5 years', 'Over 5 years'];
  const AGE_C = ['var(--q2)', 'var(--q3)', 'var(--q4)', 'var(--q5)', 'var(--q7)'];
  const NEW_L = [['Violation found', 'var(--s2)'], ['No violation', 'var(--s3)'], ['Not inspected yet, or other', 'var(--muted)']];
  const HEAR_C = ['var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s7)', 'var(--muted)'];
  const HEAR_L = { Guilty: 'Guilty', Dismissed: 'Dismissed', Reset: 'Reset to a later date', Pending: 'Result pending', Other: 'Other' };
  const INSP_C = ['var(--s1)', 'var(--s3)', 'var(--s4)', 'var(--muted)'];
  const MIN_HU = 500, perHU = (n, i) => HU[i] >= MIN_HU ? 1000 * n / HU[i] : null;
  const sentence = s => s.charAt(0) + s.slice(1).toLowerCase();

  const H = NOLA.hashState();
  const TABS = ['open', 'new', 'grass', 'abate'];
  const st = { nb: H.nb != null ? +H.nb : -1, measure: TABS.includes(H.measure) ? H.measure : 'open', stage: H.stage != null ? +H.stage : -1, res: H.res != null ? +H.res : -1,
               basis: H.basis === 'hu' ? 'hu' : 'n', kind: H.kind === 'grass' ? 'grass' : 'ce', ig: H.ig != null ? +H.ig : -1 };
  if (!(st.nb >= -1 && st.nb < 72)) st.nb = -1;
  if (!(st.stage >= -1 && st.stage < STAGE.length)) st.stage = -1;
  if (!(st.res >= -1 && st.res < NEW_L.length)) st.res = -1;
  if (!(st.ig >= -1 && st.ig < D.inspGroups.length)) st.ig = -1;
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);

  // ---------- per-neighborhood numbers ----------
  const openOf = (nb, stage = st.stage) => { const a = D.openAge[nb]; return stage >= 0 ? d3.sum(a[stage]) : d3.sum(a, r => d3.sum(r)); };
  const newOf = (nb, res = st.res) => res >= 0 ? D.new12[nb][res] : d3.sum(D.new12[nb]);
  const raw = i => st.measure === 'open' ? openOf(i) : st.measure === 'new' ? newOf(i) : st.measure === 'grass' ? D.g12[i] : D.abOpen[i];
  const val = i => st.basis === 'hu' ? perHU(raw(i), i) : raw(i);
  const MEAS = { open: 'Open code enforcement cases', new: 'Cases filed in the past 12 months', grass: 'Overgrown-lot cases, past 12 months', abate: 'Properties in abatement' };
  const MAP_L = { open: 'Open code enforcement cases, by neighborhood', new: 'Code enforcement cases filed in the past 12 months, by neighborhood',
                  grass: 'Overgrown-lot cases filed in the past 12 months, by neighborhood', abate: 'Properties in abatement, by neighborhood' };
  const keyLabel = () => MEAS[st.measure] + (st.basis === 'hu' ? ' per 1,000 homes' : '');

  // ---------- map ----------
  let m;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    NOLA.ftabs(panel, [['open', 'Open cases'], ['new', 'New cases'], ['grass', 'Overgrown lots'], ['abate', 'Abatement']], st.measure, v => set('measure', v));
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const nbs = st.nb >= 0 ? [st.nb] : d3.range(72);
    if (st.measure === 'open')
      NOLA.flist(NOLA.fsec(panel, `Stage · ${fmt(d3.sum(nbs, nb => openOf(nb, -1)))}`, st.stage >= 0 ? ['All stages', () => set('stage', -1)] : null),
        STAGE.map((s, k) => ({ key: k, name: s, color: STAGE_C[k], count: d3.sum(nbs, nb => openOf(nb, k)) })), { pressed: k => st.stage === k, onClick: toggle('stage') });
    else if (st.measure === 'new')
      NOLA.flist(NOLA.fsec(panel, `First inspection · ${fmt(d3.sum(nbs, nb => newOf(nb, -1)))}`, st.res >= 0 ? ['Show all', () => set('res', -1)] : null),
        NEW_L.map(([l, c], k) => ({ key: k, name: l, color: c, count: d3.sum(nbs, nb => D.new12[nb][k]) })), { pressed: k => st.res === k, onClick: toggle('res') });
    else if (st.measure === 'grass')
      NOLA.kv(NOLA.fsec(panel, 'Overgrown lots'), [['Cases filed, past 12 months', null, fmt(d3.sum(nbs, nb => D.g12[nb]))]]);
    else {
      NOLA.kv(NOLA.fsec(panel, 'Abatement'), [['Properties in abatement now', null, fmt(d3.sum(nbs, nb => D.abOpen[nb]))]]);
      const top = D.abEnd.slice(0, 6), rest = d3.sum(D.abEnd.slice(6), d => d[1]);
      NOLA.kv(NOLA.fsec(panel, 'How closed cases ended, citywide'), [...top.map(([k, n]) => [k === 'Not stated' ? 'No reason given' : sentence(k), null, fmt(n)]), ...(rest ? [['Other reasons', null, fmt(rest)]] : [])]);
    }
    NOLA.seg(NOLA.fsec(panel, 'Count'), [['n', 'Total'], ['hu', 'Per 1,000 homes']], st.basis, v => set('basis', v));
    const leg = document.createElement('div'); leg.className = 'legend'; NOLA.fsec(panel, keyLabel()).appendChild(leg);
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of code enforcement by neighborhood', tip: mapTip });
      m.lastNb = -1;
      plot.insertAdjacentHTML('beforeend', '<div class="maplegend"></div>');
    }
    const cl = NOLA.classes(d3.range(72).map(val));
    m.setFill(i => cl.color(val(i)));
    const none = d3.range(72).some(i => val(i) == null) ? `Under ${MIN_HU} homes` : null, lf = v => st.basis === 'hu' ? NOLA.fmtRate(v) : NOLA.short(v);
    NOLA.stepLegend(leg, cl, lf, none);
    const ml = plot.querySelector('.maplegend'); NOLA.stepLegend(ml, cl, lf, none);
    const sub = st.measure === 'open' && st.stage >= 0 ? STAGE[st.stage] : st.measure === 'new' && st.res >= 0 ? NEW_L[st.res][0] : '';
    ml.insertAdjacentHTML('afterbegin', `<div class="mlh">${keyLabel()}${sub ? ' · ' + sub : ''}</div>`);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function mapTip(i) {
    const r = perHU(raw(i), i);
    return `<b>${GEO.nb[i].name}</b>` + row('Open cases', fmt(openOf(i, -1))) + (st.stage >= 0 && st.measure === 'open' ? row('Open, ' + STAGE[st.stage].toLowerCase(), fmt(openOf(i))) : '')
      + row('Cases filed, past 12 months', fmt(newOf(i, -1))) + (st.res >= 0 && st.measure === 'new' ? row('Filed, ' + NEW_L[st.res][0].toLowerCase(), fmt(newOf(i))) : '')
      + row('Overgrown-lot cases, past 12 months', fmt(D.g12[i])) + row('Properties in abatement', fmt(D.abOpen[i]))
      + row('Housing units (2020)', fmt(HU[i] || 0)) + (r != null ? row(MEAS[st.measure] + ' per 1,000 homes', NOLA.fmtRate(r)) : '');
  }

  // ---------- cases filed per year ----------
  const KIND_L = { ce: 'Code enforcement cases filed per year', grass: 'Overgrown-lot cases filed per year' };
  const yearsData = () => ({ years: st.kind === 'grass' ? D.gyears : D.years, data: (st.kind === 'grass' ? D.gyr : D.yr)[st.nb >= 0 ? st.nb : 72] });
  function drawYears(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.ftabs(panel, [['ce', 'Code enforcement'], ['grass', 'Overgrown lots']], st.kind, v => set('kind', v));
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const { years, data } = yearsData();
    const C = [['Still open', 'var(--s2)'], ['Closed', 'var(--s1)']];
    NOLA.kv(NOLA.fsec(panel, `Filed since ${years[0]} · ${fmt(d3.sum(data, d => d[0] + d[1]))}`), C.map(([l, c], k) => [l, c, fmt(d3.sum(data, d => d[k]))]));
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 340, m: { t: 18, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(years).range([0, f.iw]).paddingInner(.22);
    const y = d3.scaleLinear().domain([0, (d3.max(data, d => d[0] + d[1]) || 1) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5, d3.format(',~d'));
    data.forEach((d, k) => { let y0 = 0; [1, 0].forEach(s => { const v = d[s]; if (!v) return;
      f.g.append('rect').attr('x', x(years[k])).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', C[s][1]).attr('opacity', partialYear(years[k]) ? .45 : 1); y0 += v; }); });
    data.forEach((d, k) => { if (partialYear(years[k]) && d[0] + d[1]) f.g.append('text').attr('class', 'halo').attr('x', x(years[k]) + x.bandwidth()).attr('y', y(d[0] + d[1]) - 5).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text('to ' + lastLabel); });
    f.g.selectAll('rect.h').data(years).join('rect').attr('class', 'h').attr('x', yy => x(yy) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => { const d = data[years.indexOf(yy)];
        tip.show(`<b>Filed in ${yy}${partialYear(yy) ? ', through ' + lastLabel : ''}</b>` + `<div style="color:var(--ink2)">${st.kind === 'grass' ? 'Overgrown lots' : 'Code enforcement'}${st.nb >= 0 ? ' · ' + nbName(st.nb) : ''}</div>` + row('Cases', fmt(d[0] + d[1])) + C.map(([l, c], s) => row(sw(c) + l, fmt(d[s]))).join(''), ev); }).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => f.iw < 420 ? "'" + String(yy).slice(2) : yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- horizontal rows: label + stacked bar ----------
  function barRows(plot, rows, colors, { tipFor, onClick, labelW = 210, prev } = {}) {
    plot.innerHTML = '';
    const narrow = (plot.clientWidth || 600) < 600, rh = narrow ? 42 : 30;
    const f = NOLA.frame(plot, { h: 30 + rows.length * rh, m: { t: 4, r: 46, b: 24, l: narrow ? 6 : labelW } });
    const mx = d3.max(rows, r => Math.max(d3.sum(r.a), prev ? r.prev || 0 : 0)) || 1;
    const x = d3.scaleLinear().domain([0, mx * 1.04]).range([0, f.iw]).nice();
    f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).ticks(5).tickSize(-f.ih).tickFormat(d3.format('~s'))).call(g => g.select('.domain').remove());
    f.g.selectAll('.gridl .tick line').attr('stroke', 'var(--grid)');
    rows.forEach((r, i) => {
      const y0 = i * rh, cy = y0 + rh - (narrow ? 11 : 15);
      f.g.append('text').attr('x', narrow ? 0 : -10).attr('y', narrow ? y0 + 13 : cy + 4).attr('text-anchor', narrow ? 'start' : 'end').style('fill', r.on ? 'var(--ink)' : 'var(--ink2)').style('font-weight', r.on ? 650 : null).text(r.name);
      let x0 = 0; r.a.forEach((v, k) => { if (!v) return; f.g.append('rect').attr('x', x(x0)).attr('width', Math.max(.5, x(x0 + v) - x(x0) - .5)).attr('y', cy - 7).attr('height', 14).attr('fill', colors[k]).attr('opacity', r.dim ? .45 : 1); x0 += v; });
      if (prev && r.prev != null) f.g.append('line').attr('x1', x(r.prev)).attr('x2', x(r.prev)).attr('y1', cy - 10).attr('y2', cy + 10).attr('stroke', 'var(--ink)').attr('stroke-width', 2);
      f.g.append('text').attr('x', x(Math.max(x0, prev ? r.prev || 0 : 0)) + 6).attr('y', cy + 4).style('fill', 'var(--ink2)').text(fmt(x0));
      f.g.append('rect').attr('x', narrow ? 0 : -f.m.l).attr('width', f.iw + (narrow ? 0 : f.m.l)).attr('y', y0).attr('height', rh).attr('fill', 'transparent').style('cursor', onClick ? 'pointer' : null)
        .on('mousemove', ev => tip.show(tipFor(r), ev)).on('mouseleave', tip.hide).on('click', () => onClick && onClick(r));
    });
  }

  // ---------- open cases by stage and age ----------
  function drawOpen(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const A = D.openAge[st.nb >= 0 ? st.nb : 72], sel = st.stage >= 0 ? [A[st.stage]] : A;
    NOLA.kv(NOLA.fsec(panel, `Open for · ${st.stage >= 0 ? STAGE[st.stage] : 'all stages'}`, st.stage >= 0 ? ['All stages', () => set('stage', -1)] : null),
      [...AGE_L.map((l, a) => [l, AGE_C[a], fmt(d3.sum(sel, r => r[a]))]), ['Total', null, fmt(d3.sum(sel, r => d3.sum(r)))]]);
    const rows = STAGE.map((s, k) => ({ k, name: s, a: A[k], on: k === st.stage, dim: st.stage >= 0 && k !== st.stage })).filter(r => d3.sum(r.a));
    if (!rows.length) { plot.innerHTML = `<div class="legend">No open cases${st.nb >= 0 ? ' in ' + nbName(st.nb) : ''}.</div>`; return; }
    barRows(plot, rows, AGE_C, { labelW: 130,
      tipFor: r => `<b>${r.name}</b><div style="color:var(--ink2)">Open cases${st.nb >= 0 ? ', ' + nbName(st.nb) : ''}</div>` + row('Total', fmt(d3.sum(r.a))) + AGE_L.map((l, a) => row(sw(AGE_C[a]) + l, fmt(r.a[a]))).join(''),
      onClick: r => set('stage', st.stage === r.k ? -1 : r.k) });
  }

  // ---------- hearing results per year ----------
  function drawHear(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.kv(NOLA.fsec(panel, `Hearings since ${D.years[0]} · ${fmt(d3.sum(D.hear, d => d3.sum(d)))}`), D.hearGroups.map((g, k) => [HEAR_L[g] || g, HEAR_C[k], fmt(d3.sum(D.hear, d => d[k]))]));
    NOLA.kv(NOLA.fsec(panel, 'Scheduled'), [['After ' + lastLabel, null, fmt(D.upcoming)]]);
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 340, m: { t: 18, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(D.years).range([0, f.iw]).paddingInner(.22);
    const y = d3.scaleLinear().domain([0, (d3.max(D.hear, d => d3.sum(d)) || 1) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5, d3.format(',~d'));
    D.hear.forEach((d, k) => { let y0 = 0; d.forEach((v, g) => { if (!v) return;
      f.g.append('rect').attr('x', x(D.years[k])).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', HEAR_C[g]).attr('opacity', partialYear(D.years[k]) ? .45 : 1); y0 += v; }); });
    D.hear.forEach((d, k) => { if (partialYear(D.years[k])) f.g.append('text').attr('class', 'halo').attr('x', x(D.years[k]) + x.bandwidth()).attr('y', y(d3.sum(d)) - 5).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text('to ' + lastLabel); });
    f.g.selectAll('rect.h').data(D.years).join('rect').attr('class', 'h').attr('x', yy => x(yy) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => { const d = D.hear[D.years.indexOf(yy)];
        tip.show(`<b>Hearings in ${yy}${partialYear(yy) ? ', through ' + lastLabel : ''}</b>` + row('Total', fmt(d3.sum(d))) + D.hearGroups.map((g, k) => d[k] ? row(sw(HEAR_C[k]) + (HEAR_L[g] || g), fmt(d[k])) : '').join(''), ev); }).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(D.years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => f.iw < 420 ? "'" + String(yy).slice(2) : yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- most cited violations ----------
  const vName = s => s.replace(/^\d+\s+/, ''), vCode = s => (s.match(/^\d+/) || [''])[0];
  function drawViol(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.kv(NOLA.fsec(panel, 'All violations cited'), [['Past 12 months', 'var(--s1)', fmt(D.violTotal[0])], ['12 months before', '|var(--ink)', fmt(D.violTotal[1])]]);
    const rows = D.viol.slice(0, 15).map(v => ({ name: vName(v[0]), code: vCode(v[0]), a: [v[1]], prev: v[2] }));
    barRows(plot, rows, ['var(--s1)'], { prev: true, labelW: 220,
      tipFor: r => `<b>${r.name}</b>${r.code ? `<div style="color:var(--ink2)">City Code section 26-${r.code}</div>` : ''}` + row('Cited, past 12 months', fmt(r.a[0])) + row('12 months before', fmt(r.prev)) });
  }

  // ---------- inspections per month ----------
  const imon = D.insp.map((a, k) => ({ k, y: D.years[0] + Math.floor(k / 12), mo: k % 12, a }));
  const isMonthEnd = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.getUTCDate() === 1; };
  function drawInsp(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.flist(NOLA.fsec(panel, 'Inspection type', st.ig >= 0 ? ['Show all', () => set('ig', -1)] : null),
      D.inspGroups.map((g, k) => ({ key: k, name: g, color: INSP_C[k], count: d3.sum(imon, d => d.a[k]) })), { pressed: k => st.ig === k, onClick: toggle('ig') });
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 320, m: { t: 14, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(imon.map(d => d.k)).range([0, f.iw]).paddingInner(.15);
    const show = g => st.ig < 0 || g === st.ig, tot = d => d3.sum(d.a.filter((v, g) => show(g)));
    const y = d3.scaleLinear().domain([0, (d3.max(imon, tot) || 1) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5, d3.format(',~d'));
    const lastMonthPartial = !isMonthEnd(D.last);
    imon.forEach(d => { let y0 = 0; d.a.forEach((v, g) => { if (!v || !show(g)) return;
      f.g.append('rect').attr('x', x(d.k)).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', INSP_C[g]).attr('opacity', d.k === imon.length - 1 && lastMonthPartial ? .45 : 1); y0 += v; }); });
    f.g.selectAll('rect.h').data(imon).join('rect').attr('class', 'h').attr('x', d => x(d.k)).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(`<b>${NOLA.monthsLong[d.mo]} ${d.y}${d.k === imon.length - 1 && lastMonthPartial ? ', through ' + lastLabel : ''}</b>` + row('Inspections', fmt(tot(d))) + D.inspGroups.map((g, k) => show(k) && d.a[k] ? row(sw(INSP_C[k]) + g, fmt(d.a[k])) : '').join(''), ev)).on('mouseleave', tip.hide);
    const step = f.iw < 500 ? 2 : 1;
    f.g.selectAll('text.x').data(imon.filter(d => d.mo === 0 && d.y % step === 0)).join('text').attr('class', 'x').attr('x', d => x(d.k)).attr('y', f.ih + 18).text(d => d.y);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- CSV downloads ----------
  const csvMap = () => NOLA.nbList().map(f => { const i = f.idx;
    return Object.assign({ neighborhood: f.name, housing_units_2020: HU[i], open_cases: openOf(i, -1) }, ...STAGE.map((s, k) => ({ ['open, ' + s.toLowerCase()]: openOf(i, k) })),
      { cases_filed_past_12_months: newOf(i, -1) }, ...NEW_L.map(([l], k) => ({ ['filed past 12 months, ' + l.toLowerCase()]: D.new12[i][k] })),
      { overgrown_lot_cases_past_12_months: D.g12[i], properties_in_abatement: D.abOpen[i] }); });
  const csvYears = () => { const { years, data } = yearsData();
    return data.map((d, k) => ({ year: years[k], area: st.nb >= 0 ? nbName(st.nb) : 'New Orleans', cases: st.kind === 'grass' ? 'overgrown lots' : 'code enforcement', filed: d[0] + d[1], still_open: d[0], closed: d[1] })); };
  const csvOpen = () => { const A = D.openAge[st.nb >= 0 ? st.nb : 72];
    return STAGE.map((s, k) => Object.assign({ area: st.nb >= 0 ? nbName(st.nb) : 'New Orleans', stage: s, open: d3.sum(A[k]) }, ...AGE_L.map((l, a) => ({ [l]: A[k][a] })))); };
  const csvHear = () => D.hear.map((d, k) => Object.assign({ year: D.years[k], hearings: d3.sum(d) }, ...D.hearGroups.map((g, j) => ({ [HEAR_L[g] || g]: d[j] }))));
  const csvViol = () => D.viol.map(v => ({ violation: vName(v[0]), code_section: vCode(v[0]) ? '26-' + vCode(v[0]) : '', past_12_months: v[1], previous_12_months: v[2] }));
  const csvInsp = () => imon.map(d => Object.assign({ month: `${d.y}-${String(d.mo + 1).padStart(2, '0')}`, inspections: d3.sum(d.a) }, ...D.inspGroups.map((g, k) => ({ [g]: d.a[k] }))));

  const V = NOLA.views([
    { id: 'map', label: () => MAP_L[st.measure], tab: 'Map of cases', keep: true, draw: drawMap, csv: csvMap },
    { id: 'years', label: () => KIND_L[st.kind], tab: 'Cases filed per year', draw: drawYears, csv: csvYears, file: () => st.kind === 'grass' ? 'overgrown-lots-per-year' : 'years' },
    { id: 'open', label: 'Open cases, by stage and how long they have been open', tab: 'Open cases', draw: drawOpen, csv: csvOpen },
    { id: 'violations', label: 'Most cited violations, past 12 months', tab: 'Violations', draw: drawViol, csv: csvViol },
    { id: 'hearings', label: 'Hearing results per year', tab: 'Hearings', draw: drawHear, csv: csvHear },
    { id: 'inspections', label: 'Inspections per month', tab: 'Inspections', draw: drawInsp, csv: csvInsp },
  ], { ds: [D.ds[0], 'Code Enforcement All Cases'],
       state: () => ({ measure: st.measure !== 'open' ? st.measure : null, stage: st.stage >= 0 ? st.stage : null, res: st.res >= 0 ? st.res : null, basis: st.basis !== 'n' ? st.basis : null,
                       kind: st.kind !== 'ce' ? st.kind : null, ig: st.ig >= 0 ? st.ig : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
