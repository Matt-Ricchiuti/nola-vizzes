"""Build the static pages from src/ templates + data/ snapshots.

    python build.py          -> site/*.html  (relative links, d3 from CDN; this is what GitHub Pages serves)
    python build.py preview  -> same, but d3 inlined from node_modules (for offline screenshots)

Templates can use these placeholders, filled in at build time:
    {{CSS}} {{NAV}} {{DATA}} {{LIB}} {{JS}} {{D3}}
    {{CITY_UPDATED}} on a data page, the last day the City updated one of its datasets (data/sources.json), e.g. "Nov 18, 2026";
    {{PULLED}}      the newest date any page's data changed;
                    elsewhere the latest of those dates
    {{CFS_YEAR}} {{CFS_DS}} {{CFS_PREV}}   year, dataset id and previous year of the Calls for Service page
    {{DRONE_YEAR}}  year covered by the drone page
    {{DRONE_THRU}} {{CFS_THRU}} {{CPC_THRU}}   last day each page's data reaches, e.g. "Nov 5, 2026"
    {{MENU}}        home-page menu of the listed pages (PAGES minus UNLISTED)
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
def write(name, text):
    """Write site/<name> only when its content changed, so pages whose data didn't change keep their file as it was."""
    path = P('site', name)
    if os.path.exists(path) and open(path, encoding='utf-8').read() == text:
        return False
    open(path, 'w', encoding='utf-8').write(text)
    return True

PAGES = {'drone': ('NOPD drone flights', {'drone': 'drone.json'}),
         'cfs': ('Calls for service', {'cfs': 'cfs.json', 'hist': 'hist.json'}),
         'cpc': ('City Planning Cases', {'cpc': 'cpc.json'}),
         '311': ('311 Requests', {'sr': '311.json'}),
         'str': ('Short-Term Rentals (STRs)', {'str': 'str.json'}),
         'blight': ('Blight/Code-enforcement', {'ce': 'blight.json'}),
         'permits': ('Permits', {'permits': 'permits.json'}),
         'trees': ('Trees', {'trees': 'trees.json', 'treq': 'treereq.json'}),
         'drain': ('Drainage', {'dr': 'drainreq.json', 'cb': 'basins.json'}),
         # src/streets.js is this page's script (inlined into streets.html); site/streets.js is the shared street base map
         'streets': ('Streets', {'sq': 'streetreq.json', 'rw': 'roadwork.json'}),
         'land': ('Vacant Land', {'land': 'land.json'}),
         'biz': ('New Businesses', {'biz': 'biz.json'})}
EXTRA = {'about': 'About'}
# Pages still built (so old links keep working and they can come back) but left out of the header and home-page
# menus. Remove a key to list the page again.
UNLISTED = {'drone', 'cfs'}
listed = lambda: [(k, l) for k, (l, _) in PAGES.items() if k not in UNLISTED]

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
          '{{FOOT}}': '<div class="foot">Not affiliated with the City of New Orleans</div>'}

# Header: the site name, then one "Visualizations" menu that opens downward to the listed pages.
# Hover, keyboard (Tab / Escape) and tap all work.
NAV_JS = ('<script>(()=>{const dd=document.currentScript.closest(".site").querySelector(".dd"),b=dd.querySelector(".ddbtn");'
          'const set=o=>{dd.classList.toggle("open",o);b.setAttribute("aria-expanded",o)};'
          'b.onclick=e=>{e.stopPropagation();set(!dd.classList.contains("open"))};'
          'document.addEventListener("click",e=>{if(!dd.contains(e.target))set(false)});'
          'dd.addEventListener("keydown",e=>{if(e.key==="Escape"){set(false);b.focus()}})})()</script>')
def nav(key):
    e = html.escape
    cur = ' class="on" aria-current="page"'
    pages = ''.join(f'<li><a href="{k}.html"{cur if k == key else ""}>{e(l)}</a></li>' for k, l in listed())
    # About opens with the notes for the page it was clicked from already picked (about.html reads #from=)
    frm = f'#from={key}' if key in PAGES else ''
    extra = ''.join(f'<a class="xlink{" on" if k == key else ""}" href="{k}.html{frm if k == "about" else ""}">{e(l)}</a>' for k, l in EXTRA.items())
    return ('<div class="site"><b><a href="index.html" style="color:inherit;text-decoration:none">Nola Vizzes</a></b>'
            '<nav class="topnav" aria-label="Site"><div class="dd">'
            f'<button type="button" class="ddbtn{" on" if key in PAGES else ""}" aria-haspopup="true" aria-expanded="false">Visualizations<span aria-hidden="true">▾</span></button>'
            f'<ul class="dd1">{pages}</ul></div>{extra}</nav>' + NAV_JS + '</div>')

# The home-page menu lists the listed pages (the home page has no header, so its footer links About).
def menu():
    e = html.escape
    pages = ''.join(f'<li><a href="{k}.html">{e(l)}</a></li>' for k, l in listed())
    return f'<ul class="vlist">{pages}</ul>'   # About is linked in the footer
TOKENS['{{MENU}}'] = menu()
# last day each of the newer pages' data reaches (the file's 'last' field), e.g. {{SR_THRU}}
for tok, f in [('SR', '311.json'), ('STR', 'str.json'), ('CE', 'blight.json'), ('PERMIT', 'permits.json'), ('BIZ', 'biz.json')]:
    TOKENS['{{%s_THRU}}' % tok] = fdate(dt.date.fromisoformat(load(f)['last'][:10]))

