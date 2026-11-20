"""Smaller layers added to existing pages (REFERENCE.md, "Add-on layers on existing pages"). fetch.py runs every entry of
ADDONS after the pages' own files; each is rebuilt only when one of its datasets' "last updated" dates moves, which the
daily catalog request already covers (their ids are in DATASETS). Each add-on is one block below, registered at its end.
"""
import math, re, sys
from collections import Counter, defaultdict

import numpy as np

# fetch.py imports this module part way through loading, after the helpers below exist. Take them from the running
# fetch.py itself (so need() raises the PipelineError that fetch.py catches), or import it when used on its own.
F = sys.modules.get('__main__')
if not hasattr(F, 'douglas_peucker'):
    import fetch as F
need, douglas_peucker, fnum, Polys, DOT_Q = F.need, F.douglas_peucker, F.fnum, F.Polys, F.DOT_Q

# file -> (label, datasets it's built from, also rebuilt when geo.json changes, build(api, nbp, geo), check(obj, prev))
ADDONS = {}
DATASETS = {}   # added to fetch.py's DATASETS: checked daily through the catalog, no staleness limit (extras on a page)

VAGUE = re.compile(r'^\s*(-|n/?a|none|tbd|varies|depends|zoom only)?\s*$', re.I)


def clean(s):
    s = re.sub(r'\(\s+', '(', re.sub(r'\s+', ' ', (s or '').strip()))
    return '' if VAGUE.match(s) else s


# ---------------------------------------------------------------- shapes
def xy(lon, lat, q=DOT_Q):
    """lon/lat -> map units x q (unrounded), the projection of dot_xy and geo.json."""
    return (lon + 90.14) * 4830 * q, (30.20 - lat) * 5550 * q


def enc_geom(geom, tol, q=DOT_Q):
    """A Polygon or MultiPolygon -> its rings as flat delta-encoded ints [x0, y0, dx1, dy1, ...] in map units x q
    (q 4: about 5 m), each simplified with Douglas-Peucker at `tol` (same units). Rings that collapse are dropped."""
    if not geom:
        return []
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    out = []
    for poly in polys:
        for ring in poly:
            pts = [xy(lon, lat, q) for lon, lat in ring]
            mid = len(pts) // 2
            s = douglas_peucker(pts[:mid + 1], tol) + douglas_peucker(pts[mid:], tol)[1:]
            rq = []
            for x, y in s:
                p = (round(x), round(y))
                if not rq or rq[-1] != p:
                    rq.append(p)
            if len(rq) < 4:
                continue
            flat, px, py = [], 0, 0
            for x, y in rq:
                flat += [x - px, y - py]
                px, py = x, y
            out.append(flat)
    return out


# ---------------------------------------------------------------- A. neighborhood groups (bqyy-s7xy)
ORG_DS = 'bqyy-s7xy'      # Self Reported Neighborhood Organizations
# Shown: the group's name, website (or Facebook page), meeting schedule and a meeting place that names a venue.
# Never shown: `poc` (a person's name). An email address only when it's plainly the organization's own: a role
# address (info@, president@, ...) on the group's own domain, not a personal or free-mail account.
ROLE = {'info', 'president', 'board', 'communications', 'contact', 'office', 'safety', 'admin', 'hello', 'secretary'}
FREEMAIL = re.compile(r'@(gmail|yahoo|hotmail|outlook|aol|msn|icloud|me|comcast|bellsouth|cox|att|live)\.', re.I)
URL = re.compile(r'(https?://[^\s;,]+|www\.[^\s;,]+|[a-z0-9-]+\.(?:org|com|net)(?:/[^\s;,]*)?)', re.I)
ORG_MIN_SHARE, NB_MIN_COVER = 0.10, 0.25   # a group is listed in a neighborhood holding 10% of its area, or 25% covered by it
GRID_M = 40


def org_links(web):
    out = []
    for u in URL.findall(web or ''):
        u = u.rstrip('.')
        u = re.sub(r'^https?://', lambda m: m.group(0).lower(), u, flags=re.I)
        if not u.startswith('http'):
            u = 'https://' + u
        if u not in out:
            out.append(u)
    return out[:2]


def org_email(e):
    for a in re.split(r'\s*(?:&|and|,|;)\s*', (e or '').strip()):
        m = re.fullmatch(r'([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]+)', a.strip(), re.I)
        if m and m.group(1).lower() in ROLE and not FREEMAIL.search(a):
            return a.strip().lower()
    return ''


def nb_areas(geo):
    """Each neighborhood's area in square meters, from geo.json's rings (map units of about 20 m)."""
    out = []
    for f in geo['nb']:
        a = 0.0
        for r in f['r']:
            x = np.cumsum(r[0::2], dtype=float)
            y = np.cumsum(r[1::2], dtype=float)
            a += abs(0.5 * np.sum(x * np.roll(y, 1) - np.roll(x, 1) * y))
        out.append(a * 400)
    return out


