"""Build the static pages from src/ templates + data/ snapshots.

    python build.py          -> site/*.html  (relative links, d3 from CDN; this is what GitHub Pages serves)
    python build.py preview  -> same, but d3 inlined from node_modules (for offline screenshots)
"""
import json, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(HERE, *a)
mode = sys.argv[1] if len(sys.argv) > 1 else 'site'
D3_CDN = '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>'
def d3_tag():
    if mode != 'preview': return D3_CDN
    p = P('node_modules', 'd3', 'dist', 'd3.min.js')
    if not os.path.exists(p): sys.exit('preview mode needs `npm i d3@7` in this folder')
    return '<script>' + open(p, encoding='utf-8').read() + '</script>'

PAGES = {'drone': ('NOPD drone flights', {'drone': 'drone.json'}),
         'cfs': ('Calls for service', {'cfs': 'cfs.json', 'hist': 'hist.json'}),
         'cpc': ('Planning cases', {'cpc': 'cpc.json'})}
TREES_URL = 'https://claude.ai/artifact/7EZEot1PFcKtp6mDzDMrFZ'  # TODO: replace with site/trees.html once ported

css = open(P('src', 'lib.css'), encoding='utf-8').read()
lib = open(P('src', 'lib.js'), encoding='utf-8').read()
geo = json.load(open(P('data', 'geo.json'), encoding='utf-8'))
os.makedirs(P('site'), exist_ok=True)
for key, (label, files) in PAGES.items():
    nav = ('<div class="site"><b><a href="index.html" style="color:inherit;text-decoration:none">NOLA Open Data, visualized</a></b><nav>'
           + ''.join(f'<a class="{"on" if k == key else ""}" href="{k}.html">{l}</a>' for k, (l, _) in PAGES.items())
           + f'<a href="{TREES_URL}">Street trees</a></nav></div>')
    data = {'geo': geo}
    for k, f in files.items(): data[k] = json.load(open(P('data', f), encoding='utf-8'))
    h = open(P('src', f'{key}.html'), encoding='utf-8').read()
    out = (h.replace('{{CSS}}', css).replace('{{NAV}}', nav)
            .replace('{{DATA}}', json.dumps(data, separators=(',', ':'), ensure_ascii=False))
            .replace('{{LIB}}', lib).replace('{{JS}}', open(P('src', f'{key}.js'), encoding='utf-8').read())
            .replace('{{D3}}', d3_tag()))
    open(P('site', f'{key}.html'), 'w', encoding='utf-8').write(out)
    print('built', key, len(out))
idx = open(P('src', 'index.html'), encoding='utf-8').read().replace('{{CSS}}', css).replace('{{TREES}}', TREES_URL)
open(P('site', 'index.html'), 'w', encoding='utf-8').write(idx)
print('built index')
