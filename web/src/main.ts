import './style.css'
import gsap from 'gsap'
import { CustomEase } from 'gsap/CustomEase'
import { Draggable } from 'gsap/Draggable'
import { Flip } from 'gsap/Flip'
import { InertiaPlugin } from 'gsap/InertiaPlugin'
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin'
import { SplitText } from 'gsap/SplitText'
import { download, toCsv } from './csv'
import { Local } from './engine/local'
import { parse } from './engine/query'
import { Remote } from './engine/remote'
import type { Business, Engine, Footprint, Gap, Intent, Place } from './engine/types'
import { Globe, type Pick } from './globe'
import { detect, LANGS, type Lang, STRINGS } from './i18n'
import { categoryLabel, shortPlace } from './labels'
import { Atlas } from './map'
import { message } from './outreach'

gsap.registerPlugin(CustomEase, Draggable, Flip, InertiaPlugin, ScrambleTextPlugin, SplitText)
CustomEase.create('glide', 'M0,0 C0.5,0 0,1 1,1')
gsap.defaults({ ease: 'glide', duration: 0.9 })

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) =>
  root.querySelector(s) as T
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
if (reduced) gsap.globalTimeline.timeScale(4)

let lang: Lang = detect()
let t = STRINGS[lang]

// Brand names stay as they are; the rest comes from the language strings.
const FILTERS: { gap: Gap; brand?: string; full?: boolean }[] = [
  { gap: 'no_website' },
  { gap: 'no_instagram', brand: 'Instagram' },
  { gap: 'no_facebook', brand: 'Facebook' },
  { gap: 'no_linkedin', brand: 'LinkedIn' },
  { gap: 'no_reviews', full: true },
  { gap: 'not_mobile', full: true },
  { gap: 'not_secure', full: true },
  { gap: 'slow', full: true },
  { gap: 'weak_seo', full: true },
  { gap: 'no_contact', full: true },
]
const HOT = 60

const ui = {
  canvas: $<HTMLCanvasElement>('.globe'),
  atlas: $('.atlas'),
  hero: $('.hero'),
  title: $('.title'),
  form: $<HTMLFormElement>('.search'),
  input: $<HTMLInputElement>('#q'),
  ghost: $('.ghost'),
  line: $('.line'),
  hint: $('.hint'),
  pin: $('.pin'),
  picked: $('.picked'),
  pinName: $('.pin-name'),
  knob: $('.knob'),
  track: $('.track'),
  fill: $('.fill'),
  km: $('.km'),
  results: $('.results'),
  rTitle: $('.r-title'),
  rCount: $('.r-count'),
  rStatus: $('.r-status'),
  filters: $('.filters'),
  list: $<HTMLOListElement>('.list'),
  depth: $('.depth'),
  detail: $('.detail'),
  sheet: $('.sheet'),
  toast: $('.toast'),
}

const state = {
  engine: null as Engine | null,
  pick: null as (Pick & { name?: string }) | null,
  km: 5,
  place: null as Place | null,
  intent: null as Intent | null,
  items: new Map<string, Business>(),
  prints: new Map<string, Footprint>(),
  filters: new Set<Gap>(),
  sort: 'opportunity' as 'opportunity' | 'distance' | 'name',
  selected: null as string | null,
  abort: null as AbortController | null,
  mode: 'globe' as 'globe' | 'map',
}

const globe = new Globe(ui.canvas)
const atlas = new Atlas(ui.atlas)

/* Engine */

async function pickEngine(): Promise<Engine> {
  const asked = new URLSearchParams(location.search).get('api') ?? import.meta.env.VITE_API
  const base = asked ?? (import.meta.env.DEV ? 'http://localhost:8000' : null)
  return (base && (await Remote.probe(base))) || new Local()
}

/* Intro */

let split: SplitText | null = null

