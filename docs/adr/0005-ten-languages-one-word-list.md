# Ten languages, one word list

Date: 2026-11-25

## Context

The first parser was a page of English regular expressions. People type the
way they speak: "fréjus dentiste", "panaderías en Madrid sin web",
"東京のパン屋 ウェブサイトなし". Two failures showed up on the first day:
searches without "in" lost their place ("bakery moldova" became a name
search for a company called Moldova), and anything not in English found
nothing.

A model would understand all of it, but it would cost money on every search
and give a different answer to the same sentence on a bad day.

## Decision

- All words live in data: `shared/categories.json` (what each category is
  called in en, fr, es, pt, de, it, zh, ja, ar, ru) and
  `shared/lexicon.json` (prepositions, filler, negations, channel names,
  "new", "small", "km"). Adding a language is a data change.
- Text is folded (lower case, Latin accents dropped) and split into tokens.
  Chinese and Japanese have no spaces, so known words are cut out first,
  longest first, and unknown runs (上海, 東京) are glued back together.
- Tokens are marked as gap, category or plain, longest phrase first. Single
  long words also match on their stem, which covers most plurals and case
  endings ("boulangeries", "Bäckereien", "пекарню").
- What's left next to a category is the place, whether or not there's a
  preposition. Modifiers before the category count only when nothing else
  is there, so "new bakeries" is recent and "New York bakeries" is a place.
- With no category at all, the engine asks Nominatim whether the words are a
  prominent place (importance ≥ 0.45): "Moldova" is, "Tesla" isn't. A
  country is then searched in its capital, not its geometric centre.
- Overture's ~600 place types are matched in English when no category fits
  ("cheese shop", "escape room").

The interface, the first message to a business, and the place names in
titles follow the same ten languages.

## Consequences

- Both parsers (Python and TypeScript) run `shared/query-cases.json`. A
  change that breaks one language breaks CI.
- Grammar the lists don't cover still fails, but the failure is visible and
  fixed by adding a word, not by retraining anything.
- Russian place names in the locative ("в Москве") need a small
  un-inflection step before geocoding. Other inflected languages will need
  the same when someone hits them.
