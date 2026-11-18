"""Fetch data.nola.gov datasets and rebuild every data/*.json file.

    python pipeline/fetch.py                 # fetch everything, validate, write data/, run build.py
    python pipeline/fetch.py --no-build      # skip build.py
    python pipeline/fetch.py --cache DIR     # dev only: keep raw API responses in DIR and reuse them
    python pipeline/fetch.py --today 2026-11-18   # pretend it's this date (to compare with old snapshots)
    python pipeline/fetch.py --full          # rebuild everything, even datasets the City hasn't changed

The aggregation rules are documented in pipeline/REFERENCE.md.

Only what changed is downloaded and written. Each data file records, in data/sources.json, the dataset
versions it was built from (Socrata's rowsUpdatedAt, or for the street centerline its segment count and
newest edit). If those are the same today, the file is kept as it is. Rebuilt files are written only when
their content differs, so a day without new City data leaves data/ and site/ untouched and the workflow
commits nothing. Boundary and population downloads are kept in .cache/raw/ (restored between runs by the
workflow), and so is a copy of this year's Calls for Service rows: on a day the City changed that dataset, only
the rows updated since the newest one in the copy are downloaded and merged in (see cfs_rows). On the 1st of
each month, and with --full, everything is downloaded fresh.

Every rebuilt file is checked before it's written. If a fetch comes back empty, a column disappears, or a
count collapses compared with the last good file, that file keeps its last good version, the other files
still refresh, and the script reports the failure (exit code 1, or `failed=` in $GITHUB_OUTPUT so the
workflow can publish first and then fail the run). A failure in the shared boundaries stops everything.

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
class Socrata:
    def __init__(self, cache=None, use_raw=True):
        self.s = requests.Session()
        tok = os.environ.get('SOCRATA_APP_TOKEN')
        if tok:
            self.s.headers['X-App-Token'] = tok
        self.s.headers['User-Agent'] = 'nola-vizzes-pipeline'
        self.cache = cache
        if cache:
            os.makedirs(cache, exist_ok=True)
        self.use_raw = use_raw
        self.metas = {}
        self.n_req = self.n_bytes = 0

    def get(self, path, params=None, kind='json'):
        key = None
        if self.cache:
            key = os.path.join(self.cache, hashlib.sha1((path + json.dumps(params, sort_keys=True)).encode()).hexdigest() + '.' + kind)
            if os.path.exists(key):
                with open(key, encoding='utf-8') as f:
                    return json.load(f) if kind != 'csv' else f.read()
        last = None
        for attempt in range(5):
            try:
                r = self.s.get(API + path, params=params, timeout=180)
                self.n_req += 1
                self.n_bytes += len(r.content)
                if r.status_code == 200:
                    r.encoding = 'utf-8'
                    body = r.text
                    if key:
                        with open(key, 'w', encoding='utf-8') as f:
                            f.write(body)
                    return json.loads(body) if kind != 'csv' else body
                last = f'HTTP {r.status_code}: {r.text[:300]}'
                if r.status_code in (400, 403, 404):
                    break
            except requests.RequestException as e:
                last = repr(e)
            time.sleep(5 * (attempt + 1))
        raise PipelineError(f'GET {path} {params} failed: {last}')

    def meta(self, ds):
        """Dataset metadata, fetched once per run. It carries both the schema and rowsUpdatedAt."""
        if ds not in self.metas:
            self.metas[ds] = self.get(f'/api/views/{ds}.json')
        return self.metas[ds]

    def version(self, ds):
        """When the City last loaded rows into the dataset, as 'YYYY-MM-DDTHH:MM:SSZ'. Changes whenever its data may have."""
        t = self.meta(ds).get('rowsUpdatedAt')
        need(t, f'{ds}: metadata has no rowsUpdatedAt')
        return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    def raw(self, ds, path, params=None, kind='json'):
        """A whole download that can only change when the dataset does, kept in RAW_CACHE under the dataset's
        version (GitHub Actions restores that folder between runs). A cache miss just means downloading it."""
        fn = os.path.join(RAW_CACHE, f"{ds}-{self.version(ds).replace(':', '')}.{kind}")
        if self.use_raw and os.path.exists(fn):
            with open(fn, encoding='utf-8') as f:
                return json.load(f)
        body = self.get(path, params, kind)
        os.makedirs(RAW_CACHE, exist_ok=True)
        for old in os.listdir(RAW_CACHE):
            if old.startswith(ds + '-'):
                os.remove(os.path.join(RAW_CACHE, old))
        with open(fn, 'w', encoding='utf-8') as f:
            json.dump(body, f)
        return body

    def columns(self, ds):
        return {c['fieldName']: c['dataTypeName'] for c in self.meta(ds)['columns']}

    def require_columns(self, ds, cols, label):
        have = self.columns(ds)
        missing = [c for c in cols if c not in have]
        need(not missing, f'{label} ({ds}): columns missing from the dataset: {missing}. The schema changed.')
        return have


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


def build_geo(api, prev=None):
    nbg = api.raw('7fw3-kdpf', '/resource/7fw3-kdpf.geojson', kind='geojson')
    pdg = api.raw('evki-aju8', '/resource/evki-aju8.geojson', kind='geojson')
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
    """2020 Census population per neighborhood (2w4d-xaw2, sum_pop100), stored as geo['pop'] in neighborhood order."""
    api.require_columns('2w4d-xaw2', ['gnocdc_lab', 'sum_pop100'], 'Neighborhood demographics 2020')
    rows = api.raw('2w4d-xaw2', '/resource/2w4d-xaw2.json', {'$select': 'gnocdc_lab,sum_pop100', '$limit': 500})
    pop = {POP_ALIAS.get(r['gnocdc_lab'], r['gnocdc_lab']): int(float(r['sum_pop100'])) for r in rows if r.get('gnocdc_lab') and r.get('sum_pop100')}
    missing = [f['n'] for f in geo['nb'] if f['n'] not in pop]
    need(not missing, f'Neighborhood population: no 2020 count for {missing}. Add the spelling to POP_ALIAS.')
    geo['pop'] = [pop[f['n']] for f in geo['nb']]
    need(300000 < sum(geo['pop']) < 450000, f"Neighborhood population: total {sum(geo['pop'])} looks wrong")


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
    """This year's call rows, downloaded incrementally.

    The City updates the dataset in place every night (a few thousand of ~300,000 rows change), so a copy of
    every row, with its Socrata row id and last-updated time, is kept in RAW_CACHE (GitHub Actions restores
    that folder between runs). Each run asks only for rows updated since the newest one in the copy and merges
    them in by row id. If the merged copy's row count differs from the City's (rows were deleted), the copy is
    missing, or this is a full run (the 1st of the month, or --full), every row is downloaded again.
    A deletion offset by an addition on the same day goes unnoticed until the next monthly full download."""
    fn = os.path.join(RAW_CACHE, f'cfs-{ds}.csv.gz')
    fields = [':id', ':updated_at'] + cols

    def fetch(where=None):
        got = []
        while True:
            params = {'$select': ','.join(fields), '$order': ':id', '$limit': 50000, '$offset': len(got)}
            if where:
                params['$where'] = where
            page = list(csv.DictReader(io.StringIO(api.get(f'/resource/{ds}.csv', params, kind='csv'))))
            got += page
            if len(page) < 50000:
                return got

    rows, how = None, ''
    if api.use_raw and os.path.exists(fn):
        try:
            with gzip.open(fn, 'rt', encoding='utf-8', newline='') as f:
                copy = {r[':id']: r for r in csv.DictReader(f)}
        except (OSError, EOFError, csv.Error):
            copy = {}
        mark = max((r[':updated_at'] for r in copy.values()), default='')
        if copy and mark:
            delta = fetch(f":updated_at >= '{mark.rstrip('Z')}'")
            for r in delta:
                copy[r[':id']] = r
            if len(copy) == total:
                rows, how = list(copy.values()), f'{len(delta):,} new or changed rows merged into the saved copy'
            else:
                print(f'  saved copy has {len(copy):,} rows but the City has {total:,}: downloading all', flush=True)
    if rows is None:
        rows, how = fetch(), 'full download'
    need(len(rows) >= total * 0.99, f'Calls for Service: fetched {len(rows)} rows but the API reports {total}')
    print(f'  calls: {how}', flush=True)
    os.makedirs(RAW_CACHE, exist_ok=True)
    for old in os.listdir(RAW_CACHE):
        if old.startswith('cfs-') and old != os.path.basename(fn):
            os.remove(os.path.join(RAW_CACHE, old))  # last year's copy
    with gzip.open(fn + '.tmp', 'wt', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r[':id']))
    os.replace(fn + '.tmp', fn)
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
    up, pts = [], []
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
        nmd = parse_ts(r.get('next_meeting_date'))
        if nmd and nmd.date() >= today:
            up.append([nmd.strftime('%Y-%m-%dT%H:%M'), r.get('next_meeting') or '', r.get('case_num') or '', CPC_TYP[t],
                       (r.get('address') or '').split(',')[0][:40], nb, x, y, re.sub(r'\s+', ' ', desc).strip()[:170]])
    up.sort(key=lambda u: u[0])
    return {'TYP': CPC_TYP, 'TH': CPC_TH, 'typeY': dict(sorted(typeY.items())), 'themeY': dict(sorted(themeY.items())),
            'openByType': openByType, 'dec': dec, 'nbRecent': nbRecent, 'up': up, 'pts': pts,
            'windowStart': win0.isoformat(), 'total': len(rows),
            'firstFiled': min((parse_ts(r.get('filing_date')) for r in rows if parse_ts(r.get('filing_date'))), default=None).strftime('%Y-%m-%d'),
            'lastFiled': max((parse_ts(r.get('filing_date')) for r in rows if parse_ts(r.get('filing_date'))), default=None).strftime('%Y-%m-%d')}


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


def central_date(iso_utc):
    """'2026-11-18T06:02:10Z' -> that moment's date in New Orleans (standard time, like `today`)."""
    return (dt.datetime.strptime(iso_utc, '%Y-%m-%dT%H:%M:%SZ') - dt.timedelta(hours=6)).date()


