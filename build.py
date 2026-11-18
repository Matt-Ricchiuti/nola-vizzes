"""Build the static pages from src/ templates + data/ snapshots.

    python build.py          -> site/*.html  (relative links, d3 from CDN; this is what GitHub Pages serves)
    python build.py preview  -> same, but d3 inlined from node_modules (for offline screenshots)

Templates can use these placeholders, filled in at build time:
    {{CSS}} {{NAV}} {{DATA}} {{LIB}} {{JS}} {{D3}}
    {{PULLED}}      date the data was pulled, e.g. "Nov 18, 2026"
    {{CFS_YEAR}} {{CFS_DS}} {{CFS_PREV}}   year, dataset id and previous year of the Calls for Service page
    {{DRONE_YEAR}}  year covered by the drone page
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
meta = load('meta.json') if os.path.exists(P('data', 'meta.json')) else {'pulled': '2026-11-18'}
pulled = dt.date.fromisoformat(meta['pulled'])
cfs_meta, drone_meta = load('cfs.json'), load('drone.json')
cfs_year, drone_year = cfs_meta.get('year', 2026), drone_meta.get('year', 2026)
TOKENS = {'{{PULLED}}': pulled.strftime('%b ') + str(pulled.day) + pulled.strftime(', %Y'),
          '{{CFS_YEAR}}': str(cfs_year), '{{CFS_PREV}}': str(cfs_year - 1), '{{CFS_DS}}': cfs_meta.get('ds', 'es9j-6y5d'),
          '{{DRONE_YEAR}}': str(drone_year),
          '{{FOOT}}': '<div class="foot">Data: <a id="dataLink" href="https://data.nola.gov">data.nola.gov</a> · Not affiliated with the City of New Orleans · <a href="about.html">About</a></div>'}

def nav(key):
    return ('<div class="site"><b><a href="index.html" style="color:inherit;text-decoration:none">Nola Vizzes</a></b><nav>'
            + ''.join(f'<a class="{"on" if k == key else ""}" href="{k}.html">{l}</a>' for k, (l, _) in PAGES.items())
            + ''.join(f'<a class="{"on" if k == key else ""}" href="{k}.html">{l}</a>' for k, l in EXTRA.items())
            + '</nav></div>')

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
    for k, v in TOKENS.items(): h = h.replace(k, v)
    return h

os.makedirs(P('site'), exist_ok=True)
for key, (label, files) in PAGES.items():
    h = open(P('src', f'{key}.html'), encoding='utf-8').read()
    if files:
        data = {'geo': geo, 'meta': meta}
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
