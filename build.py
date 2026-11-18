"""Build the static pages from src/ templates + data/ snapshots.

    python build.py          -> site/*.html  (relative links, d3 from CDN; this is what GitHub Pages serves)
    python build.py preview  -> same, but d3 inlined from node_modules (for offline screenshots)

Templates can use these placeholders, filled in at build time:
    {{CSS}} {{NAV}} {{DATA}} {{LIB}} {{JS}} {{D3}}
    {{PULLED}}      on a data page, the date that page's data last changed (data/sources.json), e.g. "Nov 18, 2026";
                    elsewhere the latest of those dates
    {{CFS_YEAR}} {{CFS_DS}} {{CFS_PREV}}   year, dataset id and previous year of the Calls for Service page
    {{DRONE_YEAR}}  year covered by the drone page
    {{DRONE_THRU}} {{CFS_THRU}} {{CPC_THRU}}   last day each page's data reaches, e.g. "Nov 5, 2026"
    {{MENU}}        home-page menu of every view on every page, read from each page's NOLA.views([...]) list
"""
import json, sys, os, re, html, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(HERE, *a)
mode = sys.argv[1] if len(sys.argv) > 1 else 'site'
D3_CDN = '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>'
def d3_tag():
    if mode != 'preview': return D3_CDN
    p = P('node_modules', 'd3', 'dist', 'd3.min.js')
    if not os.path.exists(p): sys.exit('preview mode needs `npm i d3@7` in this folder')
    return '<script>' + open(p, encoding='utf-8').read() + '</script>'
def load(f): return json.load(open(P('data', f), encoding='utf-8'))

PAGES = {'drone': ('NOPD drone flights', {'drone': 'drone.json'}),
         'cfs': ('Calls for service', {'cfs': 'cfs.json', 'hist': 'hist.json'}),
         'cpc': ('Planning cases', {'cpc': 'cpc.json'}),
         'trees': ('Street trees', {'trees': 'trees.json'})}
EXTRA = {'about': 'About'}

css = open(P('src', 'lib.css'), encoding='utf-8').read()
lib = open(P('src', 'lib.js'), encoding='utf-8').read()
geo = load('geo.json')
# Each page shows the date its own data last changed, from data/sources.json (written by pipeline/fetch.py).
# A page's HTML then only changes when its data does, so days without new City data commit nothing.
sources = load('sources.json').get('files', {}) if os.path.exists(P('data', 'sources.json')) else {}
def changed(names):
    ds = [sources[n]['changed'] for n in names if sources.get(n, {}).get('changed')]
    return dt.date.fromisoformat(max(ds)) if ds else None
page_date = {k: changed(['geo.json', *files.values()]) for k, (_, files) in PAGES.items()
             if all(f in sources for f in files.values())}  # trees.json isn't built by the pipeline, so trees gets no date
pulled = max(page_date.values(), default=None) or dt.date.fromisoformat(
    load('meta.json')['pulled'] if os.path.exists(P('data', 'meta.json')) else '2026-11-18')
cfs_meta, drone_meta = load('cfs.json'), load('drone.json')
cfs_year, drone_year = cfs_meta.get('year', 2026), drone_meta.get('year', 2026)
def fdate(d): return d.strftime('%b ') + str(d.day) + d.strftime(', %Y')
def central(utc):  # UTC datetime -> Central (DST: second Sunday in March to first Sunday in November, 2 a.m. local)
    y = utc.year
    sun = lambda m, n: dt.date(y, m, 1) + dt.timedelta(days=(6 - dt.date(y, m, 1).weekday()) % 7 + 7 * (n - 1))
    on, off = dt.datetime.combine(sun(3, 2), dt.time(8)), dt.datetime.combine(sun(11, 1), dt.time(7))
    return utc - dt.timedelta(hours=5 if on <= utc < off else 6)
# last day each page's data reaches, shown next to the pull date so a dataset the City stopped updating is visible
drone_last = max(central(dt.datetime(drone_year, 1, 1) + dt.timedelta(days=r[0], hours=r[1])) for r in drone_meta['recs']).date()
cfs_last = dt.date(cfs_year, 1, 1) + dt.timedelta(days=cfs_meta['last'])
cpc_last = dt.date.fromisoformat(load('cpc.json').get('lastFiled', pulled.isoformat())[:10])
TOKENS = {'{{PULLED}}': fdate(pulled),
          '{{DRONE_THRU}}': fdate(drone_last), '{{CFS_THRU}}': fdate(cfs_last), '{{CPC_THRU}}': fdate(cpc_last),
          '{{CFS_YEAR}}': str(cfs_year), '{{CFS_PREV}}': str(cfs_year - 1), '{{CFS_DS}}': cfs_meta.get('ds', 'es9j-6y5d'),
          '{{DRONE_YEAR}}': str(drone_year),
          '{{FOOT}}': '<div class="foot">Data: <a id="dataLink" href="https://data.nola.gov">data.nola.gov</a> · Not affiliated with the City of New Orleans · <a href="about.html">About</a></div>'}

