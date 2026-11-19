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
    """2020 Census population and housing units per neighborhood (2w4d-xaw2, sum_pop100 and sum_hu100), stored as
    geo['pop'] and geo['hu'] in neighborhood order."""
    api.require_columns('2w4d-xaw2', ['gnocdc_lab', 'sum_pop100', 'sum_hu100'], 'Neighborhood demographics 2020')
    params = {'$select': 'gnocdc_lab,sum_pop100,sum_hu100', '$limit': 500}
    rows = api.raw('2w4d-xaw2', '/resource/2w4d-xaw2.json', params)
    if rows and 'sum_hu100' not in rows[0]:  # a copy saved before housing units were added
        api.use_raw, keep = False, api.use_raw
        rows = api.raw('2w4d-xaw2', '/resource/2w4d-xaw2.json', params)
        api.use_raw = keep
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


# ---------------------------------------------------------------- large datasets, downloaded incrementally
def synced_rows(api, ds, cols, where, label, total=None):
    """Every row of `ds` matching `where`, kept in RAW_CACHE as <ds>.csv.gz and brought up to date incrementally.

    The same idea as cfs_rows: the copy holds each row's Socrata :id and :updated_at, so a run asks only for rows
    updated since the newest one in the copy (usually one small request) and merges them in by :id. If the merged
    copy's row count differs from the City's count for `where` (rows were deleted or moved out of the window), the
    copy is missing or unreadable, its columns differ, or this is a full run (the 1st of the month, or --full),
    every row is downloaded again in pages of 50,000. Returns (rows, how) with rows as dicts of strings."""
    fn = os.path.join(RAW_CACHE, f'{ds}.csv.gz')
    fields = [':id', ':updated_at'] + cols
    if total is None:
        total = int(api.get(f'/resource/{ds}.json', {'$select': 'count(*) as n', '$where': where})[0]['n'])
    need(total > 0, f'{label} ({ds}): 0 rows')

    def fetch(w):
        got = []
        while True:
            page = list(csv.DictReader(io.StringIO(api.get(f'/resource/{ds}.csv', {
                '$select': ','.join(fields), '$where': w, '$order': ':id', '$limit': 50000, '$offset': len(got)}, kind='csv'))))
            got += page
            if len(page) < 50000:
                return got

    rows, how = None, ''
    if api.use_raw and os.path.exists(fn):
        try:
            with gzip.open(fn, 'rt', encoding='utf-8', newline='') as f:
                rd = csv.DictReader(f)
                copy = {r[':id']: r for r in rd} if rd.fieldnames == fields else {}
        except (OSError, EOFError, csv.Error):
            copy = {}
        mark = max((r[':updated_at'] for r in copy.values()), default='')
        if copy and mark:
            delta = fetch(f"({where}) AND :updated_at >= '{mark.rstrip('Z')}'")
            for r in delta:
                copy[r[':id']] = r
            if len(copy) == total:
                rows, how = list(copy.values()), f'{len(delta):,} new or changed rows merged into the saved copy'
            else:
                print(f'  saved copy has {len(copy):,} rows but the City has {total:,}: downloading all', flush=True)
    if rows is None:
        rows, how = fetch(where), f'full download, {total:,} rows'
    need(len(rows) >= total * 0.99, f'{label}: fetched {len(rows)} rows but the API reports {total}')
    os.makedirs(RAW_CACHE, exist_ok=True)
    with gzip.open(fn + '.tmp', 'wt', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r[':id']))
    os.replace(fn + '.tmp', fn)
    print(f'  {label}: {how}', flush=True)
    return sorted(rows, key=lambda r: r[':id']), how


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
    return {
        'ds': SR_DS, 'start': SR_START[:7], 'last': last.strftime('%Y-%m-%d'), 'winStart': win0.isoformat(),
        'T': T, 'R': R, 'mon': mon, 'years': years, 'nby': nby,
        'nb12': [[v for r in sorted(c) for v in (r, c[r])] for c in nb12],   # [reason, n, reason, n, ...]
        'ages': AGES, 'openAge': openAge,
        'closeR': [stat(v) for v in closeR], 'closeT': [stat(v) for v in closeT],
        'closeNb': [[[len(v), median(v)] for v in row] for row in closeNb],
        'total': n, 'recent': sum(recent), 'open': sum(pending), 'noLoc': sum(nb < 0 for nb in nbs),
    }


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


