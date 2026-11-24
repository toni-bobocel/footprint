# Two engines behind one interface

Date: 2026-11-24

## Context

The demo lives on GitHub Pages, which serves files and nothing else. The real
work (opening hundreds of websites, reading Parquet from S3) needs a server.
I wanted the public page to search for real, not to replay a recording.

## Decision

The web client talks to an `Engine` with two implementations that emit the
same events (`intent`, `place`, `businesses`, `footprint`, `notice`,
`problem`, `done`):

- `Remote` streams them from the FastAPI service over server-sent events,
  read with `fetch` so a new search can abort the old one.
- `Local` produces them in the browser from Nominatim, Overpass and the
  French register, which all send CORS headers. Browsers won't let a page
  read other sites, so its footprint only covers what the map records:
  website listed or not, social tags. Filters it can't answer are hidden,
  and the page says so in one sentence.

At startup the page probes `?api=`, then `VITE_API`, then localhost in dev,
and falls back to `Local`.

## Consequences

- The Pages build is useful on its own and costs nothing to host.
- Some logic exists twice (parser, merge, map-only footprint). It's covered by
  mirrored tests rather than shared code, since one side is Python.
- Pointing Pages at a deployed API is one repository variable,
  `FOOTPRINT_API`.
