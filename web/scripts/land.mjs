// Samples evenly spaced points on the sphere and keeps the ones on land.
// Output: public/land.bin, int16 pairs of (lat, lon) * SCALE. Natural Earth
// data via world-atlas, public domain. Re-run only if N or the source changes.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { geoContains } from 'd3-geo'
import { feature } from 'topojson-client'

const N = 150_000
const SCALE = 150
const require = createRequire(import.meta.url)
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-110m.json'), 'utf8'))
const land = feature(topo, topo.objects.land)

// Fibonacci lattice: the most even spread of N points on a sphere, so the
// globe reads as a fabric of dots rather than lines of latitude.
const golden = Math.PI * (3 - Math.sqrt(5))
const out = []
for (let i = 0; i < N; i++) {
  const y = 1 - (i / (N - 1)) * 2
  const theta = golden * i
  const lat = (Math.asin(y) * 180) / Math.PI
  const lon = (((((theta * 180) / Math.PI) % 360) + 540) % 360) - 180
  if (lat < -60) continue // Antarctica is all ice and no businesses.
  if (geoContains(land, [lon, lat])) out.push(Math.round(lat * SCALE), Math.round(lon * SCALE))
}

const buf = Buffer.from(new Int16Array(out).buffer)
writeFileSync(new URL('../public/land.bin', import.meta.url), buf)
process.stdout.write(`${out.length / 2} land points, ${(buf.length / 1024).toFixed(0)} KiB
`)
