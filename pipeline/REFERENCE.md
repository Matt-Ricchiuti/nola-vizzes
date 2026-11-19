# Data reference: how each `data/*.json` file was produced

The first snapshot in `data/` was pulled on **2026-11-18** with JavaScript in a browser. `pipeline/fetch.py` now reproduces it: run against that day's data it matches `geo`, `hist`, `drone` and `cfs` exactly and `cpc` apart from hearings scheduled since. GitHub Actions runs it every morning (`.github/workflows/daily.yml`). It also adds a few fields the pages use: `drone.year`, `cfs.year`, `cfs.ds`, `cpc.windowStart`, `cpc.total`, `cpc.firstFiled`, `cpc.lastFiled`, and `data/sources.json` (see below; it replaced `data/meta.json`).

The front-end expects exactly the shapes documented below. If you change a shape, change the matching `src/*.js`.

API basics: `https://data.nola.gov/resource/<id>.json?$select=...&$where=...&$group=...&$limit=...` (SoQL). CSV is also available at `/resource/<id>.csv`. Metadata is at `/api/views/<id>.json`. A free Socrata app token (header `X-App-Token`) avoids throttling. Store it as a GitHub Actions secret.

---

## The daily refresh: what gets downloaded and committed

The workflow runs at 10:30 UTC. The City loads CPC Projects at about 06:00 UTC, Calls for Service at about 09:00 UTC (3 a.m. Central), and drone flights in occasional batches. `fetch.py` reads each dataset's metadata (`/api/views/<id>.json`, which it needs anyway to check the schema) and rebuilds a data file only when one of its inputs changed:

| File | Rebuilt when | Notes |
|---|---|---|
| `geo.json` | every run, from cached downloads | Boundaries (`7fw3-kdpf`, `evki-aju8`) and population (`2w4d-xaw2`) are kept in `.cache/raw/` under their `rowsUpdatedAt`, so they are downloaded again only when the City changes them. Features are kept in the order of the last good `geo.json`, because every `nb`/`pd` index (including the hand-built `trees.json`) points into it. |
| `streets.json` | the centerline's segment count or newest `lastupdate` changed | The centerline is re-synced from the City's GIS often without edits, so its `rowsUpdatedAt` isn't used. |
| `drone.json` | `ay9z-ynxz`'s `rowsUpdatedAt`, `geo.json` or the calendar year changed | |
| `cfs.json` | the current year's dataset id or `rowsUpdatedAt`, or `geo.json`, changed | |
| `hist.json` | with `cfs.json` (current year); a past year when its dataset's `rowsUpdatedAt` moved | Past years are checked daily for last year in January–February, and all years on the 1st of the month. The City loads each year's final rows on January 1. |
| `cpc.json` | `xxb5-5azv`'s `rowsUpdatedAt` or `geo.json` changed | "Today" for upcoming hearings and the 365-day window is the day the City loaded the data. |
| `311.json` | `2jgv-pqrq`'s `rowsUpdatedAt` or `geo.json` changed | Incremental download (see below). "Today" is the newest request in the data. |
| `str.json` | any of `ufdg-ajws`, `en36-xvxg`, `2ei9-wqw2` or `geo.json` changed | Three small whole downloads (about 8 requests, 9 MB). |
| `permits.json` | `rcm3-fn58`'s `rowsUpdatedAt` or `geo.json` changed | Also reloaded in full nightly. API counts by year, plus the past 12 months' rows (about 6 requests, 4 MB). |
| `blight.json` | any of the six code enforcement datasets or `geo.json` changed | The City reloads these every night (every row gets a new `:updated_at`), so incremental downloads don't help; most numbers are counted by the API instead (about 16 requests, 11 MB). |

