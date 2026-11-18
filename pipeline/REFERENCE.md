# Data reference: how each `data/*.json` file was produced

The first snapshot in `data/` was pulled on **2026-11-18** with JavaScript in a browser. `pipeline/fetch.py` now reproduces it: run against that day's data it matches `geo`, `hist`, `drone` and `cfs` exactly and `cpc` apart from hearings scheduled since. GitHub Actions runs it every morning (`.github/workflows/daily.yml`). It also adds a few fields the pages use: `drone.year`, `cfs.year`, `cfs.ds`, `cpc.windowStart`, `cpc.total`, `cpc.firstFiled`, `cpc.lastFiled`, and `data/meta.json` (`pulled` date).

The front-end expects exactly the shapes documented below. If you change a shape, change the matching `src/*.js`.

API basics: `https://data.nola.gov/resource/<id>.json?$select=...&$where=...&$group=...&$limit=...` (SoQL). CSV is also available at `/resource/<id>.csv`. Metadata is at `/api/views/<id>.json`. A free Socrata app token (header `X-App-Token`) avoids throttling. Store it as a GitHub Actions secret.

---

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
             "pd": [ {"n": DISTRICT, "r": [...]}, ...8 ] }
```

**Neighborhood index.** Every `nb` index in the other files is a position in this array. It's assigned by point-in-polygon against the **unsimplified** API geometry in lon/lat, with a bbox prefilter. Use -1 when the point is outside every polygon. **geo.json and the other files must be regenerated together** so the indices stay aligned.

---

## `data/drone.json`: NOPD Drone Flights (`ay9z-ynxz`)

Fetch every row (742 as of the pull): `$select=serial,longitude,latitude,takeoff_datetime,total_flight_time,deployment_purpose,activity_summary&$order=takeoff_datetime&$limit=5000`

```
{ "drones": ["22ba", ...],            # sorted unique serials with the "SkydioX10-" prefix stripped
  "missingPurpose": int, "inferred": int, "unknown": int,
  "recs": [[doy, hourUTC, durSec, cat, droneIdx, nbIdx, x, y, eventCode, inferredFlag], ...] }
```

- `doy` is days since 2026-01-01 using the timestamp **as given**. `hourUTC` is hour plus minute/60, rounded to 0.1. The timestamps look like UTC, and the front end converts them to Central time (CDT from 2026-03-08 08:00 UTC to 2026-11-01 07:00 UTC). **When the year rolls over, update the hard-coded 2026 dates and DST dates in `src/drone.js` and `src/lib.js` (`doyDate`).**
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

Note: `timecreate` and the other times are **text** columns in 2026 and 2025, but calendar_date in earlier years. Fetch all rows as CSV in pages of 50,000 (`$order=:id&$offset=`): `timecreate,timearrive,typetext,priority,selfinitiated,dispositiontext,location`. The `location` field is `POINT (lon lat)`. Times are local.

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

Past years never change. The daily job only recomputes the current year (from the rows it already fetched for `cfs.json`) and refetches last year during January and February. `src/cfs.js` leaves the current month off the trend chart until the data reaches the month's last day.

**New year:** the City publishes a new dataset id each January ("Calls for Service 2027"). `fetch.py` looks it up in `/api/catalog/v1?domains=data.nola.gov&q=calls%20for%20service%20YYYY` by exact name. Until it exists (or while it's empty) the page keeps showing last year. If it still isn't found by March the job fails: add the id to `CFS_IDS` in `fetch.py`.

## `data/cpc.json`: CPC Projects (`xxb5-5azv`)

Fetch every row (15,671 as of the pull): `case_type,case_num,address,filing_date,current_status,open_closed,previous_meeting_status,next_meeting,next_meeting_date,description,longitude,latitude`

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
- `up` has duplicate rows. The front end dedupes them on date + case number.

## Page copy that mentions specific numbers

Done. Headlines, subtitles and notes that quote numbers or dates are now filled in by each page's JS from the data (look for the `copy()` block at the end of each `src/*.js`), and the year, dataset id and pull date are filled in by `build.py`. Axis limits are computed from the data too. When editing copy in `src/*.html`, give any sentence with a number an `id` and set it from JS instead of typing the number.
