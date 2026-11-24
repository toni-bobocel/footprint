import type { Engine, Place, SearchEvent, SearchRequest } from './types'

// Talks to the FastAPI service. fetch + a stream reader rather than
// EventSource, so a new search can abort the old one cleanly.
export class Remote implements Engine {
  readonly depth = 'full'

  constructor(private base: string) {}

  static async probe(base: string): Promise<Remote | null> {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) })
      return res.ok ? new Remote(base) : null
    } catch {
      return null
    }
  }

  async reverse(lat: number, lon: number): Promise<Place | null> {
    const res = await fetch(`${this.base}/api/reverse?lat=${lat}&lon=${lon}`)
    return res.ok ? res.json() : null
  }

  async *search(req: SearchRequest, signal: AbortSignal): AsyncIterable<SearchEvent> {
    const params = new URLSearchParams({ q: req.q })
    if (req.lat !== undefined && req.lon !== undefined) {
      params.set('lat', String(req.lat))
      params.set('lon', String(req.lon))
    }
    if (req.radius_km) params.set('radius_km', String(req.radius_km))
    const res = await fetch(`${this.base}/api/search?${params}`, { signal })
    if (!res.body) return
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let cut = buffer.indexOf('\n\n')
      while (cut !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const kind = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (kind && data) yield { kind, data: JSON.parse(data) } as SearchEvent
        cut = buffer.indexOf('\n\n')
      }
    }
  }
}