# Header: the site name, then one "Visualizations" menu. It opens downward to the four pages; each page opens to the
# right with its views (read from src/<page>.js, like the home-page menu). Hover, keyboard (Tab / Escape) and tap all work.
NAV_JS = ('<script>(()=>{const dd=document.currentScript.closest(".site").querySelector(".dd"),b=dd.querySelector(".ddbtn");'
          'const set=o=>{dd.classList.toggle("open",o);b.setAttribute("aria-expanded",o)};'
          'b.onclick=e=>{e.stopPropagation();set(!dd.classList.contains("open"))};'
          'dd.querySelectorAll(".sub>a").forEach(a=>a.addEventListener("click",e=>{if(!matchMedia("(hover:hover)").matches){const li=a.parentNode;'
          'if(!li.classList.contains("open")){e.preventDefault();dd.querySelectorAll(".sub").forEach(x=>x.classList.toggle("open",x===li))}}}));'
          'document.addEventListener("click",e=>{if(!dd.contains(e.target))set(false)});'
          'dd.addEventListener("keydown",e=>{if(e.key==="Escape"){set(false);b.focus()}});addEventListener("hashchange",()=>set(false))})()</script>')
def nav(key):
    e = html.escape
    pages = ''.join(
        f'<li class="sub{" on" if k == key else ""}"><a href="{k}.html" aria-haspopup="true">{e(l)}<span aria-hidden="true">›</span></a>'
        f'<ul class="dd2">' + ''.join(f'<li><a href="{k}.html#{i}">{e(t)}</a></li>' for i, t in page_views(k)) + '</ul></li>'
        for k, (l, _) in PAGES.items())
    extra = ''.join(f'<a class="xlink{" on" if k == key else ""}" href="{k}.html">{e(l)}</a>' for k, l in EXTRA.items())
    return ('<div class="site"><b><a href="index.html" style="color:inherit;text-decoration:none">Nola Vizzes</a></b>'
            '<nav class="topnav" aria-label="Site"><div class="dd">'
            f'<button type="button" class="ddbtn{" on" if key in PAGES else ""}" aria-haspopup="true" aria-expanded="false">Visualizations<span aria-hidden="true">▾</span></button>'
            f'<ul class="dd1">{pages}</ul></div>{extra}</nav>' + NAV_JS + '</div>')

# The home-page menu lists every view of every page. It is read straight from the NOLA.views([...]) call in
# src/<page>.js (one `{ id: '...', label: '...', ... },` per line), so a new view shows up in the menu by itself.
VIEW_YEAR = {'cfs': cfs_year, 'drone': drone_year, 'cpc': pulled.year, 'trees': pulled.year}
def page_views(key):
    lines = open(P('src', f'{key}.js'), encoding='utf-8').read().split('NOLA.views([', 1)[1].split('\n')[1:]
    out = []
    for ln in lines:
        if not ln.strip().startswith('{'): break
        m = re.match(r"\s*\{\s*id:\s*'([\w-]+)',\s*label:\s*(['`])(.*?)\2", ln)
        if not m: sys.exit(f'build.py: cannot read the view on this line of src/{key}.js:\n{ln}')
        label = m[3].replace('${YEAR}', str(VIEW_YEAR[key]))
        if '${' in label: sys.exit(f'build.py: unknown placeholder in view label {label!r} (src/{key}.js)')
        out.append((m[1], label))
    if not out: sys.exit(f'build.py: no views found in src/{key}.js')
    return out
def menu():
    e = html.escape
    groups = ''.join(f'<section class="vgrp"><h2 class="eyebrow" id="vg-{k}">{e(l)}</h2><ul aria-labelledby="vg-{k}">'
                     + ''.join(f'<li><a href="{k}.html#{i}">{e(t)}</a></li>' for i, t in page_views(k)) + '</ul></section>'
                     for k, (l, _) in PAGES.items())
    extra = ''.join(f'<a href="{k}.html">{e(l)}</a>' for k, l in EXTRA.items())
    return f'<div class="vgrid">{groups}</div><div class="vextra">{extra}</div>'
TOKENS['{{MENU}}'] = menu()

# Street centerlines are shared by every map, so they go in one file the browser caches across pages.
STREETS_TAG = '<script src="streets.js"></script>'
if os.path.exists(P('data', 'streets.json')):
    streets_js = 'window.STREETS=' + json.dumps(load('streets.json'), separators=(',', ':')) + ';'
    os.makedirs(P('site'), exist_ok=True)
    open(P('site', 'streets.js'), 'w', encoding='utf-8').write(streets_js)
    if mode == 'preview': STREETS_TAG = '<script>' + streets_js + '</script>'
    print('built streets.js', len(streets_js))

def fill(h, key):
    h = h.replace('{{CSS}}', css).replace('{{NAV}}', nav(key)).replace('{{D3}}', d3_tag() + STREETS_TAG)
    h = h.replace('{{PULLED}}', fdate(page_date.get(key) or pulled))  # a data page shows when its own data last changed
    for k, v in TOKENS.items(): h = h.replace(k, v)
    return h

os.makedirs(P('site'), exist_ok=True)
for key, (label, files) in PAGES.items():
    h = open(P('src', f'{key}.html'), encoding='utf-8').read()
    if files:
        data = {'geo': geo}
        if key in page_date: data['meta'] = {'pulled': page_date[key].isoformat()}  # cpc.js reads this as "today"
        for k, f in files.items(): data[k] = load(f)
        js = open(P('src', f'{key}.js'), encoding='utf-8').read()
        # data/lib/js last, so placeholder-looking text inside the data is never touched
        h = fill(h, key)
        h = h.replace('{{LIB}}', lib).replace('{{JS}}', js).replace('{{DATA}}', json.dumps(data, separators=(',', ':'), ensure_ascii=False))
    else:
        h = fill(h, key)
    open(P('site', f'{key}.html'), 'w', encoding='utf-8').write(h)
    print('built', key, len(h))
for key in ['index', *EXTRA]:
    open(P('site', f'{key}.html'), 'w', encoding='utf-8').write(fill(open(P('src', f'{key}.html'), encoding='utf-8').read(), key))
    print('built', key)
