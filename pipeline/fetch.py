"""Fetch data.nola.gov datasets and rebuild every data/*.json file.

    python pipeline/fetch.py                 # fetch everything, validate, write data/, run build.py
    python pipeline/fetch.py --no-build      # skip build.py
    python pipeline/fetch.py --cache DIR     # dev only: keep raw API responses in DIR and reuse them
    python pipeline/fetch.py --today 2026-11-18   # pretend it's this date (to compare with old snapshots)

The aggregation rules are documented in pipeline/REFERENCE.md. Every output is
checked before anything is written. If a fetch comes back empty, a column
disappears, or a count collapses compared with the last good file, the script
exits with an error and leaves data/ untouched, so the site keeps its last good
build.

Set SOCRATA_APP_TOKEN in the environment to avoid API throttling.
"""
import argparse, csv, datetime as dt, hashlib, io, json, math, os, re, subprocess, sys, time
from collections import Counter, defaultdict

import numpy as np
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
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
    def __init__(self, cache=None):
        self.s = requests.Session()
        tok = os.environ.get('SOCRATA_APP_TOKEN')
        if tok:
            self.s.headers['X-App-Token'] = tok
        self.s.headers['User-Agent'] = 'nola-vizzes-pipeline'
        self.cache = cache
        if cache:
            os.makedirs(cache, exist_ok=True)

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

    def columns(self, ds):
        meta = self.get(f'/api/views/{ds}.json')
        return {c['fieldName']: c['dataTypeName'] for c in meta['columns']}

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


def build_geo(api):
    nbg = api.get('/resource/7fw3-kdpf.geojson', kind='geojson')
    pdg = api.get('/resource/evki-aju8.geojson', kind='geojson')
    need(len(nbg.get('features', [])) == 72, f"neighborhoods: expected 72 features, got {len(nbg.get('features', []))}")
    need(len(pdg.get('features', [])) == 8, f"police districts: expected 8 features, got {len(pdg.get('features', []))}")

    def enc(fc, name):
        out = []
        for ft in fc['features']:
            need(name in ft['properties'], f'boundary layer is missing the {name} field')
            rings = [e for poly in ft['geometry']['coordinates'] for r in poly for e in [encode_ring(r)] if e]
            out.append({'n': ft['properties'][name], 'r': rings})
        return out

    geo = {'nb': enc(nbg, 'gnocdc_lab'), 'pd': enc(pdg, 'district')}
    return geo, Polys(nbg['features']), Polys(pdg['features'])


STREET_TIER = {'Freeway': 0, 'Ramp': 1, 'Major Arterial': 2, 'Minor Arterial': 2, 'Local': 3}
STREET_Q = 4  # street coordinates are stored at 4x the map grid (about 5 m) so they stay sharp when zoomed in


def build_streets(api):
    """Street centerlines (22q2-dqpb) as one SVG path per tier: 0 freeway, 1 ramp, 2 arterial, 3 local.
    Coordinates are the shared X/Y projection times STREET_Q; pages draw them with scale(1/q)."""
    api.require_columns('22q2-dqpb', ['the_geom', 'roadclass', 'inwater'], 'Centerline')
    g = api.get('/resource/22q2-dqpb.geojson', {'$select': 'the_geom,roadclass,inwater', '$limit': 100000}, kind='geojson')
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
    return {'q': STREET_Q, 'd': d, 'n': n}


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
        '$order': 'takeoff_datetime', '$limit': 50000})
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
        recs.append([(t.date() - jan1).days, num(js_round(t.hour + t.minute / 60, 1)), num(fnum(r.get('total_flight_time')) or 0), cat,
                     drones.index((r.get('serial') or '').replace('SkydioX10-', '')),
                     int(nbs[i]) if has[i] else -1, x, y, ev, inf])
    return {'year': year, 'drones': drones, 'missingPurpose': missing, 'inferred': inferred, 'unknown': unknown, 'recs': recs}


