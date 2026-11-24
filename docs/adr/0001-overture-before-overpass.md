# Overture Maps first, Overpass second

Date: 2026-11-24

## Context

The first version asked OpenStreetMap through the public Overpass API, the
usual way to get "every bakery within 3 km". On the day it was built, every
public instance tried was either at capacity (`502, request queue is full`) or
timing out after 40–60 s. One query in four came back. A tool whose whole
promise is "anywhere in the world" can't rest on that.

Overture Maps publishes about 60 million places every month as GeoParquet on
public S3: names, categories, websites, social links, phones and addresses.
Measured from a laptop in France, DuckDB answered "bakeries within 2 km of
Lyon" in 7.7 s, reading only the row groups whose bounding box overlaps the
query.

## Decision

The API queries Overture first, through DuckDB's httpfs reader, and Overpass
in parallel. Results from both are merged by name and distance. In France the
company register runs alongside them.

Overture categories are matched on `taxonomy.hierarchy`, not just the primary
category, so `restaurant` also catches `sushi_restaurant` and
`french_restaurant` without listing them.

## Consequences

- No third-party server has to be up for a search to return something.
- Overture lags reality by up to a month. Overpass, when it answers, is live,
  which is why it stays in.
- DuckDB is a ~30 MB dependency, and the first query in a process pays a few
  seconds reading Parquet footers. Results are cached for a week per area.
- The browser-only build on GitHub Pages can't do this (see 0003). It still
  relies on Overpass and is honest about it when Overpass is down.
- Overture data is CDLA-Permissive-2.0, with OpenStreetMap-derived records
  under ODbL. Both are credited in the README and on the map.