# Street centerlines are shared by every map, so they go in one file the browser caches across pages.
STREETS_TAG = '<script src="streets.js"></script>'
if os.path.exists(P('data', 'streets.json')):
    streets_js = 'window.STREETS=' + json.dumps(load('streets.json'), separators=(',', ':')) + ';'
    os.makedirs(P('site'), exist_ok=True)
    if mode == 'preview': STREETS_TAG = '<script>' + streets_js + '</script>'
    print('built streets.js', len(streets_js), '' if write('streets.js', streets_js) else '(unchanged)')

# Data that rarely changes goes in its own file too, so a page whose other data changes daily (trees: the 311 tree
# requests) doesn't make every visitor download it again: data file -> (script, global it sets).
STATIC_DATA = {'trees.json': ('trees-data.js', 'TREES_DATA'), 'basins.json': ('basins-data.js', 'BASINS_DATA')}
static_tags = {}
for f, (js_name, var) in STATIC_DATA.items():
    if not os.path.exists(P('data', f)): continue
    body = f'window.{var}=' + json.dumps(load(f), separators=(',', ':'), ensure_ascii=False) + ';'
    static_tags[f] = '<script>' + body + '</script>' if mode == 'preview' else f'<script src="{js_name}"></script>'
    print('built', js_name, len(body), '' if write(js_name, body) else '(unchanged)')

# "City updated" on each data page: the newest time the City changed one of the page's own datasets on data.nola.gov
# (the times fetch.py saves in each file's key in data/sources.json), as a date in New Orleans. Not the neighborhood
# or street layers, and not when our copy or code changed.
CITY_TS = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d')
def city_updated(names):
    ts = [dt.datetime.fromisoformat(t) for n in names for t in CITY_TS.findall(sources.get(n, {}).get('key') or '')]
    return central(max(ts)).date() if ts else None
city_date = {k: city_updated(files.values()) for k, (_, files) in PAGES.items() if files}

# The sources box beside each data page's title lists the page's datasets, each with the date the City last updated
# it (data/sources.json 'versions', written by fetch.py; New Orleans time), e.g. "11/19/26".
VERSIONS = load('sources.json').get('versions', {}) if os.path.exists(P('data', 'sources.json')) else {}
STATIC_VERSIONS = {'3tyj-9x33': '2025-04-17T17:00:00Z'}   # the tree inventory isn't fetched daily; its City date
def short(d): return d.strftime('%m/%d/%y')
# A dataset the City reloads every night without new records shows where its records end instead of the reload date:
# the catch basin cleaning log (its newest dated record, from basins.json).
ENDS = {}
if os.path.exists(P('data', 'basins.json')):
    ENDS['2zer-6wpb'] = dt.date.fromisoformat(load('basins.json')['logLast'])
def ds_dates(h):
    def one(m):
        if m.group(2) in ENDS:
            return m.group(0) + f'<span class="upd" title="The newest record in the City\'s log">ends {short(ENDS[m.group(2)])}</span>'
        t = VERSIONS.get(m.group(2)) or STATIC_VERSIONS.get(m.group(2))
        d = short(central(dt.datetime.fromisoformat(t.replace('Z', '')))) if t else '—'
        return m.group(0) + f'<span class="upd" title="Last updated by the City">{d}</span>'
    return re.sub(r'<aside class="srcbox".*?</aside>', lambda b: re.sub(r'(<a href="https://data\.nola\.gov/d/([a-z0-9]{4}-[a-z0-9]{4})">[^<]*</a>)', one, b.group(0)), h, count=1, flags=re.S)

def fill(h, key, extra=''):
    h = h.replace('{{CSS}}', css).replace('{{NAV}}', nav(key)).replace('{{D3}}', d3_tag() + STREETS_TAG + extra)
    h = h.replace('{{CITY_UPDATED}}', short(city_date.get(key) or max(filter(None, city_date.values()), default=pulled)))
    for k, v in TOKENS.items(): h = h.replace(k, v)
    return ds_dates(h)

os.makedirs(P('site'), exist_ok=True)
for key, (label, files) in PAGES.items():
    h = open(P('src', f'{key}.html'), encoding='utf-8').read()
    if files:
        data = {'geo': geo}
        if key in page_date: data['meta'] = {'pulled': page_date[key].isoformat()}  # cpc.js reads this as "today"
        ext = {k: f for k, f in files.items() if f in static_tags}  # loaded from their own script (STATIC_DATA)
        for k, f in files.items():
            if k not in ext: data[k] = load(f)
        js = open(P('src', f'{key}.js'), encoding='utf-8').read()
        # data/lib/js last, so placeholder-looking text inside the data is never touched
        h = fill(h, key, ''.join(static_tags[f] for f in ext.values()))
        dj = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
        if ext: dj = 'Object.assign(' + dj + ',{' + ','.join(f'{json.dumps(k)}:window.{STATIC_DATA[f][1]}' for k, f in ext.items()) + '})'
        h = h.replace('{{LIB}}', lib).replace('{{JS}}', js).replace('{{DATA}}', dj)
    else:
        h = fill(h, key)
    print('built', key, len(h), '' if write(f'{key}.html', h) else '(unchanged)')
for key in ['index', *EXTRA]:
    print('built', key, '' if write(f'{key}.html', fill(open(P('src', f'{key}.html'), encoding='utf-8').read(), key)) else '(unchanged)')
