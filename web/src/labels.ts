import { CATEGORIES } from './engine/query'

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// One business's kind, in the singular: the catalogue lists the plural first
// and the singular second in every language.
export function categoryLabel(category: string | null, lang = 'en'): string {
  if (!category) return ''
  const known = CATEGORIES.find((c) => c.id === category)
  if (known) {
    const words = known.words[lang] ?? known.words.en
    return cap(words[1] ?? known.labels[lang] ?? known.label)
  }
  // Raw OSM tags and Overture types: "shop:tea", "overture:cheese_shop".
  const value = category.split(':')[1] ?? category
  return cap(value.replace(/_/g, ' '))
}

// The plural, for titles and the first message.
export function categoryPlural(category: string | null, lang = 'en'): string | null {
  const known = CATEGORIES.find((c) => c.id === category)
  return known ? (known.labels[lang] ?? known.label) : null
}

export function shortPlace(name: string): string {
  return name
    .split(',')
    .slice(0, 2)
    .map((s) => s.trim())
    .join(', ')
}