function intro() {
  split = SplitText.create(ui.title, {
    type: 'lines',
    mask: 'lines',
    linesClass: 'line-mask',
  })
  const tl = gsap.timeline({ delay: 0.15 })
  tl.add(globe.intro(), 0)
  tl.from(split.lines, { yPercent: 105, duration: 1.4, stagger: 0.12, ease: 'expo.out' }, 0.5)
  tl.from(ui.line, { scaleX: 0, duration: 1.4, ease: 'expo.inOut' }, 0.8)
  tl.from([ui.hint, '.go', '.top'], { autoAlpha: 0, duration: 1.2, stagger: 0.12 }, 1.4)
  tl.add(typeExamples, 1.6)
}

let typing: gsap.core.Timeline | null = null
function typeExamples() {
  typing?.kill()
  typing = gsap.timeline({ repeat: -1 })
  for (const text of t.examples) {
    const c = { n: 0 }
    const set = () => {
      ui.ghost.textContent = text.slice(0, Math.round(c.n))
    }
    typing
      .to(c, { n: text.length, duration: text.length * 0.045, ease: 'none', onUpdate: set })
      .to(c, { n: 0, duration: text.length * 0.014, ease: 'none', onUpdate: set }, '+=2.2')
      .to({}, { duration: 0.35 })
  }
}

ui.input.addEventListener('input', () =>
  ui.form.classList.toggle('typing', ui.input.value.length > 0),
)

/* Picking a point on the globe */

globe.onPick = async (p) => {
  if (state.mode !== 'globe') return
  const first = !state.pick
  state.pick = { ...p }
  globe.setPick(p)
  ui.pin.hidden = false
  ui.pinName.textContent = `${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°`
  typing?.pause()
  ui.ghost.textContent = t.pickGhost
  if (first) {
    ui.picked.hidden = false
    placeKnob(state.km)
    ui.hint.hidden = true
    gsap.fromTo(
      '.picked > *',
      { autoAlpha: 0, y: 8 },
      { autoAlpha: 1, y: 0, stagger: 0.07, duration: 0.7, ease: 'expo.out' },
    )
  }
  gsap.fromTo(
    '.cross',
    { scale: 1.8, autoAlpha: 0 },
    { scale: 1, autoAlpha: 1, duration: 0.7, ease: 'expo.out' },
  )
  const place = await state.engine?.reverse(p.lat, p.lon).catch(() => null)
  if (state.pick?.lat !== p.lat) return
  const name = place ? shortPlace(place.name) : t.openWater
  state.pick.name = name
  gsap.to(ui.pinName, {
    duration: 0.6,
    scrambleText: { text: name, chars: 'lowerCase', speed: 0.8 },
  })
}

function dropPin(restoreHint = true) {
  state.pick = null
  globe.setPick(null)
  ui.ghost.textContent = ''
  typing?.restart()
  gsap.to('.picked > *, .cross', {
    autoAlpha: 0,
    duration: 0.3,
    onComplete: () => {
      ui.pin.hidden = true
      ui.picked.hidden = true
      gsap.set('.cross', { autoAlpha: 1 })
    },
  })
  if (!restoreHint) return
  gsap.delayedCall(0.3, () => {
    ui.hint.hidden = false
    gsap.fromTo(ui.hint, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 })
  })
}

