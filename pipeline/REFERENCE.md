# Data reference: how each `data/*.json` file was produced

The first snapshot in `data/` was pulled on **2026-11-18** with JavaScript in a browser. `pipeline/fetch.py` now reproduces it: run against that day's data it matches `geo`, `hist`, `drone` and `cfs` exactly and `cpc` apart from hearings scheduled since. GitHub Actions runs it every morning (`.github/workflows/daily.yml`). It also adds a few fields the pages use: `drone.year`, `cfs.year`, `cfs.ds`, `cpc.windowStart`, `cpc.total`, `cpc.firstFiled`, `cpc.lastFiled`, and `data/sources.json` (see below; it replaced `data/meta.json`).

The front-end expects exactly the shapes documented below. If you change a shape, change the matching `src/*.js`.

## Dots (`dots` in 311, blight, permits and biz)

Every map's base layer is one dot per record (`NOLA.map().dots`, a canvas). The builders write them from rows they already download, so they cost no extra requests (the address columns were added to those same downloads). One `dots` object:

```
{ "q": 4, "epoch": "2000-01-01", "n": records,
  "x": [...], "y": [...],      # map units (the projection below) x q, so about 5 m
  "nb": [...],                 # neighborhood index; records outside every neighborhood or without a location are left out
  "d0": first day, "d": [...], # day of each record as days since epoch: d0, then deltas in date order (-1: no date; those come first)
  ...columns, ...lookup lists }
```

Records are sorted by date (then x, y), so a new day's records only add to the end and the committed file changes little. `NOLA.dotData()` decodes one.

