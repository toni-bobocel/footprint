import catalog from '../../../shared/categories.json'
import lexiconFile from '../../../shared/lexicon.json'
import taxonomyFile from '../../../shared/taxonomy.json'
import type { Gap } from './types'

// Port of api/src/footprint/query.py for the browser-only engine. Both run
// the cases in shared/query-cases.json, so they can't drift apart quietly.

export interface Category {
  id: string
  label: string
  labels: Record<string, string>
  words: Record<string, string[]>
  osm: [string, string][]
  overture: string[]
  naf: string[]
}

export const CATEGORIES = catalog.categories as unknown as Category[]

export interface ParsedQuery {
  text: string
  categories: string[]
  types: string[]
  terms: string | null
  place: string | null
  lat: number | null
  lon: number | null
  radius_km: number | null
  gaps: Gap[]
  recent: boolean
  size: 'small' | 'large' | null
}

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff'
const CJK_RE = new RegExp(`[${CJK}]`, 'u')
const ARTICLES = new Set([
  'a',
  'an',
  'un',
  'une',
  'de',
  "d'",
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'einen',
  'el',
  'la',
  'um',
  'uma',
  'il',
  'lo',
  'una',
  'des',
  'du',
])
const COORDS = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/

export function fold(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFKC')
}

function foldMapped(text: string): [string, number[]] {
  let out = ''
  const origin: number[] = []
  let i = 0
  for (const ch of text) {
    const f = fold(ch)
    out += f
    for (let k = 0; k < f.length; k++) origin.push(i)
    i += ch.length
  }
  origin.push(text.length)
  return [out, origin]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const key = (p: string[]) => p.join('\u0001')

interface Lexicon {
  near: Set<string>
  filler: Set<string>
  negations: Set<string>
  negationsAfter: Set<string>
  channels: Map<string, Gap>
  phrases: Map<string, Gap>
  recent: Set<string>
  small: Set<string>
  large: Set<string>
  km: RegExp
  categories: Map<string, string>
  stems: Map<string, string>
  taxonomy: Map<string, string>
  token: RegExp
  known: Set<string>
  longest: number
}

function tokens(text: string, pattern: RegExp, known: Set<string>): [string[], [number, number][]] {
  const words: string[] = []
  const spans: [number, number][] = []
  const lone: boolean[] = []
  for (const m of text.matchAll(pattern)) {
    const w = m[0]
    const a = m.index ?? 0
    const b = a + w.length
    // Unknown CJK runs (上海, 東京) come out one character at a time.
    const single = w.length === 1 && !known.has(w) && CJK_RE.test(w)
    const last = spans.length - 1
    if (single && last >= 0 && spans[last][1] === a && lone[last]) {
      words[last] += w
      spans[last] = [spans[last][0], b]
    } else {
      words.push(w)
      spans.push([a, b])
      lone.push(single)
    }
  }
  return [words, spans]
}

let cached: Lexicon | null = null
function lexicon(): Lexicon {
  if (cached) return cached
  const raw = lexiconFile as unknown as Record<string, unknown> & {
    channels: Record<string, string[]>
    phrases: Record<string, string[]>
    km: string[]
  }
  const lists = Object.values(raw).filter(Array.isArray).flat() as string[]
  const all = [
    ...lists,
    ...Object.values(raw.channels).flat(),
    ...Object.values(raw.phrases).flat(),
    ...CATEGORIES.flatMap((c) => Object.values(c.words).flat()),
  ]
  const cjkWords = [...new Set(all.filter((w) => CJK_RE.test(w)).map(fold))].sort(
    (a, b) => b.length - a.length,
  )
  // Known CJK words first, longest first; other CJK characters one at a
  // time (merged back later); then ordinary words.
  const token = new RegExp(
    [...cjkWords.map(escapeRe), `[${CJK}]`, `[^\\s,.;:!?()"${CJK}]+`].join('|'),
    'gu',
  )
  const known = new Set(cjkWords)
  const tok = (w: string) => tokens(fold(w), token, known)[0]
  const set = (words: string[]) => new Set(words.map((w) => key(tok(w))))
  const map = <T>(groups: Record<string, string[]>) => {
    const m = new Map<string, T>()
    for (const [name, words] of Object.entries(groups))
      for (const w of words) m.set(key(tok(w)), name as T)
    return m
  }

  const categories = new Map<string, string>()
  let longest = 1
  for (const c of CATEGORIES) {
    for (const w of Object.values(c.words).flat()) {
      const p = tok(w)
      if (!categories.has(key(p))) categories.set(key(p), c.id)
      longest = Math.max(longest, p.length)
    }
  }
  // Plural and case endings ("boulangeries", "пекарню"): single long words
  // also match on their stem.
  const stems = new Map<string, string>()
  for (const [k, id] of categories) {
    if (k.includes('\u0001') || k.length < 5 || CJK_RE.test(k)) continue
    const stem = k.length < 7 ? k.slice(0, -1) : k.slice(0, -2)
    if (!stems.has(stem)) stems.set(stem, id)
  }
  const taxonomy = new Map<string, string>()
  for (const t of taxonomyFile.types) {
    const words = t.replace(/_/g, ' ')
    for (const form of [words, `${words}s`, `${words}es`, words.replace(/y$/, 'ies')]) {
      const p = form.split(' ')
      if (!taxonomy.has(key(p))) taxonomy.set(key(p), t)
      longest = Math.max(longest, p.length)
    }
  }
  const lists2 = raw as unknown as Record<string, string[]>
  cached = {
    near: set(lists2.near),
    filler: set(lists2.filler),
    negations: set(lists2.negations),
    negationsAfter: set(lists2.negations_after),
    channels: map<Gap>(raw.channels),
    phrases: map<Gap>(raw.phrases),
    recent: set(lists2.recent),
    small: set(lists2.small),
    large: set(lists2.large),
    km: new RegExp(
      `(\\d{1,3})\\s*(?:${raw.km.map((k) => escapeRe(fold(k))).join('|')})(?![\\p{L}\\p{N}_])`,
      'u',
    ),
    categories,
    stems,
    taxonomy,
    token,
    known,
    longest,
  }
  return cached
}

type Table = Set<string> | Map<string, string>

class Reader {
  lex = lexicon()
  intent: ParsedQuery
  words: string[]
  spans: [number, number][]
  kinds: string[]
  origin: number[]

  constructor(readonly text: string) {
    this.intent = {
      text,
      categories: [],
      types: [],
      terms: null,
      place: null,
      lat: null,
      lon: null,
      radius_km: null,
      gaps: [],
      recent: false,
      size: null,
    }
    let [folded, origin] = foldMapped(text)
    this.origin = origin
    const blank = (m: RegExpExecArray) =>
      folded.slice(0, m.index) + ' '.repeat(m[0].length) + folded.slice(m.index + m[0].length)
    let m = this.lex.km.exec(folded)
    if (m) {
      this.intent.radius_km = Number(m[1])
      folded = blank(m)
    }
    m = COORDS.exec(folded)
    if (m) {
      this.intent.lat = Number(m[1])
      this.intent.lon = Number(m[2])
      folded = blank(m)
    }
    ;[this.words, this.spans] = tokens(folded, this.lex.token, this.lex.known)
    this.kinds = this.words.map(() => 'plain')
  }

  at(i: number, table: Table, words: string[]): number {
    for (let n = Math.min(this.lex.longest, words.length - i); n > 0; n--) {
      if (table.has(key(words.slice(i, i + n)))) return n
    }
    return 0
  }

  get(table: Map<string, string>, words: string[], i: number, n: number): string {
    return table.get(key(words.slice(i, i + n))) as string
  }

  original(idx: number[]): string {
    const a = this.spans[idx[0]][0]
    const b = this.spans[idx[idx.length - 1]][1]
    return this.text.slice(this.origin[a], this.origin[b]).replace(/^[\s,.]+|[\s,.]+$/g, '')
  }

  setKind(from: number, to: number, kind: string) {
    for (let k = from; k < to; k++) this.kinds[k] = kind
  }

  subject(id: string, i: number, n: number) {
    if (!this.intent.categories.includes(id)) this.intent.categories.push(id)
    this.setKind(i, i + n, 'subject')
  }

  stem(word: string): string | null {
    if (word.length < 5) return null
    for (const cut of [2, 1]) {
      const id = this.lex.stems.get(word.slice(0, word.length - cut))
      if (id) return id
    }
    for (const [stem, id] of this.lex.stems) {
      if (word.startsWith(stem) && word.length <= stem.length + 5) return id
    }
    return null
  }

  mark() {
    const { lex, words: w, intent: it } = this
    let i = 0
    while (i < w.length) {
      let n = this.at(i, lex.phrases, w)
      if (n) {
        it.gaps.push(this.get(lex.phrases, w, i, n) as Gap)
        this.setKind(i, i + n, 'gap')
        i += n
        continue
      }
      n = this.at(i, lex.negations, w)
      if (n) {
        let j = i + n
        while (j < w.length && ARTICLES.has(w[j])) j++
        const c = this.at(j, lex.channels, w)
        if (c) {
          it.gaps.push(this.get(lex.channels, w, j, c) as Gap)
          this.setKind(i, j + c, 'gap')
          i = j + c
          continue
        }
      }
      const c = this.at(i, lex.channels, w)
      const a = c ? this.at(i + c, lex.negationsAfter, w) : 0
      if (c && a) {
        it.gaps.push(this.get(lex.channels, w, i, c) as Gap)
        this.setKind(i, i + c + a, 'gap')
        i += c + a
        continue
      }
      n = this.at(i, lex.categories, w)
      if (n) {
        this.subject(this.get(lex.categories, w, i, n), i, n)
        i += n
        continue
      }
      const id = this.stem(w[i])
      if (id) {
        this.subject(id, i, 1)
        i += 1
        continue
      }
      i += 1
    }
    if (it.categories.length) return
    i = 0
    while (i < w.length) {
      const n = this.kinds[i] === 'plain' ? this.at(i, lex.taxonomy, w) : 0
      if (n) {
        const t = this.get(lex.taxonomy, w, i, n)
        if (!it.types.includes(t)) it.types.push(t)
        this.setKind(i, i + n, 'subject')
        i += n
      } else i += 1
    }
  }

  modifier(idx: number[], k: number, record = true): number {
    const words = idx.map((i) => this.words[i])
    const { lex, intent: it } = this
    let n = this.at(k, lex.recent, words)
    if (n) {
      if (record) it.recent = true
      return n
    }
    n = this.at(k, lex.small, words)
    if (n) {
      if (record) it.size = 'small'
      return n
    }
    n = this.at(k, lex.large, words)
    if (n && record) it.size = 'large'
    return n
  }

  glue(idx: number[], k: number): number {
    const words = idx.map((i) => this.words[i])
    return this.at(k, this.lex.near, words) || this.at(k, this.lex.filler, words)
  }

  near(idx: number[], k: number): number {
    return this.at(
      k,
      this.lex.near,
      idx.map((i) => this.words[i]),
    )
  }

  // Drop prepositions and filler at both ends; keep them inside a name
  // ("Trinidad and Tobago", "Rio de Janeiro").
  trim(idx: number[]): number[] {
    let out = idx
    for (let n = this.glue(out, 0); out.length && n; n = this.glue(out, 0)) out = out.slice(n)
    trailing: while (out.length) {
      for (let n = Math.min(3, out.length); n > 0; n--) {
        if (this.glue(out.slice(-n), 0) === n) {
          out = out.slice(0, -n)
          continue trailing
        }
      }
      break
    }
    return out
  }

  onlyModifiers(idx: number[]): boolean {
    let k = 0
    while (k < idx.length) {
      const n = this.modifier(idx, k, false) || this.glue(idx, k)
      if (!n) return false
      k += n
    }
    return true
  }

  place() {
    const it = this.intent
    const plain = this.kinds.flatMap((k, i) => (k === 'plain' ? [i] : []))
    const subject = this.kinds.flatMap((k, i) => (k === 'subject' ? [i] : []))
    if (subject.length) {
      const first = subject[0]
      const last = subject[subject.length - 1]
      const before = plain.filter((i) => i < first)
      const between = plain.filter((i) => i > first && i < last)
      const after = plain.filter((i) => i > last)
      for (let k = 0; k < between.length; ) k += this.modifier(between, k) || 1
      // After the subject: modifiers ("boulangeries récentes"), then where.
      // Once past a preposition, "new" belongs to "New York".
      let k = 0
      while (k < after.length) {
        let n = this.modifier(after, k)
        if (n) {
          k += n
          continue
        }
        n = this.near(after, k)
        if (n) {
          k += n
          break
        }
        n = this.glue(after, k)
        if (!n) break
        k += n
      }
      const where = this.trim(after.slice(k))
      // Before the subject counts as modifiers only when nothing else is
      // there: "new bakeries" is recent, "New York bakeries" a place.
      let pre = this.trim(before)
      if (pre.length && this.onlyModifiers(pre)) {
        for (let j = 0; j < pre.length; ) j += this.modifier(pre, j) || this.glue(pre, j) || 1
        pre = []
      }
      if (where.length) it.place = this.original(where)
      else if (pre.length) it.place = this.original(pre)
      return
    }

    // No subject: "Tesla in Austin" splits on the first preposition after a word.
    for (let k = 1; k < plain.length; k++) {
      const n = this.near(plain, k)
      if (!n) continue
      const terms = this.trim(plain.slice(0, k))
      const where = this.trim(plain.slice(k + n))
      if (terms.length && where.length) {
        it.terms = this.original(terms)
        it.place = this.original(where)
        return
      }
    }
    let rest = plain
    for (let n = this.modifier(rest, 0); rest.length && n; n = this.modifier(rest, 0)) {
      rest = rest.slice(n)
    }
    const words = this.trim(rest)
    if (words.length) it.terms = this.original(words)
  }
}

export function parse(text: string): ParsedQuery {
  const reader = new Reader(text)
  reader.mark()
  reader.place()
  return reader.intent
}