gsap.ticker.add(() => {
  if (!state.pick || ui.pin.hidden) return
  const s = globe.project(state.pick)
  ui.pin.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`
  ui.pin.style.opacity = s.visible ? '1' : '0'
  ui.pin.style.pointerEvents = s.visible ? '' : 'none'
})

// Radius on a log scale: 300 m to 50 km in one short line.
const MIN_KM = 0.3
const MAX_KM = 50
const toKm = (t: number) => MIN_KM * (MAX_KM / MIN_KM) ** t
const toT = (km: number) => Math.log(km / MIN_KM) / Math.log(MAX_KM / MIN_KM)
const kmText = (km: number) =>
  km < 1 ? `${Math.round(km * 10) * 100} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`

function placeKnob(km: number) {
  const w = ui.track.clientWidth
  const x = toT(km) * w
  gsap.set(ui.knob, { x })
  ui.fill.style.width = `${x}px`
  ui.km.textContent = kmText(km)
  ui.knob.setAttribute('aria-valuenow', String(Math.round(toT(km) * 100)))
  ui.knob.setAttribute('aria-valuetext', kmText(km))
  state.km = km
}

const [knob] = Draggable.create(ui.knob, {
  type: 'x',
  bounds: ui.track,
  inertia: true,
  onDrag: syncKnob,
  onThrowUpdate: syncKnob,
})
function syncKnob(this: Draggable) {
  const t = gsap.utils.clamp(0, 1, this.x / ui.track.clientWidth)
  state.km = toKm(t)
  ui.fill.style.width = `${this.x}px`
  ui.km.textContent = kmText(state.km)
}
ui.knob.addEventListener('keydown', (e) => {
  const step = e.key === 'ArrowRight' ? 0.04 : e.key === 'ArrowLeft' ? -0.04 : 0
  if (!step) return
  e.preventDefault()
  placeKnob(toKm(gsap.utils.clamp(0, 1, toT(state.km) + step)))
  knob.update()
})

ui.picked.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
  if (act === 'cancel') dropPin()
  if (act === 'here' && state.pick) {
    run(ui.input.value.trim() || 'businesses', {
      lat: state.pick.lat,
      lon: state.pick.lon,
      radius_km: state.km,
    })
  }
})

/* Searching */

ui.form.addEventListener('submit', (e) => {
  e.preventDefault()
  const q = ui.input.value.trim()
  if (q.length < 2 && state.pick) {
    run('businesses', { lat: state.pick.lat, lon: state.pick.lon, radius_km: state.km })
    return
  }
  if (q.length < 2) {
    gsap.fromTo(ui.line, { scaleX: 0.15 }, { scaleX: 1, duration: 0.9, ease: 'expo.out' })
    ui.input.focus()
    return
  }
  // A place written in the search beats a point clicked earlier.
  if (state.pick && !parse(q).place) {
    run(q, { lat: state.pick.lat, lon: state.pick.lon, radius_km: state.km })
  } else run(q, {})
})

async function run(q: string, where: { lat?: number; lon?: number; radius_km?: number }) {
  if (!state.engine) return
  state.abort?.abort()
  const abort = new AbortController()
  state.abort = abort
  state.items.clear()
  state.prints.clear()
  state.filters.clear()
  state.selected = null
  ui.list.replaceChildren()
  closeDetail()
  atlas.clear()
  status(t.looking)
  count(0)

  try {
    for await (const ev of state.engine.search({ q, lang, ...where }, abort.signal)) {
      if (abort.signal.aborted) return
      switch (ev.kind) {
        case 'intent':
          state.intent = ev.data
          for (const g of ev.data.gaps) state.filters.add(g)
          break
        case 'place':
          state.place = ev.data
          await enterMap(ev.data)
          break
        case 'businesses':
          for (const b of ev.data.items) state.items.set(b.id, b)
          render()
          break
        case 'footprint':
          state.prints.set(ev.data.business_id, ev.data)
          update(ev.data.business_id)
          break
        case 'notice':
          toast(
            ev.data.code === 'busy'
              ? t.busy
              : t.sourceDown(t.sources[ev.data.source] ?? ev.data.source),
          )
          break
        case 'problem':
          toast(t.noPlace)
          if (state.mode === 'globe') ui.input.focus()
          return
        case 'done':
          finish(ev.data.elapsed_ms, ev.data.sources)
          break
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      toast(t.failed)
      status(t.stopped)
    }
    if (import.meta.env.DEV && !abort.signal.aborted) throw err
  }
}

async function enterMap(place: Place) {
  const km = place.radius_km ?? state.km
  ui.rTitle.textContent = titleFor(state.intent, place)
  ui.depth.textContent = state.engine?.depth === 'full' ? t.depthFull : t.depthMap
  renderFilters()
  if (state.mode === 'map') {
    await atlas.show(place, km)
    return
  }
  state.mode = 'map'
  document.body.classList.add('mapped')
  typing?.pause()
  if (!ui.pin.hidden) dropPin(false)
  const tl = gsap.timeline()
  tl.to(
    [ui.title, ui.form, ui.hint],
    { autoAlpha: 0, y: -16, duration: 0.6, stagger: 0.05, ease: 'power2.in' },
    0,
  )
  tl.add(globe.dive(place), 0)
  // Start the map underneath while the globe is still diving.
  tl.add(() => {
    atlas.show(place, km)
  }, 0.6)
  // The map rises through the globe as it zooms, so the dots never thin out on screen.
  tl.set(ui.atlas, { visibility: 'visible' }, 1.5)
  tl.to(ui.atlas, { opacity: 1, duration: 1.0, ease: 'power1.inOut' }, 1.55)
  tl.add(() => {
    ui.results.hidden = false
    ui.hero.style.visibility = 'hidden'
  }, 2)
  tl.fromTo(ui.results, { xPercent: -100 }, { xPercent: 0, duration: 1.2, ease: 'expo.out' }, 2)
  tl.from('.r-head > *, .r-tools > *', { autoAlpha: 0, y: 10, stagger: 0.06, duration: 0.8 }, 2.3)
  await tl.then()
}

function leaveMap() {
  state.abort?.abort()
  closeDetail()
  state.mode = 'globe'
  document.body.classList.remove('mapped')
  const tl = gsap.timeline()
  tl.to(ui.results, { xPercent: -100, duration: 0.8, ease: 'power3.in' }, 0)
  tl.to(ui.atlas, { opacity: 0, duration: 0.8 }, 0.2)
  tl.set(ui.atlas, { visibility: 'hidden' })
  tl.add(() => {
    ui.results.hidden = true
    ui.hero.style.visibility = ''
  })
  tl.add(globe.rise(), 0.5)
  tl.to(
    [ui.title, ui.form, ui.hint],
    { autoAlpha: 1, y: 0, duration: 1, stagger: 0.08, ease: 'expo.out' },
    1,
  )
  tl.add(() => {
    ui.hint.hidden = false
    typing?.resume()
  })
}

$('.back').addEventListener('click', leaveMap)

function titleFor(intent: Intent | null, place: Place) {
  const where = shortPlace(place.name)
  if (!intent || intent.everything) return t.everyBusiness(where)
  const what = intent.categories.length
    ? intent.categories.map((c) => c.labels?.[lang] ?? c.label).join(t.and)
    : intent.types?.length
      ? intent.types.map((x) => categoryLabel(`overture:${x}`)).join(t.and)
      : `“${intent.terms}”`
  return t.whatIn(what, where)
}

/* Results list */

function visible(): Business[] {
  const items = [...state.items.values()].filter((b) => {
    if (!state.filters.size) return true
    const gaps = state.prints.get(b.id)?.gaps ?? []
    return [...state.filters].every((g) => gaps.includes(g))
  })
  const score = (b: Business) => state.prints.get(b.id)?.opportunity ?? -1
  if (state.sort === 'opportunity')
    items.sort((a, b) => score(b) - score(a) || a.distance_km - b.distance_km)
  if (state.sort === 'distance') items.sort((a, b) => a.distance_km - b.distance_km)
  if (state.sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}

function channels(b: Business, fp: Footprint | undefined): string {
  const full = state.engine?.depth === 'full'
  const known = fp && fp.website !== 'unknown'
  const s = fp?.socials ?? b.socials
  const ch = (label: string, ok: boolean | null) =>
    `<span class="ch ${ok === null ? 'unknown' : ok ? '' : 'miss'}">${label}</span>`
  return [
    ch(t.site, known ? fp.website === 'ok' : null),
    ch('Instagram', known ? !!s.instagram : null),
    ch('Facebook', known ? !!s.facebook : null),
    ch('LinkedIn', known ? !!s.linkedin : null),
    ch('TikTok', known ? !!s.tiktok : null),
    ch(t.reviews, known && full ? !fp.gaps.includes('no_reviews') : null),
  ].join('')
}

function rowFor(b: Business): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'row'
  li.dataset.id = b.id
  li.dataset.flipId = b.id
  li.tabIndex = 0
  fillRow(li, b)
  return li
}

function fillRow(li: HTMLElement, b: Business) {
  const fp = state.prints.get(b.id)
  const sub = [
    categoryLabel(b.category, lang),
    b.distance_km < 1 ? `${Math.round(b.distance_km * 1000)} m` : `${b.distance_km.toFixed(1)} km`,
  ]
  if (b.size) sub.push(t.staff(b.size))
  const score = !fp ? '·' : fp.website === 'unknown' ? '?' : String(fp.opportunity)
  const cls = !fp || fp.website === 'unknown' ? 'wait' : fp.opportunity >= HOT ? 'hot' : ''
  li.innerHTML = `
    <div class="row-name"></div>
    <div class="row-score ${cls}" title="${t.scoreTitle}">${score}</div>
    <div class="row-sub">${sub.filter(Boolean).join(' · ')}</div>
    <div class="channels">${channels(b, fp)}</div>`
  ;(li.firstElementChild as HTMLElement).textContent = b.name
  li.classList.toggle('on', state.selected === b.id)
}

function render() {
  const rows = new Map(
    [...ui.list.querySelectorAll<HTMLLIElement>('.row')].map((r) => [r.dataset.id as string, r]),
  )
  const fresh: HTMLElement[] = []
  const order = visible()
  for (const b of order) {
    let li = rows.get(b.id)
    if (!li) {
      li = rowFor(b)
      fresh.push(li)
    } else fillRow(li, b)
    ui.list.append(li)
    rows.delete(b.id)
  }
  for (const li of rows.values()) li.remove()
  if (!order.length) emptyState()
  else ui.list.querySelector('.empty')?.remove()
  gsap.from(fresh.slice(0, 24), {
    autoAlpha: 0,
    y: 14,
    duration: 0.7,
    stagger: 0.03,
    ease: 'expo.out',
  })
  count(order.length)
  atlas.setData(order, state.prints)
}

function emptyState() {
  if (ui.list.querySelector('.empty')) return
  const p = document.createElement('p')
  p.className = 'empty'
  p.textContent = state.items.size ? t.nothingMatches : t.nothingYet
  ui.list.append(p)
}

let resort: gsap.core.Tween | null = null
function update(id: string) {
  const b = state.items.get(id)
  const li = ui.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
  if (b && li) fillRow(li, b)
  if (state.selected === id) openDetail(id)
  status(t.checking(pending()))
  // Re-sort in calm batches, and never under the user's pointer.
  resort?.kill()
  resort = gsap.delayedCall(1.2, () => (ui.list.matches(':hover') ? update(id) : reflow()))
}

const pending = () => [...state.items.keys()].filter((k) => !state.prints.has(k)).length

function reflow() {
  const flip = Flip.getState(ui.list.querySelectorAll('.row'))
  render()
  Flip.from(flip, {
    duration: 0.7,
    ease: 'expo.inOut',
    absolute: false,
    nested: true,
    onEnter: (els) => gsap.fromTo(els, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 }),
    onLeave: (els) => gsap.to(els, { autoAlpha: 0, duration: 0.3 }),
  })
}

function renderFilters() {
  const full = state.engine?.depth === 'full'
  ui.filters.querySelectorAll('.toggle').forEach((t) => {
    t.remove()
  })
  for (const f of FILTERS) {
    if (f.full && !full) continue
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `toggle${state.filters.has(f.gap) ? ' on' : ''}`
    b.dataset.gap = f.gap
    b.textContent = f.brand ?? t.filters[f.gap] ?? t.gaps[f.gap]
    b.title = t.gaps[f.gap]
    ui.filters.append(b)
  }
}

ui.filters.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-gap]')
  if (!t) return
  const gap = t.dataset.gap as Gap
  if (state.filters.has(gap)) state.filters.delete(gap)
  else state.filters.add(gap)
  t.classList.toggle('on', state.filters.has(gap))
  reflow()
})

$('.sort').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]')
  if (!t) return
  state.sort = t.dataset.sort as typeof state.sort
  for (const b of $('.sort').querySelectorAll('[data-sort]')) b.classList.toggle('on', b === t)
  reflow()
})

ui.list.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('.row')?.dataset.id
  if (id) select(id)
})
ui.list.addEventListener('keydown', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('.row')?.dataset.id
  if (id && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    select(id)
  }
})
atlas.onSelect = (id) => {
  select(id)
  ui.list
    .querySelector(`[data-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

$('[data-act="csv"]').addEventListener('click', () => {
  const items = visible()
  if (!items.length) return toast(t.nothingToExport)
  const where = state.place ? shortPlace(state.place.name).split(',')[0] : 'search'
  download(`footprint-${where.toLowerCase().replace(/\W+/g, '-')}.csv`, toCsv(items, state.prints))
  toast(t.exported(items.length))
})

function finish(ms: number, sources: Record<string, string>) {
  const secs = ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))
  const used = Object.entries(sources)
    .filter(([, v]) => v === 'ok')
    .map(([k]) => t.sources[k] ?? k)
  status(state.items.size ? t.found(secs, used.join(', ')) : t.foundNone(secs))
  if (state.items.size === 0) emptyState()
  reflow()
}

function status(text: string) {
  ui.rStatus.textContent = text
}

let shown = 0
function count(n: number) {
  if (n === shown) return
  shown = n
  gsap.to(ui.rCount, {
    duration: 0.6,
    scrambleText: { text: String(n), chars: '0123456789', speed: 1 },
  })
}

/* Detail */

function select(id: string) {
  state.selected = id
  for (const r of ui.list.querySelectorAll('.row'))
    r.classList.toggle('on', (r as HTMLElement).dataset.id === id)
  atlas.select(state.items.get(id) ?? null)
  openDetail(id)
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function link(url: string, label?: string) {
  const href = /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^@/, 'instagram.com/')}`
  const text = label ?? url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`
}

