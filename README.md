# NOLA Vizzes

Hand-built visualizations of City of New Orleans open data (data.nola.gov), meant to be hosted for free on GitHub Pages and refreshed daily by GitHub Actions.

## What's here

```
src/        page templates (*.html), page scripts (*.js), shared lib.css + lib.js
data/       JSON snapshots the pages are built from (pulled 2026-11-18)
site/       built pages: index, cfs (calls for service), drone (NOPD drone flights), cpc (planning cases)
pipeline/   REFERENCE.md: exact API queries and aggregation rules behind every data file
build.py    src/ + data/ -> site/
HANDOFF.md  brief for the next working session (GitHub repo + daily pipeline)
```

## Build

```
python build.py            # writes site/*.html (d3 loaded from cdnjs)
python build.py preview    # inlines d3 for offline screenshots; needs `npm i d3@7`
```

Each page is a single self-contained HTML file. The data is inlined, and the only external dependency is d3 v7 from cdnjs.

## Pages

| Page | Dataset | Notes |
|---|---|---|
| `cfs.html` | Calls for Service 2026 (`es9j-6y5d`) + 2014–2025 yearly files | trend since 2014, daily, weekday × hour heatmap, call-type table, neighborhood map, response time by district |
| `drone.html` | NOPD Drone Flights (`ay9z-ynxz`) | weekly purpose timeline, launch-point map, fleet chart; times converted from UTC |
| `cpc.html` | CPC Projects (`xxb5-5azv`) | upcoming hearings map + list, last-12-months map, filings by year, topic trends |
| Street trees | separate Claude artifact for now | to be ported into `site/` |
