// Samples evenly spaced points on the sphere and keeps the ones on land.
// Output: public/land.bin, int16 pairs of (lat, lon) * SCALE. Natural Earth
// 1:50m via world-atlas, public domain. Re-run only if N or the source changes.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { geoBounds, geoContains } from 'd3-geo'
import { feature } from 'topojson-client'

// Dense enough that the globe still reads as a surface when the camera
// dives in, right before the map takes over.
const N = 560_000
const SCALE = 150
const require = createRequire(import.meta.url)
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-50m.json'), 'utf8'))
const land = feature(topo, topo.objects.land)

// geoContains walks every ring, so test each polygon's bounds first.
const polygons = land.features
  .flatMap((f) =>
    f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
      : [f.geometry],
  )
  .map((geometry) => ({ geometry, bounds: geoBounds(geometry) }))

function onLand(lon, lat) {
  for (const { geometry, bounds } of polygons) {
    const [[w, s], [e, n]] = bounds
    if (lat < s || lat > n) continue
    // Bounds that cross the antimeridian have w > e.
    if (w <= e ? lon < w || lon > e : lon < w && lon > e) continue
    if (geoContains(geometry, [lon, lat])) return true
  }
  return false
}

// Fibonacci lattice: the most even spread of N points on a sphere, so the
// globe reads as a fabric of dots rather than lines of latitude.
const golden = Math.PI * (3 - Math.sqrt(5))
const out = []
for (let i = 0; i < N; i++) {
  const y = 1 - (i / (N - 1)) * 2
  const lat = (Math.asin(y) * 180) / Math.PI
  if (lat < -60) continue // Antarctica is all ice and no businesses.
  const lon = (((((golden * i * 180) / Math.PI) % 360) + 540) % 360) - 180
  if (onLand(lon, lat)) out.push(Math.round(lat * SCALE), Math.round(lon * SCALE))
}

const buf = Buffer.from(new Int16Array(out).buffer)
writeFileSync(new URL('../public/land.bin', import.meta.url), buf)
process.stdout.write(`${out.length / 2} land points, ${(buf.length / 1024).toFixed(0)} KiB\n`)
