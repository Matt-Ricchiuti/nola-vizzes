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

## Page copy that mentions specific numbers

Pages no longer carry explanatory sentences: only titles, axis labels and legends. The year, dataset id and pull date are filled in by `build.py`, and axis limits and chart labels are computed from the data, so nothing goes stale as the data refreshes.
