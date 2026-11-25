import { describe, expect, it } from 'vitest'
import shared from '../../../shared/query-cases.json'
import { fold, parse } from './query'

interface Case {
  q: string
  categories: string[]
  types?: string[]
  place: string | null
  terms?: string
  gaps?: string[]
  recent?: boolean
  size?: string
  radius_km?: number
  lat?: number
}

// Same file as api/tests/test_query.py: the two parsers must agree.
describe('parse', () => {
  it.each((shared.cases as Case[]).map((c) => [c.q, c] as const))('%s', (_, c) => {
    const q = parse(c.q)
    expect(q.categories).toEqual(c.categories)
    expect(q.types).toEqual(c.types ?? [])
    expect(q.place).toBe(c.place)
    expect(q.terms).toBe(c.terms ?? null)
    expect(q.gaps).toEqual(c.gaps ?? [])
    expect(q.recent).toBe(c.recent ?? false)
    expect(q.size).toBe(c.size ?? null)
    expect(q.radius_km).toBe(c.radius_km ?? null)
    expect(q.lat).toBe(c.lat ?? null)
  })

  it('folds Latin accents but keeps Japanese and Cyrillic', () => {
    expect(fold('Près de')).toBe('pres de')
    expect(fold('パン屋')).toBe('パン屋')
    expect(fold('Москва')).toBe('москва')
  })
})
