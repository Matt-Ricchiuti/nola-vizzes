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

  // ---------- upcoming hearings: map + agenda ----------
  const seen = new Set();
  const up = P.up.filter(u => { const k = u[0] + u[2]; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(u => ({ when: u[0], body: u[1], cnum: u[2], type: u[3], fold: foldOf(TYPEIDX[u[3]]), addr: u[4].trim(), nb: u[5], x: u[6], y: u[7], desc: u[8] }));
  const dayFmt = s => new Date(s.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = s => { const h = +s.slice(11, 13), mi = s.slice(14, 16); return !h && mi === '00' ? '' : (h % 12 || 12) + ':' + mi + (h < 12 ? ' a.m.' : ' p.m.'); };
  const cleanDesc = s => s.replace(/^Zoning Docket \d+\/\d+\s*/, '').replace(/^Applicant\(s\):\s*/, '').replace(/^Request:\s*/, '') + (s.length >= 170 ? '…' : '');
  function drawUpcoming(el) {
    el.innerHTML = NOLA.legendHTML(FOLD.filter((f, i) => up.some(u => u.fold === i)).map(f => [f.color, f.n, 1])) +
      '<div class="split"><div class="map card mapp"></div><div class="card" id="uplist"></div></div>';
    const umEl = el.querySelector('.map'), list = el.querySelector('#uplist');
    const um = NOLA.map(umEl, { height: 620, extent: [-20, 880, 1000, 1640], label: 'Map of upcoming planning cases' });
    NOLA.mapButtons(umEl, um, [['Core city', [-20, 880, 1000, 1640]], ['Whole city', [-70, 130, 2110, 1730]]]);
    const upTip = d => `<b>${d.addr}</b><div style="color:var(--ink2)">${d.type} · ${d.cnum}</div>` + row('Hearing', dayFmt(d.when) + (timeFmt(d.when) ? ', ' + timeFmt(d.when) : '')) + row('Body', d.body) + row('Neighborhood', nbName(d.nb)) + `<div style="margin-top:6px">${cleanDesc(d.desc)}</div>`;
    const ud = um.layer.append('g').selectAll('circle').data(up.filter(u => u.x || u.y)).join('circle').attr('cx', d => d.x).attr('cy', d => d.y).attr('r', 7)
      .attr('fill', d => FOLD[d.fold].color).attr('stroke', 'var(--surface)').attr('stroke-width', 2)
      .on('mousemove', (ev, d) => { tip.show(upTip(d), ev); hi(d); }).on('mouseleave', () => { tip.hide(); hi(null); });
    um.onZoom(k => ud.attr('r', 7 / Math.sqrt(k)).attr('stroke-width', 2 / Math.sqrt(k)));
    list.innerHTML = up.length ? d3.groups(up, u => u.when.slice(0, 10)).map(([day, us]) => `<div class="day"><div class="dh">${dayFmt(day)} · ${[...new Set(us.map(u => u.body))].join(', ')}</div>` +
      us.map(u => `<div class="ui" data-c="${u.cnum}${u.when}"><i style="background:${FOLD[u.fold].color}"></i><div><b>${u.addr}</b> <span class="ty">${u.type}</span><div class="ds">${cleanDesc(u.desc)}</div><div class="nb">${nbName(u.nb)} · ${u.cnum}</div></div></div>`).join('') + '</div>').join('')
      : '<div class="ds">No hearings scheduled.</div>';
    const items = [...list.querySelectorAll('.ui')];
    items.forEach(it => { const u = up.find(v => v.cnum + v.when === it.dataset.c); it.onmouseenter = () => hi(u); it.onmouseleave = () => hi(null); it.onclick = () => { if (u.x) um.zoomTo([u.x - 90, u.y - 70, u.x + 90, u.y + 70], 500); }; });
    function hi(u) {
      ud.attr('opacity', d => !u || d === u ? 1 : .25);
      items.forEach(it => it.classList.toggle('on', !!u && it.dataset.c === u.cnum + u.when));
      if (u && !list.matches(':hover')) { const it = items.find(e => e.dataset.c === u.cnum + u.when); if (it) it.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  }

  // ---------- past 12 months (map and neighborhood ranking share filters) ----------
  const st = { fold: -1, theme: -1 };
  NOLA.chips(document.getElementById('typeChips'), [{ label: 'All case types', value: -1 }, ...FOLD.map((f, i) => ({ label: f.n, value: i }))], v => { st.fold = v; V.refresh(); }, { sel: -1 });
  NOLA.chips(document.getElementById('themeChips'), [{ label: 'Any topic', value: -1 }, ...P.TH.map((t, i) => ({ label: t, value: i }))], v => { st.theme = v; V.refresh(); }, { sel: -1 });
  const startDay = new Date((P.windowStart || '2025-11-18') + 'T00:00:00Z');
  const pDate = d => { const t = new Date(+startDay + d * 864e5); return NOLA.months[t.getUTCMonth()] + ' ' + t.getUTCDate() + ', ' + t.getUTCFullYear(); };
  const matching = () => P.pts.filter(p => (st.fold < 0 || foldOf(p[1]) === st.fold) && (st.theme < 0 || (p[5] >> st.theme) & 1));
  const countLine = pts => `<div class="legend">${fmt(pts.length)} case${pts.length === 1 ? '' : 's'} filed since ${pDate(0)}</div>`;
  let rm, rg, recentNb = [];
  function drawRecent(el, first) {
    const pts = matching();
    recentNb = []; pts.forEach(p => { if (p[4] >= 0) recentNb[p[4]] = (recentNb[p[4]] || 0) + 1; });
    if (first) {
      el.innerHTML = '<div></div><div class="split"><div class="map card mapp"></div><div class="card rank"></div></div>';
      const mapEl = el.querySelector('.map');
      rm = NOLA.map(mapEl, { height: 600, extent: [-20, 880, 1000, 1640], label: 'Map of planning cases filed in the past 12 months',
        tip: i => `<b>${NOLA.GEO.nb[i].name}</b>` + row('Cases, past 12 months', recentNb[i] || 0) });
      NOLA.mapButtons(mapEl, rm, [['Core city', [-20, 880, 1000, 1640]], ['Whole city', [-70, 130, 2110, 1730]]]);
      rg = rm.layer.append('g');
      rm.onZoom(k => rg.selectAll('circle').attr('r', 4 / Math.sqrt(k)).attr('stroke-width', 1 / Math.sqrt(k)));
    }
    el.firstChild.innerHTML = countLine(pts);
    drawRank(el.querySelector('.rank'), pts);
    const k = rm.k();
    rg.selectAll('circle').data(pts, p => p.join()).join('circle').attr('cx', p => p[2]).attr('cy', p => p[3]).attr('r', 4 / Math.sqrt(k))
      .attr('fill', p => FOLD[foldOf(p[1])].color).attr('fill-opacity', .8).attr('stroke', 'var(--surface)').attr('stroke-width', 1 / Math.sqrt(k))
      .on('mousemove', (ev, p) => tip.show(`<b>${P.TYP[p[1]]}</b>` + row('Filed', pDate(p[0])) + row('Neighborhood', nbName(p[4])) + (p[5] ? row('Topics', P.TH.filter((t, i) => (p[5] >> i) & 1).join(', ')) : ''), ev)).on('mouseleave', tip.hide);
  }
  function drawRank(el, pts) {
    const cnt = [];
    pts.forEach(p => { if (p[4] >= 0) cnt[p[4]] = (cnt[p[4]] || 0) + 1; });
    const top = cnt.map((v, i) => [i, v || 0]).filter(d => d[1]).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const mx = top.length ? top[0][1] : 1;
    el.innerHTML = '<b style="font-size:14px">Top neighborhoods</b>' + (top.length ? '<table><tbody>' + top.map(([i, v]) => `<tr><td>${NOLA.GEO.nb[i].name}</td><td class="num" style="width:55%"><span class="bar" style="width:${85 * v / mx}%;margin-right:6px"></span>${v}</td></tr>`).join('') + '</tbody></table>' : '<div class="legend">No matching cases.</div>');
  }

  // ---------- filings per year ----------
  function drawYears(el) {
    el.innerHTML = NOLA.legendHTML(FOLD.map(f => [f.color, f.n])) + '<div></div>';
    const yrs = Object.keys(P.typeY).sort();
    const data = yrs.map(y => { const a = FOLD.map(() => 0); P.typeY[y].forEach((v, t) => a[foldOf(t)] += v); return { y, a }; });
    const f = NOLA.frame(el.lastChild, { h: 340, m: { t: 10, r: 10, b: 28, l: 40 } });
    const x = d3.scaleBand().domain(yrs).range([0, f.iw]).paddingInner(.22);
    const yy = d3.scaleLinear().domain([0, d3.max(data, d => d3.sum(d.a)) * 1.05]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, yy, 5, d3.format('d'));
    data.forEach(d => { let y0 = 0; d.a.forEach((v, i) => { if (v) f.g.append('rect').attr('x', x(d.y)).attr('width', x.bandwidth()).attr('y', yy(y0 + v) + 1).attr('height', Math.max(.5, yy(y0) - yy(y0 + v) - 1)).attr('fill', FOLD[i].color).attr('rx', 1.5); y0 += v; }); });
    f.g.selectAll('rect.h').data(data).join('rect').attr('class', 'h').attr('x', d => x(d.y) - 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(`<b>${d.y}${+d.y === YEAR ? ` (through ${NOLA.isoDate(lastFiled).replace(/, \d+$/, '')})` : ''}</b>` + row('Total', fmt(d3.sum(d.a))) + FOLD.map((fo, i) => d.a[i] ? row(sw(fo.color) + fo.n, d.a[i]) : '').join(''), ev)).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(yrs.filter((y, i) => i % (f.iw < 500 ? 4 : 2) === 0)).join('text').attr('class', 'x').attr('x', y => x(y) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(y => "'" + y.slice(2));
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- topics per year (small multiples) ----------
  function drawTopics(el) {
    el.innerHTML = '<div class="sms"></div>';
    const host = el.firstChild;
    const yrs = Object.keys(P.themeY).sort().filter(y => +y >= 2010);
    const yMax = d3.max(P.TH, (t, i) => d3.max(yrs, y => P.themeY[y][i])) * 1.05;
    P.TH.forEach((t, i) => {
      const box = document.createElement('div'); box.className = 'sm'; host.appendChild(box);
      box.innerHTML = `<div class="smh"><b>${t}</b></div>`;
      const vals = yrs.map(y => P.themeY[y][i]);
      const f = NOLA.frame(box, { h: 100, m: { t: 6, r: 4, b: 18, l: 4 } });
      const x = d3.scaleBand().domain(yrs).range([0, f.iw]).paddingInner(.2);
      const y = d3.scaleLinear().domain([0, yMax]).range([f.ih, 0]);
      f.g.selectAll('rect').data(vals).join('rect').attr('x', (v, j) => x(yrs[j])).attr('width', x.bandwidth()).attr('y', v => y(v)).attr('height', v => f.ih - y(v)).attr('rx', 1.5).attr('fill', 'var(--s1)');
      f.g.selectAll('rect.h').data(yrs).join('rect').attr('class', 'h').attr('x', yy => x(yy) - 1).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
        .on('mousemove', (ev, yy) => tip.show(`<b>${t}, ${yy}</b>` + row('Cases', P.themeY[yy][i]), ev)).on('mouseleave', tip.hide);
      f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
      f.g.append('text').attr('x', 0).attr('y', f.ih + 13).text("'" + yrs[0].slice(2));
      f.g.append('text').attr('x', f.iw).attr('y', f.ih + 13).attr('text-anchor', 'end').text("'" + yrs[yrs.length - 1].slice(2));
    });
  }

  const V = NOLA.views([
    { id: 'upcoming', label: 'Upcoming hearings', cls: 'plain', keep: true, draw: (el, first) => { if (first) drawUpcoming(el); } },
    { id: 'recent', label: 'Cases filed in the past 12 months', cls: 'plain', keep: true, draw: drawRecent },
    { id: 'years', label: 'Cases filed per year, by type', draw: drawYears },
    { id: 'topics', label: 'Cases per year mentioning each topic', draw: drawTopics },
  ]);
})();
