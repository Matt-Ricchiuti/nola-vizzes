"""Fetch data.nola.gov datasets and rebuild every data/*.json file.

    python pipeline/fetch.py                 # fetch what changed, validate, write data/, run build.py if anything changed
    python pipeline/fetch.py --no-build      # skip build.py
    python pipeline/fetch.py --cache DIR     # dev only: keep raw API responses in DIR and reuse them
    python pipeline/fetch.py --today 2026-11-18   # pretend it's this date (to compare with old snapshots)
    python pipeline/fetch.py --full          # download and rebuild everything, ignoring .cache/raw

The aggregation rules, and what each dataset costs, are documented in pipeline/REFERENCE.md.

Only what changed is downloaded and written. One request to the Socrata catalog returns every dataset's "last
updated" date (rowsUpdatedAt) and columns. Each data file records, in data/sources.json, the dataset versions it was
built from; if those are the same today, the file is kept as it is and nothing about it is downloaded or parsed.
Rebuilt files are written only when their content differs, so a day without new City data leaves data/ and site/
untouched and the workflow commits nothing.

.cache/raw/ (restored between runs by the workflow) keeps saved copies of the datasets the City updates in place
(311, Calls for Service), brought up to date with only the rows changed since the last run (see synced_rows), and
the API's answers to every other query, kept under the dataset's version (see Socrata) and reused until it changes.
On the 1st of each month the boundary layers and past years of Calls for Service are checked too, and each saved
copy's row ids are compared with the City's; a mismatch triggers a full download. --full ignores the cache.

Every rebuilt file is checked before it's written. If a fetch comes back empty, a column disappears, or a
count collapses compared with the last good file, that file keeps its last good version, the other files
still refresh, and the script reports the failure (exit code 1, or `failed=` in $GITHUB_OUTPUT so the
workflow can publish first and then fail the run). A failure in the shared boundaries stops everything.
The run also fails (`alerts=`) when a dataset's "last updated" date stands still far longer than usual (DATASETS),
or a saved copy had to be downloaded in full twice within a few days (the cache isn't being kept).

Set SOCRATA_APP_TOKEN in the environment to avoid API throttling.
"""
import argparse, csv, datetime as dt, gzip, hashlib, io, json, math, os, re, subprocess, sys, time
from collections import Counter, defaultdict

import numpy as np
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
RAW_CACHE = os.path.join(ROOT, '.cache', 'raw')
API = 'https://data.nola.gov'

# Calls for Service: one dataset per calendar year. New years are discovered from the catalog.
CFS_IDS = {2014: 'jsyu-nz5r', 2015: 'w68y-xmk6', 2016: 'wgrp-d3ma', 2017: 'bqmt-f3jk', 2018: '9san-ivhk',
           2019: 'qf6q-pp4b', 2020: 'hp7u-i9hf', 2021: '3pha-hum9', 2022: 'nci8-thrr', 2023: 'pc5d-tvaw',
           2024: '2zcj-b6ts', 2025: '4xwx-sfte', 2026: 'es9j-6y5d'}
CFS_TEXT_TIME_FROM = 2025  # from this year on, timecreate is a text column