Blight, permit and business dots also carry a street address: `a` indexes the list `A` (most shared first; -1 none, -2 withheld). Addresses are the City's, whitespace collapsed, cut to 48 characters, and all-capitals ones put in mixed case. Business addresses are withheld (-2) where the business may be someone's home: applications marked home-based (about 6,400), and current licenses at an address a home-based application names (about 5,900). `NOLA.addrRow(P, i, withheldText)` makes the tooltip row. Current licenses also carry the business name (`businessname`, cleaned like addresses, cut to 60 characters) as `m` into `M`, withheld with the address (-2) when the license's address matches a home-based application, its type is "Home Based-Office Use Only", or the address is an apartment; the license number can't be matched to the applications' home-based flag (different numbering). A name that is only the owner's own name (`just_a_person`: the owner has no company words and every word of the name is in the owner's name) is left out (-1); `ownername` is downloaded for that check alone and never written, and the build fails if more than 5% of rows lack it.

| File | `dots` | Columns |
|---|---|---|
| 311.json | requests filed in the past 12 months, plus every request still open (any age) | `r` index into `R` ([type index, reason]: the page's `R` plus [type, "Other"] where needed), `c` days to close (-1 open, -2 closed without a close date) |
| blight.json | `cases`: open, or filed in the past 12 months; `grass`: open, or filed in the past 12 months; `abate`: in abatement now (no dates) | cases: `o` open 1/0, `s` stage index (open cases; -1 closed), `i` first inspection (0 violation, 1 none, 2 not yet or other); grass: `o`; all three: `a`/`A` (from `geoaddress` for cases, `address` for the others) |
| permits.json | every permit issued in the past 12 months (day = issue date) | `c` type (`cats`), `lu` land use, `t` index into `T` (the City's permit type), `f` days from filing to issue (-1 unknown), `a`/`A` (`address`) |
| biz.json | `apps`: every application since 2018 (day = filed); `now`: every business licensed now (day = business start date; 1900-01-01 counts as not recorded) | apps: `s` sector (`S`), `o` outcome (`out`), `h` home-based 1/0/-1, `t` business type (`T`); now: `s` sector (`S2`), `t`, `m`/`M` (`businessname`); both: `a`/`A` (`address`) |

`cpc.json` keeps its `pts` and adds `ptsInfo`: [address, case number, open 1/0] for each point, in the same order. Short-term rental `pts` carry their own address and license details.

Checked against the API on 2026-11-19 (one `count(*)` each): 311 requests filed in the 30 days to Nov 18 with a location, 8,231 (8,229 dots; two fall outside every neighborhood); permits issued in those 30 days, 1,496 = 1,496; business license applications filed in them with a location, 171 = 171. Blight's new cases in the past 12 months match the page's existing count (6,477).

API basics: `https://data.nola.gov/resource/<id>.json?$select=...&$where=...&$group=...&$limit=...` (SoQL). CSV is also available at `/resource/<id>.csv`. Metadata is at `/api/views/<id>.json`. A free Socrata app token (header `X-App-Token`) avoids throttling. Store it as a GitHub Actions secret.

---

## The daily refresh: what gets downloaded and committed

The workflow runs at 10:30 UTC. The City reloads most datasets between 04:30 and 06:00 UTC, 311 at about 08:10 UTC, Calls for Service at about 09:00 UTC (3 a.m. Central), and drone flights in occasional batches.

**The change check: one request.** `fetch.py` starts with one request to the Socrata catalog (`/api/catalog/v1?ids=…&ids=…`), which returns every dataset's `data_updated_at` and column names. `data_updated_at` equals the dataset's `rowsUpdatedAt` to the second (checked on all 20 catalogued datasets, and through a nightly load), and the column names are enough for the schema check, so the per-dataset `/api/views/<id>.json` requests (20 a day, 0.9 MB) are gone. The two boundary layers aren't in the catalog; they're checked with `/api/views/<id>.json` on the 1st of the month (they haven't changed since 2015). Past years of Calls for Service join the catalog request on the 1st, and last year's every day in January and February. If the catalog request fails, each dataset is checked on its own as before.

**What gets rebuilt.** A data file is rebuilt only when one of its inputs changed (recorded in `data/sources.json`, below). Nothing about an unchanged file is downloaded or parsed; `geo.json` and the point-in-polygon lookups are built only when some file needs them.

| File | Rebuilt when | Notes |
|---|---|---|
| `geo.json` | a boundary layer (checked monthly) or the population table (`2w4d-xaw2`) changed | Otherwise the last good file is used as is. Features are kept in the order of the last good `geo.json`, because every `nb`/`pd` index (including the hand-built `trees.json`) points into it. |
| `streets.json` | the centerline's segment count or newest `lastupdate` changed | Those two are queried only on a day the centerline's `rowsUpdatedAt` moved: it's re-synced from the City's GIS without edits now and then. |
| `drone.json` | `ay9z-ynxz`'s `rowsUpdatedAt`, `geo.json` or the calendar year changed | |
| `cfs.json` | the current year's dataset id or `rowsUpdatedAt`, or `geo.json`, changed | |
| `hist.json` | with `cfs.json` (current year); a past year when its dataset's `rowsUpdatedAt` moved | Past years are checked daily for last year in January–February, and all years on the 1st of the month. The City loads each year's final rows on January 1. |
| `cpc.json` | `xxb5-5azv`'s `rowsUpdatedAt` or `geo.json` changed | "Today" for upcoming hearings and the 365-day window is the day the City loaded the data. |
| `311.json` | `2jgv-pqrq`'s `rowsUpdatedAt` or `geo.json` changed | Incremental download (see below). "Today" is the newest request in the data. |
| `treereq.json` | with `311.json` (same rows, same key) | No requests of its own: built from the 311 rows already downloaded. |
| `drainreq.json` | with `311.json` (same rows, same key) | No requests of its own: built from the 311 rows already downloaded. |
| `streetreq.json` | with `311.json` (same rows, same key) | No requests of its own: built from the 311 rows already downloaded. |
| `roadwork.json` | `u5mk-y9z4`'s or `bsnu-de3a`'s `rowsUpdatedAt`, or `geo.json`, changed | Both lists are updated nightly, so most days both are downloaded whole: 2 requests, 7.1 MB (0.8 MB transferred). The columns are named in the query, so the outreach contact column is never downloaded. |
| `basins.json` | `se4p-ierc`'s `rowsUpdatedAt`, the cleaning log's content, or `geo.json` changed | The log (`2zer-6wpb`) is reloaded every night with the same rows (its newest dated record is from January 2025), so its version is useless as a key: one small request (`count(*)`, `max(mdate)`, `max(cbmaintid)`) stands in for it. Both datasets are downloaded whole only when one of them really changed (5 requests, 29 MB). |
| `land.json` | `5ktx-e9wc`'s, `hpm5-48nj`'s or `bsqt-btyi`'s `rowsUpdatedAt`, or `geo.json`, changed | All three are small and downloaded whole (3 requests, 3.6 MB), plus one request to the Parcels layer (`v9q5-fz7t`) for the outlines of NORA's lots (0.07 MB). The parcel layer's own date isn't in the key: it only places lots. |
| `str.json` | any of `ufdg-ajws`, `en36-xvxg`, `2ei9-wqw2` or `geo.json` changed | All three are replaced by the City every night, so they're downloaded whole (3 requests). A dataset whose date didn't move is read from the saved answers. |
| `permits.json` | `rcm3-fn58`'s `rowsUpdatedAt` or `geo.json` changed | The City rewrites 99% of rows every night, so incremental downloads don't help. API counts by year and code (with the newest issue date in the same request), plus the past 12 months' rows: 2 requests. |
| `biz.json` | `abc4-h3u3`'s or `hjcd-grvu`'s `rowsUpdatedAt`, or `geo.json`, changed | Both replaced every night: two whole downloads. |
| `blight.json` | any of the six code enforcement datasets or `geo.json` changed | The City reloads five of them every night (every row gets a new `:updated_at`), so incremental downloads don't help; most numbers are counted by the API instead (6 requests). Abatements change every week or two; on other days its answer comes from the saved answers. |

**Saved answers.** Every API answer is kept in `.cache/raw/q/` (gzipped) under the dataset's `rowsUpdatedAt`. Queries are ordered (`:id` as the tie-breaker), so while the City hasn't changed a dataset the same query returns the same rows, and it's read from disk. This matters when a page rebuilds because one of its datasets changed (STR, blight, licenses), when `geo.json` changes, and when a failed run is re-run. Answers replaced by a newer version are deleted at the end of the run. The saved copies of the incrementally downloaded datasets live next to them (below). The workflow restores `.cache/raw` before the run and saves it afterwards, even when a later step fails.

**The monthly check (1st of the month).** The boundary layers and past years of Calls for Service get their dates checked, and each saved copy's row ids are compared with the City's (one request of ids only; see "Large datasets"). Nothing else is downloaded again: a full re-download of datasets the City replaces every night anyway would only repeat the day's download, and every other answer is tied to the dataset's version. `--full` (or the workflow's "full" checkbox) ignores `.cache/raw` and downloads and rebuilds everything.

Rebuilt files are written only when their content changed, and pages embed only the date their own data last changed, so a day without new City data changes nothing and the workflow commits and deploys nothing. `fetch.py` runs `build.py` only when a data file changed, and `build.py` rewrites only the pages whose output changed. When a rebuilt file comes out identical, its new key isn't saved until the next real change, so it may be rebuilt again the next day, from the saved answers and without requests.

### What each dataset costs

Measured 2026-11-19 (MB as the API sends it, uncompressed; about a sixth of that is transferred, gzipped). "How the City updates it" comes from each dataset's `:updated_at` spread and newest records; working notes are in `research/api-minimum.md` (not committed). A typical day is one where every nightly dataset moved, which is most days.

| Dataset | How the City updates it | Checked | Downloaded when it changes | Typical day before | Typical day now |
|---|---|---|---|---|---|
| (change check) | | | | 20 metadata requests, 0.8 MB | 1 catalog request, 0.16 MB |
| Neighborhoods `7fw3-kdpf`, police districts `evki-aju8` | unchanged since 2015 | monthly (2 metadata requests; not in the catalog) | whole layer, 0.7 MB | in the 20 above | 0 |
| Population 2020 `2w4d-xaw2` | unchanged since 2023 | daily (catalog) | whole table, 4 KB | in the 20 above | 0 |
| Centerline `22q2-dqpb` | in place, a few edits a month; re-synced now and then | daily (catalog); count + newest edit only when its date moves | whole layer, 9.7 MB, only when streets were edited | 1 request | 0 |
| Drone flights `ay9z-ynxz` | batches every few weeks | daily (catalog) | the year's flights, 0.2 MB | 0 | 0 |
| Calls for Service 2026 `es9j-6y5d` | in place, nightly at ~09:00 UTC (~1,800 of 305,000 rows) | daily (catalog) | count + changed rows | 2 requests, 0.2–0.5 MB | 2 requests, 0.2–0.5 MB |
| Calls for Service 2014–2025 | closed; final rows loaded January 1 | monthly, and last year daily in Jan–Feb (catalog) | monthly counts, when a year's date moved | 0 (13 metadata requests on the 1st) | 0 |
| CPC projects `xxb5-5azv` | replaced nightly at ~06:00 UTC | daily (catalog) | all rows | 1 request, 9.2 MB | 1 request, 9.2 MB |
| 311 `2jgv-pqrq` (311.json and the trees page's treereq.json, built from the same rows) | in place, nightly at ~08:10 UTC (~1,500 of 1,048,000 rows) | daily (catalog) | count + changed rows; treereq.json adds none | 2 requests, 0.1–0.3 MB | 2 requests, 0.1–0.3 MB |
| STR licenses `ufdg-ajws`, `2ei9-wqw2`, applications `en36-xvxg` | replaced nightly | daily (catalog) | all rows of each one that moved | 3 requests, 8.5 MB | 3 requests, 8.5 MB |
| Code enforcement cases `u6yx-v2tw` | replaced nightly | daily (catalog) | open cases and cases since 2016 | 1 request, 7.2 MB | 1 request, 7.2 MB |
| Violations `3ehi-je3s`, hearings `44ct-56tr`, inspections `uh5a-f7uw` | replaced nightly | daily (catalog) | API counts | 5 requests, 0.1 MB | 3 requests, 0.1 MB |
| Grass cutting `xhih-vxs6` | 99% of rows rewritten nightly | daily (catalog) | all rows | 1 request, 2.8 MB | 1 request, 2.8 MB |
| Abatements `xv8z-gn8b` | in place, every week or two | daily (catalog) | all rows, 0.6 MB | 1 request, 0.6 MB | 0 (saved answer) |
| Permits `rcm3-fn58` | 99% of rows rewritten nightly | daily (catalog) | counts by year + past 12 months' rows | 3 requests, 4.2 MB | 2 requests, 4.2 MB |
| License applications `abc4-h3u3`, current licenses `hjcd-grvu` | replaced nightly | daily (catalog) | all rows of each | 2 requests, 10.8 MB | 2 requests, 10.8 MB |
| Catch basins `se4p-ierc`, cleaning log `2zer-6wpb` | inventory edited a few times a year; log reloaded nightly, unchanged since January 2025 | daily (catalog + 1 content check) | both whole, only when the inventory's date or the log's content moved | — | 1 request, under 1 KB (29 MB on a change) |
| RoadWork DPW `u5mk-y9z4`, SWB `bsnu-de3a` (roadwork.json; the 311 street requests come from the 311 rows above) | updated nightly | daily (catalog) | all rows of each that moved (14,300 + 8,400 rows) | — | 2 requests, 7.1 MB (0.8 MB transferred) |
| NORA uncommitted inventory `5ktx-e9wc`, NORA sold `hpm5-48nj`, Public Land `bsqt-btyi`, Parcels `v9q5-fz7t` | the NORA lists a few times a year (both 2026-11-10); Public Land last 2025-11-10; parcels about monthly | daily (catalog) | all three whole + NORA's parcels, only when one of the three moved | — | 0 (4 requests, 3.7 MB on a change) |
| **Typical day** | | | | **42 requests, 44.5 MB (6.8 MB transferred)** | **21 requests, 50.7 MB (7.5 MB transferred)** with road work; 19 requests, 43.6 MB before it |
| **Day without new City data** | | | | 21 requests, 0.8 MB | **2 requests, 0.16 MB (21 KB transferred)**: the catalog and the catch basin log's content check |
| **1st of the month** (on top of the day) | | | | everything again: 79 requests, 248 MB (53 MB transferred) | 4 requests: 2 boundary checks, row ids of 311 and calls, 22 MB (11 MB transferred) |
| **Empty cache** (first run, or no run for 7 days) | | | | 79 requests, 248 MB | 46 requests, 237 MB (50 MB transferred), mostly the 311 and calls copies |

Most of a typical day's bytes are the datasets the City replaces every night. Their content changes most days (new records daily, including weekends: 3–14% of a year's STR, license, 311 and violation records are dated on weekends), so downloading them whenever their date moves is what keeps the pages a day fresh. An incremental download wouldn't help: every row's `:updated_at` changes nightly, so the "changed rows" are all of them.

`data/sources.json` is the pipeline's memory, rewritten only along with a data change:

```
{ "files": { "cfs.json": {"key": "<inputs it was built from>", "changed": "2026-11-18"}, ... },
  "histVersions": { "2026": "<rowsUpdatedAt when hist.json last counted that year>", ... },
  "cfsIds": { "2027": "<id found in the catalog>" },        # years not in CFS_IDS, so the catalog is searched once
  "versions": { "2jgv-pqrq": "<rowsUpdatedAt>", ... },  # each dataset's last City update as last seen; build.py shows it (MM/DD/YY) in the sources box beside each page's title
  "copies": { "2jgv-pqrq": "2026-11-19" } }                 # last day a saved copy had to be downloaded again in full, unasked
```

Keys hold the inputs: dataset versions plus `geo_key` (a hash of `geo.json`) for the data files, the two boundary versions and the population version for `geo.json`, and the centerline version, segment count and newest edit for `streets.json`. When only a key changes (the centerline re-synced without edits), it's noted with the next real data change.

`build.py` shows each data page's "Updated" date as the latest `changed` of that page's files (and `geo.json`), and passes it to the page as `DATA.meta.pulled`. The About page shows the latest date of any page.

**When something fails.** A file that fails to fetch or validate keeps its last good version, and the other files still refresh and publish. The run then ends failed (the `report` job), so GitHub emails the owner. If the boundaries fail, nothing is published. Datasets whose newest record is old (no calls for 7 days, no flights for 45, no filings for 30, no new records for 7–14 days on the newer pages) show as warnings on the run.

**Alerts (the run fails, after publishing).**
- A dataset's "last updated" date stands still longer than `DATASETS` in `fetch.py` allows: 5 days for everything the City reloads nightly (and this year's Calls for Service), 60 for drone flights and abatements, no limit for boundaries, population, the centerline and past years. The page keeps showing the last data with its true "Updated" date; the alert says the City's feed stopped.
- A saved copy (311, Calls for Service) had to be downloaded in full again within 3 days of the last time (`copies` in `sources.json`). Once is a warning (expected after the cache expires, i.e. no run for 7 days); twice means the cache isn't surviving between runs, which would otherwise quietly cost a full download every day.

**The schedule.** GitHub switches off scheduled workflows after 60 days without commits. If 45 days pass without a commit, the workflow re-enables itself through the API.

## Shared: coordinates and neighborhoods (`data/geo.json`)

**Projection.** All x/y values in every data file use the same local planar projection, in units of about 20 m:

```
X(lon) = round((lon + 90.14) * 96600 / 20)
Y(lat) = round((30.20 - lat) * 111000 / 20)      # y grows southward, like SVG
```

**Boundaries.**
- Neighborhoods: dataset `7fw3-kdpf` ("(ALTERNATE) Neighborhood Statistical Areas", 72 features, name field `gnocdc_lab`). Fetch with `/resource/7fw3-kdpf.geojson`.
- Police districts: dataset `evki-aju8` (8 features, field `district`).

**Encoding.** Each ring is simplified with Douglas–Peucker at a tolerance of 0.0003° (each closed ring is split at its midpoint, both halves simplified, then rejoined). Points are projected with X/Y, consecutive duplicates are dropped, and the ring is stored as a flat delta-encoded int array `[x0, y0, dx1, dy1, ...]`. Rings with fewer than 4 points after simplification are dropped.

```
geo.json = { "nb": [ {"n": NAME, "r": [ring, ...]}, ...72 ],   # order = feature order from the API
             "pd": [ {"n": DISTRICT, "r": [...]}, ...8 ],
             "pop": [2020 population per nb, ...72],
             "hu":  [2020 housing units per nb, ...72] }
```

**Population and housing units.** `pop` is `sum_pop100` and `hu` is `sum_hu100` from "Neighborhood Statistical Areas Demographics 2020" (`2w4d-xaw2`), matched on `gnocdc_lab` (two spellings differ; see `POP_ALIAS` in `fetch.py`). It's used only for the calls-for-service map's "Per 1,000 residents" option. Planning cases and street trees aren't shown per resident: cases follow parcels and trees follow streets, so population is the wrong denominator for them. Neighborhoods under 1,000 residents get no rate.

**Opening view.** Every neighborhood is drawn, counted and listed in the pickers. `NOLA.setGeo` marks neighborhoods under 100 residents per square mile (`f.skip`: Lake Catherine, Viavant–Venetian Isles) only so maps *open* on the rest of the city; they're one zoom-out or menu pick away. Shaded maps use seven equal-count classes (`NOLA.classes`, legend `NOLA.stepLegend`).

**Neighborhood index.** Every `nb` index in the other files is a position in this array. It's assigned by point-in-polygon against the **unsimplified** API geometry in lon/lat, with a bbox prefilter. Use -1 when the point is outside every polygon. **geo.json and the other files must be regenerated together** so the indices stay aligned.

---

## `data/streets.json`: street base map (Centerline, `22q2-dqpb`)

Every map draws the City's street centerlines under its data. `build.py` writes them to `site/streets.js` (`window.STREETS = ...`), one file the browser caches across pages, and `NOLA.map()` in `src/lib.js` draws them.

```
streets.json = { "q": 4, "n": segmentCount, "d": [freeway, ramp, arterial, local],   # each an SVG path string
                 "lab": { "names": [...], "a": [...] } }                            # street-name label positions
```

- `roadclass` → tier: Freeway 0, Ramp 1, Major/Minor Arterial 2, Local 3. "Other" (alleys, driveways), "Umimproved" and `inwater = Yes` are left out.
- Each line is simplified with Douglas–Peucker at 0.00003°, projected with X/Y multiplied by `q` (so about 5 m resolution), and written as `M x y l dx dy ...`. Pages draw it with `scale(1/q)`.
- Local streets fade from 35% to full opacity as you zoom in.
- `lab` holds street-name positions: `{ names, a: [x, y, angleDeg, halfLength, nameIndex, tier, ...] }` (x, y and halfLength in map units × q; tier 0 freeway, 1 arterial, 2 local). Built from `fullnameabv`: each street's block-length pieces are chained into nearly straight runs (turns under 28°), then anchored every ~60 map units (1.2 km). Pages place a name only where the run is longer than the label at the current zoom, skip overlaps, and space repeats of the same name apart.

---

## `data/drone.json`: NOPD Drone Flights (`ay9z-ynxz`)

Fetch every row (742 as of the pull): `$select=serial,longitude,latitude,takeoff_datetime,total_flight_time,deployment_purpose,activity_summary&$order=takeoff_datetime&$limit=5000`

```
{ "drones": ["22ba", ...],            # sorted unique serials with the "SkydioX10-" prefix stripped
  "missingPurpose": int, "inferred": int, "unknown": int,
  "recs": [[doy, hourUTC, durSec, cat, droneIdx, nbIdx, x, y, eventCode, inferredFlag], ...] }
```

- `doy` is days since 2026-01-01 using the timestamp **as given**. `hourUTC` is hour plus minute/60, rounded to 4 decimals (to the minute, so a 10:58 takeoff stays in the 10 o'clock hour). The timestamps look like UTC, and the front end converts them to Central time (CDT from 2026-03-08 08:00 UTC to 2026-11-01 07:00 UTC). **When the year rolls over, update the hard-coded 2026 dates and DST dates in `src/drone.js` and `src/lib.js` (`doyDate`).**
- When a flight has no lon/lat, store x = y = 0 and nb = -1.
- `cat`: classify `deployment_purpose`. When that's blank, classify `activity_summary`. A blank purpose with an informative summary counts as inferred (`inferredFlag` = 1). A blank purpose whose summary is also blank or doesn't match a rule gets cat 8 ("not recorded"). Rules are case-insensitive, checked in this order:
  - 6 barricade/patrol: `barricade|bourbon`
  - 5 investigation/tactical: `warrant|narcotic|surveil|atf|swat|tactical|shoot house|drug|arrest`
  - 3 scene reconstruction: `reconstruction|photogrammetry|crash|accident`
  - 4 search & rescue: `search & rescue|rescue|missing`
  - 1 event overwatch: `overwatch|over watch|parade|event`
  - 0 call for service: `dispatch|call for service|carjack`
  - 2 training/test: `train|test|demo|non-operational|maint`
  - otherwise 7 (other)
- `eventCode` (matched on purpose and summary joined with a space): 1 mardi, 2 french quarter fest, 3 jazz, 4 essence, 5 saints/nfl, 6 super sunday/second line, 7 decadence, 8 takeover, otherwise 0.
- Only flights in the page's calendar year are fetched. In early January, before the new year has flights, the page keeps showing last year.
- `src/drone.js` computes `DFR` (Oct 13, 2026, the start of daily dispatch flights) as a day of the page's year. For 2027 on it is 0, which hides the before/after comparison and swaps the 2026 headline for a neutral one. Write a new headline when the 2027 story is clear. DST dates are computed for any year.

## `data/cfs.json`: Calls for Service 2026 (`es9j-6y5d`)

Note: `timecreate` and the other times are **text** columns in 2026 and 2025, but calendar_date in earlier years. Columns used: `timecreate,timearrive,typetext,priority,selfinitiated,dispositiontext,location`, fetched as CSV in pages of 50,000 (`$order=:id&$offset=`) together with the system fields `:id` and `:updated_at`. The City updates the dataset in place each night, so `fetch.py` keeps a copy of the year's rows in `.cache/raw/cfs-<id>.csv.gz` and on later runs asks only for `:updated_at >= <newest in the copy>`, merging by `:id` (a few thousand rows a day instead of ~300,000). If the merged row count differs from the City's `count(*)` (rows were deleted), the copy is missing, or it's a full run (the 1st of the month or `--full`), every row is downloaded again. Rankings (`TOP`, `disp`) break count ties by name, so the result doesn't depend on row order; an incremental build was checked to be identical to a full download. The `location` field is `POINT (lon lat)`. Times are local.

```
{ "TOP": [24 most common typetext values, by count],
  "last": lastDoyWithData,
  "daily": [[publicCount, selfInitiatedCount] per doy 0..last],
  "heat":  [7 weekdays (0 = Sunday)][24 hours] counts of PUBLIC calls,
  "types": [[n, nSelf, medianRespMin, p90RespMin, nGoneOnArrival, nReportToFollow, [priorityDigit0..3 counts]] per TOP],
  "nb":    [[public, self, medianRespP2, medianRespP1, nRespP2, [count per TOP type]] per neighborhood],
  "pd":    [[district, public, self, medianRespP2, p90RespP2, medianRespP1, nRespP2] per police-district feature],
  "mResp": [[medianP2, medianP1] per month 0..11],
  "disp":  [[dispositiontext, n] top 8],
  "noLoc": int, "outside": int }
```

- **Response time** = timearrive − timecreate in minutes, with both times truncated to whole seconds. It counts only public calls (`selfinitiated != 'Y'`) that have an arrival and whose value is ≥ 0 and < 1440.
- **Priority group** = the first character of `priority` (2 = emergency, 1 = non-emergency).
- **Medians and percentiles**: `sorted[floor(n * q)]` (no interpolation), rounded to 0.1. Null when there are fewer than 15 values.
- **Valid location**: lon < -89.5 and lat > 29.8. Neighborhood and district come from point-in-polygon.
- `GONE ON ARRIVAL` and `REPORT TO FOLLOW` are values of `dispositiontext`.
- Medical and mental-health calls have no location in the source data.

## `data/hist.json`: monthly call history

```
{ "2014": [[public, self] x 12], ..., "2026": [... months so far] }
```

Yearly dataset ids: 2014 `jsyu-nz5r`, 2015 `w68y-xmk6`, 2016 `wgrp-d3ma`, 2017 `bqmt-f3jk`, 2018 `9san-ivhk`, 2019 `qf6q-pp4b`, 2020 `hp7u-i9hf`, 2021 `3pha-hum9`, 2022 `nci8-thrr`, 2023 `pc5d-tvaw`, 2024 `2zcj-b6ts`, 2025 `4xwx-sfte`, 2026 `es9j-6y5d`. (2011–2013 have no selfinitiated column, so they're skipped.)

- **Calendar-date years**: `$select=date_trunc_ym(timecreate) as m,selfinitiated,count(*) as n&$group=m,selfinitiated`
- **Text-time years (2025, 2026)**: run one query per month: `$where=timecreate>='YYYY-MM-01' AND timecreate<'next month'&$group=selfinitiated`

Past years are closed. The daily job recomputes the current year from the rows it already fetched for `cfs.json`, and recounts a past year only when its dataset's `rowsUpdatedAt` moved (see "The daily refresh" above). `src/cfs.js` leaves the current month off the trend chart until the data reaches the month's last day.

**New year:** the City publishes a new dataset id each January ("Calls for Service 2027"). `fetch.py` looks it up in `/api/catalog/v1?domains=data.nola.gov&q=calls%20for%20service%20YYYY` by exact name. Until it exists (or while it's empty) the page keeps showing last year. If it still isn't found by March the job fails: add the id to `CFS_IDS` in `fetch.py`.

## `data/cpc.json`: CPC Projects (`xxb5-5azv`)

Fetch every row (15,671 as of the pull; 15,579 after dropping rows the dataset repeats exactly, which `fetch.py` counts once): `case_type,case_num,address,filing_date,current_status,open_closed,previous_meeting_status,next_meeting,next_meeting_date,description,longitude,latitude`

```
{ "TYP": [11 type names], "TH": [7 topic names],
  "typeY":  {year: [count per TYP]},     # all filings, by filing year
  "themeY": {year: [count per TH]},
  "openByType": [...], "dec": {"appr", "den", "wd"},
  "nbRecent": [[count per TYP] per nb]   # last 5 years
  "up":  [[nextMeetingISO16, body, caseNum, typeName, address, nb, x, y, description], ...]  # next_meeting_date >= today, sorted
         # address = text before the first comma, cut to 40 chars; description = whitespace collapsed, cut to 170 chars
  "pts": [[daysSinceWindowStart, typIdx, x, y, nb, topicBitmask], ...] }  # filings in the last 365 days
```

- **TYP index rules** (substring match on `case_type`, checked in this order):
  - 5 if it contains `Zoning Change`
  - 9 `Master Plan`
  - 6 `Text Amendment`
  - 8 `Major Subdivision`
  - 4 `Conditional Use`
  - 2 if it starts with `NPP`
  - 7 `Appeal`
  - 3 `Design Review` or `Stormwater`
  - 0 `Variance`
  - 1 `Minor Subdivision`
  - otherwise 10
- **Topic regexes** (case-insensitive, on description):
  - STR: `short[- ]term rental|\bstr\b`
  - hotels: `hotel|guest ?house|bed (and|&) breakfast|\bb&b\b`
  - alcohol: `alcohol|liquor|\bbar\b|lounge|tavern`
  - multi-family: `multi-?family|apartment|dwelling units|\d+[- ]unit`
  - restaurants: `restaurant`
  - demolition: `demoli`
  - child care: `day ?care|child ?care|school`
- **`dec`**: since 2016, `previous_meeting_status` starting with approv (or containing "modified approval") counts as appr. Starting with deni/denial counts as den. Exactly "withdrawn" counts as wd.
- `typeY` and `themeY` start at 2004 (the few December 2003 filings are left off). `pts` is in API (`:id`) order.
- The `pts` window starts 365 days before the pull date and is stored as `windowStart`.
- `up` can still list a case twice (rows that differ only in other fields). The front end dedupes them on date + case number, and flags dates that fall on a weekend or holiday as "date as listed".

## Large datasets: incremental downloads (`synced_rows` in `fetch.py`)

The 311 page and the calls for service page keep a copy of the rows they need in `.cache/raw/<id>.csv.gz` (`cfs-<id>.csv.gz` for calls), with each row's Socrata `:id` and `:updated_at`. Each run asks only for rows with `:updated_at` at or after 15 minutes before the newest one in the copy (one request of a few thousand rows; the overlap covers a load that was still in progress last time) and merges them in by `:id`. Every run compares the merged copy's row count with the City's `count(*)` for the same filter. On the 1st of the month it also downloads the City's row ids alone (one request, about 13 MB for 311) and compares them with the copy's, which catches a deletion offset by an addition. If either differs (rows deleted, or moved out of the filter), the copy is missing or unreadable, its columns changed, or it's a `--full` run, every row is downloaded again in pages of 50,000. Rows are always sorted by `:id` before aggregating, so an incremental build and a full download give identical files.

This only pays off for datasets the City updates in place. Measured on 2026-11-19: 311 changes about 1,500 of 1,048,000 rows a night and Calls for Service about 1,800 of 305,000, but permits (99% of 350,000 rows) and grass cutting (99% of 23,500) get a new `:updated_at` on nearly every row every night, and CPC, STR, licenses and the other code enforcement datasets are replaced outright, so a "delta" would be the whole dataset.

## `data/311.json`: 311 OPCD Calls (`2jgv-pqrq`)

Rows with `date_created >= 2019-02-01` (about 730,000), columns `request_type, request_reason, date_created, case_close_date, request_status, longitude, latitude`, downloaded incrementally (above). A full download is about 19 requests and 136 MB (about 30 MB as transferred); a normal day is two small requests (the count and the changed rows). The City's file dates about 313,000 older (2012–2018) requests to January 1–2, 2019, when they were moved into the current system, so the page starts with February 2019.

```
{ "ds", "start": "2019-02", "last": newest date_created (YYYY-MM-DD), "winStart": first day of the past 12 months,
  "T": [12 request types by count in the past 12 months, then "Other"],
  "R": [[typeIdx, reason], ...],          # reasons with >= 30 requests in the past 12 months, then [typeIdx, "Other"] per type
  "mon": [[count per T] per month from start],                    # whole city
  "years": [2019, ...], "nby": [[[count per T] per year] per nb], # by year created
  "nb12": [[reasonIdx, n, reasonIdx, n, ...] per nb],             # past 12 months
  "ages": [30, 90, 365, 730],
  "openAge": [[[n per age bucket] per T] per nb, + whole city as row 72],  # request_status = Pending, by days since created
  "closeR": [[n, medianDays, p90Days] per R], "closeT": [[n, medianDays, p90Days] per T],
  "closeNb": [[[n, medianDays] per T] per nb],
  "total", "recent", "open", "noLoc" }
```

- **Past 12 months** = the 365 days ending on `last` (`winStart` to `last`).
- **Types**: `request_type` as the City records it. Types not in `T` (including ones the City no longer uses, like `Roads/Drainage`) are counted as "Other".
- **Open** = `request_status` "Pending". Age buckets: under 30 days, 30–89, 90–364, 1–2 years, over 2 years.
- **Time to close** = `case_close_date − date_created` in days, for requests with `case_close_date` in the past 12 months and not before `date_created`. Many closed requests have no close date (most closed abandoned-vehicle requests), so they're not counted. Medians and 90th percentiles use the same rule as the calls page (`sorted[floor(n * q)]`, null under 15 values).
- **Location**: lon/lat, point-in-polygon against the neighborhoods. Rows with lon/lat of 0 have no neighborhood (`noLoc`, about 2%).
- The page offers requests per 1,000 residents (2020 population), since requests come from people; neighborhoods under 1,000 residents get no rate.

Checked against the API on 2026-11-19: past-12-month total, open total, October 2026 total and Streetlights in October 2026 match `count(*)` queries exactly, and Lakeview and St. Roch match `within_polygon` counts.

## `data/treereq.json`: 311 tree requests (trees page)

The "Tree requests (311)" map on the trees page. `build_311` keeps every 311 request of type `Tree Service` (about 10,800 since November 2020; nearly all since 2022) and writes one point per located request:

- `R`: reasons with at least 30 requests, by count (ties by name), then "Other". Today: Tree Trim, Street or Sidewalk Blocked, Dead or Dying Tree (added April 2026), Blocking Stop Sign or Traffic Signal.
- `x`, `y`: longitude / latitude x 1e5. `nb`: neighborhood index in `geo.json` (the page maps it to the inventory's own neighborhood list by name).
- `r`: reason index. `d`: day filed, as days since `t0`. `c`: days from filing to the City's close date (-1 still pending, -2 closed with no close date).
- `last`: the newest 311 request, the page's "today" for the Month / 6 months / Year filter.

Checked against the API on 2026-11-19: 1,706 tree requests filed in the 182 days to Nov 18, 846 still pending; the page shows 1,705 (one has no location) and 846 open.

## `data/drainreq.json`: 311 drainage requests (drainage page)

The "Drainage requests (311)" map and per-year chart. `build_311` keeps every 311 request of type `Drainage`, plus the drainage reasons filed under `Roads/Drainage` (used alongside it until August 2024) and `Roads and Streets` (`DR_GROUPS`): about 31,600 since February 2019, 4,970 still pending.

- `G`: reason groups (`DR_GROUPS`): catch basin clogged or not draining; street flooding; broken basin or manhole cover; ditch or culvert; drainage issue, not specified; water main break or leaking hydrant; other.
- `dots` (`dot_pack`): one per located request (31,343; 293 have no location). `g`: group; `c`: days from filing to the City's close date (-1 still pending, -2 closed with no close date).
- `last`: the newest 311 request, the page's "today" for the Month / 6 months / Year filter.

## `data/streetreq.json`: 311 street and streetlight requests (streets page)

The "Street requests (311)" map and per-year chart. `street_requests` keeps the 311 requests whose reason is in `SQ_GROUPS`, under the types `Roads and Streets`, `Streetlights` and the ones they replaced (`Roads/Drainage` until 2024, `Traffic Signals/Signs/Striping/Streetlights` until 2023): 92,209 since February 2019 (as of Nov 18, 2026), 15,376 still pending. Drainage reasons (including "Ditch and Culvert Maintenance") stay on the drainage page; signs and striping are left out.

- `G`: reason groups: pothole; street sinking; sidewalk, curb or ramp; shoulder or pavement damage; utility cut left unpaved; debris in the road; streetlight out; streetlight down or leaning; new streetlight wanted. Groups from `lights` (6) on are streetlights.
- `dots` (`dot_pack`): one per located request (91,444; 765 have no location). `g`: group; `c`: days from filing to the City's close date (-1 still pending, -2 closed with no close date).
- `last`: the newest 311 request, the page's "today" for the Month / 6 months / Year filter.
- The 311 copy has no address column, so tooltips show no address (adding one would mean re-downloading every 311 row once).

## `data/roadwork.json`: City road, sewer and water work (streets page)

The City's RoadWork project lists, one row per street segment of a project, each a point: DPW paving projects (`u5mk-y9z4`, 14,297 rows, 508 projects) and SWB sewer, water and drainage line work (`bsnu-de3a`, 8,416 rows). Most SWB rows carry a DPW project id (6,918) and segment id (7,264): they are the lines under the same streets. `build_roadwork` merges both by `segmentid`: 15,449 segments, 15,446 mapped.

- `P`: one row per project id in either list (542), with the columns in `pcols`: `id`, `name` (blank for 58), `phase` (index into `phases`: under construction, planned, complete, not stated; the phase most of its segments give, DPW's when the project is there; blanks don't vote), `program` (`projtype` codes expanded: RR FEMA Recovery Roads, DPW Public Works, SELA, HMGP, NDR, DOTD, RTA; unknown codes kept), `contractor` (a company), `cost`, `start`, `end` (`YYYY-MM-DD`, or the City's quarter text like `Jan-Mar 2027`; blank for TBD), `endYear` (0 when none), `src` (1 DPW, 2 SWB, 3 both). Projects by phase (`projects`): 17 under construction, 112 planned, 389 complete, 24 not stated.
- **Cost:** `total_cost` is the whole project's cost repeated on every segment (summing rows gives about $77 billion). It's kept once per project here and the page never adds it up.
- `outreach_contact` (often a person's name) is never downloaded. `lookahead_*` columns are mostly empty or from 2023 and aren't used.
- `dots`: one per segment, no dates. `p`, `ph`, `ct`: DPW project (index into `P`), phase, construction type (`CT`), or -1 when the segment isn't in the DPW list. `sp`, `ss`, `sk`, `st`: SWB project, phase, kind of lines (`K`: the 75 spellings of `sstype` grouped by the lines they name) and the City's own wording (`ST`), or -1.
- The page matches each road request to the nearest segment point within 60 m (in the browser, not here), so the two files stay independent.

## `data/basins.json`: catch basins (drainage page)

The City's catch basin inventory (`se4p-ierc`, about 80,500), with the work its cleaning and inspection log (`2zer-6wpb`) records. Served to the page as `site/basins-data.js` (`STATIC_DATA` in `build.py`), so browsers cache it.

- The log's location ids (`gisid` like `393-462-0441`) don't match the inventory's (`CB130338`). Each log entry is matched to the inventory basin nearest its point within `CB_MATCH_M` (5 m): 61,711 of 65,742 entries with a work type (94%). `matched`, `unmatched`.
- The log has 103,767 rows; 65,734 are dated, from `logFirst` (2017-01-09) to `logLast` (2025-01-02). About 38,000 rows have no date and no work type and are left out. Logged work by year (`years`, `yw`: cleaned, inspected, inaccessible) falls from about 19,000 entries in 2017 to about 2,000 in 2024.
- `dots`: one per located basin. `day`: the last cleaning recorded (none: no day). `t`: type (`T`; IN, I and In are "Inlet"). `k`: cleanings recorded. `rs`: the reason given for the last one (`RS`). `v`, `vd`: a later visit that wasn't a cleaning (`W`: inspected or inaccessible) and its day (days since `epoch`), else -1. `s`: street (`S`).
- Because the log stops in January 2025, the page shows the last cleaning *recorded*, never "time since cleaned", and the sources box shows "ends 01/02/25" for the log instead of its nightly reload date.

## `data/land.json`: vacant and public land, NORA sales (vacant land page)

Three small datasets, each downloaded whole: NORA's Uncommitted Property Inventory (`5ktx-e9wc`, 214 lots: 213 vacant lots and 1 structure), the City's Public Land list (`bsqt-btyi`, 2,149 sites, last updated November 2025) and NORA Sold Properties (`hpm5-48nj`, 5,626 sales, 1980 to September 2026).

- NORA's inventory has no coordinates. Each lot is placed at a point inside its parcel: its `geopin_2` looked up in the Parcels layer (`v9q5-fz7t`, `geopin`, `the_geom`) with one `$where geopin in (...)` request per 300 lots (`land_parcels`). All 214 matched on 2026-11-20. Sales without a geocoded point (12) are looked up there too; 11 matched.
- Public land rows carry MultiPolygons: the dot is the area centroid of the largest part, or, when that falls outside it, the middle of the widest stretch of the part along the centroid's latitude (`ring_point`). 4 of 2,149 fall outside every neighborhood or have no outline. Size: the City's `acerage` when given, else the outline's area.
- A NORA lot whose geopin is also on the public land list (135 of 214) is one dot, `src` 0, with the list's type, agencies and note.
- `land` (`dot_addresses`; no dates): `src` 0 NORA lot, 1 public land. `g`: public land group (`G`, from the City's `type`, spellings joined: `LAND_TYPE_GROUP`); NORA lots not on the City's list count as vacant land. `t`: the City's type (`TY`). `z`: NORA zoning (`Z`). `m`: managing agency (`M`), `o`, `u`, `l`: owned, used and leased by (`O`; agency spellings joined by `LAND_AGENCY`; all organizations). `nm`: site name (`N`). `k`: the City's note, only the four status notes in `LAND_NOTES` (the rest are deed references). `s`: square feet (-1 none), `sb`: size class (`sizes`). `sd`, `c`: the parcel's newest NORA sale, as days since `epoch` and channel (`SC`), else -1.
- 420 public land sites have a NORA sale on record for their geopin, nearly all dated before the list's November 2025 update; the page draws them faded, and can hide them or show only them.
- `sold` (`dot_addresses`): one per sale with a location (5,625 of 5,626). `day`: sale date. `c`: channel group (`CH`: Auction, Lot Next Door, Development, Alternative Land Use, Other = Special Transfer and Affordable Housing Development). `e`: the exact channel (`CHX`). `i`: 1 when the parcel is on NORA's uncommitted list again.
- `years`, `yc`: every sale by year (from 2000) and channel group; `pre`: the 18 sales before 2000. `first`, `last`: oldest and newest sale. `inv`/`invNoLoc`, `pub`/`pubNoLoc`, `total`/`noLoc`, `byParcel`, `merged`: counts for the checks and About.
- Buyers aren't in the City's file. NORA describes its lists at https://noraworks.org; "uncommitted" means not under contract or committed to a program, not that a lot is for sale.

## `data/str.json`: short-term rentals

Three datasets, each downloaded whole (ordered by `:id`):

- **Active Short-Term Rental Licenses** (`ufdg-ajws`, about 4,300 rows): `license_type, residential_subtype, bedroom_limit, issue_date, longitude, latitude, license_number, address, expiration_date` (the license's public details for the map's tooltips; operator and holder names and contacts are not kept). Licenses of type "Short Term Rental Operator" are permits for the person running a rental, not a place, so they're counted separately (`operators`, by subtype) and left off the map. The other three types (`cat`) are mapped: 0 "Short Term Rental Commercial Owner", 1 "Non-Commercial Short Term Rental", 2 "Lodging Exempt from STR Regulation". A new type fails the build (add it to `STR_CAT`).
- **Non-Commercial Short-Term Rental Licenses** (`2ei9-wqw2`, about 1,200 rows): `type_of_building, partial_whole, operator_type, bedrooms_rented, current_status, location`.
- **Short-Term Rental Permit Applications** (`en36-xvxg`, about 39,000 rows since 2017): `application_date, license_type, residential_subtype, current_status, x, y`. This dataset has no lon/lat columns, only Louisiana South state plane x/y in US feet (EPSG:3452), converted with `sp_lonlat` (an inverse Lambert conformal conic; it matches the City's own lon/lat in the other STR datasets to 1e-7°). x/y of -1 means no location.

```
{ "ds": [ids], "last": newest application_date,
  "cat": [3 license types], "pts": [[x, y, cat, nb, bedroomLimit, address, licenseNumber, issueDate, expirationDate], ...]   # sorted; dates YYYY-MM-DD or ""
  "operators": [[subtype, n], ...],
  "nc": { "B": [building types], "OP": [operator types], "ST": [statuses],
          "rows": [[nb, building, whole(1)/partial(0)/not stated(2), bedrooms, operatorType, status], ...] },
  "groups": ["Commercial", "Residential / non-commercial", "Temporary", "Other or not stated"],
  "status": ["Issued", "Expired", "Revoked", "Pending", "Withdrawn", "Denied", "Duplicate"],
  "years": [2017, ...], "yr": [[[n per status] per group] per year],
  "nby": [[yearIdx, group, status, n, ...] per nb],
  "total": mapped licenses, "apps": application rows, "undated": applications without a date }
```

- **Application groups** (`str_group`): Commercial = "Short Term Rental Commercial Owner", or "Short Term Rental" with subtype "Commercial STR" (2017 rules). Residential = any "Non-Commercial…" type, "Short Term Rental Residential Owner…", "Interim STR", or "Short Term Rental" + "Accessory STR". Temporary = "Short Term Rental" + "Temporary STR". Everything else (a few unlabeled or "Choose a License Type" rows) is "Other or not stated".
- **Status** is `current_status` as of the download; "Expired" means the license was issued and has since expired. An unknown status fails the build (add it to `STR_STATUS`).
- The page shades neighborhoods by license count or by licenses per 100 housing units (2020 Census `hu` in geo.json). Neighborhoods under 500 housing units get no rate.

Checked against the API on 2026-11-19: license counts by type, status totals and non-commercial building types match `count(*)` queries; Marigny and Bywater match `within_polygon` counts for both license datasets.

## `data/blight.json`: blight and code enforcement

Six datasets. The City replaces each of them in full every night, so the builder downloads only what it must and lets the API count the rest:

| Dataset | What's fetched |
|---|---|
| Code Enforcement All Cases `u6yx-v2tw` | rows with `o_c = 'Open' OR casefiled >= 2016-01-01` (about 47,000; 1 request): `casefiled, o_c, stage, xpos, ypos, initinspresult, geoaddress` |
| Grass Cutting `xhih-vxs6` | all rows (about 23,500): `casefiled, o_c, longitude, latitude, address` |
| Code Enforcement - Abatements `xv8z-gn8b` | all rows (about 7,200): `o_c, stage, xpos, ypos, address` |
| Code Enforcement All Hearings `44ct-56tr` | API counts by year and `judgment` for hearings from 2016 through "today", and a count of hearings after it |
| Code Enforcement All Violations `3ehi-je3s` | API counts by `violation` for the past 12 months and the 12 before |
| Code Enforcement All Inspections `uh5a-f7uw` | API counts by month and `inspectiontype` from 2016 |

"Today" is the newest `casefiled` date; the past 12 months are the 365 days ending then. Cases and abatements are located by state plane `xpos`/`ypos` (see `sp_lonlat`; -1 means none), grass cases by lon/lat.

```
{ "ds": [6 ids], "last", "winStart",
  "stages": [6 open-case stages], "ages": [90, 365, 730, 1826],
  "openAge": [[[n per age bucket] per stage] per nb, + whole city as row 72],   # open cases by days since filed
  "new12": [[violation found, no violation, not inspected yet or other] per nb],  # filed in the past 12 months, by initinspresult
  "years": [2016, ...], "yr": [[[still open, closed] per year filed] per nb, + whole city],
  "gyears": [2021, ...], "gyr": same for grass-cutting cases, "g12": [grass cases filed in the past 12 months per nb],
  "abOpen": [properties in abatement now per nb], "abEnd": [[how closed abatement cases ended, n], ...],
  "hearGroups": ["Guilty", "Dismissed", "Reset", "Pending", "Other"], "hear": [[n per group] per year], "upcoming": n,
  "viol": [[violation, past 12 months, 12 months before], ...top 25], "violTotal": [all violations, past 12, before],
  "inspGroups": ["Inspection", "Reinspection", "Posting a notice", "Other"], "insp": [[n per group] per month from Jan 2016],
  "open", "total", "noLoc" }
```

- **Why 2016.** About 76,000 cases and 59,000 hearings are dated 2009, when older records were moved into the City's system, and yearly volumes settle later. Grass-cutting cases start in earnest in 2021.
- **Stages** are the City's `stage` values for open cases (Inspection, Title Research, Hearing, Judgment, In Compliance, Processing). An open case in a new stage fails the build (add it to `CE_STAGES`).
- **Hearing results** (`ce_hearing_group`): judgments starting "Guilty" or "Found Guilty" → Guilty; "Dismissed…" → Dismissed; "Reset…"/"Rescheduled" → Reset; "Result Pending" → Pending; anything else → Other.
- **Inspection types** (`ce_insp_group`): "Inspection" → Inspection; reinspections, compliance and follow-up inspections → Reinspection; any "Posting of …" → Posting a notice; the rest → Other.
- **Abatements**: no property has entered abatement since 2019 in this dataset, so the page shows only properties still in abatement and how closed cases ended.
- The map can show counts per 1,000 housing units (2020 Census); neighborhoods under 500 housing units get no rate.

Checked against the API on 2026-11-19: open cases by stage, cases filed in 2025 and 2026, hearings in 2025, grass cases per year, weeds violations in the past 12 months, and the past-12-month totals of located new cases and grass cases all match `count(*)` queries. (These datasets have no usable point column for `within_polygon`, so neighborhood assignment uses the same point-in-polygon code that matched exactly on the 311 and short-term rental pages.)

## `data/permits.json`: building permits (`rcm3-fn58`)

The City reloads this dataset in full nightly (about 350,000 rows). The builder asks the API for permits issued per year and `code` since 2012 (one request) and the newest `issuedate`, then downloads only permits issued in the past 12 months (about 17,500 rows): `code, type, filingdate, issuedate, landuse, location_1, address`. "Today" is the newest `issuedate`.

```
{ "ds", "last", "winStart",
  "cats": [9 permit types], "lu": [5 land uses], "years": [2012, ...], "yr": [[n per cat] per year issued],
  "nbc": [[cat, landUse, n, ...] per nb],                     # issued in the past 12 months
  "days": [[[n, medianDays, p90Days] per land use, then all land uses] per cat],   # filingdate -> issuedate, past 12 months
  "pts": [[x, y, cat, nb, landUse, daysSinceWinStart], ...],  # new construction, demolition, solar/EV only
  "total", "noLoc" }
```

- **Permit types** (`PERMIT_CODES`, by `code`): New construction `NEWC`; Renovation and repair `RNVN RNVS RENO REPR DEMI ROOF ROTF` (interior demolition counts as renovation); Demolition `DEMO` (including City demolitions); Solar and EV chargers `SOLR SAPP EVCH EVIN`; Pools and accessory buildings `ACCS POOL`; Electrical `SERV ERPR EVAC ECOA EGEN ETMP EFLO EANN MOVS`; Mechanical and plumbing `FGAS HVAC MECH HOOD MOVG PLMB HOIS MMAN`; Signs `SATT ESGN SBNR SBIL SMRL`; every other code (construction loops, brake tags, event permits, small cells and so on) is Other.
- **Land use** (`PERMIT_LU_MAP`, by `landuse`): Single Family; Two-Family and Half of a Party Wall Double; Three to Four Family, Multi-Family and Single Unit in Multi-Family Dwelling; Business Use and Mixed Use; anything else is Other or not stated.
- **Days to permit** = `issuedate − filingdate`, with the usual median / 90th percentile rule (null under 15).
- Construction values (`constrval`) are left out: they include obvious entry errors (one category sums to tens of billions of dollars in a year).
- The map can show permits per 1,000 housing units (2020 Census); neighborhoods under 500 housing units get no rate.

Checked against the API on 2026-11-19: permits issued in 2025, solar and EV permits in 2026 and new construction in the past 12 months match `count(*)` queries; Mid-City and Gentilly Terrace match `within_polygon` counts on `location_1`.

## `data/biz.json`: new businesses

Two datasets, each downloaded whole:

- **Occupational Business License Data for the Office of Business and External Services** (`abc4-h3u3`, about 21,000 rows from 2018): one row per license application. `application_filed, currentstatus, category, businesstype, ishome, longitude, latitude, address`. This is the "new businesses" source: applications by year filed, NAICS sector (`category`) and neighborhood.
- **Occupational Business Licenses** (`hjcd-grvu`, about 38,000 rows): businesses holding a license now. `businesstype, businessstartdate, longitude, latitude, address, businessname, ownername` (`ownername` only to leave out names that are just the owner's own name; it, `phonenumber` and the mailing address are never written). It has no sector column, so each business type gets the sector the applications most often pair with it (types are matched ignoring case and spacing before parentheses). Special event, Mardi Gras, flea market and street-artist licenses are "Event and street vendors"; unmatched types are "Other or not stated". It lists only businesses licensed now, so it isn't used to count openings over time (businesses that closed are missing).

"Today" is the newest `application_filed`.

```
{ "ds": [2 ids], "last", "winStart",
  "S": [10 sectors by count in the past 12 months, "Other sectors", "Not stated"],
  "out": ["Approved or issued", "Listed as filed or in review", "Withdrawn or incomplete", "Denied", "Duplicate or wrong type", "Not stated"],
  "years": [2018, ...], "yr": [[n per S] per year filed], "yo": [[[n per outcome] per S] per year filed],
  "home": [[home-based, not] per year filed],
  "nby": [[yearIdx, S, n, ...] per nb], "new12": [[S, n, ...] per nb],          # applications
  "S2": [S without "Not stated", then "Event and street vendors", "Other or not stated"],
  "now": [[S2, n, ...] per nb], "nowTotal", "nowNoLoc", "total", "noLoc" }
```

- **Outcomes** (`biz_outcome`, on `currentstatus`): Issued, Approved, Expired (approved and since expired) and temporary issuances are Approved or issued; Application Filed and any "...Review" status are Listed as filed or in review (many older applications still carry these); denials, "does not meet requirements", misrepresentation and revoked are Denied; duplicates, incorrect application type, voided and changed type or company are Duplicate or wrong type; withdrawn, failure to respond or pay, deficient, application expired and reminders are Withdrawn or incomplete.
- Locations of 0 or the geocoder's out-of-state placeholder are left off the map (`noLoc`, `nowNoLoc`; many current licenses are vendors and taxis based outside the city).

Checked against the API on 2026-11-19: applications filed in 2025 and retail applications in the past 12 months match `count(*)` queries; Central City and the French Quarter match `within_polygon` counts for both datasets.

## Page copy that mentions specific numbers

Pages no longer carry explanatory sentences: only titles, axis labels and legends. The year, dataset id and pull date are filled in by `build.py`, and axis limits and chart labels are computed from the data, so nothing goes stale as the data refreshes.