def build_blight(api, nbp):
    for ds, cols, label in [(CE_CASES, ['casefiled', 'o_c', 'stage', 'xpos', 'ypos', 'initinspresult'], 'Code enforcement cases'),
                            (CE_VIOL, ['violationdate', 'violation'], 'Code enforcement violations'),
                            (CE_INSP, ['inspectiondate', 'inspectiontype'], 'Code enforcement inspections'),
                            (CE_HEAR, ['hearingdate', 'judgment'], 'Code enforcement hearings'),
                            (CE_GRASS, ['casefiled', 'o_c', 'longitude', 'latitude'], 'Grass cutting'),
                            (CE_ABATE, ['o_c', 'stage', 'xpos', 'ypos'], 'Abatements')]:
        api.require_columns(ds, cols, label)
    # cases: every open case, and every case filed since CE_START
    rows = fetch_all(api, CE_CASES, 'casefiled,o_c,stage,xpos,ypos,initinspresult', where=f"o_c = 'Open' OR casefiled >= '{CE_START}-01-01'")
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
    grass = fetch_all(api, CE_GRASS, 'casefiled,o_c,longitude,latitude')
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
    ab = fetch_all(api, CE_ABATE, 'o_c,stage,xpos,ypos')
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
    hear = api.get(f'/resource/{CE_HEAR}.json', {'$select': 'date_extract_y(hearingdate) as y, judgment, count(*) as n',
                                                 '$where': f"hearingdate >= '{CE_START}-01-01' AND hearingdate <= '{today.isoformat()}T23:59:59'",
                                                 '$group': 'y, judgment', '$order': 'y, judgment', '$limit': 5000})
    hyr = [[0] * len(CE_HEAR_GROUPS) for _ in years]
    for r in hear:
        hyr[int(r['y']) - CE_START][ce_hearing_group(r.get('judgment'))] += int(r['n'])
    upcoming = int(api.get(f'/resource/{CE_HEAR}.json', {'$select': 'count(*) as n', '$where': f"hearingdate > '{today.isoformat()}T23:59:59'"})[0]['n'])
    prev0 = win0 - dt.timedelta(days=365)
    viol = {}
    for k, (a, b) in enumerate([(win0, today), (prev0, win0 - dt.timedelta(days=1))]):
        for r in api.get(f'/resource/{CE_VIOL}.json', {'$select': 'violation, count(*) as n', '$where': f"violationdate >= '{a}' AND violationdate <= '{b}T23:59:59'",
                                                       '$group': 'violation', '$order': 'violation', '$limit': 5000}):
            v = re.sub(r'\s+', ' ', (r.get('violation') or '').strip()) or 'Not stated'
            viol.setdefault(v, [0, 0])[k] += int(r['n'])
    V = sorted(viol.items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))
    insp = api.get(f'/resource/{CE_INSP}.json', {'$select': 'date_trunc_ym(inspectiondate) as m, inspectiontype, count(*) as n',
                                                 '$where': f"inspectiondate >= '{CE_START}-01-01' AND inspectiondate <= '{today.isoformat()}T23:59:59'",
                                                 '$group': 'm, inspectiontype', '$order': 'm, inspectiontype', '$limit': 50000})
    imon = [[0] * len(CE_INSP_GROUPS) for _ in range(month_index(today, CE_START, 1) + 1)]
    for r in insp:
        m = parse_ts(r['m'])
        imon[month_index(m, CE_START, 1)][ce_insp_group(r.get('inspectiontype'))] += int(r['n'])
    return {
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
    cols = ['code', 'type', 'filingdate', 'issuedate', 'landuse', 'location_1']
    api.require_columns(PERMITS, cols, 'Permits')
    # permits issued per year and code, counted by the API
    yrows = api.get(f'/resource/{PERMITS}.json', {'$select': 'date_extract_y(issuedate) as y, code, count(*) as n',
                                                 '$where': f"issuedate >= '{PERMIT_START}-01-01'", '$group': 'y, code', '$order': 'y, code', '$limit': 5000})
    need(len(yrows) > 100, f'Permits: only {len(yrows)} year/code counts')
    last = parse_ts(api.get(f'/resource/{PERMITS}.json', {'$select': 'max(issuedate) as m', '$where': f"issuedate >= '{PERMIT_START}-01-01'"})[0]['m'])
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
    pts = []
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
    stat = lambda v: [len(v), median(v), p90(v)]
    return {
        'ds': PERMITS, 'last': today.isoformat(), 'winStart': win0.isoformat(),
        'cats': PERMIT_CATS, 'lu': PERMIT_LU, 'years': years, 'yr': yr,
        'nbc': [[v for k in sorted(c) for v in (*k, c[k])] for c in nbc],   # [cat, landUse, n, ...] per nb, past 12 months
        'days': [[stat(v) for v in row] + [stat([d for v in row for d in v])] for row in days],  # [n, median, p90] per land use, then all
        'pts': sorted(pts), 'total': len(rows), 'noLoc': sum(nb < 0 for nb in nbs),
    }


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
    a_cols = ['application_filed', 'currentstatus', 'category', 'businesstype', 'ishome', 'longitude', 'latitude']
    n_cols = ['businesstype', 'businessstartdate', 'longitude', 'latitude']
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
    S2 = S[:-2] + ['Other sectors', BIZ_VENDOR, 'Other or not stated']
    s2i = {c: k for k, c in enumerate(S2)}
    nnb, _ = points_to_nb(nbp, now)
    nowNb = [Counter() for _ in range(72)]
    for r, nb in zip(now, nnb):
        t = (r.get('businesstype') or '').strip()
        if re.match(r'(special events|mardi gras|flea market|artist-painting)', t, re.I):
            s = s2i[BIZ_VENDOR]
        else:
            c = t2s.get(biz_type_key(t))
            s = s2i.get(ranked(c)[0], s2i['Other sectors']) if c else len(S2) - 1
        if nb >= 0:
            nowNb[nb][s] += 1
    sparse = lambda c: [v for key in sorted(c) for v in ((*key, c[key]) if isinstance(key, tuple) else (key, c[key]))]
    return {
        'ds': [BIZ_APPS, BIZ_NOW], 'last': today.isoformat(), 'winStart': win0.isoformat(),
        'S': S, 'out': BIZ_OUT, 'years': years, 'yr': yr, 'yo': yo, 'home': home,
        'nby': [sparse(c) for c in nby],      # [yearIdx, sector, n, ...] per nb
        'new12': [sparse(c) for c in new12],  # [sector, n, ...] per nb, past 12 months
        'S2': S2, 'now': [sparse(c) for c in nowNb], 'nowTotal': len(now), 'nowNoLoc': sum(nb < 0 for nb in nnb),
        'total': len(apps), 'noLoc': sum(nb < 0 for nb in nbs),
    }


# Data files of the pages added with the 311 / housing / business set, and when each counts as stale
# (file, label, field holding its newest record date, days without a new record before warning).
NEW_FILES = ['311.json', 'str.json', 'blight.json', 'permits.json', 'biz.json']
STALE = [('311.json', '311 calls', 'last', 7), ('str.json', 'Short-term rental permit applications', 'last', 14),
         ('blight.json', 'Code enforcement cases', 'last', 14), ('permits.json', 'Permits', 'last', 14),
         ('biz.json', 'Business license applications', 'last', 14)]


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
    # ---- pages added with the 311 / housing / business set ----
    elif name == '311.json':
        need(len(obj['T']) >= 5 and len(obj['nby']) == 72 and len(obj['openAge']) == 73 and len(obj['nb12']) == 72, '311: shape')
        need(all(len(m) == len(obj['T']) for m in obj['mon']), '311: monthly rows')
        need(obj['total'] > 100000 and obj['recent'] > 20000, '311: suspiciously few requests')
        need(obj['noLoc'] < 0.1 * obj['total'], '311: most requests failed to map to a neighborhood')
        check_not_collapsed('311 requests', obj['total'], prev and prev.get('total'))
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
    elif name == 'permits.json':
        need(len(obj['nbc']) == 72 and len(obj['yr']) == len(obj['years']) and len(obj['days']) == len(obj['cats']), 'permits: shape')
        need(obj['total'] > 5000, 'permits: suspiciously few permits in the past 12 months')
        need(obj['noLoc'] < 0.1 * obj['total'], 'permits: most permits failed to map to a neighborhood')
        check_not_collapsed('permits issued in the past 12 months', obj['total'], prev and prev.get('total'), floor=0.75)
    elif name == 'biz.json':
        need(len(obj['nby']) == 72 and len(obj['new12']) == 72 and len(obj['now']) == 72 and len(obj['yr']) == len(obj['years']), 'biz: shape')
        need(obj['total'] > 10000 and obj['nowTotal'] > 10000, 'biz: suspiciously few licenses')
        need(obj['noLoc'] < 0.1 * obj['total'], 'biz: most applications failed to map to a neighborhood')
        check_not_collapsed('business license applications', obj['total'], prev and prev.get('total'))
        check_not_collapsed('current business licenses', obj['nowTotal'], prev and prev.get('nowTotal'), floor=0.8)


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
    prev = {n: load_prev(n) for n in ['geo.json', 'streets.json', 'drone.json', 'cfs.json', 'hist.json', 'cpc.json', *NEW_FILES]}
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

    # ---- pages added with the 311 / housing / business set: each file is rebuilt when its dataset(s) or geo changed
    def sr():
        if not unchanged('311.json', f'{api.version(SR_DS)}|{geo_key}'):
            out['311.json'] = build_311(api, nbp)
    print('311 requests ...', flush=True)
    attempt(['311.json'], sr)

    def strs():
        if not unchanged('str.json', '|'.join([api.version(d) for d in (STR_ACTIVE, STR_APPS, STR_NC)] + [geo_key])):
            out['str.json'] = build_str(api, nbp)
    print('short-term rentals ...', flush=True)
    attempt(['str.json'], strs)

    def blight():
        if not unchanged('blight.json', '|'.join([api.version(d) for d in (CE_CASES, CE_VIOL, CE_INSP, CE_HEAR, CE_GRASS, CE_ABATE)] + [geo_key])):
            out['blight.json'] = build_blight(api, nbp)
    print('blight and code enforcement ...', flush=True)
    attempt(['blight.json'], blight)

    def permits():
        if not unchanged('permits.json', f'{api.version(PERMITS)}|{geo_key}'):
            out['permits.json'] = build_permits(api, nbp)
    print('building permits ...', flush=True)
    attempt(['permits.json'], permits)

    def biz():
        if not unchanged('biz.json', f'{api.version(BIZ_APPS)}|{api.version(BIZ_NOW)}|{geo_key}'):
            out['biz.json'] = build_biz(api, nbp)
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
    for name in NEW_FILES:
        if cur.get(name):
            print(f"  {name}: {cur[name].get('total', '?')} records through {cur[name].get('last', '?')}")
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