def dumps(obj):
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False)


def report_error(msg):
    print(f"{'::error::' if os.environ.get('GITHUB_ACTIONS') else 'ERROR: '}{msg}", flush=True)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache')
    ap.add_argument('--today')
    ap.add_argument('--full', action='store_true', help="download and rebuild everything, even datasets the City hasn't changed")
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--out', default=DATA, help='write data files here instead of data/')
    a = ap.parse_args()
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.timezone(dt.timedelta(hours=-6))).date()
    # On the 1st of every month everything is downloaded fresh, in case a change slipped past the version checks.
    full = a.full or today.day == 1
    api = Socrata(a.cache, use_raw=not full)
    state = load_prev('sources.json') or {}
    files = state.get('files', {})                 # data file -> {'key': what it was built from, 'changed': date its content last changed}
    hist_versions = state.get('histVersions', {})  # year -> version of that year's dataset when hist.json last counted it
    FOUND_IDS.update({int(y): i for y, i in state.get('cfsIds', {}).items()})
    prev = {n: load_prev(n) for n in ['geo.json', 'streets.json', 'drone.json', 'cfs.json', 'hist.json', 'cpc.json']}
    out, keys, failed = {}, {}, []

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

    # Boundaries and population hardly ever change and come from the raw cache. Every other file is
    # positioned against them, so if they fail, nothing is published.
    print('geo ...', flush=True)
    geo, nbp, pdp = build_geo(api, prev['geo.json'])
    add_population(api, geo)
    validate('geo.json', geo, prev['geo.json'])
    out['geo.json'] = geo
    geo_key = hashlib.sha1(dumps(geo).encode()).hexdigest()[:12]

    def streets():
        api.require_columns('22q2-dqpb', ['the_geom', 'roadclass', 'inwater', 'fullnameabv', 'lastupdate'], 'Centerline')
        # The centerline is re-synced from the City's GIS whether or not anything was edited, so its version says
        # little. The segment count and the newest edit say whether the streets changed.
        fp = api.get('/resource/22q2-dqpb.json', {'$select': 'count(*) as n, max(lastupdate) as m'})[0]
        if not unchanged('streets.json', f"{fp.get('n')}|{fp.get('m')}"):
            out['streets.json'] = build_streets(api)
    print('streets ...', flush=True)
    attempt(['streets.json'], streets)

    # Pages cover the current calendar year once its data exists, else the previous year.
    def drone():
        if unchanged('drone.json', f"{api.version('ay9z-ynxz')}|{geo_key}|{today.year}"):
            return
        try:
            d = build_drone(api, nbp, today.year)
        except PipelineError as e:
            if 'rows for' not in str(e):
                raise
            if today.month > 1:
                warn(f'Drone flights has no {today.year} flights yet; still showing {today.year - 1}.')
            d = build_drone(api, nbp, today.year - 1)  # fails too if the dataset is empty
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
        hist = dict(prev['hist.json'] or {})
        version = api.version(ds)
        cur = None
        if not (unchanged('cfs.json', f'{ds}|{version}|{geo_key}') and str(cyear) in hist):
            keys['cfs.json'] = f'{ds}|{version}|{geo_key}'
            out['cfs.json'], cur = build_cfs(api, nbp, pdp, geo, cyear, ds)

        print('history ...', flush=True)
        # Past years are closed, but the City loads each year's last rows on January 1 and has occasionally
        # touched old years later. A year is recounted only when its dataset's version moved: last year is
        # checked daily in January and February, every year on the 1st of the month.
        hist = {k: v for k, v in hist.items() if int(k) < cyear}
        check = range(2014, cyear) if full else [cyear - 1] if today.month <= 2 else []
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
            out['cpc.json'] = build_cpc(api, nbp, today if a.today else min(today, central_date(version)))
    print('planning cases ...', flush=True)
    attempt(['cpc.json'], cpc)

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
    old_meta = os.path.join(a.out, 'meta.json')  # the run timestamp it held changed every page every day; sources.json replaces it
    if os.path.exists(old_meta):
        os.remove(old_meta)
        changed.append('meta.json (removed)')
    # sources.json is rewritten only along with a data change, so an idle day commits nothing.
    if changed or not os.path.exists(os.path.join(a.out, 'sources.json')):
        state = {'files': dict(sorted(files.items())), 'histVersions': dict(sorted(hist_versions.items())),
                 'cfsIds': {str(y): i for y, i in sorted(FOUND_IDS.items())}}
        with open(os.path.join(a.out, 'sources.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(state, f, indent=1, ensure_ascii=False)
    print(f"changed: {', '.join(changed) or 'nothing'}")
    print(f"  drone {len(drone_d['recs'])} flights ({drone_d['year']}), cfs {sum(map(sum, cfs_d['daily']))} calls ({cfs_d['year']}, through day {cfs_d['last']}), "
          f"cpc {cpc_d['total']} cases, {len(cpc_d['up'])} upcoming")
    print(f'  {api.n_req} API requests, {api.n_bytes / 1e6:.1f} MB')
    if not a.no_build and a.out == DATA:
        subprocess.run([sys.executable, os.path.join(ROOT, 'build.py')], check=True)
    if failed:
        report_error(f"Not refreshed today, last good version kept: {', '.join(failed)}")
        if os.environ.get('GITHUB_OUTPUT'):  # the workflow publishes what did refresh, then fails the run
            with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
                f.write(f"failed={' '.join(failed)}\n")
        else:
            sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except PipelineError as e:
        print(f"{'::error::' if os.environ.get('GITHUB_ACTIONS') else ''}PIPELINE FAILED, nothing was written: {e}", file=sys.stderr)
        sys.exit(1)