function openDetail(id: string) {
  const b = state.items.get(id)
  if (!b) return
  const fp = state.prints.get(id)
  const full = state.engine?.depth === 'full'
  const site = fp?.site
  const s = fp?.socials ?? b.socials
  const d = t.d
  const rows: [string, string, boolean][] = []
  const add = (label: string, value: string, bad = false) => rows.push([label, value, bad])

  if (fp?.website === 'unknown') add(d.website, d.notKnown)
  else if (!b.website) add(d.website, d.noneListed, true)
  else if (fp?.website === 'unreachable') add(d.website, `${link(b.website)}, ${d.didntLoad}`, true)
  else add(d.website, link(site?.final_url ?? b.website))

  if (site?.reachable) {
    const secure = site.https && site.ssl_valid !== false
    add(d.https, secure ? d.yes : site.https ? d.brokenCert : d.no, !secure)
    if (site.response_ms)
      add(d.loadTime, `${(site.response_ms / 1000).toFixed(1)} s`, site.response_ms > 3000)
    add(d.phoneLayout, site.mobile ? d.yes : d.no, !site.mobile)
    add(
      d.current,
      site.outdated.length ? esc(site.outdated.join(', ')) : d.yes,
      site.outdated.length > 0,
    )
    const seo = site.seo_missing ?? []
    add(
      d.seo,
      seo.length ? seo.map((p) => d.seoParts[p as keyof typeof d.seoParts] ?? p).join(', ') : d.yes,
      seo.length > 0,
    )
    const contact = site.contact ?? []
    add(d.contact, contact.length ? contact.join(', ') : d.none, !contact.length && !b.phone)
    if (site.emails?.length)
      add(d.emails, site.emails.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', '))
    if (site.platform) add(d.platform, esc(site.platform))
    if (site.booking?.length) add(d.booking, esc(site.booking.join(', ')))
    if (site.shop) add(d.shop, d.yes)
    add(
      d.analytics,
      site.tracking.length ? site.tracking.map((x) => x.replace(/_/g, ' ')).join(', ') : d.none,
      !site.tracking.length,
    )
  }
  if (fp?.website !== 'unknown') {
    for (const [net, label] of [
      ['instagram', 'Instagram'],
      ['facebook', 'Facebook'],
      ['linkedin', 'LinkedIn'],
      ['tiktok', 'TikTok'],
    ]) {
      const handle = s[net]
      const shown =
        net === 'instagram' && handle && !handle.includes('/')
          ? `@${handle.replace(/^@/, '')}`
          : undefined
      add(label, handle ? link(handle, shown) : d.notFound, !handle)
    }
    const reviews = Object.entries(fp?.reviews ?? {})
    if (full)
      add(
        t.reviews,
        reviews.length ? reviews.map(([k, v]) => link(v, k)).join(', ') : d.noneFound,
        !reviews.length,
      )
    if (fp?.google_rating && fp.google_reviews)
      add('Google', d.google(fp.google_rating, fp.google_reviews))
  }
  if (b.size) add(t.staff('').trim(), b.size)
  if (b.founded)
    add(d.founded, new Date(b.founded).toLocaleDateString(lang, { month: 'long', year: 'numeric' }))
  if (b.phone) add(d.phone, `<a href="tel:${esc(b.phone.replace(/\s/g, ''))}">${esc(b.phone)}</a>`)

  const area = state.place ? shortPlace(state.place.name).split(',')[0] : ''
  const score = !fp || fp.website === 'unknown' ? '—' : String(fp.opportunity)
  const osm = b.id.startsWith('osm:')
    ? `https://www.openstreetmap.org/${b.id.slice(4)}`
    : `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lon}#map=18/${b.lat}/${b.lon}`
  const sources = b.sources.map((x) => t.sources[x] ?? x).join(' + ')
  const wasOpen = !ui.detail.hidden
  ui.detail.innerHTML = `
    <div class="d-kind">${esc(categoryLabel(b.category, lang) || d.business)} · ${esc(sources)}</div>
    <h3 class="d-name">${esc(b.name)}</h3>
    <p class="d-where">${esc(b.address ?? '')}${b.address ? '<br>' : ''}${d.fromCentre(b.distance_km.toFixed(1))}</p>
    <div class="d-score"><b class="${fp && fp.opportunity >= HOT ? 'hot' : ''}">${score}</b><span>${fp?.website === 'unknown' ? d.byHand : d.outOf}</span></div>
    <ul class="checks">${rows.map(([l, v, bad]) => `<li class="${bad ? 'bad' : ''}"><span>${l}</span><span>${v}</span></li>`).join('')}</ul>
    <p class="d-label">${d.firstMessage}</p>
    <pre class="msg" contenteditable="true" spellcheck="false">${esc(message(b, fp, area, t, lang))}</pre>
    <div class="d-acts">
      <button class="act" type="button" data-act="copy">${d.copy}</button>
      <a class="act" href="${esc(osm)}" target="_blank" rel="noopener noreferrer">${d.openMap}</a>
      <button class="act quiet" type="button" data-act="close">${d.close}</button>
    </div>`
  ui.detail.querySelector('.d-score b.hot')?.setAttribute('style', 'color: var(--red)')
  if (!wasOpen) {
    ui.detail.hidden = false
    const wide = innerWidth > 900
    gsap.fromTo(ui.detail, wide ? { xPercent: 100 } : { yPercent: 100 }, {
      xPercent: 0,
      yPercent: 0,
      duration: 0.9,
      ease: 'expo.out',
    })
    gsap.from(ui.detail.children, {
      autoAlpha: 0,
      y: 12,
      duration: 0.7,
      stagger: 0.04,
      delay: 0.15,
    })
  }
}

