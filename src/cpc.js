// City Planning Commission cases page
(() => {
  const P = DATA.cpc; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const PULLED = (DATA.meta && DATA.meta.pulled) || '2026-11-18';
  const YEAR = +PULLED.slice(0, 4);
  const lastFiled = P.lastFiled || PULLED;
  const FOLD = [
    { n: 'Variance', t: [0] }, { n: 'Minor subdivision', t: [1] }, { n: 'Neighborhood notice (NPP)', t: [2] },
    { n: 'Design review', t: [3] }, { n: 'Conditional use', t: [4] }, { n: 'Zoning, text & master plan changes', t: [5, 6, 9] },
    { n: 'Appeals, major subdivisions & other', t: [7, 8, 10] }];
  FOLD.forEach((f, i) => f.color = NOLA.S(i));
  const foldOf = t => FOLD.findIndex(f => f.t.includes(t));
  const TYPEIDX = Object.fromEntries(P.TYP.map((t, i) => [t, i]));
  const nbName = i => i >= 0 ? NOLA.GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;

  const H = NOLA.hashState();
  const st = { fold: H.fold != null ? +H.fold : -1, theme: H.theme != null ? +H.theme : -1, nb: H.nb != null ? +H.nb : -1 };
  const staged = (el, first, isMap, open) => { if (first) el._s = NOLA.stage(el, { map: isMap, open }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  // shared filter sections
  const nbSection = panel => NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
  function typeSection(panel, counts) {
    NOLA.flist(NOLA.fsec(panel, 'Case type', st.fold >= 0 ? ['Show all', () => set('fold', -1)] : null),
      FOLD.map((f, i) => ({ key: i, name: f.n, color: f.color, count: counts[i] })), { pressed: i => st.fold === i, onClick: toggle('fold') });
  }

  // ---------- upcoming hearings: map, with the agenda in the panel ----------
  const seen = new Set();
  const up = P.up.filter(u => { const k = u[0] + u[2]; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(u => ({ when: u[0], body: u[1], cnum: u[2], type: u[3], fold: foldOf(TYPEIDX[u[3]]), addr: u[4].trim(), nb: u[5], x: u[6], y: u[7], desc: u[8] }));
  // The City's list includes some next-meeting dates on weekends and holidays, which can't be hearing days.
  // They're shown as listed, but flagged.
  const offDay = iso => { const d = new Date(iso.slice(0, 10) + 'T12:00:00Z'), wd = d.getUTCDay(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
    if (wd === 0 || wd === 6) return 'weekend';
    if ((m === 1 && dd === 1) || (m === 7 && dd === 4) || (m === 12 && dd === 25) || (m === 11 && ((wd === 4 && dd >= 22 && dd <= 28) || (wd === 5 && dd >= 23 && dd <= 29)))) return 'holiday';
    return ''; };
  const dayFmt = s => new Date(s.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = s => { const h = +s.slice(11, 13), mi = s.slice(14, 16); return !h && mi === '00' ? '' : (h % 12 || 12) + ':' + mi + (h < 12 ? ' a.m.' : ' p.m.'); };
  const cleanDesc = s => s.replace(/^Zoning Docket \d+\/\d+\s*/, '').replace(/^Applicant\(s\):\s*/, '').replace(/^Request:\s*/, '') + (s.length >= 170 ? '…' : '');
  const upNb = () => up.filter(u => st.nb < 0 || u.nb === st.nb);
  const upF = () => upNb().filter(u => st.fold < 0 || u.fold === st.fold);
  let um, ud;
  function drawUpcoming(pane, first) {
    const { panel, plot } = staged(pane, first, true, true); // the agenda lives in the panel, so phones show it open
    const list = upF();
    panel.innerHTML = '';
    nbSection(panel);
    typeSection(panel, FOLD.map((f, i) => upNb().filter(u => u.fold === i).length));
    const ag = NOLA.fsec(panel, `Agenda · ${fmt(list.length)} case${list.length === 1 ? '' : 's'}`);
    const box = document.createElement('div'); box.className = 'agenda'; ag.appendChild(box);
    box.innerHTML = list.length ? d3.groups(list, u => u.when.slice(0, 10)).map(([day, us]) => `<div class="day"><div class="dh">${dayFmt(day)} · ${[...new Set(us.map(u => u.body))].join(', ')}${offDay(day) ? ` <span class="offday" title="This is the next meeting date the City lists for these cases, but it falls on a ${offDay(day)}.">${offDay(day)}: date as listed</span>` : ''}</div>` +
      us.map(u => `<div class="ui" data-c="${u.cnum}${u.when}"><i style="background:${FOLD[u.fold].color}"></i><div><b>${u.addr}</b> <span class="ty">${u.type}</span><div class="ds">${cleanDesc(u.desc)}</div><div class="nb">${nbName(u.nb)} · ${u.cnum}</div></div></div>`).join('') + '</div>').join('')
      : `<div class="ds">No hearings scheduled${st.nb >= 0 ? ' in ' + nbName(st.nb) : ''}.</div>`;
    if (first) {
      um = NOLA.map(plot, { panel, label: 'Map of upcoming planning cases' });
      ud = um.layer.append('g');
      um.onZoom(k => ud.selectAll('circle').attr('r', 7 / Math.sqrt(k)).attr('stroke-width', 2 / Math.sqrt(k)));
      um.lastNb = -1;
    }
    if (um.lastNb !== st.nb) { um.focus(st.nb, first ? 0 : 450); um.lastNb = st.nb; }
    const upTip = d => `<b>${d.addr}</b><div style="color:var(--ink2)">${d.type} · ${d.cnum}</div>` + row('Hearing', dayFmt(d.when) + (timeFmt(d.when) ? ', ' + timeFmt(d.when) : '') + (offDay(d.when) ? ` (${offDay(d.when)}, as listed)` : '')) + row('Body', d.body) + row('Neighborhood', nbName(d.nb)) + `<div style="margin-top:6px">${cleanDesc(d.desc)}</div>`;
    const k = um.k();
    const dots = ud.selectAll('circle').data(list.filter(u => (u.x || u.y) && NOLA.shown(u.nb)), d => d.cnum + d.when).join('circle')
      .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', 7 / Math.sqrt(k)).attr('stroke-width', 2 / Math.sqrt(k))
      .attr('fill', d => FOLD[d.fold].color).attr('stroke', 'var(--surface)')
      .on('mousemove', (ev, d) => { tip.show(upTip(d), ev); hi(d); }).on('mouseleave', () => { tip.hide(); hi(null); });
    const items = [...box.querySelectorAll('.ui')];
    items.forEach(it => { const u = list.find(v => v.cnum + v.when === it.dataset.c); it.onmouseenter = () => hi(u); it.onmouseleave = () => hi(null); it.onclick = () => { if (u.x) um.zoomTo([u.x - 60, u.y - 45, u.x + 60, u.y + 45], 500); }; });
    function hi(u) {
      dots.attr('opacity', d => !u || d === u ? 1 : .25);
      items.forEach(it => it.classList.toggle('on', !!u && it.dataset.c === u.cnum + u.when));
      if (u && !panel.matches(':hover')) { const it = items.find(e => e.dataset.c === u.cnum + u.when); if (it) it.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  }

  // ---------- cases filed in the past 12 months ----------
  const startDay = new Date((P.windowStart || '2025-11-18') + 'T00:00:00Z');
  const pDate = d => { const t = new Date(+startDay + d * 864e5); return NOLA.months[t.getUTCMonth()] + ' ' + t.getUTCDate() + ', ' + t.getUTCFullYear(); };
  const mapped = P.pts.filter(p => NOLA.shown(p[4]));
  const okType = p => st.fold < 0 || foldOf(p[1]) === st.fold, okTheme = p => st.theme < 0 || (p[5] >> st.theme) & 1, okNb = p => st.nb < 0 || p[4] === st.nb;
  const matching = () => mapped.filter(p => okType(p) && okTheme(p));
  let rm, rg, recentNb = [];
  function drawRecent(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    const all = matching(), pts = all.filter(okNb);
    recentNb = []; pts.forEach(p => { recentNb[p[4]] = (recentNb[p[4]] || 0) + 1; });
    panel.innerHTML = '';
    nbSection(panel);
    typeSection(panel, FOLD.map((f, i) => mapped.filter(p => okTheme(p) && okNb(p) && foldOf(p[1]) === i).length));
    NOLA.flist(NOLA.fsec(panel, 'Topic in description', st.theme >= 0 ? ['Any topic', () => set('theme', -1)] : null),
      P.TH.map((t, i) => ({ key: i, name: t, color: 'var(--ink2)', count: mapped.filter(p => okType(p) && okNb(p) && (p[5] >> i) & 1).length })),
      { pressed: i => st.theme === i, onClick: toggle('theme') });
    // where the matching cases are: neighborhoods ranked, the chosen one always listed with its rank
    const cnt = []; all.forEach(p => { cnt[p[4]] = (cnt[p[4]] || 0) + 1; });
    const ranked = NOLA.nbList().map(f => [f.idx, cnt[f.idx] || 0]).sort((a, b) => b[1] - a[1]).map((d, r) => [...d, r + 1]);
    const top = ranked.filter(d => d[1]).slice(0, 8), mine = ranked.find(d => d[0] === st.nb);
    if (mine && !top.includes(mine)) top.push(mine);
    NOLA.flist(NOLA.fsec(panel, `Most cases · ${fmt(pts.length)} since ${pDate(0)}`),
      top.map(([i, v, r]) => ({ key: i, name: `${r}. ${NOLA.GEO.nb[i].name}`, color: 'var(--s1)', count: v })), { pressed: i => st.nb === i, onClick: toggle('nb') });
    if (first) {
      rm = NOLA.map(plot, { panel, label: 'Map of planning cases filed in the past 12 months',
        tip: i => `<b>${NOLA.GEO.nb[i].name}</b>` + row('Matching cases, past 12 months', recentNb[i] || 0) });
      rg = rm.layer.append('g'); rm.lastNb = -1;
      rm.onZoom(k => rg.selectAll('circle').attr('r', 4 / Math.sqrt(k)).attr('stroke-width', 1 / Math.sqrt(k)));
    }
    if (rm.lastNb !== st.nb) { rm.focus(st.nb, first ? 0 : 450); rm.lastNb = st.nb; }
    const k = rm.k();
    rg.selectAll('circle').data(pts, p => p.join()).join('circle').attr('cx', p => p[2]).attr('cy', p => p[3]).attr('r', 4 / Math.sqrt(k))
      .attr('fill', p => FOLD[foldOf(p[1])].color).attr('fill-opacity', .85).attr('stroke', 'var(--surface)').attr('stroke-width', 1 / Math.sqrt(k))
      .on('mousemove', (ev, p) => tip.show(`<b>${P.TYP[p[1]]}</b>` + row('Filed', pDate(p[0])) + row('Neighborhood', nbName(p[4])) + (p[5] ? row('Topics', P.TH.filter((t, i) => (p[5] >> i) & 1).join(', ')) : ''), ev)).on('mouseleave', tip.hide);
  }

  // ---------- filings per year ----------
  function drawYears(pane, first) {
    const { panel, plot } = staged(pane, first);
    const yrs = Object.keys(P.typeY).sort();
    const data = yrs.map(y => { const a = FOLD.map(() => 0); P.typeY[y].forEach((v, t) => a[foldOf(t)] += v); return { y, a }; });
    panel.innerHTML = '';
    typeSection(panel, FOLD.map((f, i) => d3.sum(data, d => d.a[i])));
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 380, m: { t: 10, r: 10, b: 28, l: 40 } });
    const x = d3.scaleBand().domain(yrs).range([0, f.iw]).paddingInner(.22);
    const val = d => st.fold < 0 ? d3.sum(d.a) : d.a[st.fold];
    const yy = d3.scaleLinear().domain([0, d3.max(data, val) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, yy, 5, d3.format('d'));
    // the current year is drawn lighter, with a "to date" label, until it's over
    const partial = d => +d.y === YEAR && !lastFiled.endsWith('-12-31');
    data.forEach(d => { let y0 = 0; d.a.forEach((v, i) => { if (!v || (st.fold >= 0 && i !== st.fold)) return; f.g.append('rect').attr('x', x(d.y)).attr('width', x.bandwidth()).attr('y', yy(y0 + v) + 1).attr('height', Math.max(.5, yy(y0) - yy(y0 + v) - 1)).attr('fill', FOLD[i].color).attr('rx', 1.5).attr('opacity', partial(d) ? .45 : 1); y0 += v; }); });
    data.filter(partial).forEach(d => f.g.append('text').attr('class', 'halo').attr('x', x(d.y) + x.bandwidth()).attr('y', yy(val(d)) - 5).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text('to ' + NOLA.isoDate(lastFiled).replace(/, \d+$/, '')));
    f.g.selectAll('rect.h').data(data).join('rect').attr('class', 'h').attr('x', d => x(d.y) - 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(`<b>${d.y}${+d.y === YEAR ? ` (through ${NOLA.isoDate(lastFiled).replace(/, \d+$/, '')})` : ''}</b>` + row('Total', fmt(d3.sum(d.a))) + FOLD.map((fo, i) => d.a[i] ? row(sw(fo.color) + fo.n, d.a[i]) : '').join(''), ev)).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(yrs.filter((y, i) => i % (f.iw < 500 ? 4 : 2) === 0)).join('text').attr('class', 'x').attr('x', y => x(y) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(y => "'" + y.slice(2));
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- topics per year: all side by side, or one picked in the panel ----------
  function drawTopics(pane, first) {
    const { panel, plot } = staged(pane, first);
    const yrs = Object.keys(P.themeY).sort().filter(y => +y >= 2010);
    panel.innerHTML = '';
    NOLA.flist(NOLA.fsec(panel, `Topic · cases since ${yrs[0]}`, st.theme >= 0 ? ['Show all', () => set('theme', -1)] : null),
      P.TH.map((t, i) => ({ key: i, name: t, color: 'var(--s1)', count: d3.sum(yrs, y => P.themeY[y][i]) })), { pressed: i => st.theme === i, onClick: toggle('theme') });
    plot.innerHTML = '<div class="sms"></div>';
    const host = plot.firstChild, one = st.theme >= 0;
    host.classList.toggle('one', one);
    const yMax = d3.max(one ? [st.theme] : P.TH.map((t, i) => i), i => d3.max(yrs, y => P.themeY[y][i])) * 1.05;
    P.TH.forEach((t, i) => {
      if (one && i !== st.theme) return;
      const box = document.createElement('div'); box.className = 'sm'; host.appendChild(box);
      box.innerHTML = `<div class="smh"><b>${t}</b></div>`;
      const vals = yrs.map(y => P.themeY[y][i]);
      const f = NOLA.frame(box, { h: one ? 340 : 100, m: { t: 6, r: 4, b: 18, l: one ? 34 : 4 } });
      const x = d3.scaleBand().domain(yrs).range([0, f.iw]).paddingInner(.2);
      const y = d3.scaleLinear().domain([0, yMax]).range([f.ih, 0]).nice();
      if (one) NOLA.yGrid(f, y, 4, d3.format('d'));
      f.g.selectAll('rect.b').data(vals).join('rect').attr('class', 'b').attr('x', (v, j) => x(yrs[j])).attr('width', x.bandwidth()).attr('y', v => y(v)).attr('height', v => f.ih - y(v)).attr('rx', 1.5).attr('fill', 'var(--s1)')
        .attr('opacity', (v, j) => +yrs[j] === YEAR && !lastFiled.endsWith('-12-31') ? .45 : 1); // current year so far
      f.g.selectAll('rect.h').data(yrs).join('rect').attr('class', 'h').attr('x', yy => x(yy) - 1).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
        .on('mousemove', (ev, yy) => tip.show(`<b>${t}, ${yy}${+yy === YEAR ? ` (through ${NOLA.isoDate(lastFiled).replace(/, \d+$/, '')})` : ''}</b>` + row('Cases', P.themeY[yy][i]), ev)).on('mouseleave', tip.hide);
      f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
      if (one) f.g.selectAll('text.x').data(yrs.filter((yy, j) => j % 2 === 0)).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 14).attr('text-anchor', 'middle').text(yy => "'" + yy.slice(2));
      else { f.g.append('text').attr('x', 0).attr('y', f.ih + 13).text("'" + yrs[0].slice(2)); f.g.append('text').attr('x', f.iw).attr('y', f.ih + 13).attr('text-anchor', 'end').text("'" + yrs[yrs.length - 1].slice(2)); }
    });
  }

  // ---------- CSV downloads ----------
  const csvUp = () => upF().map(u => ({ hearing: u.when.replace('T', ' '), body: u.body, case_number: u.cnum, type: u.type, address: u.addr, neighborhood: nbName(u.nb), description: u.desc }));
  const csvRecent = () => matching().filter(okNb).map(p => { const [lon, lat] = p[2] || p[3] ? NOLA.lonlat(p[2], p[3]) : ['', ''];
    return { filed: new Date(+startDay + p[0] * 864e5).toISOString().slice(0, 10), type: P.TYP[p[1]], neighborhood: nbName(p[4]), topics: P.TH.filter((t, i) => (p[5] >> i) & 1).join('; '), lon, lat }; });
  const csvYears = () => Object.keys(P.typeY).sort().map(y => Object.assign({ year: y }, ...P.TYP.map((t, i) => ({ [t]: P.typeY[y][i] }))));
  const csvTopics = () => Object.keys(P.themeY).sort().map(y => Object.assign({ year: y }, ...P.TH.map((t, i) => ({ [t]: P.themeY[y][i] }))));

  const V = NOLA.views([
    { id: 'upcoming', label: 'Upcoming hearings', keep: true, draw: drawUpcoming, csv: csvUp },
    { id: 'recent', label: 'Cases filed in the past 12 months', keep: true, draw: drawRecent, csv: csvRecent },
    { id: 'years', label: 'Cases filed per year, by type', draw: drawYears, csv: csvYears },
    { id: 'topics', label: 'Cases per year mentioning each topic', draw: drawTopics, csv: csvTopics },
  ], { ds: ['xxb5-5azv', 'CPC Projects'],
       state: () => ({ fold: st.fold >= 0 ? st.fold : null, theme: st.theme >= 0 ? st.theme : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
