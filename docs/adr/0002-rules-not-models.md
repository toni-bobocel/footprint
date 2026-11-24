# Rules, not a language model, read the search and judge the sites

Date: 2026-11-22

## Context

Two places looked like they wanted a model: understanding "new cafés in
Lisbon with no Instagram", and deciding whether a website "looks outdated".

People will act on what this tool says. They'll email a business because it
was flagged as having no website. A flag has to be reproducible, explainable
and cheap enough to run on 300 businesses per search.

## Decision

The search sentence is parsed by `query.py`: filter phrases first, then the
place (cut off before anything else touches the text, so "New York" and
"Trinidad and Tobago" survive), then category words from the shared
catalogue, longest first. Anything left over becomes a name search.

Site checks are fixed rules on one GET of the home page: final scheme and
certificate, time to first byte, a viewport meta tag, known old generators,
jQuery 1.x, Flash, "under construction" copy, copyright years more than three
years old, social profile links (share buttons excluded), review links and
analytics tags.

The opportunity score is a weighted sum of the gaps, capped at 100. The
weights live in one dictionary in `scan.py`.

## Consequences

- The same search gives the same answer, and every flag can be traced to a
  line of code.
- Phrases outside the grammar fall through to a name search instead of being
  understood. That's a visible failure, and the fix is a line in a list.
- The browser engine has a TypeScript port of the parser. `query.test.ts`
  and `test_query.py` run the same cases to keep them in step.