function closeDetail() {
  if (ui.detail.hidden) return
  state.selected = null
  atlas.select(null)
  for (const r of ui.list.querySelectorAll('.row.on')) r.classList.remove('on')
  const wide = innerWidth > 900
  gsap.to(ui.detail, {
    ...(wide ? { xPercent: 100 } : { yPercent: 100 }),
    duration: 0.6,
    ease: 'power3.in',
    onComplete: () => {
      ui.detail.hidden = true
    },
  })
}

ui.detail.addEventListener('click', async (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
  if (act === 'close') closeDetail()
  if (act === 'copy') {
    const text = ui.detail.querySelector('.msg')?.textContent ?? ''
    await navigator.clipboard.writeText(text).then(
      () => toast(t.copied),
      () => toast(t.clipboard),
    )
  }
})

/* Sheets, toast, keys */

for (const b of document.querySelectorAll<HTMLElement>('[data-sheet]')) {
  if (b.tagName !== 'BUTTON') continue
  b.addEventListener('click', () => {
    for (const a of ui.sheet.querySelectorAll<HTMLElement>('article'))
      a.hidden = a.dataset.sheet !== b.dataset.sheet
    ui.sheet.hidden = false
    gsap.fromTo(ui.sheet, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 })
    gsap.from(ui.sheet.querySelectorAll('article:not([hidden]) > *'), {
      autoAlpha: 0,
      y: 18,
      stagger: 0.07,
      duration: 0.9,
      ease: 'expo.out',
    })
  })
}
function closeSheet() {
  gsap.to(ui.sheet, {
    autoAlpha: 0,
    duration: 0.4,
    onComplete: () => {
      ui.sheet.hidden = true
    },
  })
}
$('.close').addEventListener('click', closeSheet)

