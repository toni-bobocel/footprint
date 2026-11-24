import catalog from '../../../shared/categories.json'
import type { Gap } from './types'

// Port of api/src/footprint/query.py for the browser-only engine. The two
// are kept honest by the same cases in query.test.ts and test_query.py.

export interface Category {
  id: string
  label: string
  words: string[]
  osm: [string, string][]
  overture: string[]
  naf: string[]
}

export const CATEGORIES = catalog.categories as unknown as Category[]

export interface ParsedQuery {
  text: string
  categories: string[]
  terms: string | null
  place: string | null
  lat: number | null
  lon: number | null
  radius_km: number | null
  gaps: Gap[]
  recent: boolean
  size: 'small' | 'large' | null
}

const FILTERS: [RegExp, Gap][] = [
  [/(?:without|no|lacking)\s+(?:a\s+)?(?:website|web\s*site|site)/g, 'no_website'],
  [/(?:without|no|not\s+on)\s+instagram/g, 'no_instagram'],
  [/(?:without|no|not\s+on)\s+facebook/g, 'no_facebook'],
  [/(?:without|no|not\s+on)\s+linkedin/g, 'no_linkedin'],
  [/(?:without|no|not\s+on)\s+tiktok/g, 'no_tiktok'],
  [/(?:without|no)\s+(?:google\s+)?reviews?/g, 'no_reviews'],
  [/(?:not\s+secure|insecure|without\s+https|no\s+https)/g, 'not_secure'],
  [/(?:not\s+mobile(?:[\s-]friendly)?|no\s+mobile\s+site)/g, 'not_mobile'],
  [/slow\s+(?:web)?sites?/g, 'slow'],
  [/(?:outdated|old)\s+(?:web)?sites?/g, 'outdated'],
  [/(?:no|without)\s+(?:ads|advertising|tracking|pixel)/g, 'no_tracking'],
]
const RECENT =
  /\b(?:new|newly\s+(?:created|opened)|recently\s+(?:created|opened)|just\s+opened|(?:opened|created)\s+this\s+year)\b/g
const SMALL = /\b(?:small|tiny|solo|independent|one[-\s]person)\b/g
const LARGE = /\b(?:large|big|major|corporate)\b/g
const PLACE = /\b(?:in|near|around|close\s+to|within\s+\d+\s*km\s+of)\s+(.+)$/
const COORDS = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/
const RADIUS = /\b(?:within\s+)?(\d{1,3})\s*km\b/
const TAIL = /(?:\s*\b(?:with|and|that|which|have|has|who)\b)+[\s,.]*$/
const FILLER = /\b(?:with|and|that|which|have|has|the|a|an|all|every|any|companies|businesses)\b/g

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const trim = (s: string) => s.replace(/^[\s,.]+|[\s,.]+$/g, '')

const WORDS = CATEGORIES.flatMap((c) => c.words.map((w) => [w.toLowerCase(), c.id] as const)).sort(
  (a, b) => b[0].length - a[0].length,
)

export function parse(text: string): ParsedQuery {
  let q = text.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  const out: ParsedQuery = {
    text,
    categories: [],
    terms: null,
    place: null,
    lat: null,
    lon: null,
    radius_km: null,
    gaps: [],
    recent: false,
    size: null,
  }

  for (const [pattern, gap] of FILTERS) {
    if (pattern.test(q)) {
      out.gaps.push(gap)
      q = q.replace(pattern, ' ')
    }
    pattern.lastIndex = 0
  }

  let m = RADIUS.exec(q)
  if (m) {
    out.radius_km = Number(m[1])
    q = q.slice(0, m.index) + q.slice(m.index + m[0].length)
  }
  m = COORDS.exec(q)
  if (m) {
    out.lat = Number(m[1])
    out.lon = Number(m[2])
    q = q.slice(0, m.index) + q.slice(m.index + m[0].length)
  }

  m = PLACE.exec(q)
  if (m) {
    const place = trim(m[1].replace(TAIL, ''))
    if (place) out.place = place
    q = q.slice(0, m.index)
  }
  q = q.trim().replace(/\b(?:in|near|around|at|within|of)\s*$/, '')

  if (q.match(RECENT)) {
    out.recent = true
    q = q.replace(RECENT, ' ')
  }
  if (q.match(SMALL)) {
    out.size = 'small'
    q = q.replace(SMALL, ' ')
  } else if (q.match(LARGE)) {
    out.size = 'large'
    q = q.replace(LARGE, ' ')
  }
  q = q.replace(FILLER, ' ')

  for (const [word, id] of WORDS) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'gu')
    if (re.test(q)) {
      if (!out.categories.includes(id)) out.categories.push(id)
      q = q.replace(re, ' ')
    }
  }

  const leftover = trim(q.split(/\s+/).filter(Boolean).join(' '))
  if (leftover && out.categories.length === 0) out.terms = leftover
  return out
}