# ---------------------------------------------------------------- calls for service
def cfs_dataset_id(api, year):
    if year in CFS_IDS:
        return CFS_IDS[year]
    res = api.get('/api/catalog/v1', {'domains': 'data.nola.gov', 'q': f'calls for service {year}', 'only': 'dataset', 'limit': 50})
    for r in res.get('results', []):
        name = r['resource']['name'].strip().lower()
        if name == f'calls for service {year}':
            return r['resource']['id']
    return None


def resp_minutes(create, arrive):
    if create is None or arrive is None:
        return None
    m = (arrive - create).total_seconds() / 60
    return m if 0 <= m < 1440 else None


def build_cfs(api, nbp, pdp, geo, year, ds):
    cols = ['timecreate', 'timearrive', 'typetext', 'priority', 'selfinitiated', 'dispositiontext', 'location']
    api.require_columns(ds, cols, f'Calls for Service {year}')
    total = int(api.get(f'/resource/{ds}.json', {'$select': 'count(*) as n'})[0]['n'])
    need(total > 0, f'Calls for Service {year} ({ds}): 0 rows')
    rows = []
    for off in range(0, total + 50000, 50000):
        body = api.get(f'/resource/{ds}.csv', {'$select': ','.join(cols), '$order': ':id', '$limit': 50000, '$offset': off}, kind='csv')
        page = list(csv.DictReader(io.StringIO(body)))
        rows += page
        if len(page) < 50000:
            break
    need(len(rows) >= total * 0.99, f'Calls for Service: fetched {len(rows)} rows but the API reports {total}')

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

    TOP = [t for t, _ in sorted(Counter(types).items(), key=lambda kv: -kv[1])[:24]]
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
           'disp': [[k, v] for k, v in Counter(disp).most_common(8)],
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
    lon = [fnum(r.get('longitude')) for r in rows]
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


