// 311 service requests page
(() => {
  const D = DATA.sr; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const NT = D.T.length, GEO = NOLA.GEO;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  // the seven most-requested types get a color; the rest share gray
  const tColor = t => t < 7 ? NOLA.S(t) : 'var(--muted)';
  const lastISO = D.last, lastLabel = NOLA.isoDate(lastISO).replace(/, \d+$/, '');
  const AGE_L = ['Under 30 days', '30–89 days', '90 days to 1 year', '1–2 years', 'Over 2 years'];
  const AGE_C = ['var(--q2)', 'var(--q3)', 'var(--q4)', 'var(--q5)', 'var(--q7)'];

  const H = NOLA.hashState();
  const st = { nb: H.nb != null ? +H.nb : -1, type: H.type != null ? +H.type : -1, reason: H.reason != null ? +H.reason : -1,
               measure: H.measure === 'open' ? 'open' : 'made', basis: H.basis === 'pc' ? 'pc' : 'n' };
  if (!(st.type < NT)) st.type = -1;
  if (st.reason >= 0 && (!D.R[st.reason] || D.R[st.reason][0] !== st.type)) st.reason = -1;
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; if (k === 'type') st.reason = -1; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  const reasonName = r => D.R[r][1] === 'Other' ? `Other ${D.T[D.R[r][0]].toLowerCase()} requests` : D.R[r][1];

  // ---------- per-neighborhood numbers ----------
  // past 12 months, by reason: nb12[nb] = [reason, n, reason, n, ...]
  const nbR = D.nb12.map(a => { const m = new Map(); for (let i = 0; i < a.length; i += 2) m.set(a[i], a[i + 1]); return m; });
  const madeOf = (nb, type = st.type, reason = st.reason) => {
    let s = 0; nbR[nb].forEach((n, r) => { if (reason >= 0 ? r === reason : type < 0 || D.R[r][0] === type) s += n; }); return s; };
  const openOf = (nb, type = st.type) => { const a = D.openAge[nb]; return type >= 0 ? d3.sum(a[type]) : d3.sum(a, r => d3.sum(r)); };
  const raw = i => st.measure === 'open' ? openOf(i) : madeOf(i);
  const val = i => st.basis === 'pc' ? NOLA.perK(raw(i), NOLA.popOf(i)) : raw(i);
  const measureLabel = () => (st.measure === 'open' ? 'Open requests' : 'Requests, past 12 months')
    + (st.reason >= 0 && st.measure === 'made' ? ': ' + reasonName(st.reason) : st.type >= 0 ? ': ' + D.T[st.type] : '')
    + (st.basis === 'pc' ? ' per 1,000 residents' : '');
  const POP_NOTE = '<div class="legend popnote">Per 1,000 residents (2020 Census). Requests can be about any place, so rates run high where few people live, like the CBD. Neighborhoods under 1,000 residents are left out.</div>';

  // ---------- neighborhood map ----------
  let m;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    NOLA.ftabs(panel, [['made', 'Requests, past 12 months'], ['open', 'Open now']], st.measure, v => set('measure', v));
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const inNb = nb => st.nb < 0 || nb === st.nb, nbs = d3.range(72).filter(inNb);
    const tCount = t => d3.sum(nbs, nb => st.measure === 'open' ? openOf(nb, t) : madeOf(nb, t, -1));
    NOLA.flist(NOLA.fsec(panel, 'Request type', st.type >= 0 ? ['Show all', () => set('type', -1)] : null),
      D.T.map((t, k) => ({ key: k, name: t, color: tColor(k), count: tCount(k) })), { pressed: k => st.type === k, onClick: toggle('type') });
    if (st.type >= 0 && st.measure === 'made') {
      const rs = D.R.map((r, k) => k).filter(k => D.R[k][0] === st.type);
      if (rs.length > 1) NOLA.flist(NOLA.fsec(panel, 'Reason', st.reason >= 0 ? ['Any reason', () => set('reason', -1)] : null),
        rs.map(k => ({ key: k, name: reasonName(k), color: tColor(st.type), count: d3.sum(nbs, nb => nbR[nb].get(k) || 0) })),
        { pressed: k => st.reason === k, onClick: toggle('reason') });
    }
    NOLA.seg(NOLA.fsec(panel, 'Count'), [['n', 'Total'], ['pc', 'Per 1,000 residents']], st.basis, v => set('basis', v));
    const ls = NOLA.fsec(panel, 'Legend'), leg = document.createElement('div'); leg.className = 'legend'; ls.appendChild(leg);
    if (st.basis === 'pc') ls.insertAdjacentHTML('beforeend', POP_NOTE);
    if (st.nb >= 0) yearsMini(NOLA.fsec(panel, `Requests per year · ${nbName(st.nb)}`), st.nb);
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of 311 requests by neighborhood', tip: mapTip });
      m.lastNb = -1;
      plot.insertAdjacentHTML('beforeend', '<div class="maplegend"></div>');
    }
    const cl = NOLA.classes(d3.range(72).map(val));
    m.setFill(i => cl.color(val(i)));
    const none = d3.range(72).some(i => val(i) == null) ? 'Under 1,000 residents' : null;
    const lf = v => NOLA.short(v);
    NOLA.stepLegend(leg, cl.edges, lf, none);
    const ml = plot.querySelector('.maplegend');
    NOLA.stepLegend(ml, cl.edges, lf, none);
    ml.insertAdjacentHTML('afterbegin', `<div class="mlh">${measureLabel()}</div>`);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function mapTip(i) {
    const pop = NOLA.popOf(i), made = madeOf(i), open = openOf(i), rate = NOLA.perK(raw(i), pop);
    const top = [...nbR[i]].filter(([r]) => st.type < 0 || D.R[r][0] === st.type).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const what = st.reason >= 0 ? reasonName(st.reason) : st.type >= 0 ? D.T[st.type] : 'All requests';
    return `<b>${GEO.nb[i].name}</b><div style="color:var(--ink2)">${what}</div>` + row('Requests, past 12 months', fmt(made)) + row('Open now', fmt(open))
      + row('Residents (2020)', pop == null ? '—' : fmt(pop)) + (rate != null ? row((st.measure === 'open' ? 'Open' : 'Requests') + ' per 1,000 residents', NOLA.fmtRate(rate)) : '')
      + (top.length && st.reason < 0 ? '<div style="margin-top:6px;color:var(--ink2)">Most common</div>' + top.map(([r, n]) => row(reasonName(r), fmt(n))).join('') : '');
  }
  // small yearly bar chart for the chosen neighborhood, inside the map panel
  function yearsMini(sec, nb) {
    const box = document.createElement('div'); box.className = 'srmini'; sec.appendChild(box);
    const vals = D.years.map((y, k) => st.type >= 0 ? D.nby[nb][k][st.type] : d3.sum(D.nby[nb][k]));
    const f = NOLA.frame(box, { h: 96, m: { t: 14, r: 2, b: 16, l: 2 } });
    const x = d3.scaleBand().domain(D.years).range([0, f.iw]).paddingInner(.2), y = d3.scaleLinear().domain([0, d3.max(vals) || 1]).range([f.ih, 0]);
    const partial = k => k === D.years.length - 1 || (k === 0 && D.start.slice(5) !== '01');
    f.g.selectAll('rect').data(vals).join('rect').attr('x', (v, k) => x(D.years[k])).attr('width', x.bandwidth()).attr('y', v => y(v)).attr('height', v => f.ih - y(v))
      .attr('rx', 1.5).attr('fill', st.type >= 0 ? tColor(st.type) : 'var(--s1)').attr('opacity', (v, k) => partial(k) ? .45 : 1)
      .on('mousemove', (ev, v) => { const k = vals.indexOf(v); tip.show(`<b>${D.years[k]}${k === D.years.length - 1 ? ', through ' + lastLabel : k === 0 && partial(0) ? ', from ' + NOLA.months[+D.start.slice(5) - 1] : ''}</b>` + row('Requests', fmt(v)), ev); }).on('mouseleave', tip.hide);
    f.g.selectAll('text.v').data(vals).join('text').attr('class', 'v').attr('x', (v, k) => x(D.years[k]) + x.bandwidth() / 2).attr('y', v => y(v) - 3).attr('text-anchor', 'middle').style('font-size', '9.5px').text(v => NOLA.short(v));
    f.g.selectAll('text.x').data(D.years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 12).attr('text-anchor', 'middle').style('font-size', '9.5px').text(yy => "'" + String(yy).slice(2));
  }

  // ---------- requests per month ----------
  const mon = D.mon.map((a, k) => { const y = +D.start.slice(0, 4) + Math.floor((+D.start.slice(5) - 1 + k) / 12), mo = (+D.start.slice(5) - 1 + k) % 12; return { k, y, mo, a }; });
  function drawMonthly(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.flist(NOLA.fsec(panel, `Request type · since ${NOLA.months[mon[0].mo]} ${mon[0].y}`, st.type >= 0 ? ['Show all', () => set('type', -1)] : null),
      D.T.map((t, k) => ({ key: k, name: t, color: tColor(k), count: d3.sum(mon, d => d.a[k]) })), { pressed: k => st.type === k, onClick: toggle('type') });
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 380, m: { t: 14, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(mon.map(d => d.k)).range([0, f.iw]).paddingInner(.15);
    const show = t => st.type < 0 || t === st.type;
    const tot = d => d3.sum(d.a.filter((v, t) => show(t)));
    const y = d3.scaleLinear().domain([0, d3.max(mon, tot) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5);
    const partial = d => d.k === mon.length - 1 && !isMonthEnd(lastISO);
    // stack: the colored types at the bottom, the gray ones on top
    const order = d3.range(NT).filter(show);
    mon.forEach(d => { let y0 = 0; order.forEach(t => { const v = d.a[t]; if (!v) return;
      f.g.append('rect').attr('x', x(d.k)).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', st.type >= 0 ? tColor(st.type) : tColor(t)).attr('opacity', partial(d) ? .45 : 1); y0 += v; }); });
    f.g.selectAll('rect.h').data(mon).join('rect').attr('class', 'h').attr('x', d => x(d.k)).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(`<b>${NOLA.monthsLong[d.mo]} ${d.y}${partial(d) ? ', through ' + lastLabel : ''}</b>` + row('Requests', fmt(tot(d)))
        + (st.type < 0 ? d3.range(NT).filter(t => d.a[t]).sort((a, b) => d.a[b] - d.a[a]).slice(0, 8).map(t => row(sw(tColor(t)) + D.T[t], fmt(d.a[t]))).join('') : ''), ev)).on('mouseleave', tip.hide);
    const step = f.iw < 500 ? 2 : 1;
    f.g.selectAll('text.x').data(mon.filter(d => d.mo === 0 && d.y % step === 0)).join('text').attr('class', 'x').attr('x', d => x(d.k)).attr('y', f.ih + 18).text(d => d.y);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }
  const isMonthEnd = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.getUTCDate() === 1; };

  // ---------- days to close ----------
  const dayLab = v => v == null ? '—' : v < 1 ? 'under 1 day' : v < 2 ? '1 day' : v < 60 ? Math.round(v) + ' days' : v < 730 ? Math.round(v / 30.4) + ' months' : (v / 365).toFixed(1) + ' years';
  // rows drawn as label + dot (median) + ring (slowest 10%), on a log-like day scale
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
      if (!narrow) { const node = lab.node(); while (node.getComputedTextLength && node.getComputedTextLength() > 240 && node.textContent.length > 8) node.textContent = node.textContent.slice(0, -4) + '…'; }
      mark(f.g, r, cy, x);
      f.g.append('rect').attr('x', narrow ? 0 : -f.m.l).attr('width', f.iw + (narrow ? 0 : f.m.l)).attr('y', y0).attr('height', rh).attr('fill', 'transparent').style('cursor', onClick && r.key != null ? 'pointer' : null)
        .on('mousemove', ev => tip.show(tipFor(r), ev)).on('mouseleave', tip.hide).on('click', () => onClick && r.key != null && onClick(r.key));
    });
  }
  const DAYT = [[0, 1, 7, 30, 90, 365, 1095], ['0', '1 day', '1 wk', '1 mo', '3 mo', '1 yr', '3 yr']];
  function drawClose(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    NOLA.flist(NOLA.fsec(panel, 'Request type', st.type >= 0 ? ['Show all', () => set('type', -1)] : null),
      D.T.map((t, k) => ({ key: k, name: t, color: tColor(k), count: st.nb >= 0 ? D.closeNb[st.nb][k][0] : D.closeT[k][0] })), { pressed: k => st.type === k, onClick: toggle('type') });
    NOLA.fsec(panel, 'Key').insertAdjacentHTML('beforeend', NOLA.legendHTML([['var(--s1)', 'Median', 1], ['transparent;border:2px solid var(--s1);width:8px;height:8px', 'Slowest 10% take longer than', 1]]).replace('class="legend"', 'class="legend" style="flex-direction:column;gap:6px"'));
    let rows;
    if (st.nb >= 0) rows = D.T.map((t, k) => ({ key: k, name: t, n: D.closeNb[st.nb][k][0], med: D.closeNb[st.nb][k][1], p90: null, on: k === st.type, t: k }));
    else if (st.type >= 0) rows = [{ key: null, name: 'All ' + D.T[st.type].toLowerCase(), n: D.closeT[st.type][0], med: D.closeT[st.type][1], p90: D.closeT[st.type][2], on: true, t: st.type }]
      .concat(D.R.map((r, k) => k).filter(k => D.R[k][0] === st.type).map(k => ({ key: null, name: reasonName(k), n: D.closeR[k][0], med: D.closeR[k][1], p90: D.closeR[k][2], t: st.type })));
    else rows = D.T.map((t, k) => ({ key: k, name: t, n: D.closeT[k][0], med: D.closeT[k][1], p90: D.closeT[k][2], t: k }));
    rows = rows.filter(r => r.n > 0).sort((a, b) => (b.on === true) - (a.on === true) || (a.med == null) - (b.med == null) || a.med - b.med);
    const mx = d3.max(rows, r => Math.max(r.p90 || 0, r.med || 0)) || 30;
    rowsChart(plot, rows, {
      scale: d3.scaleSymlog().constant(1).domain([0, Math.max(30, mx * 1.1)]),
      ticks: [DAYT[0].filter(v => v <= Math.max(30, mx * 1.1)), DAYT[1]],
      mark: (g, r, cy, x) => {
        if (r.med == null) { g.append('text').attr('x', 0).attr('y', cy + 4).style('fill', 'var(--muted)').text('too few to tell'); return; }
        if (r.p90 != null) g.append('line').attr('x1', x(r.med)).attr('x2', x(r.p90)).attr('y1', cy).attr('y2', cy).attr('stroke', tColor(r.t)).attr('stroke-width', 2).attr('opacity', .5);
        g.append('circle').attr('cx', x(r.med)).attr('cy', cy).attr('r', 6).attr('fill', tColor(r.t)).attr('stroke', 'var(--surface)').attr('stroke-width', 2);
        if (r.p90 != null) g.append('circle').attr('cx', x(r.p90)).attr('cy', cy).attr('r', 6.5).attr('fill', 'none').attr('stroke', tColor(r.t)).attr('stroke-width', 2);
      },
      tipFor: r => `<b>${r.name}</b>${st.nb >= 0 ? `<div style="color:var(--ink2)">${nbName(st.nb)}</div>` : ''}` + row('Closed in the past 12 months', fmt(r.n)) + row('Median time to close', dayLab(r.med)) + (r.p90 != null ? row('Slowest 10% took over', dayLab(r.p90)) : ''),
      onClick: k => set('type', st.type === k ? -1 : k),
    });
  }

  // ---------- open requests by age ----------
  function drawOpen(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const A = D.openAge[st.nb >= 0 ? st.nb : 72];
    NOLA.fsec(panel, `Open for · ${fmt(d3.sum(A, r => d3.sum(r)))} requests`).insertAdjacentHTML('beforeend', '<div class="srages">' + AGE_L.map((l, a) =>
      `<span><i style="background:${AGE_C[a]}"></i>${l}<b>${fmt(d3.sum(A, r => r[a]))}</b></span>`).join('') + '</div>');
    const rows = D.T.map((t, k) => ({ key: k, name: t, a: A[k], n: d3.sum(A[k]), on: k === st.type })).filter(r => r.n).sort((a, b) => b.n - a.n);
    const mx = d3.max(rows, r => r.n) || 1;
    rowsChart(plot, rows, {
      scale: d3.scaleLinear().domain([0, mx * 1.08]).nice(),
      ticks: (() => { const t = d3.scaleLinear().domain([0, mx * 1.08]).nice().ticks(5); return [t, t.map(v => NOLA.short(v))]; })(),
      mark: (g, r, cy, x) => { let x0 = 0; r.a.forEach((v, a) => { if (!v) return; g.append('rect').attr('x', x(x0)).attr('width', Math.max(.5, x(x0 + v) - x(x0) - .5)).attr('y', cy - 7).attr('height', 14).attr('fill', AGE_C[a]); x0 += v; }); },
      tipFor: r => `<b>${r.name}</b><div style="color:var(--ink2)">Open requests${st.nb >= 0 ? ', ' + nbName(st.nb) : ''}</div>` + row('Total', fmt(r.n)) + AGE_L.map((l, a) => row(sw(AGE_C[a]) + l, fmt(r.a[a]))).join(''),
      onClick: k => set('type', st.type === k ? -1 : k),
    });
  }

  // ---------- CSV downloads ----------
  const csvMap = () => NOLA.nbList().map(f => { const i = f.idx, pop = NOLA.popOf(i);
    return Object.assign({ neighborhood: f.name, residents_2020: pop, requests_past_12_months: madeOf(i, -1, -1), open_now: openOf(i, -1) },
      st.type >= 0 || st.reason >= 0 ? { filter: st.reason >= 0 ? reasonName(st.reason) : D.T[st.type], filtered_requests_past_12_months: madeOf(i), filtered_open_now: openOf(i) } : {},
      ...D.T.map((t, k) => ({ [t + ' (past 12 months)']: madeOf(i, k, -1) }))); });
  const csvMonthly = () => mon.map(d => Object.assign({ month: `${d.y}-${String(d.mo + 1).padStart(2, '0')}`, total: d3.sum(d.a) }, ...D.T.map((t, k) => ({ [t]: d.a[k] }))));
  const csvClose = () => st.nb >= 0
    ? D.T.map((t, k) => ({ neighborhood: nbName(st.nb), request_type: t, closed_past_12_months: D.closeNb[st.nb][k][0], median_days: D.closeNb[st.nb][k][1] ?? '' }))
    : D.T.map((t, k) => ({ request_type: t, reason: '(all)', closed_past_12_months: D.closeT[k][0], median_days: D.closeT[k][1] ?? '', slowest_10pct_days: D.closeT[k][2] ?? '' }))
      .concat(D.R.map((r, k) => ({ request_type: D.T[r[0]], reason: reasonName(k), closed_past_12_months: D.closeR[k][0], median_days: D.closeR[k][1] ?? '', slowest_10pct_days: D.closeR[k][2] ?? '' })));
  const csvOpen = () => { const A = D.openAge[st.nb >= 0 ? st.nb : 72];
    return D.T.map((t, k) => Object.assign({ area: st.nb >= 0 ? nbName(st.nb) : 'New Orleans', request_type: t, open: d3.sum(A[k]) }, ...AGE_L.map((l, a) => ({ [l]: A[k][a] })))); };

  const V = NOLA.views([
    { id: 'map', label: 'Requests by neighborhood', keep: true, draw: drawMap, csv: csvMap },
    { id: 'monthly', label: 'Requests per month', draw: drawMonthly, csv: csvMonthly },
    { id: 'close', label: 'Time to close, requests closed in the past 12 months', draw: drawClose, csv: csvClose },
    { id: 'open', label: 'Open requests, by how long they have been open', draw: drawOpen, csv: csvOpen },
  ], { ds: [D.ds, '311 OPCD Calls'],
       state: () => ({ measure: st.measure !== 'made' ? st.measure : null, type: st.type >= 0 ? st.type : null, reason: st.reason >= 0 ? st.reason : null,
                       basis: st.basis !== 'n' ? st.basis : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
