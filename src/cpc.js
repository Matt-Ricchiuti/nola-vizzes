// City Planning Commission cases page: one map (upcoming hearings / cases filed), what each case type is,
// filings per year by type, and cases per year by topic, stacked down the page
(() => {
  const P = DATA.cpc; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const PULLED = (DATA.meta && DATA.meta.pulled) || '2026-11-18';
  const YEAR = +PULLED.slice(0, 4);
  const lastFiled = P.lastFiled || PULLED;
  // case types as colored on every chart; `about` paraphrases the City's own descriptions
  // (Comprehensive Zoning Ordinance Articles 3-4, nola.gov application pages, CPC Subdivision Regulations)
  const FOLD = [
    { n: 'Variance', t: [0], about: 'Permission to depart from a specific zoning rule, such as a setback, height or parking requirement, because of a hardship. Usually decided by the Board of Zoning Adjustments.' },
    { n: 'Minor subdivision', t: [1], about: 'Dividing or redrawing property lines to create five or fewer lots, with no new street. Most are approved by CPC staff.' },
    { n: 'Neighborhood notice (NPP)', t: [2], about: 'The notice and neighborhood meeting an applicant must hold before filing for things like a zoning change, conditional use or most variances. Nothing is decided.' },
    { n: 'Design review', t: [3], about: 'CPC staff review of a project’s site plan and building design, required for larger projects and in some districts. Includes stormwater plan reviews.' },
    { n: 'Conditional use', t: [4], about: 'A use allowed on a particular site only with City Council approval, often with conditions, after a CPC public hearing and recommendation.' },
    { n: 'Zoning, text & master plan changes', t: [5, 6, 9], about: 'Changes to a property’s zoning district, to the wording of the zoning ordinance, or to the Master Plan. The CPC recommends; the City Council decides.' },
    { n: 'Appeals, major subdivisions & other', t: [7, 8, 10], about: 'Appeals of planning and zoning decisions; subdivisions that create six or more lots or a new street, which need a CPC public hearing; and all other case types.' }];
  FOLD.forEach((f, i) => f.color = NOLA.S(i));
  const foldOf = t => FOLD.findIndex(f => f.t.includes(t));
  const TYPEIDX = Object.fromEntries(P.TYP.map((t, i) => [t, i]));
  const nbName = i => i >= 0 ? NOLA.GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;

  // ---------- filing dates: `pts` counts days from windowStart; the map can show any range the data holds ----------
  const startDay = new Date((P.windowStart || '2025-11-18') + 'T00:00:00Z');
  const dayOf = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - startDay) / 864e5);
  const isoOf = d => new Date(+startDay + d * 864e5).toISOString().slice(0, 10);
  const pDate = d => NOLA.isoDate(isoOf(d));
  const LAST = Math.max(dayOf(lastFiled.slice(0, 10)), d3.max(P.pts, p => p[0]) || 0);
  const DEF_FROM = Math.max(0, LAST - 365); // the past 12 months
  const clampD = d => Math.max(0, Math.min(LAST, d));
  const hashDay = s => s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? clampD(dayOf(s)) : null;

  // older links pointed at the two separate maps; they open the matching tab of the one map now
  { const [v, ...kv] = location.hash.slice(1).split('&');
    if (v === 'upcoming' || v === 'recent') history.replaceState(null, '', '#map' + (v === 'recent' ? '&tab=filed' : '') + kv.map(s => '&' + s).join('')); }
  const H = NOLA.hashState();
  const st = { tab: H.tab === 'filed' ? 'filed' : 'up', from: hashDay(H.from) ?? DEF_FROM, to: hashDay(H.to) ?? LAST,
    fold: H.fold != null ? +H.fold : -1, theme: H.theme != null ? +H.theme : -1, nb: H.nb != null ? +H.nb : -1 };
  if (st.from > st.to) [st.from, st.to] = [st.to, st.from];
  const defRange = () => st.from === DEF_FROM && st.to === LAST;
  const rangeTxt = () => defRange() ? 'past 12 months' : `${pDate(st.from)} – ${pDate(st.to)}`;
  const mapTitle = () => st.tab === 'up' ? 'Upcoming hearings' : defRange() ? 'Cases filed in the past 12 months' : `Cases filed ${pDate(st.from)} – ${pDate(st.to)}`;

  const staged = (el, first, isMap, open) => { if (first) el._s = NOLA.stage(el, { map: isMap, open }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  // shared filter sections
  const nbSection = panel => { const s = NOLA.fsec(panel, 'Neighborhood'); NOLA.nbPick(s, st.nb, v => set('nb', v)); return s; };
  function typeSection(panel, counts) {
    NOLA.flist(NOLA.fsec(panel, 'Case type', st.fold >= 0 ? ['Show all', () => set('fold', -1)] : null),
      FOLD.map((f, i) => ({ key: i, name: f.n, color: f.color, count: counts[i] })), { pressed: i => st.fold === i, onClick: toggle('fold') });
  }

  // ---------- upcoming hearings ----------
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
  // meeting dates: past ones drop off (unless the data has nothing newer); the next one starts selected
  const dayOf_ = u => u.when.slice(0, 10);
  const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const ALLDAYS = [...new Set(up.map(dayOf_))].sort();
  const DAYS = ALLDAYS.some(d => d >= TODAY) ? ALLDAYS.filter(d => d >= TODAY) : ALLDAYS;
  const NEXT = DAYS[0] || null;
  st.day = H.date === 'all' ? 'all' : DAYS.includes(H.date) ? H.date : NEXT;
  const upLive = up.filter(u => DAYS.includes(dayOf_(u)));
  const okDay = u => st.day == null || st.day === 'all' || dayOf_(u) === st.day;
  const okFold = u => st.fold < 0 || u.fold === st.fold;
  const upNb = () => upLive.filter(u => okDay(u) && (st.nb < 0 || u.nb === st.nb));
  const upF = () => upNb().filter(okFold);

  // ---------- cases filed ----------
  const mapped = P.pts.filter(p => NOLA.shown(p[4]));
  const okType = p => st.fold < 0 || foldOf(p[1]) === st.fold, okTheme = p => st.theme < 0 || (p[5] >> st.theme) & 1, okNb = p => st.nb < 0 || p[4] === st.nb;
  const okDate = p => p[0] >= st.from && p[0] <= st.to;
  const inRange = () => mapped.filter(okDate);
  const matching = () => inRange().filter(p => okType(p) && okTheme(p));

  // ---------- the map: one section, tabs at the top of its panel ----------
  let mp, ud, rg, rangeSec, nbCnt = [];
  // the filing-date inputs stay in place across redraws, so typing a date isn't interrupted
  function makeRange(panel) {
    const sec = NOLA.fsec(panel, 'Filed', ['Past 12 months', () => { st.from = DEF_FROM; st.to = LAST; V.refresh(); }]);
    const box = document.createElement('div'); box.className = 'cpc-range';
    box.innerHTML = '<label><span>From</span><input type="date" aria-label="Filed from"></label><label><span>To</span><input type="date" aria-label="Filed to"></label>';
    const [a, b] = box.querySelectorAll('input');
    [a, b].forEach(i => { i.min = isoOf(0); i.max = isoOf(LAST); i.required = true; });
    const apply = which => () => {
      const i = which ? b : a; if (!i.value) return;
      const d = clampD(dayOf(i.value));
      if (which) { st.to = d; if (st.from > d) st.from = d; } else { st.from = d; if (st.to < d) st.to = d; }
      V.refresh();
    };
    a.onchange = apply(0); b.onchange = apply(1);
    sec.appendChild(box); sec._in = [a, b];
    return sec;
  }
  function syncRange() {
    const [a, b] = rangeSec._in;
    if (document.activeElement !== a) a.value = isoOf(st.from);
    if (document.activeElement !== b) b.value = isoOf(st.to);
    rangeSec.querySelector('.linkbtn').hidden = defRange();
  }
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true, true); // the tabs and agenda live in the panel, so phones show it open
    pane.classList.add('cpc-stage'); // a wider panel on this page (lib.css)
    const filed = st.tab === 'filed';
    pane.parentElement.querySelector('.vsec-h h2').textContent = mapTitle();
    // redrawing the panel empties it for a moment; keep the reader where they were (the panel's scroll, or the page's on phones)
    const keep = [panel.scrollTop, scrollX, scrollY];
    [...panel.children].forEach(c => { if (!(filed && c === rangeSec)) c.remove(); });
    const nbSec = nbSection(panel);
    if (filed) {
      if (!rangeSec) rangeSec = makeRange(panel);
      else if (rangeSec.parentNode !== panel) panel.appendChild(rangeSec);
      else panel.insertBefore(nbSec, rangeSec);
      syncRange();
    }
    if (first) {
      mp = NOLA.map(plot, { panel, label: 'Map of City Planning Commission cases',
        tip: i => `<b>${NOLA.GEO.nb[i].name}</b>` + row(st.tab === 'up' ? (st.day && st.day !== 'all' ? 'Cases, ' + dayFmt(st.day) : 'Upcoming hearings') : `Matching cases, ${rangeTxt()}`, fmt(nbCnt[i] || 0)) });
      rg = mp.layer.append('g'); ud = mp.layer.append('g'); mp.lastNb = -1;
      mp.onZoom(k => {
        ud.selectAll('circle').attr('r', 7 / Math.sqrt(k)).attr('stroke-width', 2 / Math.sqrt(k));
        rg.selectAll('circle').attr('r', 4 / Math.sqrt(k)).attr('stroke-width', 1 / Math.sqrt(k));
      });
      // what each color means, right under the map
      const key = document.createElement('div'); key.className = 'cpc-key';
      key.innerHTML = FOLD.map(f => `<div class="cpc-kt"><i style="background:${f.color}"></i><div><b>${f.n}</b><p>${f.about}</p></div></div>`).join('');
      pane.after(key);
    }
    if (mp.lastNb !== st.nb) { mp.focus(st.nb, first ? 0 : 450); mp.lastNb = st.nb; }
    ud.style('display', filed ? 'none' : null); rg.style('display', filed ? null : 'none');
    if (filed) drawFiled(panel); else drawUpcoming(panel);
    NOLA.ftabs(panel, [['up', 'Upcoming hearings'], ['filed', 'Cases filed']], st.tab, v => set('tab', v));
    if (!first) { panel.scrollTop = keep[0]; if (scrollY !== keep[2]) scrollTo(keep[1], keep[2]); }
  }

  function drawUpcoming(panel) {
    const list = upF();
    nbCnt = []; upLive.filter(u => okDay(u) && okFold(u)).forEach(u => { if (u.nb >= 0) nbCnt[u.nb] = (nbCnt[u.nb] || 0) + 1; });
    typeSection(panel, FOLD.map((f, i) => upNb().filter(u => u.fold === i).length));
    const ag = NOLA.fsec(panel, `Agenda · ${fmt(list.length)} case${list.length === 1 ? '' : 's'}`, st.day && st.day !== 'all' && DAYS.length > 1 ? ['All dates', () => pickDay('all')] : null);
    datePick(ag);
    const box = document.createElement('div'); box.className = 'agenda'; ag.appendChild(box);
    box.innerHTML = list.length ? d3.groups(list, u => u.when.slice(0, 10)).map(([day, us]) => `<div class="day"><div class="dh">${dayFmt(day)} · ${[...new Set(us.map(u => u.body))].join(', ')}${offDay(day) ? ` <span class="offday" title="This is the next meeting date the City lists for these cases, but it falls on a ${offDay(day)}.">${offDay(day)}: date as listed</span>` : ''}</div>` +
      us.map(u => `<div class="ui" data-c="${u.cnum}${u.when}"><i style="background:${FOLD[u.fold].color}"></i><div><b>${u.addr}</b> <span class="ty">${u.type}</span><div class="ds">${cleanDesc(u.desc)}</div><div class="nb">${nbName(u.nb)} · ${u.cnum}</div></div></div>`).join('') + '</div>').join('')
      : `<div class="ds">No hearings${st.day && st.day !== 'all' ? ' this date' : ' scheduled'}${st.nb >= 0 ? ' in ' + nbName(st.nb) : ''}${st.fold >= 0 ? ' of this type' : ''}.</div>`;
    const upTip = d => `<b>${d.addr}</b><div style="color:var(--ink2)">${d.type} · ${d.cnum}</div>` + row('Hearing', dayFmt(d.when) + (timeFmt(d.when) ? ', ' + timeFmt(d.when) : '') + (offDay(d.when) ? ` (${offDay(d.when)}, as listed)` : '')) + row('Body', d.body) + row('Neighborhood', nbName(d.nb)) + `<div style="margin-top:6px">${cleanDesc(d.desc)}</div>`;
    const k = mp.k();
    const dots = ud.selectAll('circle').data(list.filter(u => (u.x || u.y) && NOLA.shown(u.nb)), d => d.cnum + d.when).join('circle')
      .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', 7 / Math.sqrt(k)).attr('stroke-width', 2 / Math.sqrt(k))
      .attr('fill', d => FOLD[d.fold].color).attr('stroke', 'var(--surface)').attr('opacity', 1)
      .on('mousemove', (ev, d) => { tip.show(upTip(d), ev); hi(d); }).on('mouseleave', () => { tip.hide(); hi(null); });
    const items = [...box.querySelectorAll('.ui')];
    items.forEach(it => { const u = list.find(v => v.cnum + v.when === it.dataset.c); it.onmouseenter = () => hi(u); it.onmouseleave = () => hi(null); it.onclick = () => { if (u.x) mp.zoomTo([u.x - 60, u.y - 45, u.x + 60, u.y + 45], 500); }; });
    function hi(u) {
      dots.attr('opacity', d => !u || d === u ? 1 : .25);
      items.forEach(it => it.classList.toggle('on', !!u && it.dataset.c === u.cnum + u.when));
    }
  }

  // meeting dates as a row of small boxes per month, the month turned on its side at the left; one date (or all) at a time
  let refocus = false;
  const pickDay = (d, focus) => { refocus = !!focus; set('day', d); };
  function datePick(sec) {
    if (!DAYS.length) return;
    const n = d3.rollup(upLive.filter(u => (st.nb < 0 || u.nb === st.nb) && okFold(u)), v => v.length, dayOf_);
    const bodies = d3.rollup(upLive, v => [...new Set(v.map(u => u.body))].join(', '), dayOf_);
    const box = document.createElement('div'); box.className = 'cpc-days'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Meeting date');
    box.innerHTML = d3.groups(DAYS, d => d.slice(0, 7)).map(([m, ds]) => `<div class="mo"><span class="ml" aria-hidden="true">${new Date(m + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short' })}</span><div class="bx">` +
      ds.map(d => { const c = n.get(d) || 0, off = offDay(d), lab = `${dayFmt(d)} · ${bodies.get(d)} · ${c} case${c === 1 ? '' : 's'}${off ? ` · ${off}: date as listed` : ''}`;
        return `<button type="button" data-d="${d}" class="${c ? '' : 'none'}${off ? ' off' : ''}" aria-pressed="${d === st.day}" aria-label="${lab}" title="${lab}">${+d.slice(8)}</button>`; }).join('') + '</div></div>').join('');
    const bs = [...box.querySelectorAll('button')];
    const cur = bs.find(b => b.dataset.d === st.day) || bs[0]; bs.forEach(b => b.tabIndex = b === cur ? 0 : -1);
    bs.forEach(b => b.onclick = () => { if (b.dataset.d !== st.day) pickDay(b.dataset.d, true); });
    // arrow keys move between dates (and pick them, like tabs)
    box.addEventListener('keydown', ev => {
      const i = bs.indexOf(document.activeElement); if (i < 0) return;
      const j = ev.key === 'ArrowRight' ? Math.min(bs.length - 1, i + 1) : ev.key === 'ArrowLeft' ? Math.max(0, i - 1) : ev.key === 'Home' ? 0 : ev.key === 'End' ? bs.length - 1 : -1;
      if (j < 0) return; ev.preventDefault(); if (j !== i || bs[j].dataset.d !== st.day) pickDay(bs[j].dataset.d, true);
    });
    sec.appendChild(box);
    if (refocus) { refocus = false; cur.focus({ preventScroll: true }); }
  }

  function drawFiled(panel) {
    const span = inRange(), all = matching(), pts = all.filter(okNb);
    nbCnt = []; all.forEach(p => { nbCnt[p[4]] = (nbCnt[p[4]] || 0) + 1; });
    typeSection(panel, FOLD.map((f, i) => span.filter(p => okTheme(p) && okNb(p) && foldOf(p[1]) === i).length));
    NOLA.flist(NOLA.fsec(panel, 'Topic in description', st.theme >= 0 ? ['Any topic', () => set('theme', -1)] : null),
      P.TH.map((t, i) => ({ key: i, name: t, color: 'var(--ink2)', count: span.filter(p => okType(p) && okNb(p) && (p[5] >> i) & 1).length })),
      { pressed: i => st.theme === i, onClick: toggle('theme') });
    // where the matching cases are: neighborhoods ranked, the chosen one always listed with its rank
    const ranked = NOLA.nbList().map(f => [f.idx, nbCnt[f.idx] || 0]).sort((a, b) => b[1] - a[1]).map((d, r) => [...d, r + 1]);
    const top = ranked.filter(d => d[1]).slice(0, 8), mine = ranked.find(d => d[0] === st.nb);
    if (mine && !top.includes(mine)) top.push(mine);
    NOLA.flist(NOLA.fsec(panel, `Most cases · ${fmt(pts.length)} shown`),
      top.map(([i, v, r]) => ({ key: i, name: `${r}. ${NOLA.GEO.nb[i].name}`, color: 'var(--s1)', count: v })), { pressed: i => st.nb === i, onClick: toggle('nb') });
    const k = mp.k();
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

  const V = NOLA.views([
    { id: 'map', label: mapTitle(), tab: 'Map of cases', keep: true, draw: drawMap },
    { id: 'years', label: 'Cases filed per year, by type', draw: drawYears },
    { id: 'topics', label: 'Cases per year mentioning each topic', draw: drawTopics },
  ], { ds: ['xxb5-5azv', 'CPC Projects'],
       state: () => ({ tab: st.tab === 'filed' ? 'filed' : null, date: st.day !== NEXT ? st.day : null, from: st.from !== DEF_FROM ? isoOf(st.from) : null, to: st.to !== LAST ? isoOf(st.to) : null,
         fold: st.fold >= 0 ? st.fold : null, theme: st.theme >= 0 ? st.theme : null, nb: st.nb >= 0 ? st.nb : null }) });
})();
