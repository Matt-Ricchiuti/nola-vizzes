"""Build the static pages from src/ templates + data/ snapshots.

    python build.py          -> site/*.html  (relative links, d3 from CDN; this is what GitHub Pages serves)
    python build.py preview  -> same, but d3 inlined from node_modules (for offline screenshots)

Templates can use these placeholders, filled in at build time:
    {{CSS}} {{NAV}} {{DATA}} {{LIB}} {{JS}} {{D3}}
    {{PULLED}}      date the data was pulled, e.g. "Nov 18, 2026"
    {{CFS_YEAR}} {{CFS_DS}} {{CFS_PREV}}   year, dataset id and previous year of the Calls for Service page
    {{DRONE_YEAR}}  year covered by the drone page
"""
import json, sys, os, datetime as dt
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
          '{{FOOT}}': '<div class="foot">Data: <a href="https://data.nola.gov">data.nola.gov</a> · Not affiliated with the City of New Orleans · <a href="about.html">About</a></div>'}

def nav(key):
    return ('<div class="site"><b><a href="index.html" style="color:inherit;text-decoration:none">NOLA Open Data, visualized</a></b><nav>'
            + ''.join(f'<a class="{"on" if k == key else ""}" href="{k}.html">{l}</a>' for k, (l, _) in PAGES.items())
            + ''.join(f'<a class="{"on" if k == key else ""}" href="{k}.html">{l}</a>' for k, l in EXTRA.items())
            + '</nav></div>')

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
