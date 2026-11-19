# NOLA Vizzes

Hand-built visualizations of City of New Orleans open data (data.nola.gov), hosted for free on GitHub Pages and refreshed every morning by GitHub Actions.

**Live site:** https://matt-ricchiuti.github.io/nola-vizzes/

## What's here

```
src/        page templates (*.html), page scripts (*.js), shared lib.css + lib.js
data/       JSON the pages are built from (rewritten by the daily job)
site/       built pages, published as-is by GitHub Pages (streets.js = street base map shared by all maps)
pipeline/   fetch.py (downloads + aggregates everything), REFERENCE.md (rules behind every data file)
build.py    src/ + data/ -> site/
.github/workflows/
  daily.yml   every morning: fetch.py -> build.py -> commit -> deploy
  pages.yml   redeploys whenever site/ changes on main (e.g. after you edit a page)
```

## How the daily refresh works

1. At 10:30 UTC (4:30 a.m. Central in winter, 5:30 a.m. in summer), `daily.yml` runs `python pipeline/fetch.py`.
2. `fetch.py` asks data.nola.gov once for every dataset's "last updated" time (one request for all of them) and downloads only the ones the City changed. Pages whose datasets didn't change are left alone: nothing is downloaded, parsed or rebuilt for them.
3. For the two big datasets the City updates in place (311, Calls for Service) it downloads only the rows changed since the last run and merges them into a saved copy. Most other datasets are reloaded by the City every night, so they're downloaded whole when they change. Every API answer is kept until the City changes that dataset, so nothing is downloaded twice. All of this lives in `.cache/raw`, which the workflow keeps between runs.
4. On the 1st of each month the pipeline also checks the few datasets that almost never change (neighborhood and police district boundaries, past years of calls) and compares each saved copy's rows with the City's. A mismatch means one full download of that dataset.
5. Each rebuilt data file is checked. If a dataset comes back empty, a column is missing, or a count drops by more than 10%, that page keeps its last good version and the others still publish.
6. Files are rewritten only when their content changed, so a day with no new City data commits and publishes nothing. Otherwise the workflow commits `data/` and `site/` and publishes the site.
7. If any dataset failed, the run ends with a red X on the repo's **Actions** tab and GitHub emails you. It also fails when a dataset the City normally reloads every night hasn't changed in 5 days (60 for drone flights and abatements), or when the saved copies had to be downloaded again twice within a few days (the cache isn't being kept). Warnings (for example, the City hasn't added new calls in over a week) show in yellow on the run but don't stop it.

A typical day costs 18 requests to the City's API (about 44 MB, 7 MB as transferred), down from 42; a day without new data costs one request instead of 21, and the 1st of the month adds 4 requests instead of downloading everything again (248 MB). Per-dataset numbers are in `pipeline/REFERENCE.md` ("What each dataset costs").

To run it by hand: GitHub repo → **Actions** → **Daily data refresh** → **Run workflow** (tick the box to download everything fresh).

## Working locally

```
pip install -r pipeline/requirements.txt
python pipeline/fetch.py              # fetch, check, write data/, build site/
python pipeline/fetch.py --no-build   # data only
python build.py                       # rebuild pages from data/ (after editing src/)
python -m http.server 8765 --directory site   # then open http://localhost:8765
```

Commit and push changes to `src/` together with the rebuilt `site/`.

## Page layout

Every page has a title, one source line linking to its City dataset, then a row of tabs (one per chart) with **Copy link** / **Download CSV** for the open chart at the end of the row. **Download CSV** links to the open chart's City dataset on data.nola.gov, where the City's own export is; the site doesn't build CSVs itself. The chart's title and the chart sit below. A page with one chart (street trees) has no tabs: the chart's title sits in that row instead, and the trees map fills the window below it. The open chart and its filters are kept in the URL.

Filters live **on the chart**, in a panel styled after the original street-trees map: legend-style rows (swatch, name, live count, proportion bar), segmented switches and a neighborhood picker. On maps the panel floats over the top-left corner, with zoom buttons and a scale bar on the map; on charts it's a sidebar inside the chart card; on phones it stacks above (maps fold it behind a "Filters" button).