def build_orgs(api, nbp, geo):
    """nbp: the neighborhoods' point-in-polygon lookup; geo: geo.json (for the neighborhoods' areas)."""
    api.require_columns(ORG_DS, ['organization_name', 'website', 'meeting_dates', 'meeting_location', 'email', 'the_geom'], 'Neighborhood organizations')
    # the whole rows (77 small ones): `poc` comes along but is never read
    fc = api.get(f'/resource/{ORG_DS}.geojson', {'$limit': 500, '$order': ':id'}, kind='geojson')
    feats = fc.get('features', [])
    need(30 < len(feats) < 500, f'Neighborhood organizations: {len(feats)} rows')
    feats.sort(key=lambda f: (f['properties'].get('organization_name') or '').strip().lower())
    # area shares on a GRID_M-meter grid of points: each point's neighborhood, and the groups whose area holds it
    areas = nb_areas(geo)
    kx, ky = 111320 * math.cos(math.radians(29.97)), 110574
    groups, unmatched = [], []
    by_nb = defaultdict(list)
    for ft in feats:
        p = ft['properties']
        name = clean(p.get('organization_name'))
        if not name:
            continue
        g = {'n': name}
        links = org_links(p.get('website'))
        if links:
            g['w'] = links
        for k, col in (('m', 'meeting_dates'), ('l', 'meeting_location')):
            v = clean(p.get(col))[:140]
            if k == 'l' and re.match(r'^\d', v):   # a bare street address may be someone's home: left out
                v = ''
            if v:
                g[k] = v
        e = org_email(p.get('email'))
        if e:
            g['e'] = e
        nbs = []
        geom = ft.get('geometry')
        if geom:
            polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
            one = Polys([{'geometry': {'coordinates': polys}}])
            allp = np.vstack([np.asarray(r, dtype=float) for poly in polys for r in poly])
            x0, y0, x1, y1 = allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max()
            gx = np.arange(x0, x1, GRID_M / kx)
            gy = np.arange(y0, y1, GRID_M / ky)
            if len(gx) < 3 or len(gy) < 3:   # small areas: a finer grid
                gx, gy = np.linspace(x0, x1, 12), np.linspace(y0, y1, 12)
            X, Y = np.meshgrid(gx, gy)
            X, Y = X.ravel(), Y.ravel()
            inside = one.lookup(X, Y) == 0
            nb = nbp.lookup(X[inside], Y[inside])
            c = Counter(int(n) for n in nb if n >= 0)
            tot = int(inside.sum())
            for n, k in c.most_common():
                if k / max(1, tot) >= ORG_MIN_SHARE or k * (GRID_M ** 2) / max(1, areas[n]) >= NB_MIN_COVER:
                    nbs.append(n)
            if not nbs and c:
                nbs = [c.most_common(1)[0][0]]
        if not nbs:
            unmatched.append(name)
        gi = len(groups)
        groups.append(g)
        for n in nbs:
            by_nb[n].append(gi)
    need(len(unmatched) < 0.2 * len(groups), f'Neighborhood organizations: {len(unmatched)} groups matched no neighborhood')
    return {'ds': ORG_DS, 'g': groups, 'nb': [by_nb.get(i, []) for i in range(len(geo['nb']))], 'unmatched': unmatched}


def _check_orgs(o, prev):
    need(len(o['g']) > 30 and len(o['nb']) == 72, 'orgs: shape')
    need(len(o['unmatched']) < 0.2 * len(o['g']), 'orgs: most groups matched no neighborhood')


ADDONS['orgs.json'] = ('Neighborhood groups', [ORG_DS], True, lambda api, nbp, geo: build_orgs(api, nbp(), geo), _check_orgs)
DATASETS[ORG_DS] = ('Neighborhood organizations', 'daily', None)


# ---------------------------------------------------------------- B. historic districts and landmarks (permits map)
HD_DS = 'vgpk-2scb'       # Local Historic Districts (the newer hea7-kccz has no geometry in the API)
LM_DS = '25e8-s5xx'       # HDLC Landmarks
HD_TOL = 0.6   # 3 m
JURIS = {'NOHDLC': 'HDLC', 'CBDHDLC': 'HDLC (CBD)', 'VCC': 'Vieux Carré Commission'}


