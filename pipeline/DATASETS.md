# Candidate datasets for new pages

Triage of the data.nola.gov catalog on 2026-11-18: 210 datasets in total, 90 with data updated since 2025-11-18. The site's rule is to chart only datasets updated in the past year. Older data is used only as history or as map layers for those.

"Updated" here is the catalog's `data_updated_at`. A few datasets (for example the 2010–2024 Electronic Police Reports) show a 2026 date because the City reloaded them, not because new records were added. Check the newest record date before building a page.

To refresh this list:

```
https://data.nola.gov/api/catalog/v1?domains=data.nola.gov&only=dataset&limit=1000
```

## Recommended next pages (updated daily, strong public interest)

| Order | Page idea | Dataset(s) | Why |
|---|---|---|---|
| 1 | 311 service requests | 311 OPCD Calls (2012–present) `2jgv-pqrq` | Most-viewed dataset on the portal. Request types by neighborhood, how long the City takes to close them, open backlog. Long history in one dataset. |
| 2 | Short-term rentals | Active STR Licenses `ufdg-ajws`, STR Permit Applications `en36-xvxg`, Non-Commercial STR Licenses `2ei9-wqw2` | Pairs with the STR topic already on the planning page. Licenses by neighborhood and type, applications approved vs. denied over time. |
| 3 | NOPD use of force, stops and complaints | Use of Force Incidents `9mnw-mbde`, Stop and Search (Field Interviews) `kitu-f4uy`, Misconduct Complaints `gz2m-ef5u` | Use of Force is by far the most-viewed public safety dataset. Natural companion to the calls and drone pages. Needs careful caveats on demographics. |
| 4 | Building permits | Permits `rcm3-fn58` (or Permits - BLDS `72f9-bi28`) | Construction and renovation activity by neighborhood and type, permit processing times. |
| 5 | Code enforcement and blight | Code Enforcement All Cases `u6yx-v2tw`, All Hearings `44ct-56tr`, Grass Cutting `xhih-vxs6`, Abatements `xv8z-gn8b` | Where blight cases are, how long they take, outcomes of hearings. Several linked tables; join on case number. |
| 6 | Road and drainage work | RoadWork DPW Projects `u5mk-y9z4`, RoadWork SWB Projects `bsnu-de3a`, Catch Basin Cleanings `2zer-6wpb` | Where infrastructure money is going and catch basin maintenance, which matters for street flooding. |

## Also worth a look

- **Public Records Requests** `jsrk-e98x`: volume by department and response times.
- **Occupational Business Licenses** `hjcd-grvu` / Active licenses `iqay-p646`: new businesses by type and neighborhood.
- **NORA Sold Properties** `hpm5-48nj` and **Uncommitted Inventory** `5ktx-e9wc`: where the redevelopment authority's lots are and what's been sold.
- **Municipal Building Energy Use** `dm3n-f3pu`: updated yearly, a smaller one-off page.
- **NOPD Body Worn Camera Metadata** `qarb-kkbj`: updated periodically (last Aug 2026).
- **Mardi Gras Routes** `tkeu-9s5e`, Port-O-Let Locations `ekd9-snag`, Recycling Stations `955d-h748`: a seasonal page for January–February.
- **Electronic Police Reports**: the yearly files stop at 2025 (`agqi-9adb`, last updated Jul 2026). There's no 2026 file, so it doesn't meet the rule yet.
- **City jobs** (`wx2k-rsac`, `m99x-bsvt`, `ewwx-j8eu`): last updated Dec 2025, so they fall out of the one-year window soon.

## Map layers (not pages on their own)

Zoning Districts `bizp-xi7c`, Overlay and Interim Zoning `kb74-hpue`, City Council Districts `d49t-wy6p`, Planning Districts `put8-sks2`, Local Historic Districts `hea7-kccz`, Parcels `v9q5-fz7t`, Building Footprints `prh5-qsuf`, Site Address Points `hfvu-md72`, Streetlights `symk-y92t`, Schools `5qye-4vt5`, Open Greenspace `n4z3-4iyi`.

## Adding a page

1. Add a `build_<name>()` function to `pipeline/fetch.py` that returns compact JSON (use the shared `X`/`Y` projection and the neighborhood lookup `nbp.lookup`), plus checks in `validate()`.
2. Document its rules in `pipeline/REFERENCE.md`.
3. Add `src/<name>.html` and `src/<name>.js`, and register the page in `PAGES` in `build.py`.
4. Put every number quoted in the copy in an element with an `id` and set it from the page's `copy()` block, so it stays true as the data refreshes.
