import { CATEGORIES } from './engine/query'

export function categoryLabel(category: string | null): string {
  if (!category) return ''
  const known = CATEGORIES.find((c) => c.id === category)
  // "Bakeries" reads as "Bakery" on a single row; "Bars and pubs" stays as is.
  if (known)
    return / and /.test(known.label)
      ? known.label
      : known.label.replace(/s$/, '').replace(/ie$/, 'y')
  // Raw OSM tags such as "shop:tea" or "office:it".
  const value = category.split(':')[1] ?? category
  return value.replace(/_/g, ' ').replace(/^\w/, (l) => l.toUpperCase())
}

export function shortPlace(name: string): string {
  return name
    .split(',')
    .slice(0, 2)
    .map((s) => s.trim())
    .join(', ')
}
