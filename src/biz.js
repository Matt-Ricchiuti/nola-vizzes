// New businesses page (occupational license applications and current licenses)
(() => {
  const D = DATA.biz; NOLA.setGeo(DATA.geo);
  const { fmt, tip, row } = NOLA;
  const GEO = NOLA.GEO;
  const nbName = i => i >= 0 ? GEO.nb[i].name : '—';
  const sw = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> `;
  // the City's NAICS sector names, shortened to fit the panel
  const SHORT = { 'Retail Trade': 'Retail', 'Accommodation & Food Services': 'Food service and lodging', 'Other Services (Except Public Administration)': 'Repair and personal services',
    'Professional, Scientific, & Technical Services': 'Professional services', 'Transportation & Warehousing': 'Transport and warehousing',
    'Health Care & Social Assistance': 'Health and social services', 'Administrative & Support & Waste Mgmt & Remediation Services': 'Admin and support services',
    'Arts, Entertainment & Recreation': 'Arts and recreation', 'Real Estate & Rental & Leasing': 'Real estate and rentals', 'Educational Services': 'Education',
    'Finance & Insurance': 'Finance and insurance', 'Wholesale Trade': 'Wholesale', 'Manufacturing': 'Manufacturing', 'Information': 'Information' };
  const nm = s => SHORT[s] || s;
  const PAL = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s7)', 'var(--s6)', 'var(--s8)'];
  const colorOf = name => { const k = D.S.indexOf(name); return k >= 0 && k < PAL.length ? PAL[k] : name === 'Event and street vendors' ? 'var(--ink2)' : /^(Not stated|Other or not stated)$/.test(name) ? 'var(--landline)' : 'var(--muted)'; };
  const OUT_C = ['var(--s3)', 'var(--s4)', 'var(--muted)', 'var(--s8)', 'var(--s7)', 'var(--s5)'];
  const lastLabel = NOLA.isoDate(D.last).replace(/, \d+$/, ''), YEAR = +D.last.slice(0, 4), partialYear = y => y === YEAR && !D.last.endsWith('-12-31');
  const nby = D.nby.map(a => { const o = []; for (let i = 0; i < a.length; i += 3) o.push(a.slice(i, i + 3)); return o; });

  const H = NOLA.hashState();
  const st = { nb: H.nb != null ? +H.nb : -1, measure: H.measure === 'now' ? 'now' : 'new', sec: H.sec != null ? +H.sec : -1, sec2: H.sec2 != null ? +H.sec2 : -1 };
  if (!(st.nb >= -1 && st.nb < 72)) st.nb = -1;
  if (!(st.sec >= -1 && st.sec < D.S.length)) st.sec = -1;
  if (!(st.sec2 >= -1 && st.sec2 < D.S2.length)) st.sec2 = -1;
  const staged = (el, first, isMap) => { if (first) el._s = NOLA.stage(el, { map: isMap }); return el._s; };
  const set = (k, v) => { st[k] = v; V.refresh(); };
  const toggle = k => v => set(k, st[k] === v ? -1 : v);
  // ---------- map: a dot per license application (since 2018) or per business licensed now (D.dots) ----------
  // The heatmap (a checkbox on the map) counts the dots shown per neighborhood.
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PA = NOLA.dotData(D.dots.apps), PW = NOLA.dotData(D.dots.now), LASTD = PA.dayOf(D.last);
  st.per = ['1', '6', '12', 'all'].includes(H.p) ? H.p : '12';
  st.since = ['12', '60'].includes(H.since) ? H.since : 'all';
  st.out = H.out != null && +H.out >= 0 && +H.out < D.out.length ? +H.out : -1;
  st.home = H.home === '1' ? 1 : H.home === 'all' ? -1 : 0; // opens on applications not marked home-based
  st.heat = H.heat === '1';
  const isNew = () => st.measure !== 'now';
  const P = () => isNew() ? PA : PW, SEC = () => isNew() ? D.S : D.S2, sk = () => isNew() ? 'sec' : 'sec2';
  const okTime = i => isNew() ? NOLA.inPeriod(PA.day[i], LASTD, st.per) : st.since === 'all' || (PW.day[i] >= 0 && PW.day[i] > LASTD - 365 * (+st.since / 12));
  const okSec = i => st[sk()] < 0 || P().s[i] === st[sk()];
  const okOut = i => !isNew() || st.out < 0 || PA.o[i] === st.out, okHome = i => !isNew() || st.home < 0 || PA.h[i] === st.home;
  const okNb = i => st.nb < 0 || P().nb[i] === st.nb;
  const SCOL = () => SEC().map(colorOf);
  let nbCnt = new Array(72).fill(0);
  const perL = { 1: 'past month', 6: 'past 6 months', 12: 'past 12 months', all: '' };
  const mapLabel = () => isNew() ? (st.per === 'all' ? `Business license applications since ${D.years[0]}` : `New business license applications in the ${perL[st.per]}`) : 'Businesses licensed now';
  const keyLabel = () => (isNew() ? 'Applications shown' : 'Businesses shown') + ', by neighborhood';

  let m;
  function drawMap(pane, first) {
    const { panel, plot } = staged(pane, first, true);
    panel.innerHTML = '';
    const p = P(), S = SEC(), sc = new Array(S.length).fill(0), oc = new Array(D.out.length).fill(0);
    nbCnt = new Array(72).fill(0); let shown = 0;
    for (let i = 0; i < p.n; i++) {
      if (!okTime(i) || !okHome(i)) continue;
      const a = okSec(i), b = okOut(i), nb = okNb(i);
      if (nb && b) sc[p.s[i]]++;
      if (nb && a && isNew()) oc[PA.o[i]]++;
      if (a && b) { nbCnt[p.nb[i]]++; if (nb) shown++; }
    }
    NOLA.ftabs(panel, [['new', 'New applications'], ['now', 'Licensed now']], st.measure, v => set('measure', v));
    NOLA.nbPick(NOLA.fsec(panel, 'Neighborhood'), st.nb, v => set('nb', v));
    if (isNew()) NOLA.periodSeg(NOLA.fsec(panel, 'Filed in the last'), st.per, v => set('per', v));
    else NOLA.seg(NOLA.fsec(panel, 'Licensed since'), [['12', 'Past year'], ['60', 'Past 5 years'], ['all', 'Any time']], st.since, v => set('since', v));
    NOLA.flist(NOLA.fsec(panel, `Sector · ${fmt(shown)} shown`, st[sk()] >= 0 ? ['Show all', () => set(sk(), -1)] : null),
      S.map((s, k) => ({ key: k, name: nm(s), color: colorOf(s), count: sc[k] })), { pressed: k => st[sk()] === k, onClick: toggle(sk()) });
    if (isNew()) {
      NOLA.flist(NOLA.fsec(panel, 'Status now', st.out >= 0 ? ['Show all', () => set('out', -1)] : null),
        D.out.map((o, k) => ({ key: k, name: o, color: OUT_C[k], count: oc[k], square: true })), { pressed: k => st.out === k, onClick: toggle('out') });
      NOLA.seg(NOLA.fsec(panel, 'Home-based'), [[-1, 'All'], [1, 'Yes'], [0, 'No']], st.home, v => set('home', v));
    }
    if (first) {
      m = NOLA.map(plot, { panel, label: 'Map of business licenses', tip: mapTip });
      m.lastNb = -1;
    }
    m.dots({ x: p.x, y: p.y, n: p.n, colors: SCOL(), color: i => p.s[i], visible: i => okTime(i) && okHome(i) && okSec(i) && okOut(i) && okNb(i), r: NOLA.dotR, tip: dotTip });
    NOLA.heatToggle(plot, st.heat, on => set('heat', on), null);
    const cl = st.heat ? NOLA.classes(nbCnt) : null;
    m.setFill(cl ? i => cl.color(nbCnt[i]) : () => null);
    NOLA.heatKey(panel, plot, cl, keyLabel());
    if (m.lastNb !== st.nb) { m.focus(st.nb, first ? 0 : 450); m.lastNb = st.nb; }
  }
  function dotTip(i) {
    const p = P(), sec = SEC()[p.s[i]];
    const head = `<b>${esc(p.T[p.t[i]])}</b><div style="color:var(--ink2)">${sw(colorOf(sec))}${esc(nm(sec))}</div>`;
    if (isNew()) return head + (PA.a && PA.a[i] >= 0 ? NOLA.addrRow(PA, i) : '') + row('Filed', NOLA.isoDate(PA.iso(PA.day[i]))) + row('Status now', D.out[PA.o[i]]) + row('Neighborhood', nbName(PA.nb[i]));
    // licensed now: the business name as the title, its license type below (name and address withheld where it may be a home)
    const m = PW.m ? PW.m[i] : -1, type = `<div>${esc(PW.T[PW.t[i]])}</div>`;
    const top = (m >= 0 ? `<b>${esc(PW.M[m])}</b>${type}` : `<b>${esc(PW.T[PW.t[i]])}</b>`) + `<div style="color:var(--ink2)">${sw(colorOf(sec))}${esc(nm(sec))}</div>`;
    return top + (m === -2 ? row('Name and address', '<span style="color:var(--ink2)">Not shown: may be home-based</span>') : NOLA.addrRow(PW, i)) + row('Licensed since', PW.day[i] >= 0 ? NOLA.isoDate(PW.iso(PW.day[i])) : 'Not recorded') + row('Neighborhood', nbName(PW.nb[i]));
  }
  function mapTip(i) {
    return `<b>${GEO.nb[i].name}</b>` + row(isNew() ? 'Applications shown' : 'Businesses shown', fmt(nbCnt[i]));
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
    NOLA.flist(NOLA.fsec(panel, 'Sector', st.sec >= 0 ? ['Show all', () => set('sec', -1)] : null),
      D.S.map((s, k) => ({ key: k, name: nm(s), color: colorOf(s), count: d3.sum(data, d => d[k]) })), { pressed: k => st.sec === k, onClick: toggle('sec') });
    // home-based is recorded for the whole city only, without sectors, so it shows only when nothing is filtered
    if (st.nb < 0 && st.sec < 0) NOLA.kv(NOLA.fsec(panel, 'Home-based'), [['Yes', null, fmt(d3.sum(D.home, h => h[0]))], ['No', null, fmt(d3.sum(D.home, h => h[1]))]]);
    stacked(plot, data, D.S.map(colorOf), s => st.sec < 0 || s === st.sec, (yy, d, tot) => `<b>Filed in ${yy}${partialYear(yy) ? ', through ' + lastLabel : ''}</b>`
      + [st.sec >= 0 ? nm(D.S[st.sec]) : '', st.nb >= 0 ? nbName(st.nb) : ''].filter(Boolean).map(s => `<div style="color:var(--ink2)">${s}</div>`).join('') + row('Applications', fmt(tot))
      + (st.sec < 0 ? bySize(d).map(k => row(sw(colorOf(D.S[k])) + nm(D.S[k]), fmt(d[k]))).join('') : ''));
  }
  // a year's sectors, largest first; the catch-alls ("Other sectors", "Not stated") stay at the bottom
  function bySize(d) {
    const last = k => D.S[k] === 'Other sectors' ? 1 : D.S[k] === 'Not stated' ? 2 : 0;
    return D.S.map((s, k) => k).filter(k => d[k]).sort((a, b) => last(a) - last(b) || d[b] - d[a]);
  }
  function stacked(plot, data, colors, show, tipFor) {
    plot.innerHTML = '';
    const tot = d => d3.sum(d.filter((v, k) => show(k)));
    const f = NOLA.frame(plot, { h: 360, m: { t: 18, r: 10, b: 28, l: 44 } });
    const x = d3.scaleBand().domain(D.years).range([0, f.iw]).paddingInner(.22);
    const y = d3.scaleLinear().domain([0, Math.max(4, (d3.max(data, tot) || 0) * 1.05)]).range([f.ih, 0]).nice();
    NOLA.yGrid(f, y, 5, d3.format(',~d'));
    data.forEach((d, k) => { let y0 = 0; d.forEach((v, s) => { if (!v || !show(s)) return;
      f.g.append('rect').attr('x', x(D.years[k])).attr('width', x.bandwidth()).attr('y', y(y0 + v)).attr('height', Math.max(.5, y(y0) - y(y0 + v))).attr('fill', colors[s]).attr('opacity', partialYear(D.years[k]) ? .45 : 1); y0 += v; }); });
    data.forEach((d, k) => { if (partialYear(D.years[k]) && tot(d)) f.g.append('text').attr('class', 'halo').attr('x', x(D.years[k]) + x.bandwidth()).attr('y', y(tot(d)) - 5).attr('text-anchor', 'end').style('fill', 'var(--ink2)').text('to ' + lastLabel); });
    f.g.selectAll('rect.h').data(D.years).join('rect').attr('class', 'h').attr('x', yy => x(yy) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('height', f.ih).attr('fill', 'transparent')
      .on('mousemove', (ev, yy) => { const d = data[D.years.indexOf(yy)]; tip.show(tipFor(yy, d, tot(d)), ev); }).on('mouseleave', tip.hide);
    f.g.selectAll('text.x').data(D.years).join('text').attr('class', 'x').attr('x', yy => x(yy) + x.bandwidth() / 2).attr('y', f.ih + 18).attr('text-anchor', 'middle').text(yy => f.iw < 420 ? "'" + String(yy).slice(2) : yy);
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).attr('stroke', 'var(--axis)');
  }

  // ---------- current status of each year's applications ----------
  const outCounts = () => D.yo.map(per => D.out.map((o, j) => d3.sum(per.filter((v, s) => st.sec < 0 || s === st.sec), v => v[j])));
  function drawOut(pane, first) {
    const { panel, plot } = staged(pane, first);
    panel.innerHTML = '';
    const data = outCounts();
    // the bars are colored by status, so the sectors get a neutral swatch
    NOLA.flist(NOLA.fsec(panel, 'Sector', st.sec >= 0 ? ['Show all', () => set('sec', -1)] : null),
      D.S.map((s, k) => ({ key: k, name: nm(s), color: 'var(--ink2)', count: d3.sum(D.yr, d => d[k]) })), { pressed: k => st.sec === k, onClick: toggle('sec') });
    NOLA.kv(NOLA.fsec(panel, 'Current status'), D.out.map((o, j) => [o, OUT_C[j], d3.sum(data, d => d[j])]).filter(d => d[2]).map(d => [d[0], d[1], fmt(d[2])]));
    stacked(plot, data, OUT_C, () => true, (yy, d, tot) => `<b>Filed in ${yy}${partialYear(yy) ? ', through ' + lastLabel : ''}</b>` + (st.sec >= 0 ? `<div style="color:var(--ink2)">${nm(D.S[st.sec])}</div>` : '')
      + row('Applications', fmt(tot)) + D.out.map((o, j) => d[j] ? row(sw(OUT_C[j]) + o, fmt(d[j])) : '').join(''));
  }

  const V = NOLA.views([
    { id: 'map', label: mapLabel, tab: 'Map of businesses', keep: true, draw: drawMap,
      ds: () => st.measure === 'now' ? [D.ds[1], 'Occupational Business Licenses'] : [D.ds[0], 'Occupational Business License Data'] },
    { id: 'years', label: 'New business license applications per year', tab: 'Per year', draw: drawYears },
    { id: 'outcomes', label: 'License applications per year, by current status', tab: 'Status', draw: drawOut },
  ], { ds: [D.ds[0], 'Occupational Business License Data'],
       state: () => ({ measure: st.measure !== 'new' ? st.measure : null, sec: st.sec >= 0 ? st.sec : null, sec2: st.sec2 >= 0 ? st.sec2 : null, nb: st.nb >= 0 ? st.nb : null,
                       p: st.per !== '12' ? st.per : null, since: st.since !== 'all' ? st.since : null, out: st.out >= 0 ? st.out : null, home: st.home === 0 ? null : st.home < 0 ? 'all' : 1, heat: st.heat ? 1 : null }) });
})();
