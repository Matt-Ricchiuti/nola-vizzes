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
2. `fetch.py` downloads every dataset, recomputes `data/*.json`, and checks the results. If a dataset comes back empty, a column is missing, or a count drops by more than 10% from the last good version, it stops with an error and writes nothing.
3. Otherwise it runs `build.py`, and the workflow commits `data/` and `site/` and publishes the site.
4. A failed run leaves the site as it was. GitHub emails you about it, and the run shows a red X on the repo's **Actions** tab. Warnings (for example, the City hasn't added new calls in over a week) show in yellow on the run but don't stop it.

To run it by hand: GitHub repo → **Actions** → **Daily data refresh** → **Run workflow**.

## Working locally

```
pip install -r pipeline/requirements.txt
python pipeline/fetch.py              # fetch, check, write data/, build site/
python pipeline/fetch.py --no-build   # data only
python build.py                       # rebuild pages from data/ (after editing src/)
python -m http.server 8765 --directory site   # then open http://localhost:8765
```

Commit and push changes to `src/` together with the rebuilt `site/`.

## Pages

| Page | Dataset | Refreshed |
|---|---|---|
| `cfs.html` | Calls for Service, current year + 2014 onward yearly files | daily |
| `drone.html` | NOPD Drone Flights (`ay9z-ynxz`), current year | daily |
| `cpc.html` | CPC Projects (`xxb5-5azv`) | daily |
| `trees.html` | Street tree inventory (Oct 2026 export) | static |
| `about.html` | About the site, sources, disclaimer | with each build |

## Things to check now and then

- **New year:** each January the City publishes a new "Calls for Service YYYY" dataset. The pipeline finds it automatically. If it isn't found by March the job fails with a message telling you to add the id to `CFS_IDS` in `pipeline/fetch.py`.
- **Drone page story:** the 2026 headline is about October's shift to dispatch flights. From January 2027 the page switches to a neutral headline. Write a new one when there's a story.
- **60-day rule:** GitHub pauses scheduled workflows in public repos after 60 days with no commits. The daily data commits prevent that, but if the City's data stops changing entirely, re-enable the workflow on the Actions tab.
- **Socrata app token:** optional but recommended. See below.

## Socrata app token (optional)

Without a token the City's API may slow down or refuse requests during busy times. To add one:

1. Sign in at https://data.nola.gov (free account), open your profile → **Developer Settings** → **Create New App Token**. Copy the **App Token** (not the secret).
2. On GitHub: repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Name: `SOCRATA_APP_TOKEN`, value: the token.