let toastTimer: gsap.core.Tween | null = null
function toast(text: string) {
  ui.toast.textContent = text
  ui.toast.hidden = false
  gsap.fromTo(ui.toast, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.5 })
  toastTimer?.kill()
  toastTimer = gsap.delayedCall(4.5, () =>
    gsap.to(ui.toast, {
      autoAlpha: 0,
      duration: 0.5,
      onComplete: () => {
        ui.toast.hidden = true
      },
    }),
  )
}

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!langList.hidden) langList.hidden = true
  else if (!ui.sheet.hidden) closeSheet()
  else if (!ui.detail.hidden) closeDetail()
  else if (state.pick) dropPin()
})

/* Language */

const langNow = $<HTMLButtonElement>('.lang-now')
const langList = $('.langs')

function get(path: string): string {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], t) as string
}

function applyLang() {
  document.documentElement.lang = lang
  // Arabic reads right to left.
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
  for (const el of document.querySelectorAll<HTMLElement>('[data-t]')) {
    el.textContent = get(el.dataset.t as string)
  }
  split?.revert()
  ui.title.innerHTML = `${t.hero[0]}<br />${t.hero[1]}`
  if (split) {
    split = SplitText.create(ui.title, { type: 'lines', mask: 'lines', linesClass: 'line-mask' })
  }
  for (const [name, [title, paragraphs]] of [
    ['how', t.how],
    ['sources', t.about],
  ] as const) {
    $(`article[data-sheet="${name}"]`, ui.sheet).innerHTML =
      `<h2>${title}</h2>${paragraphs.map((p) => `<p>${p}</p>`).join('')}`
  }
  langNow.textContent = lang.toUpperCase()
  langList.innerHTML = LANGS.map(
    (l) =>
      `<li><button type="button" data-lang="${l}" lang="${l}" aria-current="${l === lang}">${STRINGS[l].native}</button></li>`,
  ).join('')
  ui.input.setAttribute('aria-label', t.hint)
  if (state.pick) ui.ghost.textContent = t.pickGhost
  else if (typing) typeExamples()
  if (state.mode === 'map' && state.place) {
    ui.rTitle.textContent = titleFor(state.intent, state.place)
    ui.depth.textContent = state.engine?.depth === 'full' ? t.depthFull : t.depthMap
    renderFilters()
    render()
    if (state.selected) openDetail(state.selected)
  }
}

langNow.addEventListener('click', () => {
  const open = langList.hidden
  langList.hidden = !open
  langNow.setAttribute('aria-expanded', String(open))
  if (open) gsap.from(langList.children, { autoAlpha: 0, y: -4, stagger: 0.025, duration: 0.4 })
})
langList.addEventListener('click', (e) => {
  const picked = (e.target as HTMLElement).closest<HTMLElement>('[data-lang]')?.dataset.lang
  if (!picked) return
  lang = picked as Lang
  t = STRINGS[lang]
  localStorage.setItem('footprint.lang', lang)
  langList.hidden = true
  langNow.setAttribute('aria-expanded', 'false')
  applyLang()
})

/* Boot */

async function boot() {
  const [engine] = await Promise.all([
    pickEngine(),
    globe.load(`${import.meta.env.BASE_URL}land.bin`),
  ])
  state.engine = engine
  applyLang()
  placeKnob(state.km)
  intro()
}

boot()
