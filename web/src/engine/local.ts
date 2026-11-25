import { CATEGORIES, type Category, type ParsedQuery, parse } from './query'
import type { Business, Engine, Footprint, Gap, Place, SearchEvent, SearchRequest } from './types'

// The browser-only engine used on GitHub Pages, where there is no API.
// Same open data, called straight from the page (all three send CORS
// headers). What it can't do is open each business's website: browsers
// block that, so the footprint is built from what the map already records.

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const SIRENE = 'https://recherche-entreprises.api.gouv.fr'
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
const OVERPASS_TIMEOUT = 25_000
const MAX_RADIUS = 15_000
const EVERYTHING_RADIUS = 1_500
const EVERYTHING = [
  '["shop"]',
  '["office"]',
  '["craft"]',
  '["amenity"~"^(restaurant|cafe|bar|pub|fast_food|dentist|doctors|clinic|pharmacy|veterinary|driving_school|coworking_space)$"]',
  '["tourism"~"^(hotel|guest_house|hostel)$"]',
  '["leisure"~"^(fitness_centre|spa)$"]',
  '["healthcare"]',
]
const KINDS = ['shop', 'amenity', 'office', 'craft', 'tourism', 'leisure', 'healthcare']
const SOCIAL_TAGS: Record<string, string[]> = {
  instagram: ['contact:instagram', 'instagram'],
  facebook: ['contact:facebook', 'facebook'],
  linkedin: ['contact:linkedin', 'linkedin'],
  tiktok: ['contact:tiktok', 'tiktok'],
  youtube: ['contact:youtube', 'youtube'],
  x: ['contact:twitter', 'twitter', 'contact:x'],
}
const WEIGHTS: Partial<Record<Gap, number>> = {
  no_website: 40,
  no_instagram: 8,
  no_facebook: 5,
  no_linkedin: 4,
  no_tiktok: 3,
  no_reviews: 10,
}
const SMALL_BANDS = new Set(['NN', '00', '01', '02', '03'])
const BANDS: Record<string, string> = {
  '00': '0',
  '01': '1-2',
  '02': '3-5',
  '03': '6-9',
  '11': '10-19',
  '12': '20-49',
  '21': '50-99',
  '22': '100-199',
  '31': '200-249',
  '32': '250-499',
  '41': '500-999',
  '42': '1000-1999',
  '51': '2000-4999',
  '52': '5000-9999',
  '53': '10000+',
}

let lastNominatim = 0
async function nominatim(path: string, params: Record<string, string | number>) {
  // One request a second, as Nominatim's usage policy asks.
  const wait = 1050 - (Date.now() - lastNominatim)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastNominatim = Date.now()
  const qs = new URLSearchParams(
    Object.entries({ format: 'jsonv2', addressdetails: 1, ...params }).map(([k, v]) => [
      k,
      String(v),
    ]),
  )
  const res = await fetch(`${NOMINATIM}/${path}?${qs}`, { headers: { 'Accept-Language': 'en' } })
  if (!res.ok) throw new Error(`nominatim ${res.status}`)
  return res.json()
}

// biome-ignore lint/suspicious/noExplicitAny: raw Nominatim rows
function toPlace(row: any): Place {
  const bb = row.boundingbox?.map(Number)
  return {
    name: row.display_name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    kind: row.addresstype ?? row.type ?? null,
    country: row.address?.country_code?.toUpperCase() ?? null,
    importance: Number(row.importance ?? 0),
    capital: row.extratags?.capital_city ?? null,
    bbox: bb ? [bb[0], bb[1], bb[2], bb[3]] : null,
  }
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h))
}

function radiusFor(place: Place, requested: number | null): number {
  if (requested) return Math.max(0.2, Math.min(requested, 50))
  if (place.bbox && !['country', 'state', 'region'].includes(place.kind ?? '')) {
    const [s, n, w, e] = place.bbox
    const far = Math.max(
      ...[
        [s, w],
        [s, e],
        [n, w],
        [n, e],
      ].map(([la, lo]) => distanceKm(place.lat, place.lon, la, lo)),
    )
    return Math.round(Math.max(1, Math.min(far, 15)) * 10) / 10
  }
  return 5
}