def build_historic(api):
    api.require_columns(HD_DS, ['name', 'control', 'jurisdiction', 'the_geom'], 'Local historic districts')
    api.require_columns(LM_DS, ['name', 'addr', 'architect', 'nom_des', 'date', 'the_geom'], 'HDLC landmarks')
    fc = api.get(f'/resource/{HD_DS}.geojson', {'$limit': 500, '$order': ':id'}, kind='geojson')
    lm = api.get(f'/resource/{LM_DS}.json', {'$limit': 2000, '$order': ':id'})
    need(15 <= len(fc.get('features', [])) < 500, 'Local historic districts: unexpected number of districts')
    need(200 <= len(lm) < 2000, f'HDLC landmarks: {len(lm)} rows')
    d = []
    for ft in fc['features']:
        p = ft['properties']
        r = enc_geom(ft.get('geometry'), HD_TOL)
        if r:
            d.append({'n': clean(p.get('name')), 'c': 1 if (p.get('control') or '').lower().startswith('full') else 0,
                      'j': JURIS.get((p.get('jurisdiction') or '').strip(), clean(p.get('jurisdiction'))), 'r': r})
    pts = []
    for r in lm:
        c = ((r.get('the_geom') or {}).get('coordinates') or [None, None])
        lon, lat = fnum(c[0]), fnum(c[1])
        if lon is None or lat is None:
            continue
        x, y = xy(lon, lat)
        arch = clean(r.get('architect'))
        pts.append([round(x), round(y), clean(r.get('name')), clean(r.get('addr')),
                    '' if arch.lower() in ('unknown', 'n/a') else arch, clean(r.get('date')),
                    1 if (r.get('nom_des') or '').lower().startswith('des') else 0])
    return {'ds': HD_DS, 'lmDs': LM_DS, 'q': DOT_Q, 'd': d, 'lm': pts}


def _check_historic(o, prev):
    need(len(o['d']) >= 15 and len(o['lm']) >= 200, 'historic: too few districts or landmarks')
    if prev:
        need(len(o['lm']) >= 0.9 * len(prev['lm']), 'historic: landmarks dropped by more than 10%')


ADDONS['historic.json'] = ('Historic districts and landmarks', [HD_DS, LM_DS], False, lambda api, nbp, geo: build_historic(api), _check_historic)
DATASETS[HD_DS] = ('Local historic districts', 'daily', None)
DATASETS[LM_DS] = ('HDLC landmarks', 'daily', None)


# ---------------------------------------------------------------- C. zoning (planning cases map)
ZONE_DS = 'bizp-xi7c'     # Zoning Districts
ZONE_TOL = 1.0   # 5 m: district lines mostly follow streets and lot lines
ZONE_GROUPS = ['Residential', 'Commercial and mixed use', 'Downtown (CBD)', 'Industrial', 'Campus and planned', 'Open space']


def zone_group(z):
    z = (z or '').upper()
    if z.startswith('CBD'):
        return 2
    if z in ('LI', 'HI', 'MI', 'BIP'):
        return 3
    if z in ('EC', 'MC', 'MS', 'GPD', 'LS'):
        return 4
    if z.startswith('OS') or z in ('NA', 'VCP', 'S-LP'):
        return 5
    if re.search(r'(^|-)(R[SDM]|RE|LR[SDM]|HMR|VCR)', z) or z.startswith(('HMR', 'VCR', 'S-LR', 'R-')):
        return 0
    return 1


def build_zoning(api):
    api.require_columns(ZONE_DS, ['zoneclass', 'zonedesc', 'the_geom'], 'Zoning districts')
    fc = api.get(f'/resource/{ZONE_DS}.geojson', {'$limit': 5000, '$order': ':id'}, kind='geojson')
    feats = fc.get('features', [])
    need(1000 < len(feats) < 5000, f'Zoning districts: {len(feats)} rows')
    desc = defaultdict(Counter)
    for ft in feats:
        p = ft['properties']
        if p.get('zoneclass') and p.get('zonedesc'):
            desc[p['zoneclass'].strip()][re.sub(r'\s+', ' ', p['zonedesc'].strip())] += 1
    Z = sorted({(ft['properties'].get('zoneclass') or '').strip() for ft in feats} - {''})
    zi = {z: i for i, z in enumerate(Z)}
    out = []
    for ft in feats:
        z = (ft['properties'].get('zoneclass') or '').strip()
        r = enc_geom(ft.get('geometry'), ZONE_TOL)
        if z and r:
            out.append([zi[z], r])
    return {'ds': ZONE_DS, 'q': DOT_Q, 'G': ZONE_GROUPS, 'Z': Z, 'zg': [zone_group(z) for z in Z],
            'zd': [desc[z].most_common(1)[0][0] if desc[z] else '' for z in Z], 'f': out}


def _check_zoning(o, prev):
    need(len(o['f']) > 1000 and len(o['zg']) == len(o['Z']) == len(o['zd']), 'zoning: shape')
    if prev:
        need(len(o['f']) >= 0.9 * len(prev['f']), 'zoning: districts dropped by more than 10%')


ADDONS['zoning.json'] = ('Zoning districts', [ZONE_DS], False, lambda api, nbp, geo: build_zoning(api), _check_zoning)
DATASETS[ZONE_DS] = ('Zoning districts', 'daily', None)
