// Mirrors api/src/footprint/models.py. Both engines emit exactly these events.

export type Gap =
  | 'no_website'
  | 'unreachable'
  | 'not_secure'
  | 'slow'
  | 'not_mobile'
  | 'outdated'
  | 'no_instagram'
  | 'no_facebook'
  | 'no_linkedin'
  | 'no_tiktok'
  | 'no_reviews'
  | 'no_tracking'

export interface Place {
  name: string
  lat: number
  lon: number
  kind?: string | null
  country?: string | null
  bbox?: [number, number, number, number] | null
  radius_km?: number
}

export interface Business {
  id: string
  name: string
  category: string | null
  lat: number
  lon: number
  distance_km: number
  address: string | null
  phone: string | null
  website: string | null
  socials: Record<string, string>
  size: string | null
  founded: string | null
  sources: string[]
}

export interface Site {
  reachable: boolean
  final_url: string | null
  https: boolean
  ssl_valid: boolean | null
  response_ms: number | null
  mobile: boolean | null
  generator: string | null
  outdated: string[]
  socials: Record<string, string>
  tracking: string[]
  reviews: Record<string, string>
}

export interface Footprint {
  business_id: string
  website: 'ok' | 'missing' | 'unreachable' | 'unknown'
  site: Site | null
  socials: Record<string, string>
  reviews: Record<string, string>
  google_rating: number | null
  google_reviews: number | null
  gaps: Gap[]
  opportunity: number
}

export interface Intent {
  text: string
  categories: { id: string; label: string }[]
  terms: string | null
  place: string | null
  gaps: Gap[]
  recent: boolean
  size: string | null
  everything: boolean
}

export type SearchEvent =
  | { kind: 'intent'; data: Intent }
  | { kind: 'place'; data: Place }
  | { kind: 'businesses'; data: { source: string; items: Business[] } }
  | { kind: 'footprint'; data: Footprint }
  | { kind: 'notice'; data: { source: string; message: string } }
  | { kind: 'problem'; data: { code: string; message: string } }
  | { kind: 'done'; data: { count: number; elapsed_ms: number; sources: Record<string, string> } }

export interface SearchRequest {
  q: string
  lat?: number
  lon?: number
  radius_km?: number
}

export interface Engine {
  // 'full' scans every website; 'map' only knows what OpenStreetMap knows.
  readonly depth: 'full' | 'map'
  search(req: SearchRequest, signal: AbortSignal): AsyncIterable<SearchEvent>
  reverse(lat: number, lon: number): Promise<Place | null>
}

export const GAP_LABEL: Record<Gap, string> = {
  no_website: 'No website',
  unreachable: 'Website down',
  not_secure: 'Not secure',
  slow: 'Slow site',
  not_mobile: 'Not mobile',
  outdated: 'Outdated site',
  no_instagram: 'No Instagram',
  no_facebook: 'No Facebook',
  no_linkedin: 'No LinkedIn',
  no_tiktok: 'No TikTok',
  no_reviews: 'No reviews',
  no_tracking: 'No analytics',
}