class PipelineError(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise PipelineError(msg)


def warn(msg):
    """Shows up as a yellow warning on the GitHub Actions run, without failing it."""
    print(f'::warning::{msg}' if os.environ.get('GITHUB_ACTIONS') else f'WARNING: {msg}', flush=True)


# ---------------------------------------------------------------- HTTP
RESOURCE_RX = re.compile(r'^/resource/([a-z0-9]{4}-[a-z0-9]{4})\.')
ISO = '%Y-%m-%dT%H:%M:%SZ'


class Socrata:
    """data.nola.gov client.

    Versions. A dataset's version is its rowsUpdatedAt ("data last updated"). One request to the Discovery API
    catalog (`prefetch`) returns it, with the column names, for every dataset at once; it matches rowsUpdatedAt to
    the second (checked 2026-11-19 on all 20 catalogued datasets). Datasets the catalog doesn't list (the 2015
    boundary layers) fall back to their own metadata request.

    Response cache. A query on a dataset whose version is known is kept in RAW_CACHE/q/ under that version
    (GitHub Actions restores the folder between runs). While the City hasn't changed the dataset, the same query
    returns the same rows, so it's read from disk instead of the API. Queries are always ordered, so this is exact."""

    def __init__(self, cache=None, use_raw=True):
        self.s = requests.Session()
        tok = os.environ.get('SOCRATA_APP_TOKEN')
        if tok:
            self.s.headers['X-App-Token'] = tok
        self.s.headers['User-Agent'] = 'nola-vizzes-pipeline'
        self.s.headers['Accept-Encoding'] = 'gzip'
        self.cache = cache
        if cache:
            os.makedirs(cache, exist_ok=True)
        self.use_raw = use_raw
        self.metas = {}
        self.vers = {}       # ds -> version, from the catalog, a metadata request, or (for datasets checked monthly) sources.json
        self.cols = {}       # ds -> set of column field names
        self.n_req = self.n_bytes = self.n_wire = 0
        self.by_ds = defaultdict(lambda: [0, 0, 0])   # ds -> [requests, bytes, bytes over the wire]
        self.touched, self.queried = set(), set()    # response-cache files used this run, datasets queried this run
        self.hits = 0

    def get(self, path, params=None, kind='json', cache=True):
        dev = None
        if self.cache:
            dev = os.path.join(self.cache, hashlib.sha1((path + json.dumps(params, sort_keys=True)).encode()).hexdigest() + '.' + kind)
            if os.path.exists(dev):
                with open(dev, encoding='utf-8') as f:
                    return json.load(f) if kind != 'csv' else f.read()
        m = RESOURCE_RX.match(path)
        ds = m and m.group(1)
        qfn = None
        if ds:
            self.queried.add(ds)
            if cache and ds in self.vers:   # a full run (use_raw False) doesn't read saved answers, but saves them
                h = hashlib.sha1((path + json.dumps(params, sort_keys=True)).encode()).hexdigest()[:16]
                qfn = os.path.join(RAW_CACHE, 'q', f"{ds}-{h}-{self.vers[ds].replace(':', '')}.{kind}.gz")
                self.touched.add(os.path.basename(qfn))
                if self.use_raw and os.path.exists(qfn):
                    try:
                        with gzip.open(qfn, 'rt', encoding='utf-8') as f:
                            body = f.read()
                        self.hits += 1
                        return json.loads(body) if kind != 'csv' else body
                    except (OSError, EOFError, ValueError):
                        pass
        last = None
        for attempt in range(5):
            try:
                r = self.s.get(API + path, params=params, timeout=180, stream=True)
                raw = r.raw.read(decode_content=False)   # as transferred (gzip), to count it
                content = gzip.decompress(raw) if r.headers.get('Content-Encoding') == 'gzip' else raw
                self.n_req += 1
                self.n_bytes += len(content)
                self.n_wire += len(raw)
                st = self.by_ds[ds or ('catalog' if 'catalog' in path else 'metadata')]
                st[0] += 1; st[1] += len(content); st[2] += len(raw)
                if r.status_code == 200:
                    body = content.decode('utf-8')
                    if dev:
                        with open(dev, 'w', encoding='utf-8') as f:
                            f.write(body)
                    if qfn:
                        os.makedirs(os.path.dirname(qfn), exist_ok=True)
                        with gzip.open(qfn + '.tmp', 'wt', encoding='utf-8') as f:
                            f.write(body)
                        os.replace(qfn + '.tmp', qfn)
                    return json.loads(body) if kind != 'csv' else body
                last = f"HTTP {r.status_code}: {content.decode('utf-8', 'replace')[:300]}"
                if r.status_code in (400, 403, 404):
                    break
            except (requests.RequestException, OSError, EOFError) as e:   # includes a truncated gzip body
                last = repr(e)
            time.sleep(5 * (attempt + 1))
        raise PipelineError(f'GET {path} {params} failed: {last}')

    def prefetch(self, ids):
        """Versions and column names of many datasets in one catalog request. Datasets missing from the answer
        (or all of them, if the catalog fails) are looked up one by one when needed."""
        ids = sorted({i for i in ids if i and i not in self.vers})
        if not ids:
            return
        try:
            res = self.get('/api/catalog/v1', [('ids', i) for i in ids] + [('limit', len(ids))])
        except PipelineError as e:
            warn(f'catalog request failed, checking datasets one by one: {e}')
            return
        for r in res.get('results', []):
            x = r.get('resource') or {}
            t = x.get('data_updated_at')
            if x.get('id') in ids and t and x.get('columns_field_name'):
                self.vers[x['id']] = dt.datetime.fromisoformat(t.replace('Z', '+00:00')).astimezone(dt.timezone.utc).strftime(ISO)
                self.cols[x['id']] = set(x['columns_field_name'])

    def meta(self, ds):
        """Dataset metadata (schema and rowsUpdatedAt), fetched once per run, for datasets the catalog doesn't list."""
        if ds not in self.metas:
            self.metas[ds] = self.get(f'/api/views/{ds}.json')
        return self.metas[ds]

    def version(self, ds):
        """When the City last loaded rows into the dataset, as 'YYYY-MM-DDTHH:MM:SSZ'. Changes whenever its data may have."""
        if ds not in self.vers:
            t = self.meta(ds).get('rowsUpdatedAt')
            need(t, f'{ds}: metadata has no rowsUpdatedAt')
            self.vers[ds] = dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime(ISO)
        return self.vers[ds]

    def columns(self, ds):
        if ds not in self.cols:
            self.cols[ds] = {c['fieldName'] for c in self.meta(ds)['columns']}
        return self.cols[ds]

    def require_columns(self, ds, cols, label):
        have = self.columns(ds)
        missing = [c for c in cols if c not in have]
        need(not missing, f'{label} ({ds}): columns missing from the dataset: {missing}. The schema changed.')
        return have

    def tidy_cache(self):
        """Drop cached responses this run replaced: those of datasets queried this run that weren't used.
        Responses of datasets not queried today stay, for the day they're needed again."""
        qdir = os.path.join(RAW_CACHE, 'q')
        if os.path.isdir(qdir):
            for fn in os.listdir(qdir):
                if fn[:9] in self.queried and fn not in self.touched:
                    os.remove(os.path.join(qdir, fn))
        if os.path.isdir(RAW_CACHE):   # whole downloads kept by older versions of this script
            for fn in os.listdir(RAW_CACHE):
                if re.match(r'^[a-z0-9]{4}-[a-z0-9]{4}-\d{4}-\d\d-\d\dT\d{6}Z\.(geo)?json$', fn):
                    os.remove(os.path.join(RAW_CACHE, fn))


# ---------------------------------------------------------------- helpers
def js_round(v, nd=0):
    """Math.round semantics (half up), optionally to nd decimals."""
    m = 10 ** nd
    r = math.floor(v * m + 0.5) / m
    return int(r) if nd == 0 else r


def num(v):
    """JSON-friendly number: 13.0 -> 13 (matches what the browser wrote)."""
    if v is None:
        return None
    return int(v) if float(v).is_integer() else v


def quantile(vals, q):
    """sorted(vals)[floor(n * q)] (no interpolation, as in the original snapshot), rounded to 0.1.
    None when fewer than 15 values."""
    if len(vals) < 15:
        return None
    return num(js_round(sorted(vals)[int(len(vals) * q)], 1))


def median(vals):
    return quantile(vals, 0.5)


def p90(vals):
    return quantile(vals, 0.9)


def X(lon):
    return js_round((lon + 90.14) * 96600 / 20)


def Y(lat):
    return js_round((30.20 - lat) * 111000 / 20)


def parse_ts(s):
    """'2026-01-01T02:07:41.537000' or '2026-01-01T02:07:41.537' -> datetime (naive)."""
    if not s:
        return None
    s = s.strip()
    try:
        return dt.datetime.fromisoformat(s[:26])
    except ValueError:
        try:
            return dt.datetime.fromisoformat(s[:19])
        except ValueError:
            return None


def fnum(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- geography
def douglas_peucker(pts, tol):
    if len(pts) < 3:
        return pts[:]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = math.hypot(px - ax, py - ay) if L == 0 else abs(dy * px - dx * py + bx * ay - by * ax) / L
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def encode_ring(ring):
    mid = len(ring) // 2
    s = douglas_peucker(ring[:mid + 1], 0.0003) + douglas_peucker(ring[mid:], 0.0003)[1:]
    q = []
    for lon, lat in s:
        p = (X(lon), Y(lat))
        if not q or q[-1] != p:
            q.append(p)
    if len(q) < 4:
        return None
    out, px, py = [], 0, 0
    for x, y in q:
        out += [x - px, y - py]
        px, py = x, y
    return out


class Polys:
    """Point-in-polygon lookup against unsimplified lon/lat geometry (even-odd over all rings of a feature)."""

    def __init__(self, features):
        self.f = []
        for ft in features:
            rings = [np.asarray(r, dtype=float) for poly in ft['geometry']['coordinates'] for r in poly]
            allp = np.vstack(rings)
            self.f.append((allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max(), rings))

    def lookup(self, lon, lat):
        lon = np.asarray(lon, dtype=float)
        lat = np.asarray(lat, dtype=float)
        out = np.full(len(lon), -1, dtype=int)
        for idx, (x0, y0, x1, y1, rings) in enumerate(self.f):
            cand = np.where((out < 0) & (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1))[0]
            if not len(cand):
                continue
            px, py = lon[cand], lat[cand]
            inside = np.zeros(len(cand), dtype=bool)
            for r in rings:
                xi, yi = r[:, 0], r[:, 1]
                xj, yj = np.roll(xi, 1), np.roll(yi, 1)
                for k in range(len(r)):
                    c = ((yi[k] > py) != (yj[k] > py)) & (px < (xj[k] - xi[k]) * (py - yi[k]) / ((yj[k] - yi[k]) or 1e-300) + xi[k])
                    inside ^= c
            out[cand[inside]] = idx
        return out


def keep_order(fc, name, prev):
    """Put features in the same order as the last good geo.json. Every nb/pd index in the other data files,
    including the hand-built trees.json, is a position in that order, and the API doesn't promise one."""
    if not prev or sorted(prev) != sorted(f['properties'].get(name) for f in fc['features']):
        return
    pos = {n: i for i, n in enumerate(prev)}
    fc['features'].sort(key=lambda f: pos[f['properties'][name]])


NB_DS, PD_DS, POP_DS = '7fw3-kdpf', 'evki-aju8', '2w4d-xaw2'   # neighborhoods, police districts, 2020 population


def build_geo(api, prev=None):
    nbg = api.get(f'/resource/{NB_DS}.geojson', kind='geojson')
    pdg = api.get(f'/resource/{PD_DS}.geojson', kind='geojson')
    need(len(nbg.get('features', [])) == 72, f"neighborhoods: expected 72 features, got {len(nbg.get('features', []))}")
    need(len(pdg.get('features', [])) == 8, f"police districts: expected 8 features, got {len(pdg.get('features', []))}")
    keep_order(nbg, 'gnocdc_lab', prev and [f['n'] for f in prev['nb']])
    keep_order(pdg, 'district', prev and [f['n'] for f in prev['pd']])

    def enc(fc, name):
        out = []
        for ft in fc['features']:
            need(name in ft['properties'], f'boundary layer is missing the {name} field')
            rings = [e for poly in ft['geometry']['coordinates'] for r in poly for e in [encode_ring(r)] if e]
            out.append({'n': ft['properties'][name], 'r': rings})
        return out

    geo = {'nb': enc(nbg, 'gnocdc_lab'), 'pd': enc(pdg, 'district')}
    return geo, Polys(nbg['features']), Polys(pdg['features'])


POP_ALIAS = {'FILMORE': 'FILLMORE', 'MARLYVILLE - FONTAINEBLEAU': 'MARLYVILLE - FONTAINBLEAU'}  # population table spelling -> boundary spelling


def add_population(api, geo):
    """2020 Census population and housing units per neighborhood (2w4d-xaw2, sum_pop100 and sum_hu100), stored as
    geo['pop'] and geo['hu'] in neighborhood order."""
    api.require_columns(POP_DS, ['gnocdc_lab', 'sum_pop100', 'sum_hu100'], 'Neighborhood demographics 2020')
    rows = api.get(f'/resource/{POP_DS}.json', {'$select': 'gnocdc_lab,sum_pop100,sum_hu100', '$order': ':id', '$limit': 500})
    def col(c):
        return {POP_ALIAS.get(r['gnocdc_lab'], r['gnocdc_lab']): int(float(r[c])) for r in rows if r.get('gnocdc_lab') and r.get(c)}
    pop, hu = col('sum_pop100'), col('sum_hu100')
    missing = [f['n'] for f in geo['nb'] if f['n'] not in pop or f['n'] not in hu]
    need(not missing, f'Neighborhood population: no 2020 count for {missing}. Add the spelling to POP_ALIAS.')
    geo['pop'] = [pop[f['n']] for f in geo['nb']]
    geo['hu'] = [hu[f['n']] for f in geo['nb']]
    need(300000 < sum(geo['pop']) < 450000, f"Neighborhood population: total {sum(geo['pop'])} looks wrong")
    need(150000 < sum(geo['hu']) < 250000, f"Neighborhood housing units: total {sum(geo['hu'])} looks wrong")


STREET_TIER = {'Freeway': 0, 'Ramp': 1, 'Major Arterial': 2, 'Minor Arterial': 2, 'Local': 3}
STREET_Q = 4  # street coordinates are stored at 4x the map grid (about 5 m) so they stay sharp when zoomed in


def build_streets(api):
    """Street centerlines (22q2-dqpb) as one SVG path per tier: 0 freeway, 1 ramp, 2 arterial, 3 local.
    Coordinates are the shared X/Y projection times STREET_Q; pages draw them with scale(1/q)."""
    api.require_columns('22q2-dqpb', ['the_geom', 'roadclass', 'inwater', 'fullnameabv'], 'Centerline')
    # ordered, so the same streets always build the same file
    g = api.get('/resource/22q2-dqpb.geojson', {'$select': 'the_geom,roadclass,inwater,fullnameabv', '$order': ':id', '$limit': 100000}, kind='geojson')
    feats = g.get('features', [])
    need(len(feats) > 20000, f'Centerline: only {len(feats)} street segments')
    d, n = ['', '', '', ''], 0
    for f in feats:
        p = f.get('properties') or {}
        t = STREET_TIER.get(p.get('roadclass'))
        if t is None or p.get('inwater') == 'Yes' or not f.get('geometry'):
            continue
        lines = f['geometry']['coordinates'] if f['geometry']['type'] == 'MultiLineString' else [f['geometry']['coordinates']]
        for line in lines:
            q = []
            for lon, lat in douglas_peucker(line, 0.00003):
                xy = (js_round((lon + 90.14) * 96600 / 20 * STREET_Q), js_round((30.20 - lat) * 111000 / 20 * STREET_Q))
                if not q or q[-1] != xy:
                    q.append(xy)
            if len(q) < 2:
                continue
            d[t] += 'M%d %d' % q[0] + 'l' + ' '.join('%d %d' % (b[0] - a[0], b[1] - a[1]) for a, b in zip(q, q[1:]))
            n += 1
    need(n > 20000 and all(d), f'Centerline: only {n} usable segments, or a road class is missing')
    return {'q': STREET_Q, 'd': d, 'n': n, 'lab': street_labels(feats)}


def street_labels(feats):
    """Where street names can go: the City's centerline comes in block-length pieces, so join each street's pieces
    into nearly straight runs, then put an anchor at the middle of every ~60-unit (1.2 km) stretch.
    Returns {'names': [...], 'a': [x, y, angleDeg, halfLength, nameIndex, tier, ...]} with x, y, halfLength in map
    units x STREET_Q and tier 0 freeway, 1 arterial, 2 local."""
    LT = {'Freeway': 0, 'Major Arterial': 1, 'Minor Arterial': 1, 'Local': 2}
    segs = defaultdict(list)  # (name, tier) -> list of polylines in map units
    for f in feats:
        p = f.get('properties') or {}
        t, name = LT.get(p.get('roadclass')), (p.get('fullnameabv') or '').strip()
        if t is None or not name or p.get('inwater') == 'Yes' or not f.get('geometry'):
            continue
        lines = f['geometry']['coordinates'] if f['geometry']['type'] == 'MultiLineString' else [f['geometry']['coordinates']]
        for line in lines:
            pts = [((lon + 90.14) * 4830, (30.20 - lat) * 5550) for lon, lat in line]
            if len(pts) >= 2:
                segs[(name, t)].append(pts)
    ang = lambda a, b: math.atan2(b[1] - a[1], b[0] - a[0])
    def turn(a1, a2):
        d = abs(a1 - a2) % (2 * math.pi)
        return min(d, 2 * math.pi - d)
    key = lambda p: (round(p[0] * 2), round(p[1] * 2))
    names, out = [], []
    for (name, t), lines in segs.items():
        ends = defaultdict(list)
        for i, l in enumerate(lines):
            ends[key(l[0])].append(i); ends[key(l[-1])].append(i)
        used = [False] * len(lines)
        def grow(chain, forward):
            while True:
                tip = chain[-1] if forward else chain[0]
                prev = chain[-2] if forward else chain[1]
                nxt = None
                for j in ends[key(tip)]:
                    if used[j]:
                        continue
                    l = lines[j] if key(lines[j][0]) == key(tip) else lines[j][::-1]
                    a_in, a_out = ang(prev, tip) if forward else ang(tip, prev), ang(l[0], l[1]) if forward else ang(l[1], l[0])
                    if turn(a_in, a_out) < math.radians(28):
                        nxt = (j, l); break
                if not nxt:
                    return chain
                used[nxt[0]] = True
                chain = chain + nxt[1][1:] if forward else nxt[1][::-1][:-1] + chain
        for i, l in enumerate(lines):
            if used[i]:
                continue
            used[i] = True
            chain = grow(grow(list(l), True), False)
            # cut the run into stretches of ~60 units and anchor each one at its middle
            seglen = [math.dist(chain[k], chain[k + 1]) for k in range(len(chain) - 1)]
            total = sum(seglen)
            if total < 5:  # about one block
                continue
            pieces = max(1, round(total / 60))
            step = total / pieces
            if name not in names:
                names.append(name)
            ni = names.index(name)
            for pc in range(pieces):
                target, acc = (pc + 0.5) * step, 0.0
                for k, L in enumerate(seglen):
                    if acc + L >= target and L > 0:
                        f_ = (target - acc) / L
                        x = chain[k][0] + f_ * (chain[k + 1][0] - chain[k][0]); y = chain[k][1] + f_ * (chain[k + 1][1] - chain[k][1])
                        a = math.degrees(ang(chain[k], chain[k + 1]))
                        a = a - 180 if a > 90 else a + 180 if a < -90 else a  # keep text upright
                        out += [js_round(x * STREET_Q), js_round(y * STREET_Q), js_round(a), js_round(step / 2 * STREET_Q), ni, t]
                        break
                    acc += L
    return {'names': names, 'a': out}


# ---------------------------------------------------------------- drone flights
DRONE_RULES = [
    (6, r'barricade|bourbon'),
    (5, r'warrant|narcotic|surveil|atf|swat|tactical|shoot house|drug|arrest'),
    (3, r'reconstruction|photogrammetry|crash|accident'),
    (4, r'search & rescue|rescue|missing'),
    (1, r'overwatch|over watch|parade|event'),
    (0, r'dispatch|call for service|carjack'),
    (2, r'train|test|demo|non-operational|maint'),
]
DRONE_EVENTS = [(1, r'mardi'), (2, r'french quarter fest'), (3, r'jazz'), (4, r'essence'), (5, r'saints|nfl'),
                (6, r'super sunday|second line'), (7, r'decadence'), (8, r'takeover')]


def classify(text, rules):
    t = text.lower()
    for code, rx in rules:
        if re.search(rx, t):
            return code
    return None


def build_drone(api, nbp, year):
    ds = 'ay9z-ynxz'
    api.require_columns(ds, ['serial', 'longitude', 'latitude', 'takeoff_datetime', 'total_flight_time',
                             'deployment_purpose', 'activity_summary'], 'Drone flights')
    rows = api.get(f'/resource/{ds}.json', {
        '$select': 'serial,longitude,latitude,takeoff_datetime,total_flight_time,deployment_purpose,activity_summary',
        '$where': f"takeoff_datetime >= '{year}-01-01T00:00:00' AND takeoff_datetime < '{year + 1}-01-01T00:00:00'",
        '$order': 'takeoff_datetime,:id', '$limit': 50000})  # :id breaks ties, so the same flights always build the same file
    need(len(rows) > 0, f'Drone flights: 0 rows for {year}')
    jan1 = dt.date(year, 1, 1)
    drones = sorted({(r.get('serial') or '').replace('SkydioX10-', '') for r in rows})
    lon = [fnum(r.get('longitude')) for r in rows]
    lat = [fnum(r.get('latitude')) for r in rows]
    has = [a is not None and b is not None for a, b in zip(lon, lat)]
    nbs = nbp.lookup([a if h else 0 for a, h in zip(lon, has)], [b if h else 0 for b, h in zip(lat, has)])
    recs, missing, inferred, unknown = [], 0, 0, 0
    for i, r in enumerate(rows):
        t = parse_ts(r.get('takeoff_datetime'))
        need(t is not None, f"Drone flights: unreadable takeoff_datetime {r.get('takeoff_datetime')!r}")
        purpose = (r.get('deployment_purpose') or '').strip()
        summary = (r.get('activity_summary') or '').strip()
        inf = 0
        if purpose:
            cat = classify(purpose, DRONE_RULES)
            cat = 7 if cat is None else cat
        else:
            missing += 1
            cat = classify(summary, DRONE_RULES) if summary else None
            if cat is None:
                cat = 8
                unknown += 1
            else:
                inf = 1
                inferred += 1
        ev = classify(purpose + ' ' + summary, DRONE_EVENTS) or 0
        x, y = (X(lon[i]), Y(lat[i])) if has[i] else (0, 0)
        # hour to the minute (4 decimals), so a takeoff at 10:58 stays in the 10 a.m. hour
        recs.append([(t.date() - jan1).days, num(js_round(t.hour + t.minute / 60, 4)), num(fnum(r.get('total_flight_time')) or 0), cat,
                     drones.index((r.get('serial') or '').replace('SkydioX10-', '')),
                     int(nbs[i]) if has[i] else -1, x, y, ev, inf])
    return {'year': year, 'drones': drones, 'missingPurpose': missing, 'inferred': inferred, 'unknown': unknown, 'recs': recs}


# ---------------------------------------------------------------- calls for service
FOUND_IDS = {}  # year -> id found in the catalog on an earlier run (kept in data/sources.json)


def cfs_dataset_id(api, year):
    if year in CFS_IDS:
        return CFS_IDS[year]
    if year in FOUND_IDS:
        return FOUND_IDS[year]
    res = api.get('/api/catalog/v1', {'domains': 'data.nola.gov', 'q': f'calls for service {year}', 'only': 'dataset', 'limit': 50})
    for r in res.get('results', []):
        name = r['resource']['name'].strip().lower()
        if name == f'calls for service {year}':
            FOUND_IDS[year] = r['resource']['id']
            return FOUND_IDS[year]
    return None


def resp_minutes(create, arrive):
    if create is None or arrive is None:
        return None
    m = (arrive - create).total_seconds() / 60
    return m if 0 <= m < 1440 else None


def cfs_rows(api, ds, cols, total):
    """This year's call rows, kept as a saved copy and downloaded incrementally (see synced_rows). The City updates
    the dataset in place every night: a few thousand of ~300,000 rows change."""
    rows, _ = synced_rows(api, ds, cols, None, 'Calls for Service', total, fn=f'cfs-{ds}.csv.gz')
    for old in os.listdir(RAW_CACHE):
        if old.startswith('cfs-') and old != f'cfs-{ds}.csv.gz':
            os.remove(os.path.join(RAW_CACHE, old))  # last year's copy
    return rows


def build_cfs(api, nbp, pdp, geo, year, ds):
    cols = ['timecreate', 'timearrive', 'typetext', 'priority', 'selfinitiated', 'dispositiontext', 'location']
    api.require_columns(ds, cols, f'Calls for Service {year}')
    total = int(api.get(f'/resource/{ds}.json', {'$select': 'count(*) as n'})[0]['n'])
    need(total > 0, f'Calls for Service {year} ({ds}): 0 rows')
    rows = cfs_rows(api, ds, cols, total)

    jan1 = dt.datetime(year, 1, 1)
    n = len(rows)
    # times are compared at whole-second precision, as in the original snapshot
    tc = [parse_ts((r['timecreate'] or '')[:19]) for r in rows]
    bad = sum(t is None for t in tc)
    need(bad < n * 0.001, f'Calls for Service: {bad} rows with unreadable timecreate')
    keep = [i for i in range(n) if tc[i] is not None and tc[i].year == year]
    rows = [rows[i] for i in keep]
    tc = [tc[i] for i in keep]
    n = len(rows)
    selfi = [r['selfinitiated'] == 'Y' for r in rows]
    types = [r['typetext'] for r in rows]
    pri = [(r['priority'] or ' ')[0] for r in rows]
    disp = [r['dispositiontext'] for r in rows]
    resp = [None if selfi[i] else resp_minutes(tc[i], parse_ts((rows[i]['timearrive'] or '')[:19])) for i in range(n)]
    doy = [(t - jan1).days for t in tc]

    # location -> neighborhood, district
    lon = np.zeros(n)
    lat = np.zeros(n)
    valid = np.zeros(n, dtype=bool)
    rx = re.compile(r'POINT \(([-\d.]+) ([-\d.]+)\)')
    for i, r in enumerate(rows):
        m = rx.match(r['location'] or '')
        if m:
            a, b = float(m.group(1)), float(m.group(2))
            if a < -89.5 and b > 29.8:
                lon[i], lat[i], valid[i] = a, b, True
    nbi = nbp.lookup(lon, lat)
    pdi = pdp.lookup(lon, lat)
    nbi[~valid] = -1
    pdi[~valid] = -1

    # rankings break ties by name, so the result doesn't depend on the order rows arrive in (see cfs_rows)
    TOP = [t for t, _ in sorted(Counter(types).items(), key=lambda kv: (-kv[1], kv[0]))[:24]]
    tix = {t: k for k, t in enumerate(TOP)}
    last = max(doy)
    daily = [[0, 0] for _ in range(last + 1)]
    heat = [[0] * 24 for _ in range(7)]
    for i in range(n):
        daily[doy[i]][1 if selfi[i] else 0] += 1
        if not selfi[i]:
            heat[(tc[i].weekday() + 1) % 7][tc[i].hour] += 1

    ty = []
    for k, t in enumerate(TOP):
        idx = [i for i in range(n) if types[i] == t]
        rs = [resp[i] for i in idx if resp[i] is not None]
        pc = [0, 0, 0, 0]
        for i in idx:
            if pri[i] in '0123':
                pc[int(pri[i])] += 1
        ty.append([len(idx), sum(selfi[i] for i in idx), median(rs), p90(rs),
                   sum(disp[i] == 'GONE ON ARRIVAL' for i in idx), sum(disp[i] == 'REPORT TO FOLLOW' for i in idx), pc])

    def area_stats(groups, nfeat):
        acc = [{'pub': 0, 'self': 0, 'r2': [], 'r1': [], 't': [0] * 24} for _ in range(nfeat)]
        for i in range(n):
            g = groups[i]
            if g < 0:
                continue
            a = acc[g]
            if selfi[i]:
                a['self'] += 1
            else:
                a['pub'] += 1
                if resp[i] is not None:
                    if pri[i] == '2':
                        a['r2'].append(resp[i])
                    elif pri[i] == '1':
                        a['r1'].append(resp[i])
            if types[i] in tix:
                a['t'][tix[types[i]]] += 1
        return acc

    nb = [[a['pub'], a['self'], median(a['r2']), median(a['r1']), len(a['r2']), a['t']] for a in area_stats(nbi, len(geo['nb']))]
    pd = [[f['n'], a['pub'], a['self'], median(a['r2']), p90(a['r2']), median(a['r1']), len(a['r2'])]
          for f, a in zip(geo['pd'], area_stats(pdi, len(geo['pd'])))]
    mr = [[[], []] for _ in range(12)]
    for i in range(n):
        if resp[i] is not None and pri[i] in '21':
            mr[tc[i].month - 1][0 if pri[i] == '2' else 1].append(resp[i])
    mResp = [[median(a), median(b)] for a, b in mr]
    hist_months = [[0, 0] for _ in range(tc and max(t.month for t in tc) or 0)]
    for i in range(n):
        hist_months[tc[i].month - 1][1 if selfi[i] else 0] += 1
    out = {'year': year, 'ds': ds, 'TOP': TOP, 'last': last, 'daily': daily, 'heat': heat, 'types': ty, 'nb': nb, 'pd': pd, 'mResp': mResp,
           'disp': [[k, v] for k, v in sorted(Counter(disp).items(), key=lambda kv: (-kv[1], kv[0] or ''))[:8]],
           'noLoc': int((~valid).sum()), 'outside': int((valid & (nbi < 0)).sum())}
    return out, hist_months


def hist_year(api, year):
    """Monthly [public, self] counts for one past year."""
    ds = cfs_dataset_id(api, year)
    need(ds, f'no Calls for Service dataset found for {year}')
    out = [[0, 0] for _ in range(12)]
    if year < CFS_TEXT_TIME_FROM:
        rows = api.get(f'/resource/{ds}.json', {'$select': 'date_trunc_ym(timecreate) as m,selfinitiated,count(*) as n',
                                                '$group': 'm,selfinitiated', '$limit': 1000})
        for r in rows:
            m = parse_ts(r.get('m'))
            if m and m.year == year:
                out[m.month - 1][1 if r.get('selfinitiated') == 'Y' else 0] += int(r['n'])
    else:
        for mo in range(12):
            a = f'{year}-{mo + 1:02d}-01'
            b = f'{year + (mo == 11)}-{(mo + 1) % 12 + 1:02d}-01'
            rows = api.get(f'/resource/{ds}.json', {'$select': 'selfinitiated,count(*) as n',
                                                    '$where': f"timecreate>='{a}' AND timecreate<'{b}'", '$group': 'selfinitiated'})
            for r in rows:
                out[mo][1 if r.get('selfinitiated') == 'Y' else 0] += int(r['n'])
    need(sum(map(sum, out)) > 0, f'Calls for Service {year}: monthly history came back empty')
    return out


# ---------------------------------------------------------------- planning cases
CPC_TYP = ['Variance', 'Minor Subdivision', 'NPP Notification', 'Design Review', 'Conditional Use', 'Zoning Change',
           'Text Amendment', 'Appeal', 'Major Subdivision', 'Master Plan Amendment', 'Other']
CPC_TH = ['Short-term rentals', 'Hotels & guest houses', 'Alcohol sales / bars', 'Multi-family housing', 'Restaurants',
          'Demolition', 'Child care & schools']
CPC_TH_RX = [re.compile(p, re.I) for p in [r'short[- ]term rental|\bstr\b', r'hotel|guest ?house|bed (and|&) breakfast|\bb&b\b',
                                           r'alcohol|liquor|\bbar\b|lounge|tavern', r'multi-?family|apartment|dwelling units|\d+[- ]unit',
                                           r'restaurant', r'demoli', r'day ?care|child ?care|school']]


def cpc_desc(s):
    """A hearing's description for the agenda, without the docket number or the applicant: applicants are often
    private people, and the site names no private person."""
    s = re.sub(r'\s+', ' ', s or '').strip()
    s = re.sub(r'^Zoning Docket \S+\s*', '', s)
    if s.startswith('Applicant'):
        m = re.search(r'Request:', s)
        s = s[m.start():] if m else ''
    return re.sub(r'^Request:\s*', '', s)[:170]


def cpc_type(ct):
    ct = ct or ''
    for idx, s in [(5, 'Zoning Change'), (9, 'Master Plan'), (6, 'Text Amendment'), (8, 'Major Subdivision'), (4, 'Conditional Use')]:
        if s in ct:
            return idx
    if ct.startswith('NPP'):
        return 2
    if 'Appeal' in ct:
        return 7
    if 'Design Review' in ct or 'Stormwater' in ct:
        return 3
    if 'Variance' in ct:
        return 0
    if 'Minor Subdivision' in ct:
        return 1
    return 10


def build_cpc(api, nbp, today):
    ds = 'xxb5-5azv'
    cols = ['case_type', 'case_num', 'address', 'filing_date', 'current_status', 'open_closed', 'previous_meeting_status',
            'next_meeting', 'next_meeting_date', 'description', 'longitude', 'latitude']
    api.require_columns(ds, cols, 'CPC Projects')
    rows = []
    while True:
        page = api.get(f'/resource/{ds}.json', {'$select': ','.join(cols), '$order': ':id', '$limit': 50000, '$offset': len(rows)})
        rows += page
        if len(page) < 50000:
            break
    need(len(rows) > 0, 'CPC Projects: 0 rows')
    # the dataset repeats some rows exactly (about 90 in 2026); count each once
    seen, uniq = set(), []
    for r in rows:
        k = json.dumps(r, sort_keys=True)
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    rows = uniq
    lon =[fnum(r.get('longitude')) for r in rows]
    lat = [fnum(r.get('latitude')) for r in rows]
    has = [a is not None and b is not None and a < -89.5 and b > 29.8 for a, b in zip(lon, lat)]
    nbs = nbp.lookup([a if h else 0 for a, h in zip(lon, has)], [b if h else 0 for b, h in zip(lat, has)])
    win0 = today - dt.timedelta(days=365)
    recent0 = today.replace(year=today.year - 5)
    typeY, themeY = defaultdict(lambda: [0] * 11), defaultdict(lambda: [0] * 7)
    openByType = [0] * 11
    dec = {'appr': 0, 'den': 0, 'wd': 0}
    nbRecent = [[0] * 11 for _ in range(72)]
    up, pts, ptsInfo = [], [], []
    for i, r in enumerate(rows):
        t = cpc_type(r.get('case_type'))
        desc = r.get('description') or ''
        bits = sum(1 << k for k, rx in enumerate(CPC_TH_RX) if rx.search(desc))
        fd = parse_ts(r.get('filing_date'))
        nb = int(nbs[i]) if has[i] else -1
        x, y = (X(lon[i]), Y(lat[i])) if has[i] else (0, 0)
        if r.get('open_closed') == 'Open':
            openByType[t] += 1
        if fd:
            yk = str(fd.year)
            if fd.year >= 2004:  # the handful of Dec 2003 filings are left off the yearly charts
                typeY[yk][t] += 1
            for k in range(7):
                if bits >> k & 1 and fd.year >= 2004:
                    themeY[yk][k] += 1
            if fd.year >= 2016:
                ps = (r.get('previous_meeting_status') or '').strip().lower()
                if ps.startswith('approv') or 'modified approval' in ps:
                    dec['appr'] += 1
                elif ps.startswith('deni') or ps.startswith('denial'):
                    dec['den'] += 1
                elif ps == 'withdrawn':
                    dec['wd'] += 1
            if nb >= 0 and fd.date() >= recent0:
                nbRecent[nb][t] += 1
            if win0 <= fd.date() <= today:
                pts.append([(fd.date() - win0).days, t, x, y, nb, bits])
                ptsInfo.append([(r.get('address') or '').split(',')[0].strip()[:40], (r.get('case_num') or '').strip(), int(r.get('open_closed') == 'Open')])
        nmd = parse_ts(r.get('next_meeting_date'))
        if nmd and nmd.date() >= today:
            up.append([nmd.strftime('%Y-%m-%dT%H:%M'), r.get('next_meeting') or '', r.get('case_num') or '', CPC_TYP[t],
                       (r.get('address') or '').split(',')[0][:40], nb, x, y, cpc_desc(desc)])
    up.sort(key=lambda u: u[0])
    return {'TYP': CPC_TYP, 'TH': CPC_TH, 'typeY': dict(sorted(typeY.items())), 'themeY': dict(sorted(themeY.items())),
            'openByType': openByType, 'dec': dec, 'nbRecent': nbRecent, 'up': up, 'pts': pts,
            'ptsInfo': ptsInfo,   # [address, case number, open (1) / closed (0)] per pts entry, same order
            'windowStart': win0.isoformat(), 'total': len(rows),
            'firstFiled': min((parse_ts(r.get('filing_date')) for r in rows if parse_ts(r.get('filing_date'))), default=None).strftime('%Y-%m-%d'),
            'lastFiled': max((parse_ts(r.get('filing_date')) for r in rows if parse_ts(r.get('filing_date'))), default=None).strftime('%Y-%m-%d')}


# ---------------------------------------------------------------- large datasets, downloaded incrementally
CHECK_COPIES = False   # set on the monthly check day: compare each saved copy's row ids with the City's
FULL_DOWNLOADS = {}    # ds -> why its saved copy was downloaded again in full this run
OVERLAP = dt.timedelta(minutes=15)   # re-ask for rows updated this long before the copy's newest, in case a load was in progress


def synced_rows(api, ds, cols, where, label, total=None, fn=None):
    """Every row of `ds` matching `where`, kept in RAW_CACHE as <ds>.csv.gz and brought up to date incrementally.

    For datasets the City updates in place (311, Calls for Service): the copy holds each row's Socrata :id and
    :updated_at, so a run asks only for rows updated since the newest one in the copy (one small request) and merges
    them in by :id. Every run compares the merged copy's row count with the City's count for `where`; on the monthly
    check day it also compares the row ids themselves (one request for the ids alone), which catches a deletion
    offset by an addition. A mismatch, a missing or unreadable copy, changed columns, or a full run (--full) means
    every row is downloaded again in pages of 50,000. Returns (rows sorted by :id, how), rows as dicts of strings."""
    fn = os.path.join(RAW_CACHE, fn or f'{ds}.csv.gz')
    fields = [':id', ':updated_at'] + cols
    if total is None:
        total = int(api.get(f'/resource/{ds}.json', {'$select': 'count(*) as n', '$where': where})[0]['n'])
    need(total > 0, f'{label} ({ds}): 0 rows')
    both = lambda w: f'({where}) AND {w}' if where else w

    def fetch(w, select=fields, page=50000):
        got = []
        while True:
            params = {'$select': ','.join(select), '$order': ':id', '$limit': page, '$offset': len(got)}
            if w:
                params['$where'] = w
            got += (p := list(csv.DictReader(io.StringIO(api.get(f'/resource/{ds}.csv', params, kind='csv', cache=False)))))
            if len(p) < page:
                return got

    rows, how, why = None, '', 'no saved copy'
    if api.use_raw and os.path.exists(fn):
        try:
            with gzip.open(fn, 'rt', encoding='utf-8', newline='') as f:
                rd = csv.DictReader(f)
                copy = {r[':id']: r for r in rd} if rd.fieldnames == fields else {}
            why = 'saved copy has different columns' if not copy else why
        except (OSError, EOFError, csv.Error):
            copy, why = {}, 'saved copy unreadable'
        mark = max((r[':updated_at'] for r in copy.values()), default='')
        if copy and mark:
            since = (dt.datetime.fromisoformat(mark.rstrip('Z')[:23]) - OVERLAP).isoformat(timespec='milliseconds')
            delta = fetch(both(f":updated_at >= '{since}'"))
            for r in delta:
                copy[r[':id']] = r
            if len(copy) != total:
                why = f'saved copy has {len(copy):,} rows but the City has {total:,}'
            elif CHECK_COPIES and {r[':id'] for r in fetch(where, [':id'], 1000000)} != copy.keys():
                why = 'saved copy has the right number of rows but not the same rows'
            else:
                rows, how = list(copy.values()), f'{len(delta):,} new or changed rows merged into the saved copy' + (', row ids checked' if CHECK_COPIES else '')
    if rows is None:
        if not api.use_raw:
            why = 'full run'
        else:
            FULL_DOWNLOADS[ds] = why
        print(f'  {label}: {why}: downloading all {total:,} rows', flush=True)
        rows, how = fetch(where), f'full download, {total:,} rows'
    need(len(rows) >= total * 0.99, f'{label}: fetched {len(rows)} rows but the API reports {total}')
    rows.sort(key=lambda r: r[':id'])
    os.makedirs(RAW_CACHE, exist_ok=True)
    with gzip.open(fn + '.tmp', 'wt', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    os.replace(fn + '.tmp', fn)
    print(f'  {label}: {how}', flush=True)
    return rows, how


def points_to_nb(nbp, rows, lon='longitude', lat='latitude'):
    """Neighborhood index per row (-1 when the row has no usable location), plus x/y in the shared projection."""
    lo = [fnum(r.get(lon)) for r in rows]
    la = [fnum(r.get(lat)) for r in rows]
    has = [a is not None and b is not None and -90.2 < a < -89.5 and 29.8 < b < 30.25 for a, b in zip(lo, la)]
    nbs = nbp.lookup([a if h else 0 for a, h in zip(lo, has)], [b if h else 0 for b, h in zip(la, has)])
    return [int(n) if h else -1 for n, h in zip(nbs, has)], [(X(a), Y(b)) if h else (0, 0) for a, b, h in zip(lo, la, has)]


def sp_lonlat(x, y):
    """Louisiana South state plane coordinates in US feet (NAD83, EPSG:3452), which several City datasets use
    instead of lon/lat, -> (lon, lat). Inverse Lambert conformal conic on GRS80; matches the City's own lon/lat
    columns to 1e-7 degrees. None for missing or placeholder (-1) values."""
    if x is None or y is None or x < 3e6 or y < 3e5:
        return None
    a, f = 6378137.0, 1 / 298.257222101
    e = math.sqrt(2 * f - f * f)
    p1, p2, p0, l0 = (math.radians(v) for v in (30 + 42 / 60, 29 + 18 / 60, 28 + 30 / 60, -(91 + 20 / 60)))
    m = lambda p: math.cos(p) / math.sqrt(1 - (e * math.sin(p)) ** 2)
    t = lambda p: math.tan(math.pi / 4 - p / 2) / ((1 - e * math.sin(p)) / (1 + e * math.sin(p))) ** (e / 2)
    n = (math.log(m(p1)) - math.log(m(p2))) / (math.log(t(p1)) - math.log(t(p2)))
    F = m(p1) / (n * t(p1) ** n)
    r0 = a * F * t(p0) ** n
    xm, ym = x * 1200 / 3937 - 1000000.0, r0 - y * 1200 / 3937
    tt = (math.copysign(math.hypot(xm, ym), n) / (a * F)) ** (1 / n)
    phi = math.pi / 2 - 2 * math.atan(tt)
    for _ in range(8):
        phi = math.pi / 2 - 2 * math.atan(tt * ((1 - e * math.sin(phi)) / (1 + e * math.sin(phi))) ** (e / 2))
    return math.degrees(math.atan2(xm, ym) / n + l0), math.degrees(phi)


def sp_points_to_nb(nbp, rows, xcol, ycol):
    """points_to_nb for rows located by state plane x/y columns."""
    ll = [sp_lonlat(fnum(r.get(xcol)), fnum(r.get(ycol))) for r in rows]
    return points_to_nb(nbp, [{'longitude': p and p[0], 'latitude': p and p[1]} for p in ll])


def days_between(a, b):
    """Days from datetime a to b, to 0.1, or None when either is missing or b is before a."""
    if a is None or b is None or b < a:
        return None
    return (b - a).total_seconds() / 86400


def ranked(counter, keep=None):
    """Keys by count, ties broken by name, so the same data always gives the same order."""
    out = [k for k, _ in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))]
    return out[:keep] if keep else out


def month_index(d, y0, m0):
    return (d.year - y0) * 12 + d.month - m0


# ---------------------------------------------------------------- dots: one point per record, for the maps' dot layers
# Each map page's data file carries a `dots` object built from rows its builder already downloads (no extra requests).
# Columnar and small: x/y in map units x DOT_Q (about 5 m), the record's day as days since DOT_EPOCH, delta-encoded in
# date order (so a new day's records only add to the end, and the committed file changes little from day to day),
# and small lookup lists for categories. Records outside every neighborhood or without a location are left out.
DOT_Q = 4
DOT_EPOCH = dt.date(2000, 1, 1)


def dot_xy(lon, lat):
    """[lon, lat] -> (x, y) in map units x DOT_Q, or None when the location is missing or outside the parish's box."""
    if lon is None or lat is None or not (-90.2 < lon < -89.5 and 29.8 < lat < 30.25):
        return None
    return round((lon + 90.14) * 4830 * DOT_Q), round((30.20 - lat) * 5550 * DOT_Q)


def dot_lonlat(nbp, lons, lats):
    """Neighborhood index and dot x/y per record (nb -1 and xy None when it isn't mapped)."""
    xy = [dot_xy(a, b) for a, b in zip(lons, lats)]
    nbs = nbp.lookup([a if p else 0 for a, p in zip(lons, xy)], [b if p else 0 for b, p in zip(lats, xy)])
    return [int(n) if p else -1 for n, p in zip(nbs, xy)], xy


def dot_pack(recs, cols):
    """recs: dicts with 'day' (a date or None), 'x', 'y', 'nb' and the keys in `cols`. Sorted by day (records without
    one first, then by x, y), packed column by column. 'd' holds day deltas from `d0` (days since DOT_EPOCH)."""
    recs = sorted(recs, key=lambda r: (r['day'] is not None, r['day'] or DOT_EPOCH, r['x'], r['y'], [str(r[c]) for c in cols]))
    out = {'q': DOT_Q, 'epoch': DOT_EPOCH.isoformat(), 'n': len(recs),
           'x': [r['x'] for r in recs], 'y': [r['y'] for r in recs], 'nb': [r['nb'] for r in recs]}
    days = [(r['day'] - DOT_EPOCH).days if r['day'] else None for r in recs]
    if any(d is not None for d in days):
        d0 = next(d for d in days if d is not None)
        out['d0'], prev, dd = d0, d0, []
        for d in days:
            if d is None:
                dd.append(-1)   # no date (sorted first, so it never sits between two dated records)
            else:
                dd.append(d - prev)
                prev = d
        out['d'] = dd
    for c in cols:
        out[c] = [r[c] for r in recs]
    return out


def dot_dict(values):
    """Category strings -> (list by count, ties by name; index per value)."""
    lst = ranked(Counter(values))
    ix = {v: k for k, v in enumerate(lst)}
    return lst, [ix[v] for v in values]


def clean_addr(s):
    """A street address, whitespace collapsed and cut to 48 characters; one in all capitals is put in the mixed case
    the other datasets use ('625 PIRATE'S ALY' -> '625 Pirate's Aly', '2ND ST' -> '2nd St')."""
    s = re.sub(r'\s+', ' ', (s or '').strip())[:48]
    if s and not re.search(r'[a-z]', s):
        s = ' '.join(w[:1] + w[1:].lower() for w in s.split(' '))
        s = re.sub(r"\bO'([a-z])", lambda m: "O'" + m.group(1).upper(), s)
    return s


# words kept in capitals when an all-capitals business name is put in mixed case
NAME_CAPS = {'LLC', 'L.L.C.', 'LLP', 'PLLC', 'LP', 'PC', 'P.C.', 'DBA', 'USA', 'NOLA', 'II', 'III', 'IV', 'TV', 'AC', 'BBQ', 'CPA', 'MD', 'DDS', 'ATM', 'ABC'}


# words that mark an owner as a company, not a person
OWNER_CO = re.compile(r'\b(LLC|L\.L\.C|INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LLP|PLLC|LP|PC|APC|TRUST|GROUP|HOLDINGS|PARTNERS|PARTNERSHIP|'
                      r'ASSOCIATES|ASSOCIATION|ENTERPRISES?|FOUNDATION|CHURCH|UNIVERSITY|SCHOOL|CITY|STATE|PARISH|BANK|SERVICES?|AUTHORITY|CLUB)\b')
NAME_SKIP = {'JR', 'SR', 'II', 'III', 'IV', 'DBA', 'MR', 'MRS', 'MS', 'DR'}


def name_tokens(s):
    """Upper-case words of a name, without initials, generational suffixes or titles."""
    return [w for w in re.findall(r"[A-Z][A-Z'\-]*", (s or '').upper()) if len(w) > 1 and w not in NAME_SKIP]


def just_a_person(name, owner):
    """True when a business name is only its owner's own name: the owner is a person (no company words) and every
    word of the name, apart from initials and suffixes, is a word of the owner's name ('Joan T Baker' owned by
    'BAKER, JOAN'). The owner's name is used only for this check and is never kept."""
    if not owner or OWNER_CO.search(owner.upper()):
        return False
    nt, ot = name_tokens(name), set(name_tokens(owner))
    return len(nt) >= 2 and all(w in ot for w in nt)


def clean_name(s):
    """A business name, whitespace collapsed and cut to 60 characters; one in all capitals is put in mixed case,
    keeping company suffixes, initials and words without vowels in capitals ('JOE'S BBQ LLC' -> 'Joe's BBQ LLC')."""
    s = re.sub(r'\s+', ' ', (s or '').strip())[:60].strip()
    if s and not re.search(r'[a-z]', s):
        def word(w):
            core = w.strip(',()')
            if re.fullmatch(r'\d+(ST|ND|RD|TH)', core):
                return w.lower()
            if core in NAME_CAPS or not re.search(r'[AEIOUY]', core) or re.fullmatch(r'(?:[A-Z]\.)+|[A-Z]{1,2}&[A-Z]{1,2}', core):
                return w
            return re.sub(r"(^|[-/(&])([A-Z])([A-Z']*)", lambda m: m.group(1) + m.group(2) + m.group(3).lower(), w)
        s = ' '.join(word(w) for w in s.split(' '))
        s = re.sub(r"\b(O'|Mc)([a-z])", lambda m: m.group(1) + m.group(2).upper(), s)
    return s


def dot_lookup(recs, key, col):
    """Each record's text `key` -> index `col` into the returned list (most shared first; -1 when missing, -2 when
    withheld: the text is None)."""
    L, _ = dot_dict([r[key] for r in recs if r[key]])
    ix = {v: k for k, v in enumerate(L)}
    for r in recs:
        r[col] = -2 if r[key] is None else ix.get(r[key], -1)
    return L


def dot_addresses(recs, cols):
    """dot_pack, with each record's street address `ad` stored as an index `a` into the list `A` (and, when records
    carry a business name `bn`, that as `m` into `M`), as dot_lookup."""
    A = dot_lookup(recs, 'ad', 'a')
    names = recs and 'bn' in recs[0]
    M = dot_lookup(recs, 'bn', 'm') if names else None
    out = dot_pack(recs, cols + ['a'] + (['m'] if names else []))
    out['A'] = A
    if names:
        out['M'] = M
    return out


# ---------------------------------------------------------------- 311 service requests
SR_DS = '2jgv-pqrq'
# The City loaded about 313,000 older (2012-2018) requests with a created date of January 1-2, 2019, so the page
# starts with February 2019, the first full month of requests made through the current system.
SR_START = '2019-02-01'
SR_TYPES = 12      # request types shown by name (by count since SR_START); the rest are "Other"
SR_REASON_MIN = 30  # a reason needs this many requests in the past 12 months to be listed by name


def build_311(api, nbp):
    cols = ['request_type', 'request_reason', 'date_created', 'case_close_date', 'request_status', 'longitude', 'latitude']
    api.require_columns(SR_DS, cols, '311 calls')
    rows, _ = synced_rows(api, SR_DS, cols, f"date_created >= '{SR_START}'", '311 requests')
    created = [parse_ts(r['date_created']) for r in rows]
    bad = sum(c is None for c in created)
    need(bad < len(rows) * 0.001, f'311 requests: {bad} rows with unreadable date_created')
    keep = [i for i, c in enumerate(created) if c is not None]
    rows, created = [rows[i] for i in keep], [created[i] for i in keep]
    closed = [parse_ts(r['case_close_date']) for r in rows]
    nbs, _ = points_to_nb(nbp, rows)
    n = len(rows)
    last = max(created)
    today = last.date()                     # "now" is the newest request in the data, so the file only changes with it
    win0 = today - dt.timedelta(days=364)   # past 12 months: the 365 days ending on that day
    recent = [created[i].date() >= win0 for i in range(n)]
    pending = [r['request_status'] == 'Pending' for r in rows]
    typ = [(r['request_type'] or '').strip() or 'Not recorded' for r in rows]
    reason = [(r['request_reason'] or '').strip() or 'Not recorded' for r in rows]

    # types in the order of the past 12 months, so the list matches what people ask for now; types the City has
    # stopped using (e.g. 'Roads/Drainage' before it was split) fall under "Other"
    T = ranked(Counter(t for t, r in zip(typ, recent) if r), SR_TYPES)
    T += ['Other'] * (len(set(typ)) > len(T))
    ti = {t: k for k, t in enumerate(T)}
    tix = [ti.get(t, len(T) - 1) for t in typ]
    # reasons, with the type each belongs to; rare ones are pooled as "Other" within their type
    rc = Counter((tix[i], reason[i]) for i in range(n) if recent[i])
    R = sorted((list(k) for k in rc if rc[k] >= SR_REASON_MIN), key=lambda k: (k[0], -rc[tuple(k)], k[1]))
    R += [[t, 'Other'] for t in range(len(T)) if any(k[0] == t and rc[k] < SR_REASON_MIN for k in rc)]
    ri = {(t, s): k for k, (t, s) in enumerate(R)}
    rix = [ri.get((tix[i], reason[i]), ri.get((tix[i], 'Other'), -1)) for i in range(n)]

    y0, m0 = int(SR_START[:4]), int(SR_START[5:7])
    nm = month_index(last, y0, m0) + 1
    month = [month_index(c, y0, m0) for c in created]
    years = list(range(y0, last.year + 1))
    NT, AGES = len(T), [30, 90, 365, 730]                     # open for: <30 days, 30-89, 90-364, 1-2 years, 2+ years
    mon = [[0] * NT for _ in range(nm)]                       # requests per month per type, whole city
    nby = [[[0] * NT for _ in years] for _ in range(72)]      # requests per year per type, per neighborhood
    nb12 = [Counter() for _ in range(72)]                     # past 12 months, per neighborhood per reason
    openAge = [[[0] * (len(AGES) + 1) for _ in range(NT)] for _ in range(73)]  # still open, by age; row 72 = whole city
    closeR, closeT = [[] for _ in R], [[] for _ in T]         # days to close, requests closed in the past 12 months
    closeNb = [[[] for _ in T] for _ in range(72)]
    for i in range(n):
        t, nb = tix[i], nbs[i]
        mon[month[i]][t] += 1
        if nb >= 0:
            nby[nb][created[i].year - y0][t] += 1
            if recent[i]:
                nb12[nb][rix[i]] += 1
        if pending[i]:
            age = sum((today - created[i].date()).days >= a for a in AGES)
            openAge[72][t][age] += 1
            if nb >= 0:
                openAge[nb][t][age] += 1
        elif closed[i] is not None and closed[i].date() >= win0:
            d = days_between(created[i], closed[i])
            if d is not None:
                closeR[rix[i]].append(d)
                closeT[t].append(d)
                if nb >= 0:
                    closeNb[nb][t].append(d)
    stat = lambda v: [len(v), median(v), p90(v)]
    trees = tree_requests(rows, created, closed, nbs, typ, reason, pending, last)
    drain = drainage_requests(rows, created, closed, nbs, typ, reason, pending, last)
    streq = street_requests(rows, created, closed, nbs, typ, reason, pending, last)
    dots = sr_dots(rows, created, closed, pending, recent, nbs, tix, reason, R)
    return trees, drain, streq, {
        'dots': dots,
        'ds': SR_DS, 'start': SR_START[:7], 'last': last.strftime('%Y-%m-%d'), 'winStart': win0.isoformat(),
        'T': T, 'R': R, 'mon': mon, 'years': years, 'nby': nby,
        'nb12': [[v for r in sorted(c) for v in (r, c[r])] for c in nb12],   # [reason, n, reason, n, ...]
        'ages': AGES, 'openAge': openAge,
        'closeR': [stat(v) for v in closeR], 'closeT': [stat(v) for v in closeT],
        'closeNb': [[[len(v), median(v)] for v in row] for row in closeNb],
        'total': n, 'recent': sum(recent), 'open': sum(pending), 'noLoc': sum(nb < 0 for nb in nbs),
    }


def sr_dots(rows, created, closed, pending, recent, nbs, tix, reason, R):
    """One dot per located request filed in the past 12 months or still open (any age). r: index into `R`
    (the page's [type, reason] list, plus [type, 'Other'] for reasons it doesn't list); c: days to close
    (-1 still open, -2 closed with no close date)."""
    RP = [list(r) for r in R]
    ri = {(t, s): k for k, (t, s) in enumerate(RP)}
    recs = []
    for i in range(len(rows)):
        if not (recent[i] or pending[i]) or nbs[i] < 0:
            continue
        p = dot_xy(fnum(rows[i]['longitude']), fnum(rows[i]['latitude']))
        if p is None:
            continue
        k = ri.get((tix[i], reason[i]), ri.get((tix[i], 'Other')))
        if k is None:
            RP.append([tix[i], 'Other'])
            k = ri[(tix[i], 'Other')] = len(RP) - 1
        days = None if pending[i] else days_between(created[i], closed[i])
        recs.append({'day': created[i].date(), 'x': p[0], 'y': p[1], 'nb': nbs[i], 'r': k,
                     'c': -1 if pending[i] else -2 if days is None else int(days + 0.5)})
    out = dot_pack(recs, ['r', 'c'])
    out['R'] = RP
    return out


TR_TYPE = 'Tree Service'  # the 311 request type for trees (trims, dead or dying trees, blocked streets and signs)
TR_REASON_MIN = 30        # a reason needs this many tree requests in all to be listed by name; the rest are "Other"


def tree_requests(rows, created, closed, nbs, typ, reason, pending, last):
    """The 311 tree requests, one point each, for the trees page's request map. Built from the 311 rows already
    downloaded, so it costs no extra API requests. Points: lon/lat x 1e5, reason index, day filed (days since
    `t0`), and days to close (-1 still open, -2 closed with no close date)."""
    idx = [i for i in range(len(rows)) if typ[i] == TR_TYPE]
    need(len(idx) > 1000, f'311 tree requests: only {len(idx)} found')
    rc = Counter(reason[i] for i in idx)
    R = [r for r in ranked(rc) if rc[r] >= TR_REASON_MIN]
    R += ['Other'] * any(rc[r] < TR_REASON_MIN for r in rc)
    ri = {r: k for k, r in enumerate(R)}
    t0 = min(created[i] for i in idx).date()
    x, y, rr, d, c, nb = [], [], [], [], [], []
    no_loc = 0
    for i in idx:
        lo, la = fnum(rows[i]['longitude']), fnum(rows[i]['latitude'])
        if nbs[i] < 0 or lo is None or la is None:
            no_loc += 1
            continue
        x.append(round(lo * 1e5)); y.append(round(la * 1e5))
        rr.append(ri.get(reason[i], len(R) - 1))
        d.append((created[i].date() - t0).days)
        days = days_between(created[i], closed[i]) if not pending[i] else None
        c.append(-1 if pending[i] else -2 if days is None else round(days))
        nb.append(nbs[i])
    return {'ds': SR_DS, 't0': t0.isoformat(), 'last': last.strftime('%Y-%m-%d'), 'R': R,
            'x': x, 'y': y, 'r': rr, 'd': d, 'c': c, 'nb': nb, 'total': len(idx), 'noLoc': no_loc}


# ---------------------------------------------------------------- drainage
# 311 drainage requests: every reason under the "Drainage" type, plus the drainage reasons filed under the older
# "Roads/Drainage" type (used alongside it until 2024) and under "Roads and Streets". Reasons are grouped; anything
# else under "Drainage" is "Other".
DR_GROUPS = [
    ('Catch basin clogged or not draining', ['Catch Basin Not Draining', 'Catch Basin Clogged', 'Catch Basin - Clogged', 'Illegal Dumping (Catch Basin)']),
    ('Street flooding', ['Street Flooding', 'Street Flooding / Drainage', 'Alley Way Drainage Issue']),
    ('Broken basin or manhole cover', ['Catch Basin Frame and Cover Missing or Damaged', 'Catch Basin Damaged', 'Catch Basin - Broken/Damage',
                                       'Drainage Manhole Cover Missing or Damaged', 'Man hole cover issue']),
    ('Ditch or culvert', ['Ditch and Culvert Maintenance', 'Ditch Issue', 'Culvert Issue']),
    ('Drainage issue, not specified', ['Drainage Issue (Catch Basins, Culverts, Ditches, and Manhole Covers)']),
    ('Water main break or leaking hydrant', ['WaterMain Break', 'Leaking Hydrant']),
    ('Other', []),
]
DR_TYPE = 'Drainage'
DR_REASON_GROUP = {r: g for g, (_, rs) in enumerate(DR_GROUPS) for r in rs}


def drainage_requests(rows, created, closed, nbs, typ, reason, pending, last):
    """The 311 drainage requests since SR_START, one dot each, for the drainage page. Built from the 311 rows already
    downloaded, so it costs no extra API requests. Dots (dot_pack): g reason group (DR_GROUPS), c days to close
    (-1 still open, -2 closed with no close date)."""
    other = len(DR_GROUPS) - 1
    idx = [i for i in range(len(rows)) if typ[i] == DR_TYPE or reason[i] in DR_REASON_GROUP]
    need(len(idx) > 1000, f'311 drainage requests: only {len(idx)} found')
    recs, no_loc = [], 0
    for i in idx:
        p = dot_xy(fnum(rows[i]['longitude']), fnum(rows[i]['latitude']))
        if p is None or nbs[i] < 0:
            no_loc += 1
            continue
        days = None if pending[i] else days_between(created[i], closed[i])
        recs.append({'day': created[i].date(), 'x': p[0], 'y': p[1], 'nb': nbs[i], 'g': DR_REASON_GROUP.get(reason[i], other),
                     'c': -1 if pending[i] else -2 if days is None else int(days + 0.5)})
    return {'ds': SR_DS, 'start': SR_START, 'last': last.strftime('%Y-%m-%d'), 'G': [g for g, _ in DR_GROUPS],
            'dots': dot_pack(recs, ['g', 'c']), 'total': len(idx), 'open': sum(pending[i] for i in idx), 'noLoc': no_loc}


# ---------------------------------------------------------------- streets
# 311 street requests: road surface, sidewalks and curbs, utility cuts, debris, and streetlights. The current types
# ("Roads and Streets", "Streetlights") replaced "Roads/Drainage" (used until 2024) and "Traffic Signals/Signs/Striping/
# Streetlights" (until 2023), so their reasons are read under all four. Drainage reasons are on the drainage page;
# signs and striping are left out.
SQ_TYPES = {'Roads and Streets', 'Roads/Drainage', 'Streetlights', 'Traffic Signals/Signs/Striping/Streetlights'}
SQ_GROUPS = [
    ('Pothole', ['Pothole']),
    ('Street sinking', ['Street Subsidence (Sinking)']),
    ('Sidewalk, curb or ramp', ['Sidewalk Damaged or Missing', 'Damaged Sidewalk', 'Accessibility Ramps, Curbs and Sidewalk Repair',
                                'Curb Damage', 'ADA Ramps Damaged or Missing']),
    ('Shoulder or pavement damage', ['Road Shoulder Damage', 'Road Shoulder Repair', 'Push-up/Pavement Expansion']),
    ('Utility cut left unpaved', ['Abandoned Service Cut', 'Service Cut']),
    ('Debris in the road', ['Debris in Driving Lanes', 'Debris in Roadway']),
    ('Streetlight out', ['Streetlight Outage/Malfunction', 'Street Light Outage/Malfunction']),
    ('Streetlight down or leaning', ['Streetlight Knocked Down/Leaning', 'Street Light Knocked Down/Leaning']),
    ('New streetlight wanted', ['New Streetlight Request']),
]
SQ_LIGHTS = 6   # groups from this one on are streetlights
SQ_REASON_GROUP = {r: g for g, (_, rs) in enumerate(SQ_GROUPS) for r in rs}


def street_requests(rows, created, closed, nbs, typ, reason, pending, last):
    """The 311 street and streetlight requests since SR_START, one dot each, for the streets page. Built from the 311
    rows already downloaded, so it costs no extra API requests. Dots (dot_pack): g reason group (SQ_GROUPS), c days to
    close (-1 still open, -2 closed with no close date)."""
    idx = [i for i in range(len(rows)) if typ[i] in SQ_TYPES and reason[i] in SQ_REASON_GROUP]
    need(len(idx) > 10000, f'311 street requests: only {len(idx)} found')
    recs, no_loc = [], 0
    for i in idx:
        p = dot_xy(fnum(rows[i]['longitude']), fnum(rows[i]['latitude']))
        if p is None or nbs[i] < 0:
            no_loc += 1
            continue
        days = None if pending[i] else days_between(created[i], closed[i])
        recs.append({'day': created[i].date(), 'x': p[0], 'y': p[1], 'nb': nbs[i], 'g': SQ_REASON_GROUP[reason[i]],
                     'c': -1 if pending[i] else -2 if days is None else int(days + 0.5)})
    return {'ds': SR_DS, 'start': SR_START, 'last': last.strftime('%Y-%m-%d'), 'G': [g for g, _ in SQ_GROUPS], 'lights': SQ_LIGHTS,
            'dots': dot_pack(recs, ['g', 'c']), 'total': len(idx), 'open': sum(pending[i] for i in idx), 'noLoc': no_loc}


# Road work: the City's RoadWork project lists, one row per street segment of a project (a point on the segment).
# DPW (u5mk-y9z4) is the paving work; SWB (bsnu-de3a) the sewer, water and drainage lines under the same streets, mostly
# under the same project ids. Both are merged by segment id, so a block is one dot. A project's total cost is repeated
# on every one of its segments: it's kept once per project and never added up across segments. The outreach contact
# column (often a person's name) is never downloaded.
RW_DPW, RW_SWB = 'u5mk-y9z4', 'bsnu-de3a'
RW_DPW_COLS = ['segmentid', 'projid', 'project_name', 'current_phase', 'projtype', 'consttype', 'startqtr', 'endqtr',
               'total_cost', 'project_contractor', 'location']
RW_SWB_COLS = ['segmentid', 'projid', 'ssstat', 'sstype', 'location']
RW_PHASES = ['Under construction', 'Planned', 'Complete', 'Not stated']   # a block with two phases shows the first
RW_PHASE_OF = {'construction': 0, 'planned': 1, 'planned/complete': 1, 'complete': 2}
RW_PROGRAMS = {'RR': 'FEMA Recovery Roads', 'DPW': 'Public Works', 'SELA': 'SELA drainage', 'HMGP': 'FEMA Hazard Mitigation',
               'NDR': 'National Disaster Resilience', 'DOTD': 'State DOTD', 'RTA': 'RTA', 'SWB': 'Sewerage & Water Board'}


def rw_phase(s):
    return RW_PHASE_OF.get(re.sub(r'\s+', '', (s or '')).lower(), 3)


def rw_program(s):
    """'DPW/RR' -> 'Public Works + FEMA Recovery Roads'; codes it doesn't know are kept as they are."""
    codes = re.findall(r'RR|DPW|SELA|HMGP|NDR|DOTD|RTA|SWB|[A-Z]{2,}', (s or '').upper())
    out = list(dict.fromkeys(RW_PROGRAMS.get(c, c) for c in codes))
    return ' + '.join(out) or 'Not stated'


def rw_lines(s):
    """The SWB work type by the lines it names: 'Sewer Line Repair (SSERP)' -> 'Sewer line'; 'Drainage Line, Sewer Line,
    and Water Line Replacement (FEMA)' -> 'Drainage, sewer and water lines'. Its 75 spellings come down to a few kinds."""
    s = (s or '').lower()
    parts = [w for w, k in (('Drainage', 'drain'), ('Sewer', 'sewer'), ('Water', 'water')) if k in s]
    if not parts:
        return 'Not stated'
    if len(parts) == 1:
        return parts[0] + ' line'
    words = [parts[0]] + [p.lower() for p in parts[1:]]
    return ', '.join(words[:-1]) + ' and ' + words[-1] + ' lines'


def rw_when(s):
    """'06/05/2025' -> '2025-06-05'; 'Jan-Mar 2027' kept; 'TBD' or blank -> ''."""
    s = (s or '').strip()
    m = re.fullmatch(r'(\d\d?)/(\d\d?)/(\d{4})', s)
    if m:
        return f'{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}'
    return s if re.fullmatch(r'[A-Z][a-z]{2}-[A-Z][a-z]{2} \d{4}', s) else ''


def build_roadwork(api, nbp):
    api.require_columns(RW_DPW, RW_DPW_COLS, 'RoadWork DPW projects')
    api.require_columns(RW_SWB, RW_SWB_COLS, 'RoadWork SWB projects')
    dpw = fetch_all(api, RW_DPW, ','.join(RW_DPW_COLS), order='segmentid,projid')
    swb = fetch_all(api, RW_SWB, ','.join(RW_SWB_COLS), order='segmentid,projid')
    need(len(dpw) > 5000, f'RoadWork DPW projects: only {len(dpw)} rows')
    need(len(swb) > 2000, f'RoadWork SWB projects: only {len(swb)} rows')
    common = lambda vals: (ranked(Counter(v for v in vals if v)) or [''])[0]   # the value most segments give
    txt = lambda r, c: re.sub(r'\s+', ' ', (r.get(c) or '').strip())
    # projects: everything the page says about a project, once (its cost, dates and contractor repeat on each segment)
    by, sby = defaultdict(list), defaultdict(list)
    for r in dpw:
        by[txt(r, 'projid')].append(r)
    for r in swb:
        sby[txt(r, 'projid')].append(r)
    P, pix = [], {}
    for pid in sorted((set(by) | set(sby)) - {''}):
        rs, ss = by.get(pid, []), sby.get(pid, [])
        # the phase most of its segments give (DPW's when the project is there, else SWB's); blanks don't vote
        ph = Counter(rw_phase(r.get('current_phase')) for r in rs) if rs else Counter(rw_phase(r.get('ssstat')) for r in ss)
        voted = Counter({k: v for k, v in ph.items() if k != 3}) or ph
        cost = fnum(common(r.get('total_cost') for r in rs))
        end = rw_when(common(r.get('endqtr') for r in rs))
        pix[pid] = len(P)
        P.append([pid, common(txt(r, 'project_name') for r in rs), ranked(voted)[0],
                  rw_program(common(r.get('projtype') for r in rs)) if rs else '',
                  common(txt(r, 'project_contractor') for r in rs if txt(r, 'project_contractor') != 'TBD'),
                  round(cost) if cost and cost > 0 else 0, rw_when(common(r.get('startqtr') for r in rs)), end,
                  int(end[-4:] if '-' in end[3:4] else end[:4]) if end else 0, (1 if rs else 0) + (2 if ss else 0)])
    CT, ctx = dot_dict([txt(r, 'consttype') or 'Not stated' for r in dpw])
    K, kx = dot_dict([rw_lines(r.get('sstype')) for r in swb])
    ST, stx = dot_dict([txt(r, 'sstype') or 'Not stated' for r in swb])
    seg = {}
    pt = lambda r: (r.get('location') or {}).get('coordinates') or [None, None]
    for i, r in enumerate(dpw):
        seg[r['segmentid']] = {'pt': pt(r), 'p': pix.get(txt(r, 'projid'), -1), 'ph': rw_phase(r.get('current_phase')),
                               'ct': ctx[i], 'sp': -1, 'sk': -1, 'ss': -1, 'st': -1}
    both = 0
    for i, r in enumerate(swb):
        s = seg.get(r['segmentid'])
        if s is None:
            s = seg[r['segmentid']] = {'pt': pt(r), 'p': -1, 'ph': -1, 'ct': -1}
        else:
            both += 1
        s.update(sp=pix.get(txt(r, 'projid'), -1), sk=kx[i], ss=rw_phase(r.get('ssstat')), st=stx[i])
    keys = sorted(seg)
    nbs, xy = dot_lonlat(nbp, [fnum(seg[k]['pt'][0]) for k in keys], [fnum(seg[k]['pt'][1]) for k in keys])
    recs, no_loc = [], 0
    for j, k in enumerate(keys):
        if xy[j] is None or nbs[j] < 0:
            no_loc += 1
            continue
        s = seg[k]
        recs.append({'day': None, 'x': xy[j][0], 'y': xy[j][1], 'nb': nbs[j], **{c: s[c] for c in ('p', 'ph', 'ct', 'sp', 'sk', 'ss', 'st')}})
    return {'ds': RW_DPW, 'swbDs': RW_SWB, 'phases': RW_PHASES, 'CT': CT, 'K': K, 'ST': ST,
            'P': P, 'pcols': ['id', 'name', 'phase', 'program', 'contractor', 'cost', 'start', 'end', 'endYear', 'src'],
            'dots': dot_pack(recs, ['p', 'ph', 'ct', 'sp', 'sk', 'ss', 'st']),
            'dpwRows': len(dpw), 'swbRows': len(swb), 'both': both, 'total': len(keys), 'noLoc': no_loc,
            'projects': [sum(1 for p in P if p[2] == k) for k in range(len(RW_PHASES))]}


# Catch basins: the City's inventory, with the work recorded in its cleaning and inspection log. The log has its own
# location ids, so each logged visit is matched to the inventory basin nearest its point, within CB_MATCH_M meters.
# The log is reloaded every night but its newest dated record is from January 2025: the page says so, and the basin
# map shows the last cleaning *recorded*, never "time since cleaned".
CB_DS, CBW_DS = 'se4p-ierc', '2zer-6wpb'
CB_MATCH_M = 5
CB_TYPES = ['Vertical', 'Rollover', 'CB', 'Inlet', 'Not recorded']
CB_TYPE_OF = {'vertical': 0, 'rollover': 1, 'cb': 2, 'in': 3, 'i': 3, 'inlet': 3}
CB_WORK = ['Cleaned', 'Inspected', 'Inaccessible']   # CleanedInFront counts as Cleaned; Incomplete and blank are left out
CB_WORK_OF = {'cleaned': 0, 'cleanedinfront': 0, 'inspected': 1, 'inaccessible': 2}
CB_REASON = ['311 request', 'Routine maintenance', 'Emergency or storm', 'Special event', 'Other']


def cb_reason(s):
    s = re.sub(r'\s+', '', (s or '')).lower()
    if s == '311case':
        return 0
    if 'maintenance' in s:
        return 1
    if 'emergency' in s or 'ida' in s or 'flood' in s:
        return 2
    if 'event' in s:
        return 3
    return 4


def cb_fingerprint(api):
    """The cleaning log's content, in one small request: the City reloads it every night (so its version moves daily)
    while its rows stay the same. The basins file is rebuilt only when this or the inventory's version changes."""
    r = api.get(f'/resource/{CBW_DS}.json', {'$select': 'count(*) as n, max(mdate) as last, max(cbmaintid) as id'}, cache=False)[0]
    return f"{r.get('n')}/{(r.get('last') or '')[:10]}/{r.get('id')}"


def title_street(s):
    """'CONSTANTINOPLE ST' -> 'Constantinople St', '2ND ST' -> '2nd St' (the basin inventory's street names are in capitals)."""
    s = re.sub(r'\s+', ' ', (s or '').strip())
    if not s:
        return 'Not recorded'
    return ' '.join(w.lower() if re.fullmatch(r'\d+(St|Nd|Rd|Th)', w) else w for w in s.title().split(' '))


def build_basins(api, nbp):
    api.require_columns(CB_DS, ['the_geom', 'gisid', 'cbtype', 'stname'], 'Catch basins')
    api.require_columns(CBW_DS, ['mdate', 'worktype', 'reason', 'x', 'y', 'nearestfu', 'gisid', 'cbmaintid'], 'Catch basin cleanings')
    inv = fetch_all(api, CB_DS, 'the_geom,gisid,cbtype,stname')
    log = fetch_all(api, CBW_DS, 'mdate,worktype,reason,x,y,nearestfu,gisid,cbmaintid')
    need(len(inv) > 50000, f'Catch basins: only {len(inv)} rows')
    need(len(log) > 50000, f'Catch basin cleanings: only {len(log)} rows')
    coords = [((r.get('the_geom') or {}).get('coordinates') or [None, None]) for r in inv]
    lon, lat = [fnum(c[0]) for c in coords], [fnum(c[1]) for c in coords]
    nbs, xy = dot_lonlat(nbp, lon, lat)
    # meters (east, north) for matching; a grid of CELL-meter cells holds the inventory
    kx, ky, CELL = 111320 * math.cos(math.radians(29.97)), 110574, 10
    grid = defaultdict(list)
    for i, (a, b) in enumerate(zip(lon, lat)):
        if a is not None and b is not None:
            X, Y = a * kx, b * ky
            grid[(int(X // CELL), int(Y // CELL))].append((i, X, Y))

    def nearest(a, b):
        X, Y = a * kx, b * ky
        cx, cy, best, bd = int(X // CELL), int(Y // CELL), -1, CB_MATCH_M
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i, x2, y2 in grid.get((cx + dx, cy + dy), ()):
                    d = math.hypot(X - x2, Y - y2)
                    if d <= bd:
                        best, bd = i, d
        return best

    n = len(inv)
    last_clean, n_clean, last_visit, visit_kind, last_reason = [None] * n, [0] * n, [None] * n, [-1] * n, [-1] * n
    years = Counter()            # (year, work) -> visits logged, matched or not
    matched = unmatched = dated = 0
    log_first = log_last = None
    for r in log:
        w = CB_WORK_OF.get(re.sub(r'\s+', '', (r.get('worktype') or '')).lower())
        day = dt.date.fromisoformat(r['mdate'][:10]) if r.get('mdate') else None
        if day:
            dated += 1
            log_first, log_last = min(log_first or day, day), max(log_last or day, day)
            if w is not None:
                years[(day.year, w)] += 1
        if w is None:
            continue
        a, b = fnum(r.get('x')), fnum(r.get('y'))
        i = nearest(a, b) if a is not None and b is not None else -1
        if i < 0:
            unmatched += 1
            continue
        matched += 1
        if day is None:   # a few visits have a kind but no date: matched, but they say nothing about when
            continue
        if w == 0:
            n_clean[i] += 1
            if last_clean[i] is None or day > last_clean[i]:
                last_clean[i], last_reason[i] = day, cb_reason(r.get('reason'))
        if last_visit[i] is None or day >= last_visit[i]:
            last_visit[i], visit_kind[i] = day, w
    need(matched > 0.8 * (matched + unmatched), f'Catch basin cleanings: only {matched} of {matched + unmatched} visits matched a basin')
    S, sx = dot_dict([title_street(r.get('stname')) for r in inv])
    recs, no_loc = [], 0
    for i, r in enumerate(inv):
        if xy[i] is None or nbs[i] < 0:
            no_loc += 1
            continue
        t = CB_TYPE_OF.get((r.get('cbtype') or '').strip().lower(), len(CB_TYPES) - 1)
        lv = last_visit[i]
        after = lv is not None and lv != last_clean[i]   # the last visit wasn't the last cleaning
        recs.append({'day': last_clean[i], 'x': xy[i][0], 'y': xy[i][1], 'nb': nbs[i], 't': t, 'k': n_clean[i], 'rs': last_reason[i],
                     'v': visit_kind[i] if after else -1, 'vd': (lv - DOT_EPOCH).days if after else -1, 's': sx[i]})
    y0, y1 = min(y for y, _ in years), max(y for y, _ in years)
    return {'ds': CB_DS, 'logDs': CBW_DS, 'T': CB_TYPES, 'W': CB_WORK, 'RS': CB_REASON, 'S': S,
            'dots': dot_pack(recs, ['t', 'k', 'rs', 'v', 'vd', 's']),
            'logFirst': log_first.isoformat(), 'logLast': log_last.isoformat(), 'logRows': len(log), 'logDated': dated,
            'matched': matched, 'unmatched': unmatched, 'matchM': CB_MATCH_M,
            'years': list(range(y0, y1 + 1)), 'yw': [[years[(y, w)] for w in range(len(CB_WORK))] for y in range(y0, y1 + 1)],
            'total': n, 'noLoc': no_loc}


# ---------------------------------------------------------------- short-term rentals
STR_ACTIVE, STR_APPS, STR_NC = 'ufdg-ajws', 'en36-xvxg', '2ei9-wqw2'
# active licenses that are rentals (operator permits are people, not places, and are counted separately)
STR_CAT = ['Short Term Rental Commercial Owner', 'Non-Commercial Short Term Rental', 'Lodging Exempt from STR Regulation']
# applications: license types the City has used since 2017, grouped
STR_GROUPS = ['Commercial', 'Residential / non-commercial', 'Temporary', 'Other or not stated']
STR_STATUS = ['Issued', 'Expired', 'Revoked', 'Pending', 'Withdrawn', 'Denied', 'Duplicate']


def str_group(lt, sub):
    lt, sub = (lt or '').strip(), (sub or '').strip()
    if lt == 'Short Term Rental Commercial Owner' or (lt == 'Short Term Rental' and sub == 'Commercial STR'):
        return 0
    if lt.startswith('Non-Commercial') or lt.startswith('Short Term Rental Residential') or lt == 'Interim STR' or (lt == 'Short Term Rental' and sub == 'Accessory STR'):
        return 1
    if lt == 'Short Term Rental' and sub == 'Temporary STR':
        return 2
    return 3


def fetch_all(api, ds, select, order=':id', where=None, page=50000):
    rows = []
    while True:
        params = {'$select': select, '$order': order, '$limit': page, '$offset': len(rows)}
        if where:
            params['$where'] = where
        got = api.get(f'/resource/{ds}.json', params)
        rows += got
        if len(got) < page:
            return rows


def build_str(api, nbp):
    # active licenses
    # license number, address and dates are public on the license; operator and holder names are left out
    cols = ['license_type', 'residential_subtype', 'bedroom_limit', 'issue_date', 'longitude', 'latitude', 'license_number', 'address', 'expiration_date']
    api.require_columns(STR_ACTIVE, cols, 'Active STR licenses')
    act = fetch_all(api, STR_ACTIVE, ','.join(cols))
    need(len(act) > 500, f'Active STR licenses: only {len(act)} rows')
    nbs, xy = points_to_nb(nbp, act)
    pts, operators, other = [], Counter(), 0
    for r, nb, (x, y) in zip(act, nbs, xy):
        lt = (r.get('license_type') or '').strip()
        if lt == 'Short Term Rental Operator':
            operators[(r.get('residential_subtype') or '').strip() or 'N/A'] += 1
        elif lt in STR_CAT:
            pts.append([x, y, STR_CAT.index(lt), nb, int(fnum(r.get('bedroom_limit')) or 0), re.sub(r'\s+', ' ', (r.get('address') or '').strip()),
                        (r.get('license_number') or '').strip(), (r.get('issue_date') or '')[:10], (r.get('expiration_date') or '')[:10]])
        else:
            other += 1
    need(not other, f'Active STR licenses: {other} rows of an unknown license type. Add it to STR_CAT.')
    pts.sort()
    # non-commercial license details
    nc_cols = ['type_of_building', 'partial_whole', 'operator_type', 'bedrooms_rented', 'current_status', 'location']
    api.require_columns(STR_NC, nc_cols, 'Non-commercial STR licenses')
    nc = fetch_all(api, STR_NC, ','.join(nc_cols))
    need(len(nc) > 100, f'Non-commercial STR licenses: only {len(nc)} rows')
    loc = [(r.get('location') or {}).get('coordinates') or [None, None] for r in nc]
    ncnb, _ = points_to_nb(nbp, [{'longitude': a, 'latitude': b} for a, b in loc])
    clean = lambda v: re.sub(r'\s+', ' ', (v or '').strip()) or 'Not stated'
    B = ranked(Counter(clean(r.get('type_of_building')) for r in nc))
    OP = ranked(Counter(clean(r.get('operator_type')) for r in nc))
    ST = ranked(Counter(clean(r.get('current_status')) for r in nc))
    ncr = sorted([nb, B.index(clean(r.get('type_of_building'))), 1 if clean(r.get('partial_whole')) == 'Whole Unit' else 0 if clean(r.get('partial_whole')) == 'Partial Unit' else 2,
                  int(fnum(r.get('bedrooms_rented')) or 0), OP.index(clean(r.get('operator_type'))), ST.index(clean(r.get('current_status')))] for r, nb in zip(nc, ncnb))
    # applications since 2017
    a_cols = ['application_date', 'license_type', 'residential_subtype', 'current_status', 'x', 'y']
    api.require_columns(STR_APPS, a_cols, 'STR permit applications')
    apps = fetch_all(api, STR_APPS, ','.join(a_cols))
    need(len(apps) > 10000, f'STR permit applications: only {len(apps)} rows')
    anb, _ = sp_points_to_nb(nbp, apps, 'x', 'y')
    dates = [parse_ts(r.get('application_date')) for r in apps]
    last = max(d for d in dates if d)
    y0 = min(d.year for d in dates if d)
    years = list(range(y0, last.year + 1))
    yr = [[[0] * len(STR_STATUS) for _ in STR_GROUPS] for _ in years]
    nby = [Counter() for _ in range(72)]
    undated = unknown = 0
    for r, d, nb in zip(apps, dates, anb):
        s = (r.get('current_status') or '').strip()
        if s not in STR_STATUS:
            unknown += 1
            continue
        if d is None:
            undated += 1
            continue
        g, k, si = str_group(r.get('license_type'), r.get('residential_subtype')), d.year - y0, STR_STATUS.index(s)
        yr[k][g][si] += 1
        if nb >= 0:
            nby[nb][(k, g, si)] += 1
    need(unknown < 50, f'STR permit applications: {unknown} rows with an unknown status. Add it to STR_STATUS.')
    return {
        'ds': [STR_ACTIVE, STR_APPS, STR_NC], 'last': last.strftime('%Y-%m-%d'),
        'cat': STR_CAT, 'pts': pts, 'operators': [[k, v] for k, v in sorted(operators.items(), key=lambda kv: (-kv[1], kv[0]))],
        'nc': {'B': B, 'OP': OP, 'ST': ST, 'rows': ncr},   # rows: [nb, building, whole(1)/partial(0)/not stated(2), bedrooms, operatorType, status]
        'groups': STR_GROUPS, 'status': STR_STATUS, 'years': years, 'yr': yr,
        'nby': [[v for key in sorted(c) for v in (*key, c[key])] for c in nby],   # [yearIdx, group, status, n, ...]
        'total': len(pts), 'apps': len(apps), 'undated': undated,
    }


# ---------------------------------------------------------------- blight and code enforcement
CE_CASES, CE_VIOL, CE_INSP, CE_HEAR, CE_GRASS, CE_ABATE = 'u6yx-v2tw', '3ehi-je3s', 'uh5a-f7uw', '44ct-56tr', 'xhih-vxs6', 'xv8z-gn8b'
# The City moved older code enforcement records into this system in 2009 (about 76,000 cases and 59,000 hearings
# are dated 2009), and filings settle into a steady pattern later, so yearly charts start here.
CE_START = 2016
CE_STAGES = ['1 - Inspection', '2 - Title Research', '3 - Hearing', '4 - Judgment', '5 - In Compliance', 'X - Processing']
CE_AGES = [90, 365, 730, 1826]   # open for: under 90 days, 90 days-1 year, 1-2 years, 2-5 years, over 5 years
CE_HEAR_GROUPS = ['Guilty', 'Dismissed', 'Reset', 'Pending', 'Other']
CE_INSP_GROUPS = ['Inspection', 'Reinspection', 'Posting a notice', 'Other']


def ce_hearing_group(j):
    j = (j or '').strip().lower()
    if j.startswith('guilty') or j.startswith('found guilty'):
        return 0
    if j.startswith('dismissed'):
        return 1
    if j.startswith('reset') or j.startswith('rescheduled'):
        return 2
    if j.startswith('result pending'):
        return 3
    return 4


def ce_insp_group(t):
    t = (t or '').strip().lower()
    if t == 'inspection':
        return 0
    if 'reinspection' in t or 'compliance inspection' in t or 'follow-up' in t:
        return 1
    if 'posting' in t:
        return 2
    return 3


def blight_dots(rows, filed, nbs, grass, gfiled, gnb, ab, anb, today, win0):
    """Dots for the blight map, from the rows build_blight already has. cases: every open case and every case filed
    in the past 12 months (o 1 open; s stage index for open cases, -1 closed; i first inspection: 0 violation,
    1 no violation, 2 not yet or other). grass: grass-cutting cases open or filed in the past 12 months. abate:
    properties in abatement now (the rows fetched carry no dates). Each carries its street address (a, A)."""
    sp = lambda r: dot_xy(*(sp_lonlat(fnum(r.get('xpos')), fnum(r.get('ypos'))) or (None, None)))
    cases = []
    for r, f, nb in zip(rows, filed, nbs):
        is_open = r.get('o_c') == 'Open'
        if f is None or nb < 0 or not (is_open or win0 <= f.date() <= today):
            continue
        p = sp(r)
        if p is None:
            continue
        st = (r.get('stage') or '').strip()
        res = (r.get('initinspresult') or '').lower()
        cases.append({'day': f.date(), 'x': p[0], 'y': p[1], 'nb': nb, 'o': int(is_open),
                      's': CE_STAGES.index(st) if is_open and st in CE_STAGES else -1,
                      'i': 0 if res.startswith('violation') else 1 if res.startswith('no violation') else 2, 'ad': clean_addr(r.get('geoaddress'))})
    gr = []
    for r, f, nb in zip(grass, gfiled, gnb):
        is_open = r.get('o_c') == 'Open'
        if f is None or nb < 0 or f.date() > today or not (is_open or f.date() >= win0):
            continue
        p = dot_xy(fnum(r.get('longitude')), fnum(r.get('latitude')))
        if p:
            gr.append({'day': f.date(), 'x': p[0], 'y': p[1], 'nb': nb, 'o': int(is_open), 'ad': clean_addr(r.get('address'))})
    abate = []
    for r, nb in zip(ab, anb):
        if r.get('o_c') == 'Open' and nb >= 0:
            p = sp(r)
            if p:
                abate.append({'day': None, 'x': p[0], 'y': p[1], 'nb': nb, 'ad': clean_addr(r.get('address'))})
    return {'cases': dot_addresses(cases, ['o', 's', 'i']), 'grass': dot_addresses(gr, ['o']), 'abate': dot_addresses(abate, [])}


def build_blight(api, nbp):
    for ds, cols, label in [(CE_CASES, ['casefiled', 'o_c', 'stage', 'xpos', 'ypos', 'initinspresult', 'geoaddress'], 'Code enforcement cases'),
                            (CE_VIOL, ['violationdate', 'violation'], 'Code enforcement violations'),
                            (CE_INSP, ['inspectiondate', 'inspectiontype'], 'Code enforcement inspections'),
                            (CE_HEAR, ['hearingdate', 'judgment'], 'Code enforcement hearings'),
                            (CE_GRASS, ['casefiled', 'o_c', 'longitude', 'latitude', 'address'], 'Grass cutting'),
                            (CE_ABATE, ['o_c', 'stage', 'xpos', 'ypos', 'address'], 'Abatements')]:
        api.require_columns(ds, cols, label)
    # cases: every open case, and every case filed since CE_START
    rows = fetch_all(api, CE_CASES, 'casefiled,o_c,stage,xpos,ypos,initinspresult,geoaddress', where=f"o_c = 'Open' OR casefiled >= '{CE_START}-01-01'")
    need(len(rows) > 20000, f'Code enforcement cases: only {len(rows)} rows')
    filed = [parse_ts(r.get('casefiled')) for r in rows]
    need(sum(f is None for f in filed) < 50, 'Code enforcement cases: unreadable casefiled dates')
    nbs, _ = sp_points_to_nb(nbp, rows, 'xpos', 'ypos')
    today = max(f for f in filed if f).date()          # "now" is the newest case in the data
    win0 = today - dt.timedelta(days=364)
    years = list(range(CE_START, today.year + 1))
    NS, NA = len(CE_STAGES), len(CE_AGES) + 1
    openAge = [[[0] * NA for _ in range(NS)] for _ in range(73)]   # row 72 = whole city
    new12 = [[0, 0, 0] for _ in range(72)]    # by first inspection: violation found, no violation, not inspected yet / other
    yr = [[[0, 0] for _ in years] for _ in range(73)]               # [open, closed] per year filed; row 72 = whole city
    unknown_stage = Counter()
    for r, f, nb in zip(rows, filed, nbs):
        if f is None:
            continue
        is_open = r.get('o_c') == 'Open'
        if is_open:
            s = (r.get('stage') or '').strip()
            if s not in CE_STAGES:
                unknown_stage[s] += 1
                continue
            age = sum((today - f.date()).days >= a for a in CE_AGES)
            for k in (72, nb) if nb >= 0 else (72,):
                openAge[k][CE_STAGES.index(s)][age] += 1
        if f.year >= CE_START:
            for k in (72, nb) if nb >= 0 else (72,):
                yr[k][f.year - CE_START][0 if is_open else 1] += 1
        if nb >= 0 and f.date() >= win0:
            res = (r.get('initinspresult') or '').lower()
            new12[nb][0 if res.startswith('violation') else 1 if res.startswith('no violation') else 2] += 1
    need(sum(unknown_stage.values()) < 50, f'Code enforcement cases: open cases in unknown stages {dict(unknown_stage)}. Add them to CE_STAGES.')
    # overgrown lots (grass cutting cases), all rows
    grass = fetch_all(api, CE_GRASS, 'casefiled,o_c,longitude,latitude,address')
    need(len(grass) > 5000, f'Grass cutting: only {len(grass)} rows')
    gnb, _ = points_to_nb(nbp, grass)
    gfiled = [parse_ts(r.get('casefiled')) for r in grass]
    gy0 = 2021   # the City's grass-cutting cases start in earnest in 2021 (a few dozen a year before)
    gyears = list(range(gy0, today.year + 1))
    gyr = [[[0, 0] for _ in gyears] for _ in range(73)]
    g12 = [0] * 72
    for r, f, nb in zip(grass, gfiled, gnb):
        if f is None or f.year < gy0 or f.date() > today:
            continue
        for k in (72, nb) if nb >= 0 else (72,):
            gyr[k][f.year - gy0][0 if r.get('o_c') == 'Open' else 1] += 1
        if nb >= 0 and f.date() >= win0:
            g12[nb] += 1
    # properties in abatement now, and how closed abatement cases ended
    ab = fetch_all(api, CE_ABATE, 'o_c,stage,xpos,ypos,address')
    need(len(ab) > 1000, f'Abatements: only {len(ab)} rows')
    anb, _ = sp_points_to_nb(nbp, ab, 'xpos', 'ypos')
    abOpen = [0] * 72
    abEnd = Counter()
    for r, nb in zip(ab, anb):
        if r.get('o_c') == 'Open':
            if nb >= 0:
                abOpen[nb] += 1
        else:
            abEnd[re.sub(r'^Closed:?\s*', '', (r.get('stage') or '').strip()) or 'Not stated'] += 1
    # hearings, violations and inspections: counted by the API
    # one request each: hearings through "today" by year and judgment, plus those after it (w = 'up');
    # violations in the past 12 months (w = 0) and the 12 before (w = 1)
    end = f'{today.isoformat()}T23:59:59'
    hear = api.get(f'/resource/{CE_HEAR}.json', {'$select': f"date_extract_y(hearingdate) as y, judgment, case(hearingdate > '{end}', 'up', true, 'past') as w, count(*) as n",
                                                 '$where': f"hearingdate >= '{CE_START}-01-01'",
                                                 '$group': 'y, judgment, w', '$order': 'w, y, judgment', '$limit': 5000})
    hyr = [[0] * len(CE_HEAR_GROUPS) for _ in years]
    upcoming = 0
    for r in hear:
        if r['w'] == 'up':
            upcoming += int(r['n'])
        else:
            hyr[int(r['y']) - CE_START][ce_hearing_group(r.get('judgment'))] += int(r['n'])
    prev0 = win0 - dt.timedelta(days=365)
    viol = {}
    for r in api.get(f'/resource/{CE_VIOL}.json', {'$select': f"violation, case(violationdate >= '{win0}', 0, violationdate <= '{win0 - dt.timedelta(days=1)}T23:59:59', 1) as w, count(*) as n",
                                                   '$where': f"violationdate >= '{prev0}' AND violationdate <= '{end}'",
                                                   '$group': 'violation, w', '$order': 'violation, w', '$limit': 5000}):
        if r.get('w') is not None:
            v = re.sub(r'\s+', ' ', (r.get('violation') or '').strip()) or 'Not stated'
            viol.setdefault(v, [0, 0])[int(r['w'])] += int(r['n'])
    V = sorted(viol.items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))
    insp = api.get(f'/resource/{CE_INSP}.json', {'$select': 'date_trunc_ym(inspectiondate) as m, inspectiontype, count(*) as n',
                                                 '$where': f"inspectiondate >= '{CE_START}-01-01' AND inspectiondate <= '{today.isoformat()}T23:59:59'",
                                                 '$group': 'm, inspectiontype', '$order': 'm, inspectiontype', '$limit': 50000})
    imon = [[0] * len(CE_INSP_GROUPS) for _ in range(month_index(today, CE_START, 1) + 1)]
    for r in insp:
        m = parse_ts(r['m'])
        imon[month_index(m, CE_START, 1)][ce_insp_group(r.get('inspectiontype'))] += int(r['n'])
    dots = blight_dots(rows, filed, nbs, grass, gfiled, gnb, ab, anb, today, win0)
    return {
        'dots': dots,
        'ds': [CE_CASES, CE_VIOL, CE_INSP, CE_HEAR, CE_GRASS, CE_ABATE], 'last': today.isoformat(), 'winStart': win0.isoformat(),
        'stages': CE_STAGES, 'ages': CE_AGES, 'openAge': openAge, 'new12': new12,
        'years': years, 'yr': yr,
        'gyears': gyears, 'gyr': gyr, 'g12': g12,
        'abOpen': abOpen, 'abEnd': sorted(abEnd.items(), key=lambda kv: (-kv[1], kv[0])),
        'hearGroups': CE_HEAR_GROUPS, 'hear': hyr, 'upcoming': upcoming,
        'viol': [[k, *v] for k, v in V[:25]], 'violTotal': [sum(v[0] for _, v in V), sum(v[1] for _, v in V)],
        'inspGroups': CE_INSP_GROUPS, 'insp': imon,
        'open': sum(map(sum, openAge[72])), 'total': len(rows),
        'noLoc': sum(nb < 0 for nb in nbs),
    }


# ---------------------------------------------------------------- building permits
PERMITS = 'rcm3-fn58'
PERMIT_START = 2012   # the first full year of permits in this dataset
PERMIT_CATS = ['New construction', 'Renovation and repair', 'Demolition', 'Solar and EV chargers', 'Pools and accessory buildings',
               'Electrical', 'Mechanical and plumbing', 'Signs', 'Other']
PERMIT_CODES = {'NEWC': 0, 'RNVN': 1, 'RNVS': 1, 'RENO': 1, 'REPR': 1, 'DEMI': 1, 'ROOF': 1, 'ROTF': 1, 'DEMO': 2,
                'SOLR': 3, 'SAPP': 3, 'EVCH': 3, 'EVIN': 3, 'ACCS': 4, 'POOL': 4,
                'SERV': 5, 'ERPR': 5, 'EVAC': 5, 'ECOA': 5, 'EGEN': 5, 'ETMP': 5, 'EFLO': 5, 'EANN': 5, 'MOVS': 5,
                'FGAS': 6, 'HVAC': 6, 'MECH': 6, 'HOOD': 6, 'MOVG': 6, 'PLMB': 6, 'HOIS': 6, 'MMAN': 6,
                'SATT': 7, 'ESGN': 7, 'SBNR': 7, 'SBIL': 7, 'SMRL': 7}   # any other code: Other
PERMIT_LU = ['Single-family', 'Two-family', 'Multi-family', 'Business or mixed use', 'Other or not stated']
PERMIT_LU_MAP = {'Single Family': 0, 'Two-Family': 1, 'Half of a Party Wall Double': 1, 'Three to Four Family': 2, 'Multi-Family': 2,
                 'Multi-Family (More than Four Units)': 2, 'Single Unit in Multi-Family Dwelling': 2, 'Business Use': 3, 'Mixed Use': 3}
PERMIT_POINTS = (0, 2, 3)   # categories small enough to map permit by permit


def build_permits(api, nbp):
    cols = ['code', 'type', 'filingdate', 'issuedate', 'landuse', 'location_1', 'address']
    api.require_columns(PERMITS, cols, 'Permits')
    # permits issued per year and code, counted by the API
    # (each group's newest issue date comes along, so the newest overall needs no request of its own)
    yrows = api.get(f'/resource/{PERMITS}.json', {'$select': 'date_extract_y(issuedate) as y, code, count(*) as n, max(issuedate) as m',
                                                 '$where': f"issuedate >= '{PERMIT_START}-01-01'", '$group': 'y, code', '$order': 'y, code', '$limit': 5000})
    need(len(yrows) > 100, f'Permits: only {len(yrows)} year/code counts')
    last = parse_ts(max(r['m'] for r in yrows))
    today = last.date()
    years = list(range(PERMIT_START, today.year + 1))
    yr = [[0] * len(PERMIT_CATS) for _ in years]
    for r in yrows:
        y = int(r['y'])
        if PERMIT_START <= y <= today.year:   # a few permits carry issue dates in the future
            yr[y - PERMIT_START][PERMIT_CODES.get((r.get('code') or '').strip(), 8)] += int(r['n'])
    # permits issued in the past 12 months, row by row
    win0 = today - dt.timedelta(days=364)
    rows = fetch_all(api, PERMITS, ','.join(cols), where=f"issuedate >= '{win0}' AND issuedate <= '{today}T23:59:59'")
    need(len(rows) > 5000, f'Permits: only {len(rows)} issued in the past 12 months')
    nbs, xy = points_to_nb(nbp, [{'longitude': (r.get('location_1') or {}).get('longitude'), 'latitude': (r.get('location_1') or {}).get('latitude')} for r in rows])
    nbc = [Counter() for _ in range(72)]
    days = [[[] for _ in PERMIT_LU] for _ in PERMIT_CATS]
    pts, dots = [], []
    for r, nb, (x, y) in zip(rows, nbs, xy):
        c = PERMIT_CODES.get((r.get('code') or '').strip(), 8)
        lu = PERMIT_LU_MAP.get((r.get('landuse') or '').strip(), 4)
        issued, filed = parse_ts(r.get('issuedate')), parse_ts(r.get('filingdate'))
        if nb >= 0:
            nbc[nb][(c, lu)] += 1
        d = days_between(filed, issued)
        if d is not None:
            days[c][lu].append(d)
        if c in PERMIT_POINTS and nb >= 0:
            pts.append([x, y, c, nb, lu, (issued.date() - win0).days])
        loc = r.get('location_1') or {}
        p = dot_xy(fnum(loc.get('longitude')), fnum(loc.get('latitude'))) if nb >= 0 and issued else None
        if p:   # dots: every located permit; tn the City's permit type, f days from filing to issue (-1 unknown)
            dots.append({'day': issued.date(), 'x': p[0], 'y': p[1], 'nb': nb, 'c': c, 'lu': lu, 'f': -1 if d is None else int(d + 0.5),
                         'tn': re.sub(r'\s+', ' ', (r.get('type') or '').strip()) or 'Not stated', 'ad': clean_addr(r.get('address'))})
    stat = lambda v: [len(v), median(v), p90(v)]
    return {
        'ds': PERMITS, 'last': today.isoformat(), 'winStart': win0.isoformat(),
        'cats': PERMIT_CATS, 'lu': PERMIT_LU, 'years': years, 'yr': yr,
        'nbc': [[v for k in sorted(c) for v in (*k, c[k])] for c in nbc],   # [cat, landUse, n, ...] per nb, past 12 months
        'days': [[stat(v) for v in row] + [stat([d for v in row for d in v])] for row in days],  # [n, median, p90] per land use, then all
        'pts': sorted(pts), 'total': len(rows), 'noLoc': sum(nb < 0 for nb in nbs),
        'dots': dot_typed(dots, ['c', 'lu', 't', 'f'], addr=True),
    }


def dot_typed(recs, cols, addr=False):
    """dot_pack, with each record's type name `tn` stored as an index `t` into the list `T` (and with addr, its
    address as in dot_addresses)."""
    T, ti = dot_dict([r['tn'] for r in recs])
    for r, k in zip(recs, ti):
        r['t'] = k
    out = dot_addresses(recs, cols) if addr else dot_pack(recs, cols)
    out['T'] = T
    return out


# ---------------------------------------------------------------- new businesses (occupational licenses)
BIZ_APPS, BIZ_NOW = 'abc4-h3u3', 'hjcd-grvu'
BIZ_START = 2018   # the license application dataset starts in 2018
BIZ_OUT = ['Approved or issued', 'Listed as filed or in review', 'Withdrawn or incomplete', 'Denied', 'Duplicate or wrong type', 'Not stated']
BIZ_SECTORS = 10   # sectors shown by name (by count in the past 12 months); the rest are "Other sectors"
BIZ_VENDOR = 'Event and street vendors'


def biz_outcome(s):
    s = (s or '').strip().lower()
    if not s:
        return 5
    if s in ('issued', 'approved', 'expired') or 'issuance' in s:
        return 0
    if 'review' in s or s in ('application filed', 'gtb hearing required'):
        return 1
    if s.startswith('denied') or 'denial' in s or 'does not meet' in s or 'misrepresentation' in s or 'revoked' in s:
        return 3
    if 'duplicate' in s or 'incorrect application type' in s or s.startswith('void') or 'changed' in s:
        return 4
    return 2   # withdrew, failed to respond or pay, deficient, application expired, reminders


def biz_type_key(s):
    """Business types are spelled slightly differently in the two datasets ('Restaurants (table…' vs 'Restaurants(table…')."""
    return re.sub(r'\s+', ' ', re.sub(r'\s*\(\s*', '(', (s or '').lower())).strip()


def build_biz(api, nbp):
    a_cols = ['application_filed', 'currentstatus', 'category', 'businesstype', 'ishome', 'longitude', 'latitude', 'address']
    n_cols = ['businesstype', 'businessstartdate', 'longitude', 'latitude', 'address', 'businessname', 'ownername']
    api.require_columns(BIZ_APPS, a_cols, 'Business license applications')
    api.require_columns(BIZ_NOW, n_cols, 'Occupational business licenses')
    apps = fetch_all(api, BIZ_APPS, ','.join(a_cols))
    need(len(apps) > 10000, f'Business license applications: only {len(apps)} rows')
    clean = lambda s: re.sub(r'\s+', ' ', (s or '').strip())
    filed = [parse_ts(r.get('application_filed')) for r in apps]
    today = max(f for f in filed if f).date()
    win0 = today - dt.timedelta(days=364)
    years = list(range(BIZ_START, today.year + 1))
    # sectors (NAICS) in order of the past 12 months; applications without one are "Not stated"
    cat = [clean(r.get('category')) or 'Not stated' for r in apps]
    S = [c for c in ranked(Counter(c for c, f in zip(cat, filed) if f and f.date() >= win0)) if c != 'Not stated'][:BIZ_SECTORS]
    S += ['Other sectors', 'Not stated']
    si = {c: k for k, c in enumerate(S)}
    sector = lambda c: si.get(c, len(S) - 2)
    nbs, _ = points_to_nb(nbp, apps)
    yr = [[0] * len(S) for _ in years]
    yo = [[[0] * len(BIZ_OUT) for _ in S] for _ in years]
    nby = [Counter() for _ in range(72)]
    new12 = [Counter() for _ in range(72)]
    home = [[0, 0] for _ in years]   # [home-based, not] per year filed
    for r, f, c, nb in zip(apps, filed, cat, nbs):
        if f is None or f.year < BIZ_START or f.date() > today:
            continue
        k, s = f.year - BIZ_START, sector(c)
        yr[k][s] += 1
        yo[k][s][biz_outcome(r.get('currentstatus'))] += 1
        h = (r.get('ishome') or '').strip()
        if h in ('True', 'False'):
            home[k][0 if h == 'True' else 1] += 1
        if nb >= 0:
            nby[nb][(k, s)] += 1
            if f.date() >= win0:
                new12[nb][s] += 1
    # businesses licensed now, given a sector through the applications' type -> sector pairs
    t2s = defaultdict(Counter)
    for r, c in zip(apps, cat):
        if r.get('businesstype') and c != 'Not stated':
            t2s[biz_type_key(r['businesstype'])][c] += 1
    now = fetch_all(api, BIZ_NOW, ','.join(n_cols))
    need(len(now) > 10000, f'Occupational business licenses: only {len(now)} rows')
    # owner names are what keep business names that are only a person's name off the map (just_a_person)
    no_owner = sum(not (r.get('ownername') or '').strip() for r in now)
    need(no_owner < len(now) * 0.05, f'Occupational business licenses: {no_owner} rows without an owner name, so business names that are only a person\'s name could not be left out')
    S2 = S[:-2] + ['Other sectors', BIZ_VENDOR, 'Other or not stated']
    s2i = {c: k for k, c in enumerate(S2)}
    nnb, _ = points_to_nb(nbp, now)
    nowNb = [Counter() for _ in range(72)]
    now_s = []
    for r, nb in zip(now, nnb):
        t = (r.get('businesstype') or '').strip()
        if re.match(r'(special events|mardi gras|flea market|artist-painting)', t, re.I):
            s = s2i[BIZ_VENDOR]
        else:
            c = t2s.get(biz_type_key(t))
            s = s2i.get(ranked(c)[0], s2i['Other sectors']) if c else len(S2) - 1
        now_s.append(s)
        if nb >= 0:
            nowNb[nb][s] += 1
    sparse = lambda c: [v for key in sorted(c) for v in ((*key, c[key]) if isinstance(key, tuple) else (key, c[key]))]
    # dots: every located application since BIZ_START (s sector, o outcome, h home-based 1 / not 0 / not stated -1,
    # t business type), and every located business licensed now (day licensed since, s sector in S2, t type).
    # Street addresses (and, for current licenses, business names) are kept except where the business may be
    # someone's home: applications marked home-based; current licenses at an address that a home-based application
    # names, of a home-based license type, or at an apartment. (The current-license number doesn't match the
    # applications' numbers, so their home-based flag can't be carried over directly.)
    tn = lambda v: re.sub(r'\s+', ' ', (v or '').strip()) or 'Not stated'
    akey = lambda v: clean_addr(v).upper()
    homes = {akey(r.get('address')) for r in apps if (r.get('ishome') or '').strip() == 'True'} - {''}
    home_now = lambda r: (akey(r.get('address')) in homes or tn(r.get('businesstype')).lower().startswith('home based')
                          or re.search(r'\b(APT|APARTMENT)\b', akey(r.get('address'))) is not None)
    da, dn = [], []
    for r, f, c, nb in zip(apps, filed, cat, nbs):
        p = dot_xy(fnum(r.get('longitude')), fnum(r.get('latitude'))) if nb >= 0 and f and BIZ_START <= f.year and f.date() <= today else None
        if p:
            h = (r.get('ishome') or '').strip()
            da.append({'day': f.date(), 'x': p[0], 'y': p[1], 'nb': nb, 's': sector(c), 'o': biz_outcome(r.get('currentstatus')),
                       'h': 1 if h == 'True' else 0 if h == 'False' else -1, 'tn': tn(r.get('businesstype')),
                       'ad': None if h == 'True' else clean_addr(r.get('address'))})
    for r, nb, s in zip(now, nnb, now_s):
        p = dot_xy(fnum(r.get('longitude')), fnum(r.get('latitude'))) if nb >= 0 else None
        if p:
            sd = parse_ts(r.get('businessstartdate'))
            dn.append({'day': sd.date() if sd and sd.year > 1900 else None,   # 1900-01-01 stands for 'not recorded'
                       'x': p[0], 'y': p[1], 'nb': nb, 's': s, 'tn': tn(r.get('businesstype')),
                       'ad': None if home_now(r) else clean_addr(r.get('address')),
                       # a name that is only the owner's own name is left out ('' = no name); ownername isn't kept
                       'bn': None if home_now(r) else '' if just_a_person(r.get('businessname'), r.get('ownername')) else clean_name(r.get('businessname'))})
    return {
        'dots': {'apps': dot_typed(da, ['s', 'o', 'h', 't'], addr=True), 'now': dot_typed(dn, ['s', 't'], addr=True)},
        'ds': [BIZ_APPS, BIZ_NOW], 'last': today.isoformat(), 'winStart': win0.isoformat(),
        'S': S, 'out': BIZ_OUT, 'years': years, 'yr': yr, 'yo': yo, 'home': home,
        'nby': [sparse(c) for c in nby],      # [yearIdx, sector, n, ...] per nb
        'new12': [sparse(c) for c in new12],  # [sector, n, ...] per nb, past 12 months
        'S2': S2, 'now': [sparse(c) for c in nowNb], 'nowTotal': len(now), 'nowNoLoc': sum(nb < 0 for nb in nnb),
        'total': len(apps), 'noLoc': sum(nb < 0 for nb in nbs),
    }


# Data files of the pages added with the 311 / housing / business set, and when each counts as stale
# (file, label, field holding its newest record date, days without a new record before warning).
NEW_FILES = ['311.json', 'treereq.json', 'drainreq.json', 'basins.json', 'streetreq.json', 'roadwork.json', 'str.json', 'blight.json', 'permits.json', 'biz.json']
STALE = [('311.json', '311 calls', 'last', 7), ('str.json', 'Short-term rental permit applications', 'last', 14),
         ('blight.json', 'Code enforcement cases', 'last', 14), ('permits.json', 'Permits', 'last', 14),
         ('biz.json', 'Business license applications', 'last', 14)]


# Every dataset the pipeline reads (besides Calls for Service, whose id changes each year): when its "last updated"
# date is checked, and how many days that date may stand still before the run fails (None: it changes rarely or
# never, so no limit). "daily" datasets cost nothing extra to check: one catalog request covers them all.
# "monthly" ones aren't in the catalog and are checked with a request each on the 1st. Measured cadences are in
# REFERENCE.md ("The daily refresh").
DATASETS = {
    NB_DS: ('Neighborhood boundaries', 'monthly', None),       # last changed 2015
    PD_DS: ('Police districts', 'monthly', None),              # last changed 2015
    POP_DS: ('Neighborhood population 2020', 'daily', None),   # last changed 2023
    '22q2-dqpb': ('Street centerlines', 'daily', None),        # a few edits a month
    'ay9z-ynxz': ('NOPD drone flights', 'daily', 60),          # loaded in occasional batches
    'xxb5-5azv': ('CPC projects', 'daily', 5),                 # the rest: reloaded every night
    SR_DS: ('311 calls', 'daily', 5),
    STR_ACTIVE: ('Active short-term rental licenses', 'daily', 5),
    STR_APPS: ('Short-term rental permit applications', 'daily', 5),
    STR_NC: ('Non-commercial short-term rental licenses', 'daily', 5),
    CE_CASES: ('Code enforcement cases', 'daily', 5),
    CE_VIOL: ('Code enforcement violations', 'daily', 5),
    CE_INSP: ('Code enforcement inspections', 'daily', 5),
    CE_HEAR: ('Code enforcement hearings', 'daily', 5),
    CE_GRASS: ('Grass cutting cases', 'daily', 5),
    CE_ABATE: ('Code enforcement abatements', 'daily', 60),    # updated in place every week or two
    PERMITS: ('Permits', 'daily', 5),
    BIZ_APPS: ('Business license applications', 'daily', 5),
    BIZ_NOW: ('Occupational business licenses', 'daily', 5),
    CB_DS: ('Catch basins', 'daily', None),                     # edited a few times a year
    CBW_DS: ('Catch basin cleanings', 'daily', None),           # reloaded every night; newest dated record January 2025
    RW_DPW: ('RoadWork DPW projects', 'daily', None),           # updated nightly; no limit, the page shows its date
    RW_SWB: ('RoadWork SWB projects', 'daily', None),
}
CFS_MAX_DAYS = 5   # the current year's Calls for Service dataset is reloaded every night

# ---------------------------------------------------------------- sanity checks against the last good build
def load_prev(name):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return None


def check_not_collapsed(label, new, old, floor=0.9):
    """A daily refresh should only ever add rows. A big drop means a broken fetch, not news."""
    if old is not None and old > 0:
        need(new >= old * floor, f'{label}: {new} now vs {old} in the last good build. Refusing to publish.')


def dots_ok(label, d, least):
    """A dots object: every column as long as the record count, and at least `least` records."""
    cols = [k for k, v in d.items() if isinstance(v, list) and k not in ('R', 'T', 'A', 'M')]
    need(all(len(d[k]) == d['n'] for k in cols), f'{label} dots: columns of different lengths')
    need(d['n'] >= least, f'{label} dots: only {d["n"]} records')


def validate(name, obj, prev, same_year=True):
    """Checks one rebuilt data file before it's written. prev is the last good version of the same file."""
    if name == 'geo.json':
        need(len(obj['nb']) == 72 and len(obj['pd']) == 8, 'geo: unexpected feature counts')
        need(all(f['r'] for f in obj['nb'] + obj['pd']), 'geo: a feature lost all its rings')
    elif name == 'streets.json':
        check_not_collapsed('street segments', obj['n'], (prev or {}).get('n'))
    elif name == 'drone.json':
        need(len(obj['recs']) > 0 and len(obj['drones']) > 0, 'drone: empty')
        need(all(len(r) == 10 for r in obj['recs']), 'drone: record shape')
        if same_year:
            check_not_collapsed('drone flights', len(obj['recs']), prev and len(prev['recs']))
    elif name == 'cfs.json':
        need(len(obj['TOP']) == 24 and len(obj['types']) == 24, 'cfs: TOP/types length')
        need(len(obj['daily']) == obj['last'] + 1 and len(obj['heat']) == 7 and all(len(h) == 24 for h in obj['heat']), 'cfs: daily/heat shape')
        need(len(obj['nb']) == 72 and len(obj['pd']) == 8 and len(obj['mResp']) == 12, 'cfs: nb/pd/mResp shape')
        need(sum(r[0] + r[1] for r in obj['nb']) > 0.8 * sum(map(sum, obj['daily'])), 'cfs: most calls failed to map to a neighborhood')
        if same_year:
            check_not_collapsed('calls for service', sum(map(sum, obj['daily'])), prev and sum(map(sum, prev['daily'])))
    elif name == 'hist.json':
        need(len(obj) >= 12, 'hist: missing years')
    elif name == 'cpc.json':
        need(len(obj['nbRecent']) == 72 and len(obj['TYP']) == 11 and len(obj['TH']) == 7, 'cpc: shape')
        need(obj['total'] > 1000, 'cpc: suspiciously few cases')
        check_not_collapsed('planning cases', obj['total'], prev and (prev.get('total') or sum(sum(v) for v in prev['typeY'].values())))
    # ---- pages added with the 311 / housing / business set ----
    elif name == '311.json':
        need(len(obj['T']) >= 5 and len(obj['nby']) == 72 and len(obj['openAge']) == 73 and len(obj['nb12']) == 72, '311: shape')
        need(all(len(m) == len(obj['T']) for m in obj['mon']), '311: monthly rows')
        need(obj['total'] > 100000 and obj['recent'] > 20000, '311: suspiciously few requests')
        need(obj['noLoc'] < 0.1 * obj['total'], '311: most requests failed to map to a neighborhood')
        check_not_collapsed('311 requests', obj['total'], prev and prev.get('total'))
        dots_ok('311', obj['dots'], 20000)
    elif name == 'treereq.json':
        n = len(obj['x'])
        need(all(len(obj[k]) == n for k in ('y', 'r', 'd', 'c', 'nb')) and len(obj['R']) >= 2, 'tree requests: shape')
        need(obj['noLoc'] < 0.1 * obj['total'], 'tree requests: most failed to map to a neighborhood')
        check_not_collapsed('311 tree requests', obj['total'], prev and prev.get('total'))
    elif name == 'drainreq.json':
        need(len(obj['G']) >= 2 and obj['noLoc'] < 0.1 * obj['total'], 'drainage requests: shape, or most failed to map')
        check_not_collapsed('311 drainage requests', obj['total'], prev and prev.get('total'))
        dots_ok('drainage requests', obj['dots'], 5000)
    elif name == 'streetreq.json':
        need(len(obj['G']) >= 2 and obj['noLoc'] < 0.1 * obj['total'], 'street requests: shape, or most failed to map')
        check_not_collapsed('311 street requests', obj['total'], prev and prev.get('total'))
        dots_ok('street requests', obj['dots'], 20000)
    elif name == 'roadwork.json':
        need(len(obj['P']) > 200 and all(len(p) == len(obj['pcols']) for p in obj['P']), 'road work: projects')
        need(obj['noLoc'] < 0.1 * obj['total'], 'road work: most segments failed to map to a neighborhood')
        check_not_collapsed('road work segments', obj['total'], prev and prev.get('total'), floor=0.8)
        dots_ok('road work', obj['dots'], 8000)
    elif name == 'basins.json':
        need(obj['matched'] > 0.8 * (obj['matched'] + obj['unmatched']), 'basins: most logged visits matched no basin')
        need(len(obj['yw']) == len(obj['years']), 'basins: shape')
        check_not_collapsed('catch basins', obj['total'], prev and prev.get('total'))
        dots_ok('catch basins', obj['dots'], 50000)
    elif name == 'str.json':
        need(len(obj['nby']) == 72 and len(obj['yr']) == len(obj['years']) and all(len(p) == 9 for p in obj['pts']), 'str: shape')
        need(obj['total'] > 500 and len(obj['nc']['rows']) > 100, 'str: suspiciously few licenses')
        need(sum(p[3] < 0 for p in obj['pts']) < 0.1 * obj['total'], 'str: most licenses failed to map to a neighborhood')
        check_not_collapsed('STR permit applications', obj['apps'], prev and prev.get('apps'))
    elif name == 'blight.json':
        need(len(obj['openAge']) == 73 and len(obj['new12']) == 72 and len(obj['yr']) == 73 and len(obj['gyr']) == 73 and len(obj['abOpen']) == 72, 'blight: shape')
        need(len(obj['hear']) == len(obj['years']) and len(obj['viol']) >= 10 and len(obj['insp']) > 100, 'blight: hearings/violations/inspections')
        need(obj['open'] > 2000 and obj['total'] > 20000, 'blight: suspiciously few cases')
        need(obj['noLoc'] < 0.1 * obj['total'], 'blight: most cases failed to map to a neighborhood')
        check_not_collapsed('code enforcement cases', obj['total'], prev and prev.get('total'))
        for k, lo in (('cases', 2000), ('grass', 200), ('abate', 200)):
            dots_ok('blight ' + k, obj['dots'][k], lo)
    elif name == 'permits.json':
        need(len(obj['nbc']) == 72 and len(obj['yr']) == len(obj['years']) and len(obj['days']) == len(obj['cats']), 'permits: shape')
        need(obj['total'] > 5000, 'permits: suspiciously few permits in the past 12 months')
        need(obj['noLoc'] < 0.1 * obj['total'], 'permits: most permits failed to map to a neighborhood')
        check_not_collapsed('permits issued in the past 12 months', obj['total'], prev and prev.get('total'), floor=0.75)
        dots_ok('permits', obj['dots'], 0.8 * (obj['total'] - obj['noLoc']))
    elif name == 'biz.json':
        need(len(obj['nby']) == 72 and len(obj['new12']) == 72 and len(obj['now']) == 72 and len(obj['yr']) == len(obj['years']), 'biz: shape')
        need(obj['total'] > 10000 and obj['nowTotal'] > 10000, 'biz: suspiciously few licenses')
        need(obj['noLoc'] < 0.1 * obj['total'], 'biz: most applications failed to map to a neighborhood')
        check_not_collapsed('business license applications', obj['total'], prev and prev.get('total'))
        check_not_collapsed('current business licenses', obj['nowTotal'], prev and prev.get('nowTotal'), floor=0.8)
        dots_ok('business applications', obj['dots']['apps'], 0.8 * (obj['total'] - obj['noLoc']))
        dots_ok('current business licenses', obj['dots']['now'], 0.8 * (obj['nowTotal'] - obj['nowNoLoc']))


def central_date(iso_utc):
    """'2026-11-18T06:02:10Z' -> that moment's date in New Orleans (standard time, like `today`)."""
    return (dt.datetime.strptime(iso_utc, '%Y-%m-%dT%H:%M:%SZ') - dt.timedelta(hours=6)).date()


def dumps(obj):
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False)


def report_error(msg):
    print(f"{'::error::' if os.environ.get('GITHUB_ACTIONS') else 'ERROR: '}{msg}", flush=True)


# ---------------------------------------------------------------- main
def main():
    global CHECK_COPIES
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache')
    ap.add_argument('--today')
    ap.add_argument('--full', action='store_true', help="download and rebuild everything, even datasets the City hasn't changed")
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--out', default=DATA, help='write data files here instead of data/')
    a = ap.parse_args()
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.timezone(dt.timedelta(hours=-6))).date()
    full = a.full
    # The 1st of the month is the check day: the datasets that aren't in the catalog (boundaries) and past years of
    # Calls for Service get their "last updated" date checked, and each saved copy's row ids are compared with the City's.
    check_day = today.day == 1 or full
    CHECK_COPIES = check_day and not full
    api = Socrata(a.cache, use_raw=not full)
    state = load_prev('sources.json') or {}
    files = state.get('files', {})                 # data file -> {'key': what it was built from, 'changed': date its content last changed}
    hist_versions = state.get('histVersions', {})  # year -> version of that year's dataset when hist.json last counted it
    copies = dict(state.get('copies', {}))         # ds -> last day its saved copy had to be downloaded again in full, unasked
    FOUND_IDS.update({int(y): i for y, i in state.get('cfsIds', {}).items()})
    prev = {n: load_prev(n) for n in ['geo.json', 'streets.json', 'drone.json', 'cfs.json', 'hist.json', 'cpc.json', *NEW_FILES]}
    out, keys, key_only, failed, alerts = {}, {}, {}, [], []
    watch = {ds: (label, days) for ds, (label, _, days) in DATASETS.items()}

    def unchanged(name, key):
        """True when the last good `name` was built from exactly these inputs, so it can be kept as it is."""
        keys[name] = key
        same = not full and prev[name] is not None and files.get(name, {}).get('key') == key
        if same:
            print(f"  {name}: the City's data hasn't changed, kept", flush=True)
        return same

    def attempt(names, build):
        """Rebuild some data files. If that fails and they have a last good version, keep it and carry on."""
        try:
            build()
        except PipelineError as e:
            if any(prev[n] is None for n in names):
                raise
            report_error(f"{' and '.join(names)} not refreshed, keeping the last good version: {e}")
            for n in names:
                failed.append(n)
                out.pop(n, None)
                keys.pop(n, None)

    # One catalog request: the "last updated" date and columns of every dataset checked daily, this year's Calls for
    # Service (and last year's in January and February, when the City loads its final rows), and on the check day
    # every past year.
    cfs_years = [y for y in range(2014, today.year + 1) if check_day or y >= today.year - (today.month <= 2)
                 or str(y) not in (prev['hist.json'] or {})]
    api.prefetch([ds for ds, (_, how, _) in DATASETS.items() if how == 'daily'] + [cfs_dataset_id(api, y) for y in cfs_years])

    # Boundaries and population: checked monthly / daily, rebuilt only when one of them changed. Every other file is
    # positioned against them, so if they fail, nothing is published.
    print('geo ...', flush=True)
    gk = (files.get('geo.json', {}).get('key') or '').split('|')
    if not check_day and len(gk) == 3 and prev['geo.json'] is not None:
        api.vers.setdefault(NB_DS, gk[0])   # last checked on the 1st
        api.vers.setdefault(PD_DS, gk[1])
    polys = []

    def P():
        """Point-in-polygon lookups (neighborhoods, police districts), built only when some file is rebuilt."""
        if not polys:
            _, nbp, pdp = build_geo(api, prev['geo.json'])
            polys.extend([nbp, pdp])
        return polys

    if unchanged('geo.json', '|'.join(api.version(d) for d in (NB_DS, PD_DS, POP_DS))):
        geo = prev['geo.json']
    else:
        geo, nbp, pdp = build_geo(api, prev['geo.json'])
        polys.extend([nbp, pdp])
        add_population(api, geo)
        validate('geo.json', geo, prev['geo.json'])
        out['geo.json'] = geo
    geo_key = hashlib.sha1(dumps(geo).encode()).hexdigest()[:12]

    def streets():
        # The centerline is re-synced from the City's GIS whether or not anything was edited, so a new version only
        # prompts a look at the segment count and the newest edit, which say whether the streets changed.
        ver = api.version('22q2-dqpb')
        old = files.get('streets.json', {}).get('key') or ''
        if not full and prev['streets.json'] is not None and old.startswith(ver + '|'):
            keys['streets.json'] = old
            print("  streets.json: the City's data hasn't changed, kept", flush=True)
            return
        api.require_columns('22q2-dqpb', ['the_geom', 'roadclass', 'inwater', 'fullnameabv', 'lastupdate'], 'Centerline')
        fp = api.get('/resource/22q2-dqpb.json', {'$select': 'count(*) as n, max(lastupdate) as m'})[0]
        key = f"{ver}|{fp.get('n')}|{fp.get('m')}"
        if not full and prev['streets.json'] is not None and old.split('|')[-2:] == key.split('|')[-2:]:
            key_only['streets.json'] = key
            print('  streets.json: centerline re-synced without street edits, kept', flush=True)
            return
        keys['streets.json'] = key
        out['streets.json'] = build_streets(api)
    print('streets ...', flush=True)
    attempt(['streets.json'], streets)

    # Pages cover the current calendar year once its data exists, else the previous year.
    def drone():
        if unchanged('drone.json', f"{api.version('ay9z-ynxz')}|{geo_key}|{today.year}"):
            return
        try:
            d = build_drone(api, P()[0], today.year)
        except PipelineError as e:
            if 'rows for' not in str(e):
                raise
            if today.month > 1:
                warn(f'Drone flights has no {today.year} flights yet; still showing {today.year - 1}.')
            d = build_drone(api, P()[0], today.year - 1)  # fails too if the dataset is empty
        out['drone.json'] = d
    print('drone ...', flush=True)
    attempt(['drone.json'], drone)

    def cfs():
        cyear = today.year
        ds = cfs_dataset_id(api, cyear)
        if not ds:
            need(today.month <= 2, f'no "Calls for Service {cyear}" dataset in the catalog. Find its id on data.nola.gov and add it to CFS_IDS in pipeline/fetch.py.')
            warn(f'"Calls for Service {cyear}" is not in the catalog yet; still showing {cyear - 1}.')
            cyear -= 1
            ds = cfs_dataset_id(api, cyear)
        elif today.month == 1 and int(api.get(f'/resource/{ds}.json', {'$select': 'count(*) as n'})[0]['n']) == 0:
            cyear -= 1  # the new year's dataset exists but is still empty
            ds = cfs_dataset_id(api, cyear)
        else:
            watch[ds] = (f'Calls for Service {cyear}', CFS_MAX_DAYS)
        hist = dict(prev['hist.json'] or {})
        version = api.version(ds)
        cur = None
        if not (unchanged('cfs.json', f'{ds}|{version}|{geo_key}') and str(cyear) in hist):
            keys['cfs.json'] = f'{ds}|{version}|{geo_key}'
            nbp, pdp = P()
            out['cfs.json'], cur = build_cfs(api, nbp, pdp, geo, cyear, ds)

        print('history ...', flush=True)
        # Past years are closed, but the City loads each year's last rows on January 1 and has occasionally
        # touched old years later. A year is recounted only when its dataset's version moved: last year is
        # checked daily in January and February, every year on the check day.
        hist = {k: v for k, v in hist.items() if int(k) < cyear}
        check = range(2014, cyear) if check_day else [cyear - 1] if today.month <= 2 else []
        for y in range(2014, cyear):
            v = api.version(cfs_dataset_id(api, y)) if (y in check or str(y) not in hist) else None
            if str(y) not in hist or (v and hist_versions.get(str(y)) and v != hist_versions[str(y)]):
                print(f'  counting {y}', flush=True)
                hist[str(y)] = hist_year(api, y)
            if v:
                hist_versions[str(y)] = v
        if cur is not None:
            hist[str(cyear)] = cur
            hist_versions[str(cyear)] = version  # so the year's final load, next January 1, triggers a recount
        else:
            hist[str(cyear)] = prev['hist.json'][str(cyear)]
        out['hist.json'] = dict(sorted(hist.items()))
    print('calls for service ...', flush=True)
    attempt(['cfs.json', 'hist.json'], cfs)

    # Upcoming hearings and the 365-day window are computed as of the day the City loaded the data (it reloads
    # every night), so the file changes when the City's data does, not merely because a day went by.
    def cpc():
        version = api.version('xxb5-5azv')
        if not unchanged('cpc.json', f'{version}|{geo_key}'):
            out['cpc.json'] = build_cpc(api, P()[0], today if a.today else min(today, central_date(version)))
    print('planning cases ...', flush=True)
    attempt(['cpc.json'], cpc)

    # ---- pages added with the 311 / housing / business set: each file is rebuilt when its dataset(s) or geo changed
    def sr():  # 311.json and the trees, drainage and streets pages' requests come from the same rows
        key = f'{api.version(SR_DS)}|{geo_key}'
        if not (unchanged('311.json', key) & unchanged('treereq.json', key) & unchanged('drainreq.json', key) & unchanged('streetreq.json', key)):
            out['treereq.json'], out['drainreq.json'], out['streetreq.json'], out['311.json'] = build_311(api, P()[0])
    print('311 requests ...', flush=True)
    attempt(['311.json', 'treereq.json', 'drainreq.json', 'streetreq.json'], sr)

    def roadwork():  # both project lists are updated nightly: downloaded (one request each) when either version moves
        if not unchanged('roadwork.json', f'{api.version(RW_DPW)}|{api.version(RW_SWB)}|{geo_key}'):
            out['roadwork.json'] = build_roadwork(api, P()[0])
    print('road work ...', flush=True)
    attempt(['roadwork.json'], roadwork)

    def basins():  # the inventory by its version; the cleaning log, reloaded nightly, by its content (one small request)
        if not unchanged('basins.json', f'{api.version(CB_DS)}|{cb_fingerprint(api)}|{geo_key}'):
            out['basins.json'] = build_basins(api, P()[0])
    print('catch basins ...', flush=True)
    attempt(['basins.json'], basins)

    def strs():
        if not unchanged('str.json', '|'.join([api.version(d) for d in (STR_ACTIVE, STR_APPS, STR_NC)] + [geo_key])):
            out['str.json'] = build_str(api, P()[0])
    print('short-term rentals ...', flush=True)
    attempt(['str.json'], strs)

    def blight():
        if not unchanged('blight.json', '|'.join([api.version(d) for d in (CE_CASES, CE_VIOL, CE_INSP, CE_HEAR, CE_GRASS, CE_ABATE)] + [geo_key])):
            out['blight.json'] = build_blight(api, P()[0])
    print('blight and code enforcement ...', flush=True)
    attempt(['blight.json'], blight)

    def permits():
        if not unchanged('permits.json', f'{api.version(PERMITS)}|{geo_key}'):
            out['permits.json'] = build_permits(api, P()[0])
    print('building permits ...', flush=True)
    attempt(['permits.json'], permits)

    def biz():
        if not unchanged('biz.json', f'{api.version(BIZ_APPS)}|{api.version(BIZ_NOW)}|{geo_key}'):
            out['biz.json'] = build_biz(api, P()[0])
    print('new businesses ...', flush=True)
    attempt(['biz.json'], biz)

    for name in [n for n in out if n != 'geo.json']:
        same_year = (prev[name] or {}).get('year') == out[name].get('year') if name in ('drone.json', 'cfs.json') else True
        attempt([name], lambda: validate(name, out[name], prev[name], same_year))
    if 'cfs.json' in failed and 'hist.json' not in failed:
        attempt(['hist.json'], lambda: need(False, 'calls for service failed'))

    # The City sometimes stops updating a dataset. That isn't a reason to stop the site, but it's worth a look.
    cur = {n: out.get(n) or prev[n] for n in prev}
    cfs_d, drone_d, cpc_d = cur['cfs.json'], cur['drone.json'], cur['cpc.json']
    cfs_last = dt.date(cfs_d['year'], 1, 1) + dt.timedelta(days=cfs_d['last'])
    drone_last = dt.date(drone_d['year'], 1, 1) + dt.timedelta(days=max(r[0] for r in drone_d['recs']))
    if (today - cfs_last).days > 7:
        warn(f'Calls for Service has no calls after {cfs_last} ({(today - cfs_last).days} days ago).')
    if (today - drone_last).days > 45:
        warn(f'Drone flights has no flights after {drone_last} ({(today - drone_last).days} days ago).')
    if cpc_d['lastFiled'] < (today - dt.timedelta(days=30)).isoformat():
        warn(f"CPC Projects has no filings after {cpc_d['lastFiled']}.")
    for name, label, field, days in STALE:
        d = cur.get(name)
        if d and d.get(field) and d[field][:10] < (today - dt.timedelta(days=days)).isoformat():
            warn(f'{label} has no records after {d[field][:10]}.')
    # A dataset the City normally reloads every night but hasn't for days means its feed broke: fail the run, so the
    # owner hears about it instead of the page quietly going stale.
    for ds, (label, days) in sorted(watch.items()):
        if days and ds in api.vers:
            age = (today - central_date(api.vers[ds])).days
            if age > days:
                alerts.append(f'{label} ({ds}) was last updated by the City on {central_date(api.vers[ds])}, {age} days ago; '
                              f'it normally updates at least every {days} days. Its page still shows that data.')
    # A saved copy downloaded again in full twice within a few days means the GitHub cache isn't keeping it between
    # runs (or it keeps disagreeing with the City), and every day would cost a full download.
    for ds, why in sorted(FULL_DOWNLOADS.items()):
        last = copies.get(ds)
        if last and (today - dt.date.fromisoformat(last)).days <= 3:
            alerts.append(f'{ds} was downloaded again in full ({why}), as it was on {last}. The saved copy in .cache/raw is not '
                          'surviving between runs: check the cache steps of the workflow.')
        else:
            warn(f'{ds} was downloaded again in full ({why}). Expected after a long pause; if it repeats, check the workflow cache.')
        copies[ds] = today.isoformat()

    # Write only the files whose content changed, so a day without new data leaves data/ and the site untouched.
    os.makedirs(a.out, exist_ok=True)
    changed = []
    for name, obj in out.items():
        text, path = dumps(obj), os.path.join(a.out, name)
        old = open(path, encoding='utf-8').read() if os.path.exists(path) else None
        entry = dict(files.get(name, {}))
        if text != old:
            with open(path + '.tmp', 'w', encoding='utf-8', newline='\n') as f:
                f.write(text)
            os.replace(path + '.tmp', path)
            changed.append(name)
            entry['changed'] = today.isoformat()
        entry.setdefault('changed', today.isoformat())
        if name in keys:
            entry['key'] = keys[name]
        files[name] = entry
    for name, key in key_only.items():   # inputs moved without changing the file: noted along with the next real change
        files[name] = {**files.get(name, {}), 'key': key}
    old_meta = os.path.join(a.out, 'meta.json')  # the run timestamp it held changed every page every day; sources.json replaces it
    if os.path.exists(old_meta):
        os.remove(old_meta)
        changed.append('meta.json (removed)')
    # sources.json is rewritten only along with a data change (or a full re-download to remember), so an idle day commits nothing.
    if changed or copies != state.get('copies', {}) or not os.path.exists(os.path.join(a.out, 'sources.json')):
        state = {'files': dict(sorted(files.items())), 'histVersions': dict(sorted(hist_versions.items())),
                 'cfsIds': {str(y): i for y, i in sorted(FOUND_IDS.items())},
                 # each dataset's "data last updated" time on data.nola.gov, as last seen; build.py prints it by its link
                 'versions': dict(sorted({**state.get('versions', {}), **api.vers}.items()))}
        if copies:
            state['copies'] = dict(sorted(copies.items()))
        with open(os.path.join(a.out, 'sources.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(state, f, indent=1, ensure_ascii=False)
    api.tidy_cache()
    print(f"changed: {', '.join(changed) or 'nothing'}")
    print(f"  drone {len(drone_d['recs'])} flights ({drone_d['year']}), cfs {sum(map(sum, cfs_d['daily']))} calls ({cfs_d['year']}, through day {cfs_d['last']}), "
          f"cpc {cpc_d['total']} cases, {len(cpc_d['up'])} upcoming")
    for name in NEW_FILES:
        if cur.get(name):
            print(f"  {name}: {cur[name].get('total', '?')} records through {cur[name].get('last', '?')}")
    for k, (n, b, w) in sorted(api.by_ds.items()):
        print(f'    {k:10} {n:3} requests {b / 1e6:7.2f} MB ({w / 1e6:.2f} MB transferred)')
    print(f'  {api.n_req} API requests, {api.n_bytes / 1e6:.1f} MB ({api.n_wire / 1e6:.1f} MB transferred, compressed); '
          f'{api.hits} answered from the saved responses')
    if changed and not a.no_build and a.out == DATA:
        subprocess.run([sys.executable, os.path.join(ROOT, 'build.py')], check=True)
    for msg in alerts:
        report_error(msg)
    if failed:
        report_error(f"Not refreshed today, last good version kept: {', '.join(failed)}")
    if failed or alerts:
        if os.environ.get('GITHUB_OUTPUT'):  # the workflow publishes what did refresh, then fails the run
            with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
                f.write(f"failed={' '.join(failed)}\n")
                f.write(f"alerts={len(alerts)}\n" if alerts else '')
        else:
            sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except PipelineError as e:
        print(f"{'::error::' if os.environ.get('GITHUB_ACTIONS') else ''}PIPELINE FAILED, nothing was written: {e}", file=sys.stderr)
        sys.exit(1)
