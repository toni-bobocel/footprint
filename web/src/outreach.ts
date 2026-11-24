import { CATEGORIES } from './engine/query'
import type { Business, Footprint, Gap } from './engine/types'

// A first message should name one concrete thing, not list everything that
// is wrong. The most valuable gap leads; at most one more follows.
const LINES: Partial<Record<Gap, (fp: Footprint) => string>> = {
  no_website: () =>
    "I couldn't find a website for you, so anyone searching online only sees your map pin",
  unreachable: () => "your website didn't load when I tried it today",
  not_mobile: () => "your site doesn't adapt to phones, which is where most people will open it",
  not_secure: () => "browsers mark your site as 'not secure', which puts some visitors off",
  slow: (fp) =>
    `your home page took ${((fp.site?.response_ms ?? 0) / 1000).toFixed(1)} seconds to load for me`,
  outdated: () => 'your site looks like it was built a while ago',
  no_reviews: () => "I couldn't find anywhere customers can leave you a review",
  no_instagram: () => "I couldn't find you on Instagram",
  no_facebook: () => "I couldn't find a Facebook page for you",
  no_tracking: () => "your site doesn't measure its visitors, so it's hard to know what works",
}
const ORDER: Gap[] = [
  'no_website',
  'unreachable',
  'not_mobile',
  'not_secure',
  'slow',
  'outdated',
  'no_reviews',
  'no_instagram',
  'no_facebook',
  'no_tracking',
]

export function message(b: Business, fp: Footprint | undefined, area: string): string {
  const kind =
    CATEGORIES.find((c) => c.id === b.category)?.label.toLowerCase() ?? 'businesses like yours'
  const found = ORDER.filter((g) => fp?.gaps.includes(g)).slice(0, 2)
  const lines = found.map((g) => LINES[g]?.(fp as Footprint)).filter(Boolean)
  const observation = lines.length
    ? `${lines[0]}${lines[1] ? `, and ${lines[1]}` : ''}.`
    : 'I had a few ideas about how more people nearby could find you.'
  return [
    `Hi ${b.name},`,
    '',
    `I was looking at ${kind} around ${area} and came across you. ${capital(observation)}`,
    '',
    'I help local businesses with exactly this. Would a 15-minute call next week be useful?',
    '',
    'Best,',
  ].join('\n')
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
