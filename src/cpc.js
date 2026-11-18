// City Planning Commission projects page
(() => {
  const P = DATA.cpc; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const FOLD = [
    { n: 'Variance', t: [0] }, { n: 'Minor subdivision', t: [1] }, { n: 'Neighborhood notice (NPP)', t: [2] },
    { n: 'Design review', t: [3] }, { n: 'Conditional use', t: [4] }, { n: 'Zoning, text & master plan changes', t: [5, 6, 9] },
    { n: 'Appeals, major subdivisions & other', t: [7, 8, 10] }];
  FOLD.forEach((f, i) => f.color = NOLA.S(i));
  const foldOf = t => FOLD.findIndex(f => f.t.includes(t));
  const TYPEIDX = Object.fromEntries(P.TYP.map((t, i) => [t, i]));
  const nbName = i => i >= 0 ? NOLA.GEO.nb[i].name : '—';

  // dedupe upcoming
  const seen = new Set();
  const up = P.up.filter(u => { const k = u[0] + u[2]; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(u => ({ when: u[0], body: u[1], cnum: u[2], type: u[3], fold: foldOf(TYPEIDX[u[3]]), addr: u[4].trim(), nb: u[5], x: u[6], y: u[7], desc: u[8] }));
  const dayFmt = s => { const d = new Date(s.slice(0, 10) + 'T12:00:00'); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  const timeFmt = s => { const h = +s.slice(11, 13), mi = s.slice(14, 16); if (!h && mi === '00') return ''; return (h % 12 || 12) + ':' + mi + (h < 12 ? ' a.m.' : ' p.m.'); };
  const cleanDesc = s => s.replace(/^Zoning Docket \d+\/\d+\s*/, '').replace(/^Applicant\(s\):\s*/, '').replace(/^Request:\s*/, '') + (s.length >= 170 ? '…' : '');

  const y26 = d3.sum(P.typeY['2026']); const npp12 = P.pts.filter(p => p[1] === 2).length;
  const dec = P.dec; const apr = Math.round(100 * dec.appr / (dec.appr + dec.den));
  document.getElementById('tiles').innerHTML = [
    [up.length, 'cases on upcoming hearing agendas through Jan 5'],
    [fmt(y26), 'cases filed in 2026 so far'],
    [fmt(npp12), 'neighborhood notices (NPP) filed in the past 12 months, an early sign of what\'s coming'],
    [apr + '%', `approved, among the ${dec.appr + dec.den} cases since 2016 with an approve-or-deny decision recorded`]
  ].map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  // ---------- upcoming: map + list ----------
  const umEl = document.getElementById('upmap');
  const um = NOLA.map(umEl, { height: 620, extent: [-20, 880, 1000, 1640], label: 'Map of upcoming planning cases' });
  NOLA.mapButtons(umEl, um, [['Core city', [-20, 880, 1000, 1640]], ['Whole city', [-70, 130, 2110, 1730]]]);
  const located = up.filter(u => u.x || u.y);
  const ud = um.layer.append('g').selectAll('circle').data(located).join('circle').attr('cx', d => d.x).attr('cy', d => d.y).attr('r', 7)
    .attr('fill', d => FOLD[d.fold].color).attr('stroke', 'var(--surface)').attr('stroke-width', 2)
    .on('mousemove', (ev, d) => { tip.show(upTip(d), ev); hi(d); }).on('mouseleave', () => { tip.hide(); hi(null); });
  um.onZoom(k => ud.attr('r', 7 / Math.sqrt(k)).attr('stroke-width', 2 / Math.sqrt(k)));
  function upTip(d) { return `<b>${d.addr}</b><div style="color:var(--ink2)">${d.type} · ${d.cnum}</div>` + row('Hearing', dayFmt(d.when) + (timeFmt(d.when) ? ', ' + timeFmt(d.when) : '')) + row('Body', d.body) + row('Neighborhood', nbName(d.nb)) + `<div style="margin-top:6px">${cleanDesc(d.desc)}</div>`; }
  const list = document.getElementById('uplist');
  const byDay = d3.groups(up, u => u.when.slice(0, 10));
  list.innerHTML = byDay.map(([day, us]) => `<div class="day"><div class="dh">${dayFmt(day)} · ${[...new Set(us.map(u => u.body))].join(', ')}</div>` +
    us.map(u => `<div class="ui" data-c="${u.cnum}${u.when}"><i style="background:${FOLD[u.fold].color}"></i><div><b>${u.addr}</b> <span class="ty">${u.type}</span><div class="ds">${cleanDesc(u.desc)}</div><div class="nb">${nbName(u.nb)} · ${u.cnum}</div></div></div>`).join('') + '</div>').join('');
  const items = [...list.querySelectorAll('.ui')];
  items.forEach((el, i) => { const u = up.find(v => v.cnum + v.when === el.dataset.c); el.onmouseenter = () => hi(u); el.onmouseleave = () => hi(null); el.onclick = () => { if (u.x) um.zoomTo([u.x - 90, u.y - 70, u.x + 90, u.y + 70], 500); }; });
  function hi(u) {
    ud.attr('opacity', d => !u || d === u ? 1 : .25);
    items.forEach(el => el.classList.toggle('on', !!u && el.dataset.c === u.cnum + u.when));
    if (u) { const el = items.find(e => e.dataset.c === u.cnum + u.when); if (el && list.matches(':hover') === false) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  document.getElementById('upLeg').innerHTML = FOLD.filter((f, i) => up.some(u => u.fold === i)).map(f => `<span><i style="background:${f.color};border-radius:50%"></i>${f.n}</span>`).join('');

  // ---------- past 12 months: filter map + ranking ----------
  const st = { fold: -1, theme: -1 };
  NOLA.chips(document.getElementById('typeChips'), [{ label: 'All case types', value: -1 }, ...FOLD.map((f, i) => ({ label: f.n, value: i }))], v => { st.fold = v; drawRecent(); }, { sel: -1 });
  NOLA.chips(document.getElementById('themeChips'), [{ label: 'Any topic', value: -1 }, ...P.TH.map((t, i) => ({ label: t, value: i }))], v => { st.theme = v; drawRecent(); }, { sel: -1 });
  const rmEl = document.getElementById('recmap');
  const rm = NOLA.map(rmEl, { height: 600, extent: [-20, 880, 1000, 1640], label: 'Map of planning cases filed in the past 12 months',
    tip: i => `<b>${NOLA.GEO.nb[i].name}</b>` + row('Matching cases, past 12 months', recentNb[i] || 0) });
  NOLA.mapButtons(rmEl, rm, [['Core city', [-20, 880, 1000, 1640]], ['Whole city', [-70, 130, 2110, 1730]]]);
  const rg = rm.layer.append('g');
  let recentNb = [];
  const startDay = new Date(Date.UTC(2025, 10, 18));
  const pDate = d => { const t = new Date(+startDay + d * 864e5); return NOLA.months[t.getUTCMonth()] + ' ' + t.getUTCDate() + ', ' + t.getUTCFullYear(); };
  function drawRecent() {
    const pts = P.pts.filter(p => (st.fold < 0 || foldOf(p[1]) === st.fold) && (st.theme < 0 || (p[5] >> st.theme) & 1));
    recentNb = []; pts.forEach(p => { if (p[4] >= 0) recentNb[p[4]] = (recentNb[p[4]] || 0) + 1; });
    const k = rm.k();
    rg.selectAll('circle').data(pts, p => p.join()).join('circle').attr('cx', p => p[2]).attr('cy', p => p[3]).attr('r', 4 / Math.sqrt(k))
      .attr('fill', 'var(--s1)').attr('fill-opacity', .75).attr('stroke', 'var(--surface)').attr('stroke-width', 1 / Math.sqrt(k))
      .on('mousemove', (ev, p) => tip.show(`<b>${P.TYP[p[1]]}</b>` + row('Filed', pDate(p[0])) + row('Neighborhood', nbName(p[4])) + (p[5] ? row('Topics', P.TH.filter((t, i) => (p[5] >> i) & 1).join(', ')) : ''), ev)).on('mouseleave', tip.hide);
    document.getElementById('recCount').textContent = `${fmt(pts.length)} matching case${pts.length === 1 ? '' : 's'} filed since Nov 18, 2025`;
    const top = recentNb.map((v, i) => [i, v || 0]).filter(d => d[1]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const mx = top.length ? top[0][1] : 1;
    document.getElementById('rank').innerHTML = top.length ? '<tbody>' + top.map(([i, v]) => `<tr><td>${NOLA.GEO.nb[i].name}</td><td class="num" style="width:40%"><span class="bar" style="width:${70 * v / mx}%;margin-right:6px"></span>${v}</td></tr>`).join('') + '</tbody>' : '<tbody><tr><td>No matching cases</td></tr></tbody>';
  }
  rm.onZoom(k => rg.selectAll('circle').attr('r', 4 / Math.sqrt(k)).attr('stroke-width', 1 / Math.sqrt(k)));

  // ---------- yearly stacked bars ----------
  (function () {
    const el = document.getElementById('years');
    const yrs = Object.keys(P.typeY).sort();
    const data = yrs.map(y => { const a = FOLD.map(() => 0); P.typeY[y].forEach((v, t) => a[foldOf(t)] += v); return { y, a }; });
    const f = NOLA.frame(el, { h: 300, m: { t: 10, r: 10, b: 28, l: 40 } });
    const x = d3.scaleBand().domain(yrs).range([0, f.iw]).paddingInner(.22);
    const yy = d3.scaleLinear().domain([0, 1000]).range([f.ih, 0]);
    NOLA.yGrid(f, yy, 5, d3.format('d'));
    data.forEach(d => { let y0 = 0; d.a.forEach((v, i) => { if (v) f.g.append('rect').attr('x', x(d.y)).attr('width', x.bandwidth()).attr('y', yy(y0 + v) + 1).attr('height', Math.max(.5, yy(y0) - yy(y0 + v) - 1)).attr('fill', FOLD[i].color).attr('rx', 1.5); y0 += v; }); });
    f.g.selectAll('rect.h').data(data).join('rect').attr('class', 'h').attr('x', d => x(d.y) - 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => tip.show(`<b>${d.y}${d.y === '2026' ? ' (through Nov 17)' : ''}</b>` + row('Total', fmt(d3.sum(d.a))) + FOLD.map((fo, i) => d.a[i] ? row(fo.n, d.a[i]) : '').join(''), ev)).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(yrs.filter((y, i) => i % 2 === 0)).join('text').attr('class', 'x').attr('x', y => x(y) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(y => "'" + y.slice(2));
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
    document.getElementById('yearLeg').innerHTML = FOLD.map(f => `<span><i style="background:${f.color}"></i>${f.n}</span>`).join('');
  })();

  // ---------- topic small multiples ----------
  (function () {
    const el = document.getElementById('themes');
    const yrs = Object.keys(P.themeY).sort().filter(y => +y >= 2010);
    const boxes = P.TH.map(() => { const b = document.createElement('div'); b.className = 'card sm'; el.appendChild(b); return b; });
    P.TH.forEach((t, i) => {
      const box = boxes[i];
      const vals = yrs.map(y => P.themeY[y][i]); const pk = d3.max(vals); const pkY = yrs[vals.indexOf(pk)];
      box.innerHTML = `<div class="smh"><b>${t}</b><span>peak ${pk} in ${pkY}</span></div>`;
      const f = NOLA.frame(box, { h: 96, m: { t: 6, r: 4, b: 18, l: 4 } });
      const x = d3.scaleBand().domain(yrs).range([0, f.iw]).paddingInner(.2);
      const y = d3.scaleLinear().domain([0, 72]).range([f.ih, 0]);
      f.g.selectAll('rect').data(vals).join('rect').attr('x', (v, j) => x(yrs[j])).attr('width', x.bandwidth()).attr('y', v => y(v)).attr('height', v => f.ih - y(v)).attr('rx', 1.5).attr('fill', 'var(--s1)');
      f.g.selectAll('rect.h').data(yrs).join('rect').attr('class', 'h').attr('x', yy => x(yy) - 1).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
        .on('mousemove', (ev, yy) => tip.show(`<b>${t}, ${yy}</b>` + row('Cases mentioning it', P.themeY[yy][i]), ev)).on('mouseleave', tip.hide);
      f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
      f.g.append('text').attr('x', 0).attr('y', f.ih + 13).text("'" + yrs[0].slice(2));
      f.g.append('text').attr('x', f.iw).attr('y', f.ih + 13).attr('text-anchor', 'end').text("'" + yrs[yrs.length - 1].slice(2));
    });
  })();

  drawRecent();
})();