How to build a view (`src/lib.js`): `NOLA.views([...])` lists the views; each view's `draw(pane, first)` calls `NOLA.stage(pane, { map })` once to get `{ panel, plot }`, fills the panel with `NOLA.fsec` / `NOLA.flist` / `NOLA.seg` / `NOLA.nbPick` (and `NOLA.kv` for a key that isn't a filter), in the order: map tabs (`NOLA.ftabs`), neighborhood, type filters, key. It draws into `plot`. A view whose subject follows its filters can give `label` as a function (with a short `tab`); the heading is set again on each redraw. Map options such as "Per 1k residents" are checkboxes on the map above the scale bar, from `NOLA.mapChecks(plot, [{ key, label, checked, disabled, onChange }])`. Redraws keep the panel's scroll, the page's scroll and keyboard focus. Shaded maps use `NOLA.classes` + `NOLA.stepLegend` (up to seven equal-count shades, whole-number edges for counts). Maps come from `NOLA.map(plot, { panel })`, which adds the City street map, street names (placed after each zoom, never overlapping), zoom controls and a scale bar. Give each view a `ds: [id, name]` for the City dataset its chart is about (a function returning one if the chart's filters switch datasets); it falls back to the page's `ds`. Supporting data (neighborhoods, population, street centerlines) is credited on the About page, not on the button. Keep text to titles, axis labels and legends; caveats go on the About page. Every neighborhood is drawn and counted; maps just open framed on the populated city (neighborhoods under 100 residents per square mile, `MIN_DENSITY`, start out of view). Map controls are deliberately neutral (no named regions).

## Pages

| Page | Dataset | Refreshed |
|---|---|---|
| `cfs.html` | Calls for Service, current year + 2014 onward yearly files | daily (not in the menus) |
| `drone.html` | NOPD Drone Flights (`ay9z-ynxz`), current year | daily (not in the menus) |
| `cpc.html` | CPC Projects (`xxb5-5azv`) | daily |
| `311.html` | 311 OPCD Calls (`2jgv-pqrq`), February 2019 on | daily (incremental download) |
| `blight.html` | Code Enforcement All Cases (`u6yx-v2tw`), Violations (`3ehi-je3s`), Inspections (`uh5a-f7uw`), Hearings (`44ct-56tr`), Grass Cutting (`xhih-vxs6`), Abatements (`xv8z-gn8b`) | daily |
| `permits.html` | Permits (`rcm3-fn58`) | daily |
| `biz.html` | Occupational Business License Data (`abc4-h3u3`, applications) and Occupational Business Licenses (`hjcd-grvu`, current) | daily |
| `str.html` | Active Short-Term Rental Licenses (`ufdg-ajws`), Non-Commercial STR Licenses (`2ei9-wqw2`), STR Permit Applications (`en36-xvxg`) | daily |
| `trees.html` | Tree Location (`3tyj-9x33`) + green space, Oct 2026 export in `data/trees.json`; 311 tree requests (`2jgv-pqrq`) in `data/treereq.json` | inventory static; requests daily with 311 |
| `about.html` | About the site, sources, disclaimer | with each build |

Pages listed in `UNLISTED` in `build.py` are still refreshed and built, so old links work, but are left out of the header and home-page menus. Remove a page from that set to list it again.

## Things to check now and then

- **New year:** each January the City publishes a new "Calls for Service YYYY" dataset. The pipeline finds it automatically. If it isn't found by March the job fails with a message telling you to add the id to `CFS_IDS` in `pipeline/fetch.py`.
- **Drone page story:** the 2026 headline is about October's shift to dispatch flights. From January 2027 the page switches to a neutral headline. Write a new one when there's a story.
- **60-day rule:** GitHub pauses scheduled workflows in public repos after 60 days with no commits. The daily data commits prevent that, but if the City's data stops changing entirely, re-enable the workflow on the Actions tab.
- **Socrata app token:** optional but recommended. See below.

## Socrata app token (optional)

Without a token the City's API may slow down or refuse requests during busy times. To add one:

1. Sign in at https://data.nola.gov (free account), open your profile → **Developer Settings** → **Create New App Token**. Copy the **App Token** (not the secret).
2. On GitHub: repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Name: `SOCRATA_APP_TOKEN`, value: the token.
