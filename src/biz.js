// New businesses page (occupational license applications and current licenses)
(() => {
  const D = DATA.biz; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const GEO = NOLA.GEO;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const SHORT = { 'Retail Trade': 'Retail', 'Accommodation & Food Services': 'Food service and lodging', 'Other Services (Except Public Administration)': 'Repair, personal and other services',
    'Professional, Scientific, & Technical Services': 'Professional and technical services', 'Transportation & Warehousing': 'Transportation and warehousing',
    'Health Care & Social Assistance': 'Health care and social assistance', 'Administrative & Support & Waste Mgmt & Remediation Services': 'Administrative, support and cleanup services',
    'Arts, Entertainment & Recreation': 'Arts, entertainment and recreation', 'Real Estate & Rental & Leasing': 'Real estate, rental and leasing', 'Educational Services': 'Education',
    'Finance & Insurance': 'Finance and insurance', 'Wholesale Trade': 'Wholesale' };
  const nm = s => SHORT[s] || s;
  const PAL = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s7)', 'var(--s6)', 'var(--s8)'];
  const colorOf = name => { const k = D.S.indexOf(name); return k >= 0 && k < PAL.length ? PAL[k] : name === 'Event and street vendors' ? 'var(--ink2)' : /^(Not stated|Other or not stated)$/.test(name) ? 'var(--landline)' : 'var(--muted)'; };
  const OUT_C = ['var(--s3)', 'var(--s4)', 'var(--muted)', 'var(--s8)', 'var(--s7)', 'var(--s5)'];
  const lastLabel = NOLA.isoDate(D.last).replace(/, \d+$/, ''), YEAR = +D.last.slice(0, 4), partialYear = y => y === YEAR && !D.last.endsWith('-12-31');
  const pairs = a => { const o = []; for (let i = 0; i < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; };
  const new12 = D.new12.map(pairs), now = D.now.map(pairs);
  const nby = D.nby.map(a => { const o = []; for (let i = 0; i < a.length; i += 3) o.push(a.slice(i, i + 3)); return o; });

  const H = NOLA.hashState();
  const st = { nb: H.nb != null ? +H.nb : -1, measure: H.measure === 'now' ? 'now' : 'new', sec: H.sec != null ? +H.sec : -1, sec2: H.sec2 != null ? +H.sec2 : -1 };
  if (!(st.sec < D.S.length)) st.sec = -1; if (!(st.sec2 < D.S2.length)) st.sec2 = -1;
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  const kvList = (sec, items) => sec.insertAdjacentHTML('beforeend', '<div class="srages">' + items.map(([l, c, n]) => `<span>${c ? `<i style="background:${c}"></i>` : '<i></i>'}${l}<b>${n}</b></span>`).join('') + '</div>');
  const sumOf = (list, s) => d3.sum(list.filter(([k]) => s < 0 || k === s), d => d[1]);
  const newOf = (nb, s = st.sec) => sumOf(new12[nb], s), nowOf = (nb, s = st.sec2) => sumOf(now[nb], s);
  const val = i => st.measure === 'now' ? nowOf(i) : newOf(i);

  // ---------- map ----------
  let m;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    NOLA.ftabs(panel, [['new', 'New applications, past 12 months'], ['now', 'Licensed now']], st.measure, v => set('measure', v));
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const nbs = d3.range(72).filter(nb => st.nb < 0 || nb === st.nb);
    if (st.measure === 'new')
      NOLA.flist(NOLA.fsec(panel, `Sector · since ${NOLA.isoDate(D.winStart).replace(/, \d+$/, '')}`, st.sec >= 0 ? ['Show all', () => set('sec', -1)] : null),
        D.S.map((s, k) => ({ key: k, name: nm(s), color: colorOf(s), count: d3.sum(nbs, nb => newOf(nb, k)) })), { pressed: k => st.sec === k, onClick: toggle('sec') });
    else
      NOLA.flist(NOLA.fsec(panel, 'Sector', st.sec2 >= 0 ? ['Show all', () => set('sec2', -1)] : null),
        D.S2.map((s, k) => ({ key: k, name: nm(s), color: colorOf(s), count: d3.sum(nbs, nb => nowOf(nb, k)) })), { pressed: k => st.sec2 === k, onClick: toggle('sec2') });
    const ls = NOLA.fsec(panel, 'Legend'), leg = document.createElement('div'); leg.className = 'legend'; ls.appendChild(leg);
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of business licenses by neighborhood', tip: mapTip });
      m.lastNb = -1;
      plot.insertAdjacentHTML('beforeend', '<div class="maplegend"></div>');
    }
    const cl = NOLA.classes(d3.range(72).map(val));
    m.setFill(i => cl.color(val(i)));
    NOLA.stepLegend(leg, cl.edges, NOLA.short);
    const ml = plot.querySelector('.maplegend'); NOLA.stepLegend(ml, cl.edges, NOLA.short);
    const sel = st.measure === 'now' ? (st.sec2 >= 0 ? nm(D.S2[st.sec2]) : '') : (st.sec >= 0 ? nm(D.S[st.sec]) : '');
    ml.insertAdjacentHTML('afterbegin', `<div class="mlh">${st.measure === 'now' ? 'Businesses licensed now' : 'New license applications, past 12 months'}${sel ? ': ' + sel : ''}</div>`);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function mapTip(i) {
    const top = new12[i].slice().sort((a, b) => b[1] - a[1]).filter(([k]) => D.S[k] !== 'Not stated').slice(0, 4);
    return `<b>${GEO.nb[i].name}</b>` + row('New license applications, past 12 months', fmt(newOf(i, -1)))
      + top.map(([k, n]) => row(sw(colorOf(D.S[k])) + nm(D.S[k]), fmt(n))).join('') + row('Businesses licensed now', fmt(nowOf(i, -1)));
  }

  // ---------- applications per year ----------
  const yearCounts = () => st.nb >= 0
    ? D.years.map((y, k) => D.S.map((s, j) => d3.sum(nby[st.nb].filter(a => a[0] === k && a[1] === j), a => a[2])))
    : D.yr;
  function drawYears(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    const data = yearCounts();
    NOLA.flist(NOLA.fsec(panel, `Sector · since ${D.years[0]}`, st.sec >= 0 ? ['Show all', () => set('sec', -1)] : null),
      D.S.map((s, k) => ({ key: k, name: nm(s), color: colorOf(s), count: d3.sum(data, d => d[k]) })), { pressed: k => st.sec === k, onClick: toggle('sec') });
    if (st.nb < 0) kvList(NOLA.fsec(panel, 'Home-based'), [['Yes', null, fmt(d3.sum(D.home, h => h[0]))], ['No', null, fmt(d3.sum(D.home, h => h[1]))]]);
    stacked(plot, data, D.S.map(colorOf), s => st.sec < 0 || s === st.sec, (yy, d, tot) => `<b>Filed in ${yy}${partialYear(yy) ? ', through ' + lastLabel : ''}</b>`
      + (st.nb >= 0 ? `<div style="color:var(--ink2)">${nbName(st.nb)}</div>` : '') + row('Applications', fmt(tot))
      + (st.sec < 0 ? D.S.map((s, k) => d[k] ? row(sw(colorOf(s)) + nm(s), fmt(d[k])) : '').join('') : ''));
  }
  function stacked(plot, data, colors, show, tipFor) {
    plot.innerHTML = '';
    const tot = d => d3.sum(d.filter((v, k) => show(k)));
    const f = NOLA.frame(plot, { h: 360, m: { t: 18, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(D.years).range([0, f.iw]).paddingInner(.22);
    const y = d3.scaleLinear().domain([0, (d3.max(data, tot) || 1) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5, d3.format(','));
    data.forEach((d, k) => { let y0 = 0; d.forEach((v, s) => { if (!v || !show(s)) return;
      f.g.append('rect').attr('x', x(D.years[k])).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', colors[s]).attr('opacity', partialYear(D.years[k]) ? .55 : 1); y0 += v; }); });
    data.forEach((d, k) => { if (partialYear(D.years[k])) f.g.append('text').attr('class', 'halo').attr('x', x(D.years[k]) + x.bandwidth()).attr('y', y(tot(d)) - 5).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text('to ' + lastLabel); });
    f.g.selectAll('rect.h').data(D.years).join('rect').attr('class', 'h').attr('x', yy => x(yy) - 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => { const d = data[D.years.indexOf(yy)]; tip.show(tipFor(yy, d, tot(d)), ev); }).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(D.years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => f.iw < 420 ? "'" + String(yy).slice(2) : yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- outcomes ----------
  const outCounts = () => D.yo.map(per => D.out.map((o, j) => d3.sum(per.filter((v, s) => st.sec < 0 || s === st.sec), v => v[j])));
  function drawOut(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    const data = outCounts();
    NOLA.flist(NOLA.fsec(panel, 'Sector', st.sec >= 0 ? ['Show all', () => set('sec', -1)] : null),
      D.S.map((s, k) => ({ key: k, name: nm(s), color: colorOf(s), count: d3.sum(D.yr, d => d[k]) })), { pressed: k => st.sec === k, onClick: toggle('sec') });
    kvList(NOLA.fsec(panel, 'Status now'), D.out.map((o, j) => [o, OUT_C[j], fmt(d3.sum(data, d => d[j]))]).filter(d => d[2] !== '0'));
    stacked(plot, data, OUT_C, () => true, (yy, d, tot) => `<b>Filed in ${yy}${partialYear(yy) ? ', through ' + lastLabel : ''}</b>` + (st.sec >= 0 ? `<div style="color:var(--ink2)">${nm(D.S[st.sec])}</div>` : '')
      + row('Applications', fmt(tot)) + D.out.map((o, j) => d[j] ? row(sw(OUT_C[j]) + o, fmt(d[j])) : '').join(''));
  }

  const V = NOLA.views([
    { id: 'map', label: 'Business licenses by neighborhood', tab: 'Map of licenses', keep: true, draw: drawMap,
      ds: () => st.measure === 'now' ? [D.ds[1], 'Occupational Business Licenses'] : [D.ds[0], 'Occupational Business License Data'] },
    { id: 'years', label: 'New business license applications per year', tab: 'Applications per year', draw: drawYears },
    { id: 'outcomes', label: 'What happened to each year’s applications', tab: 'Outcomes', draw: drawOut },
  ], { ds: [D.ds[0], 'Occupational Business License Data'],
       state: () => ({ measure: st.measure !== 'new' ? st.measure : null, sec: st.sec >= 0 ? st.sec : null, sec2: st.sec2 >= 0 ? st.sec2 : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
