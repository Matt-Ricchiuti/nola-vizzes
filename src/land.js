// Vacant Land page: the lots NORA lists as uncommitted and the City's public land list, and NORA's past sales
(() => {
  const LD = DATA.land; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA, GEO = NOLA.GEO;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  const monthYear = iso => { const [y, m] = iso.split('-').map(Number); return NOLA.months[m - 1] + ' ' + y; };
  const ACRE = 43560;
  const sizeTxt = s => s < 0 ? null : s >= ACRE ? `${(s / ACRE).toFixed(s >= 10 * ACRE ? 0 : 1)} acres` : `${fmt(s)} sq ft`;

  // ---------- land: one dot per NORA lot (placed by parcel) and per site on the City's public land list (LD.land) ----------
  // a NORA lot that is also on the City's list is one dot, a NORA lot, with the list's details in its tooltip
  const L = NOLA.dotData(LD.land), LN = L.n, pubWhen = monthYear(LD.pubDate);
  const KINDS = [['NORA lots, uncommitted', 'var(--s2)'], ['Public: vacant land', 'var(--s1)'], ['Public: parks and greenspace', 'var(--s6)'],
    ['Public: buildings and facilities', 'var(--s7)'], ['Public: housing', 'var(--s5)'], ['Public: utilities, drainage, right of way', 'var(--s4)'], ['Public: type not given', 'var(--muted)']];
  const kindOf = Int8Array.from({ length: LN }, (_, i) => L.src[i] === 0 ? 0 : 1 + L.g[i]);
  // a site on the City's (year-old) list that NORA's sales record shows as sold: drawn faint unless picked out
  const soldRec = i => L.src[i] === 1 && L.sd[i] >= 0;
  const SZ = ['Under 3,000 sq ft', '3,000–5,000 sq ft', '5,000–10,000 sq ft', '10,000 sq ft to 1 acre', 'Over 1 acre'];
  // faded public land under full-color public land, NORA's lots on top
  const LAND_COLORS = [...KINDS.slice(1).map(([, c]) => [c, .28]), ...KINDS.slice(1).map(([, c]) => c), KINDS[0][1]];

  // ---------- sales: one dot per NORA sale (LD.sold) ----------
  const S = NOLA.dotData(LD.sold), SN = S.n;
  const CH_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s7)', 'var(--s6)', 'var(--muted)'];   // auction, lot next door, development, alternative land use, other
  const LASTD = S.dayOf(LD.last), lastLabel = NOLA.isoDate(LD.last);
  const PER = [['12', 'Year'], ['60', '5 years'], ['all', 'All']], PER_DAYS = { 12: 365, 60: 1826 };
  const perLabel = { 12: ` in the year to ${lastLabel}`, 60: ` in the 5 years to ${lastLabel}`, all: `, ${LD.first.slice(0, 4)} to ${lastLabel}` };
  const inPer = i => st.per === 'all' || (S.day[i] >= 0 && S.day[i] > LASTD - PER_DAYS[st.per]);

  // ---------- state (in the link) ----------
  const H = NOLA.hashState();
  const int = (v, lo, hi) => v != null && +v >= lo && +v < hi ? +v : -1;
  const st = { mode: H.m === 'sold' ? 'sold' : 'land', nb: int(H.nb, 0, 72), heat: H.heat === '1', ac: H.ac === '1', pc: H.pc === '1',
               k: int(H.k, 0, KINDS.length), mg: int(H.mg, 0, LD.M.length), sz: int(H.sz, 0, SZ.length), z: int(H.z, 0, LD.Z.length),
               ns: ['hide', 'only'].includes(H.ns) ? H.ns : 'fade', per: ['12', '60'].includes(H.p) ? H.p : 'all', ch: int(H.ch, 0, LD.CH.length) };
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  const okNb = nb => st.nb < 0 || nb === st.nb;
  const okNs = i => st.ns === 'fade' || (st.ns === 'hide') !== soldRec(i);
  // each filter, so a list's counts can leave out its own filter
  const fK = i => st.k < 0 || kindOf[i] === st.k, fM = i => st.mg < 0 || L.m[i] === st.mg, fS = i => st.sz < 0 || L.sb[i] === st.sz, fZ = i => st.z < 0 || L.z[i] === st.z;
  const landOk = i => fK(i) && fM(i) && fS(i) && fZ(i) && okNs(i) && okNb(L.nb[i]);
  const soldOk = i => inPer(i) && (st.ch < 0 || S.c[i] === st.ch) && okNb(S.nb[i]);

  const mapLabel = () => st.mode === 'sold' ? `NORA property sales${perLabel[st.per]}`
    : `NORA's uncommitted lots and City public land (list from ${pubWhen})`;

  // a dropdown inside a panel section: [[value, label], ...] after an "all" option (-1)
  function pick(sec, opts, value, onSel, all) {
    const s = document.createElement('select'); s.className = 'fsel'; s.setAttribute('aria-label', all);
    s.innerHTML = `<option value="-1">${esc(all)}</option>` + opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    s.value = String(value); s.onchange = () => onSel(+s.value); sec.appendChild(s); return s;
  }

  // ---------- the map ----------
  let m, modeEl, nbCnt = new Array(72).fill(0);
  const heatVal = i => st.mode === 'sold' ? (st.pc ? NOLA.perK(nbCnt[i], NOLA.popOf(i)) : nbCnt[i]) : nbCnt[i];
  const keyLabel = () => st.mode === 'sold' ? 'Sales shown' + (st.pc ? ' per 1,000 residents' : '') + ', by neighborhood'
    : (st.ac ? 'Acres shown' : 'Sites shown') + ', by neighborhood';
  const acf = v => v >= 100 ? fmt(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);

  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    nbCnt = new Array(72).fill(0); let shown = 0;
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    if (st.mode === 'land') {
      const kC = new Array(KINDS.length).fill(0), mC = new Array(LD.M.length).fill(0), sC = new Array(SZ.length).fill(0), zC = new Array(LD.Z.length).fill(0);
      let sold = 0;
      for (let i = 0; i < LN; i++) {
        if (landOk2(i)) nbAdd(i);
        if (!okNb(L.nb[i])) continue;
        const a = fK(i), b = fM(i), c = fS(i), d = fZ(i);
        if (a && b && c && d && soldRec(i)) sold++;
        if (!okNs(i)) continue;
        if (b && c && d) kC[kindOf[i]]++;
        if (a && c && d && L.m[i] >= 0) mC[L.m[i]]++;
        if (a && b && d) sC[L.sb[i]]++;
        if (a && b && c && L.z[i] >= 0) zC[L.z[i]]++;
        if (a && b && c && d) shown++;
      }
      NOLA.flist(NOLA.fsec(panel, `Show · ${fmt(shown)} sites`, st.k >= 0 ? ['Show all', () => set('k', -1)] : null),
        KINDS.map(([l, c], k) => ({ key: k, name: l, color: c, count: kC[k] })), { pressed: k => st.k === k, onClick: toggle('k') });
      NOLA.seg(NOLA.fsec(panel, `Public land with a NORA sale on record · ${fmt(sold)}`), [['fade', 'Faded'], ['hide', 'Hidden'], ['only', 'Only these']], st.ns, v => set('ns', v));
      NOLA.flist(NOLA.fsec(panel, 'Size', st.sz >= 0 ? ['Show all', () => set('sz', -1)] : null),
        SZ.map((l, k) => ({ key: k, name: l, color: 'var(--ink2)', count: sC[k], square: true })), { pressed: k => st.sz === k, onClick: toggle('sz') });
      pick(NOLA.fsec(panel, 'Managed by'), LD.M.map((n, k) => [k, `${n} (${fmt(mC[k])})`]), st.mg, v => set('mg', v), 'All agencies');
      pick(NOLA.fsec(panel, 'Zoning (NORA lots only)'), LD.Z.map((n, k) => [k, `${n} (${fmt(zC[k])})`]), st.z, v => set('z', v), 'Any zoning');
    } else {
      const cC = new Array(LD.CH.length).fill(0);
      for (let i = 0; i < SN; i++) {
        if (!inPer(i)) continue;
        const inNb = okNb(S.nb[i]);
        if (inNb) cC[S.c[i]]++;
        if (st.ch < 0 || S.c[i] === st.ch) { nbCnt[S.nb[i]]++; if (inNb) shown++; }
      }
      NOLA.periodSeg(NOLA.fsec(panel, 'Sold in the last'), st.per, v => set('per', v), PER);
      NOLA.flist(NOLA.fsec(panel, `How NORA sold it · ${fmt(shown)} sales`, st.ch >= 0 ? ['Show all', () => set('ch', -1)] : null),
        LD.CH.map((l, k) => ({ key: k, name: l, color: CH_COLORS[k], count: cC[k], sub: k === LD.CH.length - 1 ? 'Special transfer, affordable housing' : null })),
        { pressed: k => st.ch === k, onClick: toggle('ch') });
    }
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of vacant and public land and NORA sales', tip: mapTip });
      m.lastNb = -1;
      // the two maps, switched from a pill floating at the top center of the map; the view stays put
      modeEl = document.createElement('div'); modeEl.className = 'ftabs tmode'; modeEl.setAttribute('role', 'tablist'); modeEl.setAttribute('aria-label', 'Map');
      [['land', 'Available & public land'], ['sold', 'NORA sales']].forEach(([v, l]) => {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.m = v; b.textContent = l;
        b.onclick = () => { if (st.mode !== v) { tip.hide(); set('mode', v); } }; modeEl.appendChild(b);
      });
      modeEl.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set('mode', st.mode === 'land' ? 'sold' : 'land'); modeEl.querySelector(`[data-m="${st.mode}"]`).focus(); } });
      plot.appendChild(modeEl);
    }
    modeEl.querySelectorAll('button').forEach(b => { const on = b.dataset.m === st.mode; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    if (st.mode === 'land') m.dots({ x: L.x, y: L.y, n: LN, colors: LAND_COLORS, visible: landOk, r: NOLA.dotR, tip: landTip,
      color: i => kindOf[i] === 0 ? 12 : soldRec(i) && st.ns !== 'only' ? kindOf[i] - 1 : 5 + kindOf[i] });
    else m.dots({ x: S.x, y: S.y, n: SN, colors: CH_COLORS, color: i => S.c[i], visible: soldOk, r: NOLA.dotR, tip: soldTip });
    NOLA.heatToggle(plot, st.heat, on => set('heat', on), st.mode === 'sold'
      ? { label: 'Per 1k residents', checked: st.pc, onChange: on => set('pc', on) }
      : { label: 'By acreage', checked: st.ac, onChange: on => set('ac', on) });
    const cl = st.heat ? NOLA.classes(d3.range(72).map(heatVal)) : null;
    m.setFill(cl ? i => cl.color(heatVal(i)) : () => null);
    const none = cl && d3.range(72).some(i => heatVal(i) == null) ? 'Under 1,000 residents' : null;
    NOLA.heatKey(panel, plot, cl, keyLabel(), st.mode === 'land' && st.ac ? acf : NOLA.short, none);
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  // the heatmap counts every neighborhood (the neighborhood pick only zooms), with the other filters applied
  const landOk2 = i => fK(i) && fM(i) && fS(i) && fZ(i) && okNs(i);
  const nbAdd = i => { nbCnt[L.nb[i]] += st.ac ? Math.max(0, L.s[i]) / ACRE : 1; };

  function landTip(i) {
    const a = L.a[i], nm = L.nm[i] >= 0 ? LD.N[L.nm[i]] : null, k = kindOf[i], mg = L.m[i] >= 0 ? LD.M[L.m[i]] : null;
    const org = j => j >= 0 && LD.O[j] !== mg ? esc(LD.O[j]) : null, ty = L.t[i] >= 0 ? LD.TY[L.t[i]] : null;
    const sale = L.sd[i] >= 0 ? `${NOLA.isoDate(L.iso(L.sd[i]))}, ${esc(LD.SC[L.c[i]] || 'channel not stated')}` : null;
    return `<b>${esc(a >= 0 ? L.A[a] : nm || 'No address listed')}</b>`
      + `<div style="color:var(--ink2)">${k === 0 ? 'NORA lot, uncommitted' : 'City public land' + (ty ? ' · ' + esc(ty) : '')}</div>`
      + (nm && a >= 0 ? row('Site', esc(nm)) : '')
      + (k === 0 && ty ? row("On the City's list as", esc(ty)) : '')
      + (L.z[i] >= 0 ? row('Zoning', esc(LD.Z[L.z[i]])) : '')
      + (L.s[i] >= 0 ? row('Size', sizeTxt(L.s[i])) : '')
      + (mg ? row('Managed by', esc(mg)) : '')
      + (org(L.o[i]) ? row('Owned by', org(L.o[i])) : '')
      + (org(L.u[i]) ? row('Used by', org(L.u[i])) : '')
      + (L.l[i] >= 0 ? row('Leased by', esc(LD.O[L.l[i]])) : '')
      + (L.k[i] >= 0 && !(LD.NT[L.k[i]] === 'Vacant' && ty === 'Vacant Land') ? row("City's note", esc(LD.NT[L.k[i]])) : '')
      + (sale ? row(k === 0 ? 'Earlier NORA sale' : 'NORA sale on record', sale) : '')
      + row('Neighborhood', nbName(L.nb[i]));
  }
  function soldTip(i) {
    const a = S.a[i];
    return `<b>${esc(a >= 0 ? S.A[a] : 'No address listed')}</b><div style="color:var(--ink2)">Sold by NORA</div>`
      + row('Sold', S.day[i] >= 0 ? NOLA.isoDate(S.iso(S.day[i])) : 'Date not listed') + row('How', esc(LD.CHX[S.e[i]]))
      + (S.i[i] ? row('Now', "On NORA's uncommitted list again") : '')
      + row('Neighborhood', nbName(S.nb[i]));
  }
  function mapTip(i) {
    if (st.mode === 'land') return `<b>${GEO.nb[i].name}</b>` + row(st.ac ? 'Acres shown' : 'Sites shown', st.ac ? acf(nbCnt[i]) : fmt(nbCnt[i]));
    const pop = NOLA.popOf(i), rate = NOLA.perK(nbCnt[i], pop);
    return `<b>${GEO.nb[i].name}</b>` + row('Sales shown', fmt(nbCnt[i])) + row('Residents (2020)', pop == null ? '—' : fmt(pop))
      + (rate != null ? row('Per 1,000 residents', NOLA.fmtRate(rate)) : '');
  }

  // ---------- sales per year, by channel ----------
  const YS = LD.years, Y0 = YS[0], NY = YS.length, lastShort = lastLabel.replace(/, \d+$/, '');
  const yearOf = new Int16Array(SN); for (let i = 0; i < SN; i++) yearOf[i] = S.day[i] >= 0 ? +S.iso(S.day[i]).slice(0, 4) : 0;
  function drawYears(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    // every sale (LD.yc) citywide; the mapped ones when a neighborhood is picked
    let yc = LD.yc;
    if (st.nb >= 0) {
      yc = YS.map(() => new Array(LD.CH.length).fill(0));
      for (let i = 0; i < SN; i++) if (S.nb[i] === st.nb && yearOf[i] >= Y0) yc[yearOf[i] - Y0][S.c[i]]++;
    }
    const cC = LD.CH.map((c, k) => d3.sum(yc, r => r[k]));
    NOLA.flist(NOLA.fsec(panel, `How NORA sold it · since ${Y0}`, st.ch >= 0 ? ['Show all', () => set('ch', -1)] : null),
      LD.CH.map((l, k) => ({ key: k, name: l, color: CH_COLORS[k], count: cC[k], sub: k === LD.CH.length - 1 ? 'Special transfer, affordable housing' : null })),
      { pressed: k => st.ch === k, onClick: toggle('ch') });
    const stacks = yc.map(r => r.map((v, k) => st.ch < 0 || k === st.ch ? v : 0));
    plot.innerHTML = '';
    const f = NOLA.frame(plot, { h: 380, m: { t: 14, r: 10, b: 28, l: 48 } });
    const x = d3.scaleBand().domain(YS).range([0, f.iw]).paddingInner(.22);
    const tot = k => d3.sum(stacks[k]), partial = k => k === NY - 1;
    const y = d3.scaleLinear().domain([0, Math.max(4, (d3.max(YS, (yy, k) => tot(k)) || 0) * 1.05)]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5);
    YS.forEach((yy, k) => { let y0 = 0; stacks[k].forEach((v, s) => { if (!v) return;
      f.g.append('rect').attr('x', x(yy)).attr('width', x.bandwidth()).attr('y', y(y0 + v) + 1).attr('height', Math.max(.5, y(y0) - y(y0 + v) - 1))
        .attr('fill', CH_COLORS[s]).attr('rx', 1.5).attr('opacity', partial(k) ? .45 : 1); y0 += v; }); });
    // the last year is partial: its label ends at the bar's right edge so it stays inside the chart
    f.g.append('text').attr('class', 'halo').attr('x', x(YS[NY - 1]) + x.bandwidth()).attr('y', y(tot(NY - 1)) - 5)
      .attr('text-anchor', 'end').style('fill', 'var(--ink2)').style('font-size', '11px').text('to ' + lastShort);
    f.g.selectAll('rect.h').data(YS).join('rect').attr('class', 'h').attr('x', yy => x(yy) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => { const k = YS.indexOf(yy);
        tip.show(`<b>${yy}${partial(k) ? ', through ' + lastShort : ''}</b>` + (st.nb >= 0 ? `<div style="color:var(--ink2)">${nbName(st.nb)}</div>` : '')
          + LD.CH.map((c, s) => st.ch < 0 || s === st.ch ? row(sw(CH_COLORS[s]) + c, fmt(stacks[k][s])) : '').join('')
          + (st.ch < 0 ? row('All sales', fmt(tot(k))) : ''), ev); })
      .on('mouseleave', tip.hide);
    const step = f.iw < 520 ? 3 : f.iw < 900 ? 2 : 1;
    f.g.selectAll('text.x').data(YS.filter((yy, k) => (NY - 1 - k) % step === 0)).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  const V = NOLA.views([
    { id: 'map', label: mapLabel, tab: 'Map', keep: true, draw: drawMap },
    { id: 'years', label: () => 'NORA sales per year, by how they were sold', tab: 'Sales per year', draw: drawYears },
  ], { ds: [LD.invDs, 'NORA Uncommitted Property Inventory'],
       state: () => ({ m: st.mode === 'sold' ? 'sold' : null, nb: st.nb >= 0 ? st.nb : null, heat: st.heat ? 1 : null, ac: st.ac ? 1 : null, pc: st.pc ? 1 : null,
                       k: st.k >= 0 ? st.k : null, mg: st.mg >= 0 ? st.mg : null, sz: st.sz >= 0 ? st.sz : null, z: st.z >= 0 ? st.z : null,
                       ns: st.ns !== 'fade' ? st.ns : null, p: st.per !== 'all' ? st.per : null, ch: st.ch >= 0 ? st.ch : null }) });
})();
