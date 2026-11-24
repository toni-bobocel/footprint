import type { Feature } from 'geojson'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Business, Footprint, Place } from './engine/types'

// OpenFreeMap's Positron: free, keyless, and already close to white.
const STYLE = 'https://tiles.openfreemap.org/styles/positron'
const HOT = 60

function circle(lat: number, lon: number, km: number, steps = 96): Feature {
  const coords: [number, number][] = []
  const dLat = km / 110.574
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180))
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    coords.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)])
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } }
}

export class Atlas {
  private map: maplibregl.Map | null = null
  private ready: Promise<void> | null = null
  onSelect: (id: string) => void = () => {}

  constructor(private el: HTMLElement) {}

  private boot(center: [number, number]): Promise<void> {
    if (this.ready) return this.ready
    this.map = new maplibregl.Map({
      container: this.el,
      style: STYLE,
      center,
      zoom: 3,
      attributionControl: { compact: true },
      fadeDuration: 0,
    })
    const map = this.map
    this.ready = new Promise((resolve) => {
      map.on('load', () => {
        this.quiet(map)
        map.addSource('radius', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        map.addSource('biz', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'radius-fill',
          type: 'fill',
          source: 'radius',
          paint: { 'fill-color': '#171a20', 'fill-opacity': 0.025 },
        })
        map.addLayer({
          id: 'radius-line',
          type: 'line',
          source: 'radius',
          paint: {
            'line-color': '#171a20',
            'line-width': 1,
            'line-opacity': 0.35,
            'line-dasharray': [2, 3],
          },
        })
        map.addLayer({
          id: 'biz',
          type: 'circle',
          source: 'biz',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              ['case', ['boolean', ['feature-state', 'selected'], false], 6, 2.5],
              16,
              ['case', ['boolean', ['feature-state', 'selected'], false], 9, 5],
            ],
            'circle-color': ['case', ['>=', ['get', 'opportunity'], HOT], '#e31937', '#171a20'],
            'circle-opacity': ['case', ['get', 'scanned'], 0.95, 0.35],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              2.5,
              1,
            ],
          },
        })
        map.on('click', 'biz', (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id
          if (id) this.onSelect(String(id))
        })
        map.on('mouseenter', 'biz', () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', 'biz', () => {
          map.getCanvas().style.cursor = ''
        })
        resolve()
      })
    })
    return this.ready
  }

  // Positron with less in it: no POI icons, softer labels, paler roads.
  private quiet(map: maplibregl.Map) {
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type === 'symbol' && /poi|transit|airport/.test(layer.id)) {
        map.setLayoutProperty(layer.id, 'visibility', 'none')
      }
      if (layer.type === 'symbol') map.setPaintProperty(layer.id, 'text-color', '#8e9094')
      if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#fbfbfb')
      if (layer.type === 'fill' && /water/.test(layer.id))
        map.setPaintProperty(layer.id, 'fill-color', '#eef0f2')
    }
  }

  async show(place: Place, km: number): Promise<void> {
    await this.boot([place.lon, place.lat])
    const map = this.map
    if (!map) return
    map.resize()
    ;(map.getSource('radius') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [circle(place.lat, place.lon, km)],
    })
    const d = km / 111
    map.jumpTo({ center: [place.lon, place.lat], zoom: 4 })
    map.fitBounds(
      [
        [place.lon - d * 1.4, place.lat - d],
        [place.lon + d * 1.4, place.lat + d],
      ],
      {
        padding: { top: 90, bottom: 60, left: this.leftPad(), right: 60 },
        duration: 2600,
        essential: true,
      },
    )
  }

  private leftPad() {
    return window.innerWidth > 900 ? Math.min(520, window.innerWidth * 0.4) + 40 : 40
  }

  setData(items: Business[], prints: Map<string, Footprint>) {
    // Results can land before the style has finished loading.
    if (!this.map?.getSource('biz')) {
      this.ready?.then(() => this.setData(items, prints))
      return
    }
    const src = this.map?.getSource('biz') as GeoJSONSource | undefined
    src?.setData({
      type: 'FeatureCollection',
      features: items.map((b) => ({
        type: 'Feature',
        id: this.numeric(b.id),
        properties: {
          id: b.id,
          opportunity: prints.get(b.id)?.opportunity ?? 0,
          scanned: prints.has(b.id),
        },
        geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      })),
    })
  }

  private ids = new Map<string, number>()
  private selected: number | null = null
  // Feature state needs numeric ids.
  private numeric(id: string) {
    let n = this.ids.get(id)
    if (n === undefined) {
      n = this.ids.size + 1
      this.ids.set(id, n)
    }
    return n
  }

  select(b: Business | null) {
    const map = this.map
    if (!map?.getSource('biz')) return
    if (this.selected !== null)
      map.setFeatureState({ source: 'biz', id: this.selected }, { selected: false })
    this.selected = b ? this.numeric(b.id) : null
    if (!b || this.selected === null) return
    map.setFeatureState({ source: 'biz', id: this.selected }, { selected: true })
    map.easeTo({
      center: [b.lon, b.lat],
      zoom: Math.max(map.getZoom(), 15),
      duration: 900,
      padding: {
        left: this.leftPad(),
        right: window.innerWidth > 900 ? 460 : 0,
        top: 0,
        bottom: 0,
      },
    })
  }

  clear() {
    this.ids.clear()
    this.selected = null
    this.setData([], new Map())
  }
}