function overpassQuery(
  lat: number,
  lon: number,
  km: number,
  cats: Category[],
  terms: string | null,
) {
  const everything = !cats.length && !terms
  const r = Math.round(Math.min(km * 1000, everything ? EVERYTHING_RADIUS : MAX_RADIUS))
  const around = `(around:${r},${lat.toFixed(6)},${lon.toFixed(6)})`
  const parts = everything ? EVERYTHING.map((sel) => `nwr${sel}["name"]${around};`) : []
  for (const c of cats)
    for (const [k, v] of c.osm) parts.push(`nwr["${k}"="${v}"]["name"]${around};`)
  if (terms && !cats.length) {
    const pattern = terms.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')
    parts.push(`nwr["name"~"${pattern}",i][~"^(${KINDS.join('|')})$"~"."]${around};`)
  }
  return `[out:json][timeout:25];(${parts.join('')});out center tags 300;`
}

async function overpass(
  query: string,
  signal: AbortSignal,
  // biome-ignore lint/suspicious/noExplicitAny: raw Overpass elements
): Promise<any[]> {
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(OVERPASS_TIMEOUT)]),
      })
      if (res.ok) return (await res.json()).elements ?? []
    } catch (err) {
      if (signal.aborted) throw err
    }
  }
  throw new Error('overpass unavailable')
}

