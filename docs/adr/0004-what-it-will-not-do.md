# What Footprint won't do

Date: 2026-11-23

## Context

A prospecting tool is a few shortcuts away from being a spam cannon or a
scraper that ignores everyone's terms. Most of the hard calls here were about
what to leave out.

## Decision

- **Opt-outs are final.** French companies with
  `opposition_diffusion_commerciale` set have asked not to be prospected.
  They're dropped in the source adapter, before anything else sees them, in
  both engines. Dissolved, bankrupt or struck-off companies are dropped from
  every register the same way.
- **No personal data beyond the business.** The register returns directors'
  names and birth dates. They're never read into the model. Many small
  businesses are one person, and their name isn't what's being prospected.
- **No Google scraping.** Ratings and review counts come only from the Places
  API, only when whoever runs the server sets `GOOGLE_PLACES_KEY`, and only
  three fields are requested.
- **One visit per site.** The scanner makes one GET of the home page with an
  identifying User-Agent, stops reading at 1.5 MB, and caches the result for
  three days. It doesn't crawl, submit forms or follow links. Email
  addresses are only the ones a business publishes as `mailto:` links on its
  own home page.
- **Polite to open data.** Nominatim gets at most one request a second.
  Overpass mirrors are walked in order rather than hit at once. Everything is
  cached.
- **No sending.** The tool drafts a first message. It never sends one.

## Consequences

Some searches return less than they could. That's the point. Anyone running
their own instance can change these lines, but they'll have to do it on
purpose.
