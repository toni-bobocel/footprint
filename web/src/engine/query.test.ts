import { describe, expect, it } from 'vitest'
import { parse } from './query'

// Same cases as api/tests/test_query.py: the two parsers must agree.
describe('parse', () => {
  it.each([
    ['bakeries in Lyon without a website', ['bakery'], 'lyon', ['no_website']],
    [
      'Plumbers near Manchester with no Instagram and no reviews',
      ['plumber'],
      'manchester',
      ['no_instagram', 'no_reviews'],
    ],
    ['cafes in Lyon that have no website', ['cafe'], 'lyon', ['no_website']],
    ['pet shops in Trinidad and Tobago', ['pet'], 'trinidad and tobago', []],
    ['dentists in São Paulo not mobile friendly', ['dentist'], 'são paulo', ['not_mobile']],
    ['hair salons', ['hairdresser'], null, []],
  ])('%s', (text, categories, place, gaps) => {
    const q = parse(text)
    expect(q.categories).toEqual(categories)
    expect(q.place).toBe(place)
    expect(q.gaps).toEqual(gaps)
  })

  it('does not read "new" in a place name as a filter', () => {
    expect(parse('coffee shops in New York')).toMatchObject({ place: 'new york', recent: false })
    expect(parse('new coffee shops in Brooklyn, New York').recent).toBe(true)
  })

  it('prefers the longest phrase', () => {
    expect(parse('coffee shops in Rome').categories).toEqual(['cafe'])
  })

  it('reads coordinates and a radius', () => {
    expect(parse('small law firms within 20 km of 48.8566, 2.3522')).toMatchObject({
      categories: ['lawyer'],
      lat: 48.8566,
      lon: 2.3522,
      radius_km: 20,
      size: 'small',
    })
  })

  it('turns unknown words into a name search', () => {
    expect(parse('Tesla in Austin')).toMatchObject({
      categories: [],
      terms: 'tesla',
      place: 'austin',
    })
  })

  it('matches accented category words', () => {
    expect(parse('cafés in Paris').categories).toEqual(['cafe'])
  })
})