function fromOsm(
  // biome-ignore lint/suspicious/noExplicitAny: raw Overpass element
  el: any,
  lat: number,
  lon: number,
  cats: Category[],
): Business | null {
  const tags: Record<string, string> = el.tags ?? {}
  const name = tags.name ?? tags.brand
  const c = el.center ?? el
  if (!name || c.lat === undefined) return null
  const socials: Record<string, string> = {}
  for (const [net, keys] of Object.entries(SOCIAL_TAGS)) {
    const v = keys.map((k) => tags[k]).find(Boolean)
    if (v) socials[net] = v
  }
  const category =
    cats.find((cat) => cat.osm.some(([k, v]) => tags[k] === v))?.id ??
    KINDS.filter((k) => tags[k]).map((k) => `${k}:${tags[k]}`)[0] ??
    null
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
  const city = [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ')
  return {
    id: `osm:${el.type}/${el.id}`,
    name,
    category,
    lat: c.lat,
    lon: c.lon,
    distance_km: Math.round(distanceKm(lat, lon, c.lat, c.lon) * 1000) / 1000,
    address: [street, city].filter(Boolean).join(', ') || null,
    phone: tags.phone ?? tags['contact:phone'] ?? null,
    website: tags.website ?? tags['contact:website'] ?? tags.url ?? null,
    socials,
    size: null,
    founded: null,
    sources: ['openstreetmap'],
  }
}

async function sirene(
  lat: number,
  lon: number,
  km: number,
  cats: Category[],
  recent: boolean,
  size: string | null,
  signal: AbortSignal,
): Promise<Business[]> {
  const naf = [...new Set(cats.flatMap((c) => c.naf))].sort()
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  const out: Business[] = []
  for (let page = 1; page <= 4; page++) {
    const qs = new URLSearchParams({
      lat: String(lat),
      long: String(lon),
      radius: String(Math.min(km, 50)),
      per_page: '25',
      page: String(page),
    })
    if (naf.length) qs.set('activite_principale', naf.join(','))
    const res = await fetch(`${SIRENE}/near_point?${qs}`, { signal })
    if (!res.ok) throw new Error(`sirene ${res.status}`)
    const body = await res.json()
    for (const row of body.results ?? []) {
      // Companies that opted out of prospecting are never shown.
      if (row.opposition_diffusion_commerciale || row.etat_administratif !== 'A') continue
      const band = row.tranche_effectif_salarie ?? 'NN'
      if (size === 'small' && !SMALL_BANDS.has(band)) continue
      if (size === 'large' && SMALL_BANDS.has(band)) continue
      if (recent && (!row.date_creation || row.date_creation < since)) continue
      const category = cats.find((c) => c.naf.includes(row.activite_principale))?.id ?? null
      for (const site of row.matching_etablissements ?? []) {
        if (site.etat_administratif && site.etat_administratif !== 'A') continue
        const slat = Number(site.latitude)
        const slon = Number(site.longitude)
        if (!Number.isFinite(slat) || !Number.isFinite(slon)) continue
        const raw: string = site.liste_enseignes?.[0] ?? row.nom_complet ?? ''
        out.push({
          id: `siret:${site.siret}`,
          name:
            raw === raw.toUpperCase()
              ? raw.toLowerCase().replace(/\b\p{L}/gu, (l) => l.toUpperCase())
              : raw,
          category,
          lat: slat,
          lon: slon,
          distance_km: Math.round(distanceKm(lat, lon, slat, slon) * 1000) / 1000,
          address: site.adresse ?? null,
          phone: null,
          website: null,
          socials: {},
          size: BANDS[band] ?? null,
          founded: row.date_creation ?? null,
          sources: ['sirene'],
        })
      }
    }
    if (page >= (body.total_pages ?? 1)) break
    await new Promise((r) => setTimeout(r, 200))
  }
  return out
}

const LEGAL =
  /\b(?:sarl|sas|sasu|eurl|sa|sci|snc|ei|eirl|ltd|limited|llc|inc|gmbh|ag|bv|srl|spa|plc|co)\b\.?/g
const key = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(LEGAL, ' ')
    .replace(/[^a-z0-9]+/g, '')
const sameName = (a: string, b: string) =>
  !!a && !!b && (a === b || (Math.min(a.length, b.length) > 4 && (a.includes(b) || b.includes(a))))

export function merge(items: Business[]): Business[] {
  const kept: Business[] = []
  for (const b of items) {
    const k = key(b.name)
    const twin = kept.find(
      (t) =>
        t.id === b.id || (sameName(k, key(t.name)) && distanceKm(t.lat, t.lon, b.lat, b.lon) < 0.2),
    )
    if (!twin) {
      kept.push({ ...b, socials: { ...b.socials } })
      continue
    }
    twin.size ??= b.size
    twin.founded ??= b.founded
    twin.website ??= b.website
    twin.phone ??= b.phone
    twin.address ??= b.address
    twin.category ??= b.category
    for (const [n, v] of Object.entries(b.socials)) twin.socials[n] ??= v
    twin.sources = [...new Set([...twin.sources, ...b.sources])].sort()
  }
  return kept
}

export function mapFootprint(b: Business): Footprint {
  if (!b.website && !b.sources.includes('openstreetmap')) {
    return {
      business_id: b.id,
      website: 'unknown',
      site: null,
      socials: b.socials,
      reviews: {},
      google_rating: null,
      google_reviews: null,
      gaps: [],
      opportunity: 0,
    }
  }
  const gaps: Gap[] = []
  if (!b.website) gaps.push('no_website')
  for (const net of ['instagram', 'facebook', 'linkedin', 'tiktok'] as const) {
    if (!b.socials[net]) gaps.push(`no_${net}`)
  }
  return {
    business_id: b.id,
    website: b.website ? 'ok' : 'missing',
    site: null,
    socials: b.socials,
    reviews: {},
    google_rating: null,
    google_reviews: null,
    gaps,
    opportunity: Math.min(
      100,
      gaps.reduce((sum, g) => sum + (WEIGHTS[g] ?? 0), 0),
    ),
  }
}

// Same rules as the API's Engine._settle and _guess (api/src/footprint/search.py).
const BROAD = ['country', 'state', 'region', 'province']
const PROMINENT = 0.45

async function geocode(text: string): Promise<Place | null> {
  const rows = await nominatim('search', { q: text, limit: 1, extratags: 1 })
  return rows[0] ? toPlace(rows[0]) : null
}

// Nominative guesses for an inflected Russian place name ("в Москве").
function uninflect(text: string): string[] {
  if (!/[еиу]$/.test(text)) return []
  const stem = text.slice(0, -1)
  return ['а', 'ь', '', 'я', 'ы'].map((ending) => stem + ending)
}

async function settle(text: string): Promise<Place | null> {
  let place: Place | null = null
  for (const variant of uninflect(text)) {
    const candidate = await geocode(variant)
    if (candidate && (candidate.importance ?? 0) >= PROMINENT) {
      place = candidate
      break
    }
  }
  place ??= await geocode(text)
  // The middle of Moldova is fields; its businesses are in Chișinău.
  if (place?.capital && BROAD.includes(place.kind ?? '')) {
    return (await geocode(`${place.capital}, ${text}`)) ?? place
  }
  return place
}

// No category and no preposition: "Moldova", "Tesla Austin".
async function guess(q: ParsedQuery): Promise<Place | null> {
  const terms = q.terms ?? ''
  const words = terms.split(' ')
  const splits: [string, string][] = [[terms, '']]
  for (const k of [1, 2]) {
    if (words.length > k) {
      splits.push([words.slice(-k).join(' '), words.slice(0, -k).join(' ')])
      splits.push([words.slice(0, k).join(' '), words.slice(k).join(' ')])
    }
  }
  for (const [where, rest] of splits) {
    const place = await geocode(where)
    if (place && (place.importance ?? 0) >= PROMINENT) {
      q.place = where
      q.terms = rest || null
      return BROAD.includes(place.kind ?? '') ? settle(where) : place
    }
  }
  return null
}

export class Local implements Engine {
  readonly depth = 'map'

  async reverse(lat: number, lon: number): Promise<Place | null> {
    const row = await nominatim('reverse', { lat, lon, zoom: 10 })
    return row.error ? null : { ...toPlace(row), lat, lon }
  }

  async *search(req: SearchRequest, signal: AbortSignal): AsyncIterable<SearchEvent> {
    const started = performance.now()
    const q = parse(req.q)
    const lat = req.lat ?? q.lat
    const lon = req.lon ?? q.lon
    let place: Place | null = null
    if (lat != null && lon != null) {
      place = (await this.reverse(lat, lon)) ?? {
        name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        lat,
        lon,
      }
    } else if (q.place) {
      place = await settle(q.place)
    } else if (q.terms) {
      place = await guess(q)
    }
    const cats = q.categories
      .map((id) => CATEGORIES.find((c) => c.id === id))
      .filter((c): c is Category => !!c)
    yield {
      kind: 'intent',
      data: {
        text: q.text,
        categories: cats.map((c) => ({ id: c.id, label: c.label, labels: c.labels })),
        types: q.types,
        terms: q.terms,
        place: q.place,
        gaps: q.gaps,
        recent: q.recent,
        size: q.size,
        everything: !cats.length && !q.types.length && !q.terms,
      },
    }
    if (!place) {
      yield { kind: 'problem', data: { code: 'no_place' } }
      return
    }
    const km = radiusFor(place, req.radius_km ?? q.radius_km)
    yield { kind: 'place', data: { ...place, radius_km: km } }

    const status: Record<string, string> = {}
    let found: Business[] = []
    const queue: SearchEvent[] = []
    let wake: (() => void) | null = null
    const push = (e: SearchEvent) => {
      queue.push(e)
      wake?.()
    }
    const land = (source: string, items: Business[]) => {
      const before = new Set(found.map((b) => b.id))
      found = merge([...found, ...items]).slice(0, 300)
      push({ kind: 'businesses', data: { source, items: found } })
      for (const b of found)
        if (!before.has(b.id)) push({ kind: 'footprint', data: mapFootprint(b) })
    }

    const inFrance = place.country ? place.country === 'FR' : false
    const jobs: Promise<void>[] = []
    if (q.types.length && !cats.length) status.openstreetmap = 'skipped'
    else
      jobs.push(
        overpass(overpassQuery(place.lat, place.lon, km, cats, q.terms), signal)
          .then((els) => {
            status.openstreetmap = 'ok'
            const items = els
              .map((el) => fromOsm(el, place.lat, place.lon, cats))
              .filter((b): b is Business => !!b)
            land('openstreetmap', items)
          })
          .catch(() => {
            status.openstreetmap = 'unavailable'
            push({
              kind: 'notice',
              data: { source: 'openstreetmap', code: 'busy' },
            })
          }),
      )
    if (!q.terms && !q.types.length && inFrance) {
      jobs.push(
        sirene(place.lat, place.lon, km, cats, q.recent, q.size, signal)
          .then((items) => {
            status.sirene = 'ok'
            land('sirene', items)
          })
          .catch(() => {
            status.sirene = 'error'
          }),
      )
    } else status.sirene = 'skipped'

    let finished = false
    Promise.all(jobs).then(() => {
      finished = true
      wake?.()
    })
    while (!finished || queue.length) {
      if (signal.aborted) return
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      await new Promise<void>((r) => {
        wake = r
      })
      wake = null
    }
    yield {
      kind: 'done',
      data: {
        count: found.length,
        elapsed_ms: Math.round(performance.now() - started),
        sources: status,
      },
    }
  }
}