On the 1st of every month (and with `--full`, or the workflow's "full" checkbox) everything is downloaded and rebuilt regardless. Queries are ordered (`:id` as the tie-breaker), so the same City data always produces byte-identical files. Rebuilt files are written only when their content changed, and pages embed only the date their own data last changed, so a day without new City data changes nothing and the workflow commits and deploys nothing.

`data/sources.json` is the pipeline's memory, rewritten only along with a data change:

```
{ "files": { "cfs.json": {"key": "<inputs it was built from>", "changed": "2026-11-18"}, ... },
  "histVersions": { "2026": "<rowsUpdatedAt when hist.json last counted that year>", ... },
  "cfsIds": { "2027": "<id found in the catalog>" } }        # years not in CFS_IDS, so the catalog is searched once
```

`build.py` shows each data page's "Updated" date as the latest `changed` of that page's files (and `geo.json`), and passes it to the page as `DATA.meta.pulled`. The About page shows the latest date of any page.

**When something fails.** A file that fails to fetch or validate keeps its last good version, and the other files still refresh and publish. The run then ends failed (the `report` job), so GitHub emails the owner. If the boundaries fail, nothing is published. Datasets that stop updating (no calls for 7 days, no flights for 45, no filings for 30) show as warnings on the run.

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

The 311 page (and any other page built from a dataset of hundreds of thousands of rows) keeps a copy of the rows it needs in `.cache/raw/<id>.csv.gz`, with each row's Socrata `:id` and `:updated_at`. Each run asks only for rows with `:updated_at` at or after the newest one in the copy (one request of a few hundred to a few thousand rows) and merges them in by `:id`. If the merged copy's row count differs from the City's `count(*)` for the same filter (rows deleted, or moved out of the filter), the copy is missing or unreadable, its columns changed, or it's a full run (the 1st of the month or `--full`), every row is downloaded again in pages of 50,000. Rows are always sorted by `:id` before aggregating, so an incremental build and a full download give identical files.

## `data/311.json`: 311 OPCD Calls (`2jgv-pqrq`)

Rows with `date_created >= 2019-02-01` (about 730,000), columns `request_type, request_reason, date_created, case_close_date, request_status, longitude, latitude`, downloaded incrementally (above). A full download is about 19 requests and 136 MB; a normal day is one small request. The City's file dates about 313,000 older (2012–2018) requests to January 1–2, 2019, when they were moved into the current system, so the page starts with February 2019.

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

## `data/str.json`: short-term rentals

Three datasets, each downloaded whole (ordered by `:id`):

- **Active Short-Term Rental Licenses** (`ufdg-ajws`, about 4,300 rows): `license_type, residential_subtype, bedroom_limit, issue_date, longitude, latitude`. Licenses of type "Short Term Rental Operator" are permits for the person running a rental, not a place, so they're counted separately (`operators`, by subtype) and left off the map. The other three types (`cat`) are mapped: 0 "Short Term Rental Commercial Owner", 1 "Non-Commercial Short Term Rental", 2 "Lodging Exempt from STR Regulation". A new type fails the build (add it to `STR_CAT`).
- **Non-Commercial Short-Term Rental Licenses** (`2ei9-wqw2`, about 1,200 rows): `type_of_building, partial_whole, operator_type, bedrooms_rented, current_status, location`.
- **Short-Term Rental Permit Applications** (`en36-xvxg`, about 39,000 rows since 2017): `application_date, license_type, residential_subtype, current_status, x, y`. This dataset has no lon/lat columns, only Louisiana South state plane x/y in US feet (EPSG:3452), converted with `sp_lonlat` (an inverse Lambert conformal conic; it matches the City's own lon/lat in the other STR datasets to 1e-7°). x/y of -1 means no location.

```
{ "ds": [ids], "last": newest application_date,
  "cat": [3 license types], "pts": [[x, y, cat, nb, bedroomLimit], ...]   # sorted, so the file only changes with the data
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
| Code Enforcement All Cases `u6yx-v2tw` | rows with `o_c = 'Open' OR casefiled >= 2016-01-01` (about 47,000; 1 request): `casefiled, o_c, stage, xpos, ypos, initinspresult` |
| Grass Cutting `xhih-vxs6` | all rows (about 23,500): `casefiled, o_c, longitude, latitude` |
| Code Enforcement - Abatements `xv8z-gn8b` | all rows (about 7,200): `o_c, stage, xpos, ypos` |
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

The City reloads this dataset in full nightly (about 350,000 rows). The builder asks the API for permits issued per year and `code` since 2012 (one request) and the newest `issuedate`, then downloads only permits issued in the past 12 months (about 17,500 rows): `code, type, filingdate, issuedate, landuse, location_1`. "Today" is the newest `issuedate`.

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

## Page copy that mentions specific numbers

Pages no longer carry explanatory sentences: only titles, axis labels and legends. The year, dataset id and pull date are filled in by `build.py`, and axis limits and chart labels are computed from the data, so nothing goes stale as the data refreshes.
