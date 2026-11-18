# Handoff: set up the GitHub repo and daily pipeline

Paste this into a new Claude Code session opened in this folder, or tell it "read HANDOFF.md and start."

## Context

Matt (Urban Conservancy, New Orleans) is building a free public website of rich visualizations of data.nola.gov datasets. The City's built-in charts are weak, and the goal is bespoke, explanatory pages, refreshed once a day. Three pages are done and live as Claude artifacts:

- Calls for Service: https://claude.ai/artifact/EyGqRPHt7uWim4ua59LAAK
- NOPD Drone Flights: https://claude.ai/artifact/CDqUmhkoGgGanKE3hjxxnx
- CPC (planning) cases: https://claude.ai/artifact/FwedjEpeBMmjhh4AeubRDu
- Street trees (earlier, separate build): https://claude.ai/artifact/7EZEot1PFcKtp6mDzDMrFZ

This folder contains the source, data snapshots and built `site/`. See README.md for the layout and `pipeline/REFERENCE.md` for exactly how each data file was produced.

**Decisions already made**

- **Hosting**: GitHub Pages on a **public** repo (free with GitHub Free). The daily refresh runs on GitHub Actions, which is free for public repos.
- **Domain**: start on `<user>.github.io`. A custom domain is optional and costs about $10–15 a year.
- **Scope**: chart only datasets updated in the past year. Keep older data that feeds those charts (yearly history files, boundary layers). Older years are stored as compact aggregates.
- **Design**: one bespoke page per dataset. The daily job refreshes the data only and does not redesign pages.
- **Style**: system sans, light/dark aware, and the categorical palette in `src/lib.css`. Hand-built SVG charts with d3, hover tooltips on everything, and plain-language notes about data caveats.
- **Ownership**: Matt is a Google Workspace admin with limited networking and Git experience. Explain GitHub steps plainly and do the work rather than handing it back.

## Tasks, in order

1. **Repo.** Help Matt create a GitHub account if needed, then a public repo, for example `nola-vizzes`. Initialize it from this folder and push.
2. **Pages.** Turn on GitHub Pages, deploying with GitHub Actions and publishing `site/`. Confirm `https://<user>.github.io/nola-vizzes/` loads all four links.
3. **Pipeline.** Write `pipeline/fetch.py` (or one script per dataset) that reproduces each `data/*.json` exactly as specified in `pipeline/REFERENCE.md`, then runs `build.py`. Validate it against the committed snapshots: shapes and indices must match, and counts should be close, allowing for data added since 2026-11-18.
4. **Schedule.** Add `.github/workflows/daily.yml`. Run it on a daily cron (early morning Central, after the City's ~3 a.m. UTC refreshes) plus `workflow_dispatch`. It runs the fetch, rebuilds, commits `data/` and `site/` only when they changed, and deploys Pages. Use a Socrata app token stored as a repo secret (`SOCRATA_APP_TOKEN`). Make the job fail loudly, not publish stale or empty data: if a fetch returns 0 rows or a schema changes, fail and keep the last good build.
5. **Make copy durable.** Fix the hard-coded snapshot values listed at the end of `pipeline/REFERENCE.md` (the DFR date, the `startDay` window, the incomplete-month cutoff, numbers quoted in headlines) so the pages stay true as data refreshes. Also handle the calendar year changing: the new Calls for Service dataset id each January, and 2026 constants in drone.js and lib.js.
6. **Trees page.** Port the street-trees artifact into `site/trees.html` and update `TREES_URL` in `build.py`. You can read the artifact's HTML with the claude-artifacts `read_artifact` tool if it's available. Otherwise ask Matt to download it.
7. **Afterwards.** Set up an About page, a "not affiliated with the City" disclaimer (already on the index), and a plan for adding more datasets (triage the catalog for data updated in the past year).

## Gotchas found so far

- Claude's cloud workspace couldn't reach data.nola.gov directly (egress allowlist), so the snapshots were pulled through the desktop app's browser. GitHub's runners can reach it, and Matt's own machine can too.
- The drone data's timestamps appear to be UTC. The calls data's times are local.
- Calls for Service 2025 and 2026 store times as text. Earlier years use calendar dates.
- In a public repo, scheduled workflows are disabled after 60 days without repo activity. Daily data commits should keep it active, but check after the first couple of months.
