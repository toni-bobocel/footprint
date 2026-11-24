import type { Business, Footprint } from './engine/types'
import { categoryLabel } from './labels'

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  // Quote everything that could break a row, and defuse spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(items: Business[], prints: Map<string, Footprint>): string {
  const head = [
    'name',
    'category',
    'address',
    'phone',
    'website',
    'distance_km',
    'size',
    'founded',
    'instagram',
    'facebook',
    'linkedin',
    'tiktok',
    'opportunity',
    'missing',
    'sources',
  ]
  const rows = items.map((b) => {
    const fp = prints.get(b.id)
    const s = fp?.socials ?? b.socials
    return [
      b.name,
      categoryLabel(b.category),
      b.address,
      b.phone,
      fp?.site?.final_url ?? b.website,
      b.distance_km,
      b.size,
      b.founded,
      s.instagram,
      s.facebook,
      s.linkedin,
      s.tiktok,
      fp?.opportunity ?? '',
      fp?.gaps.join(' ') ?? '',
      b.sources.join(' '),
    ].map(cell)
  })
  return [head, ...rows].map((r) => r.join(',')).join('\r\n')
}

export function download(name: string, text: string) {
  // BOM so Excel opens accented names correctly.
  const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/csv;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