def validate(out, prev, same_year):
    geo, drone, cfs, hist, cpc = out['geo.json'], out['drone.json'], out['cfs.json'], out['hist.json'], out['cpc.json']
    need(len(geo['nb']) == 72 and len(geo['pd']) == 8, 'geo: unexpected feature counts')
    need(all(f['r'] for f in geo['nb'] + geo['pd']), 'geo: a feature lost all its rings')
    need(len(drone['recs']) > 0 and len(drone['drones']) > 0, 'drone: empty')
    need(all(len(r) == 10 for r in drone['recs']), 'drone: record shape')
    need(len(cfs['TOP']) == 24 and len(cfs['types']) == 24, 'cfs: TOP/types length')
    need(len(cfs['daily']) == cfs['last'] + 1 and len(cfs['heat']) == 7 and all(len(h) == 24 for h in cfs['heat']), 'cfs: daily/heat shape')
    need(len(cfs['nb']) == 72 and len(cfs['pd']) == 8 and len(cfs['mResp']) == 12, 'cfs: nb/pd/mResp shape')
    need(sum(r[0] + r[1] for r in cfs['nb']) > 0.8 * sum(map(sum, cfs['daily'])), 'cfs: most calls failed to map to a neighborhood')
    need(len(cpc['nbRecent']) == 72 and len(cpc['TYP']) == 11 and len(cpc['TH']) == 7, 'cpc: shape')
    need(cpc['total'] > 1000, 'cpc: suspiciously few cases')
    need(len(hist) >= 12, 'hist: missing years')
    check_not_collapsed('street segments', out['streets.json']['n'], (load_prev('streets.json') or {}).get('n'))
    p = prev
    if same_year['drone']:
        check_not_collapsed('drone flights', len(drone['recs']), p['drone'] and len(p['drone']['recs']))
    if same_year['cfs']:
        check_not_collapsed('calls for service', sum(map(sum, cfs['daily'])), p['cfs'] and sum(map(sum, p['cfs']['daily'])))
    check_not_collapsed('planning cases', cpc['total'], p['cpc'] and (p['cpc'].get('total') or sum(sum(v) for v in p['cpc']['typeY'].values())))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache')
    ap.add_argument('--today')
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--out', default=DATA, help='write data files here instead of data/')
    a = ap.parse_args()
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.timezone(dt.timedelta(hours=-6))).date()
    api = Socrata(a.cache)
    prev = {k: load_prev(k + '.json') for k in ['drone', 'cfs', 'hist', 'cpc']}

    print('geo ...', flush=True)
    geo, nbp, pdp = build_geo(api)
    print('streets ...', flush=True)
    streets = build_streets(api)

    # Pages cover the current calendar year once its data exists, else the previous year.
    print('drone ...', flush=True)
    try:
        drone = build_drone(api, nbp, today.year)
    except PipelineError as e:
        if 'rows for' not in str(e):
            raise
        if today.month > 1:
            warn(f'Drone flights has no {today.year} flights yet; still showing {today.year - 1}.')
        drone = build_drone(api, nbp, today.year - 1)  # fails too if the dataset is empty

    print('calls for service ...', flush=True)
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
    cfs, cur_hist = build_cfs(api, nbp, pdp, geo, cyear, ds)

    print('history ...', flush=True)
    hist = {k: v for k, v in (prev['hist'] or {}).items() if int(k) < cyear}
    for y in range(2014, cyear):
        # past years never change, but re-check last year early in the new year while the City finishes it
        if str(y) not in hist or (y == cyear - 1 and today.month <= 2):
            hist[str(y)] = hist_year(api, y)
    hist[str(cyear)] = cur_hist
    hist = dict(sorted(hist.items()))

    print('planning cases ...', flush=True)
    cpc = build_cpc(api, nbp, today)

    out = {'geo.json': geo, 'streets.json': streets, 'drone.json': drone, 'cfs.json': cfs, 'hist.json': hist, 'cpc.json': cpc}
    validate(out, prev, {'drone': (prev['drone'] or {}).get('year', 2026) == drone['year'],
                         'cfs': (prev['cfs'] or {}).get('year', 2026) == cfs['year']})
    # The City sometimes stops updating a dataset. That isn't a reason to stop the site, but it's worth a look.
    cfs_last = dt.date(cfs['year'], 1, 1) + dt.timedelta(days=cfs['last'])
    drone_last = dt.date(drone['year'], 1, 1) + dt.timedelta(days=max(r[0] for r in drone['recs']))
    if (today - cfs_last).days > 7:
        warn(f'Calls for Service has no calls after {cfs_last} ({(today - cfs_last).days} days ago).')
    if (today - drone_last).days > 45:
        warn(f'Drone flights has no flights after {drone_last} ({(today - drone_last).days} days ago).')
    if cpc['lastFiled'] < (today - dt.timedelta(days=30)).isoformat():
        warn(f"CPC Projects has no filings after {cpc['lastFiled']}.")
    os.makedirs(a.out, exist_ok=True)
    meta = {'pulled': today.isoformat(), 'pulledAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')}
    out['meta.json'] = meta
    for name, obj in out.items():
        tmp = os.path.join(a.out, name + '.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, separators=(',', ':'), ensure_ascii=False)
    for name in out:
        os.replace(os.path.join(a.out, name + '.tmp'), os.path.join(a.out, name))
    print(f"wrote {', '.join(out)} to {a.out}")
    print(f"  drone {len(drone['recs'])} flights ({drone['year']}), cfs {sum(map(sum, cfs['daily']))} calls ({cfs['year']}, through day {cfs['last']}), "
          f"cpc {cpc['total']} cases, {len(cpc['up'])} upcoming")
    if not a.no_build and a.out == DATA:
        subprocess.run([sys.executable, os.path.join(ROOT, 'build.py')], check=True)


if __name__ == '__main__':
    try:
        main()
    except PipelineError as e:
        print(f"{'::error::' if os.environ.get('GITHUB_ACTIONS') else ''}PIPELINE FAILED, nothing was written: {e}", file=sys.stderr)
        sys.exit(1)
