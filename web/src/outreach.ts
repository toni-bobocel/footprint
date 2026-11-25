import type { Business, Footprint, Gap } from './engine/types'
import type { Strings } from './i18n'
import { categoryPlural } from './labels'

// A first message should name one concrete thing, not list everything that
// is wrong. The most valuable gap leads; at most one more follows.
const ORDER: Gap[] = [
  'no_website',
  'unreachable',
  'not_mobile',
  'not_secure',
  'slow',
  'outdated',
  'no_contact',
  'no_reviews',
  'weak_seo',
  'no_instagram',
  'no_facebook',
  'no_tracking',
]

export function message(
  b: Business,
  fp: Footprint | undefined,
  area: string,
  t: Strings,
  lang: string,
): string {
  const plural = categoryPlural(b.category, lang)
  // German nouns keep their capital; elsewhere a category reads lower case mid-sentence.
  const kind = plural ? (lang === 'de' ? plural : plural.toLowerCase()) : t.msg.kindFallback
  const seconds = ((fp?.site?.response_ms ?? 0) / 1000).toFixed(1)
  const lines = ORDER.filter((g) => fp?.gaps.includes(g))
    .map((g) => t.msg.lines[g]?.(seconds))
    .filter((l): l is string => !!l)
    .slice(0, 2)
  const observation = lines.length
    ? `${capital(lines[0])}${lines[1] ? `${t.msg.and}${lines[1]}` : ''}.`
    : t.msg.fallback
  return [
    t.msg.hi(b.name),
    '',
    `${t.msg.intro(kind, area)} ${observation}`,
    '',
    t.msg.offer,
    '',
    t.msg.bye,
  ].join('\n')
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
