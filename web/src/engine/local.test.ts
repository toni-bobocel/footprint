import { describe, expect, it } from 'vitest'
import { toCsv } from '../csv'
import { message } from '../outreach'
import { mapFootprint, merge } from './local'
import type { Business } from './types'

const shop = (over: Partial<Business> = {}): Business => ({
  id: 'osm:node/1',
  name: 'Boulangerie du Parc',
  category: 'bakery',
  lat: 45.7601,
  lon: 4.8403,
  distance_km: 0.4,
  address: null,
  phone: null,
  website: null,
  socials: {},
  size: null,
  founded: null,
  sources: ['openstreetmap'],
  ...over,
})

describe('map-only footprint', () => {
  it('flags a missing website first', () => {
    const fp = mapFootprint(shop())
    expect(fp.website).toBe('missing')
    expect(fp.gaps[0]).toBe('no_website')
    expect(fp.opportunity).toBeGreaterThanOrEqual(40)
  })

  it('says unknown for register-only businesses', () => {
    const fp = mapFootprint(shop({ id: 'siret:1', sources: ['sirene'] }))
    expect(fp.website).toBe('unknown')
    expect(fp.gaps).toEqual([])
  })
})

describe('merge', () => {
  it('joins the map and register entries for one shop', () => {
    const merged = merge([
      shop({ website: 'parc.fr' }),
      shop({
        id: 'siret:1',
        name: 'BOULANGERIE DU PARC SARL',
        lat: 45.7602,
        size: '1-2',
        sources: ['sirene'],
      }),
      shop({ id: 'osm:node/9', lat: 45.8 }),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      website: 'parc.fr',
      size: '1-2',
      sources: ['openstreetmap', 'sirene'],
    })
  })
})

describe('outreach', () => {
  it('names one concrete thing', () => {
    const b = shop()
    const text = message(b, mapFootprint(b), 'Lyon')
    expect(text).toContain('Hi Boulangerie du Parc,')
    expect(text).toContain("I couldn't find a website for you")
    expect(text).toContain('around Lyon')
  })
})

describe('csv', () => {
  it('quotes commas and defuses formulas', () => {
    const csv = toCsv([shop({ name: '=HYPERLINK("x")', address: '3 Place, Lyon' })], new Map())
    const row = csv.split('\r\n')[1]
    expect(row.startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true)
    expect(row).toContain('"3 Place, Lyon"')
  })
})
