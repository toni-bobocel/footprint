import json
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

from .catalog import categories
from .models import Gap

# Deterministic on purpose: the same sentence always means the same search,
# and anyone can read this file and shared/lexicon.json to see why. The web
# client runs a port of it (web/src/engine/query.ts); both are tested against
# shared/query-cases.json.

SHARED = Path(__file__).resolve().parents[3] / 'shared'
CJK = '぀-ヿ㐀-鿿豈-﫿'
ARTICLES = {'a', 'an', 'un', 'une', 'de', "d'", 'der', 'die', 'das', 'ein', 'eine', 'einen',
            'el', 'la', 'um', 'uma', 'il', 'lo', 'una', 'des', 'du'}  # fmt: skip
COORDS = re.compile(r'(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)')

Phrase = tuple[str, ...]


def fold(text: str) -> str:
    """Lower case, Latin accents dropped. Only U+0300-036F marks go, so
    Japanese dakuten survive."""
    text = unicodedata.normalize('NFKD', text.lower())
    return unicodedata.normalize('NFKC', re.sub(r'[̀-ͯ]', '', text))


def fold_mapped(text: str) -> tuple[str, list[int]]:
    """fold(), plus the index in text that each output character came from."""
    out: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        f = fold(ch)
        out.append(f)
        origin.extend([i] * len(f))
    origin.append(len(text))
    return ''.join(out), origin


@dataclass(frozen=True)
class Lexicon:
    near: frozenset[Phrase]
    filler: frozenset[Phrase]
    negations: frozenset[Phrase]
    negations_after: frozenset[Phrase]
    channels: dict[Phrase, Gap]
    phrases: dict[Phrase, Gap]
    recent: frozenset[Phrase]
    small: frozenset[Phrase]
    large: frozenset[Phrase]
    km: re.Pattern[str]
    categories: dict[Phrase, str]
    stems: dict[str, str]
    taxonomy: dict[Phrase, str]
    token: re.Pattern[str]
    cjk_known: frozenset[str]
    longest: int


@cache
def lexicon() -> Lexicon:
    raw = json.loads((SHARED / 'lexicon.json').read_text(encoding='utf-8'))
    tax = json.loads((SHARED / 'taxonomy.json').read_text(encoding='utf-8'))['types']
    lists = [w for v in raw.values() if isinstance(v, list) for w in v]
    lists += [w for d in (raw['channels'], raw['phrases']) for ws in d.values() for w in ws]
    lists += [w for c in categories() for w in c.words]
    cjk_words = sorted({fold(w) for w in lists if re.search(f'[{CJK}]', w)}, key=len, reverse=True)
    # Known CJK words first, longest first, so 面包店 is never cut into 面包 + 店;
    # other CJK characters one at a time (merged back later); then plain words.
    token = re.compile(
        '|'.join([*map(re.escape, cjk_words), f'[{CJK}]', rf'[^\s,.;:!?()\"{CJK}]+'])
    )

    known = frozenset(cjk_words)

    def phrases(words: list[str]) -> frozenset[Phrase]:
        return frozenset(tuple(tokens(fold(w), token, known)[0]) for w in words)

    cats: dict[Phrase, str] = {}
    for c in categories():
        for w in c.words:
            cats.setdefault(tuple(tokens(fold(w), token, known)[0]), c.id)
    # Plural and case endings ("boulangeries", "пекарню", "bäckereien"):
    # single long words also match on their stem.
    stems: dict[str, str] = {}
    for p, cid in cats.items():
        if len(p) == 1 and len(p[0]) >= 5 and not re.search(f'[{CJK}]', p[0]):
            stems.setdefault(p[0][:-1] if len(p[0]) < 7 else p[0][:-2], cid)
    taxonomy: dict[Phrase, str] = {}
    for t in tax:
        words = t.replace('_', ' ')
        for form in (words, f'{words}s', f'{words}es', re.sub(r'y$', 'ies', words)):
            taxonomy.setdefault(tuple(form.split()), t)

    return Lexicon(
        near=phrases(raw['near']),
        filler=phrases(raw['filler']),
        negations=phrases(raw['negations']),
        negations_after=phrases(raw['negations_after']),
        channels={p: gap for gap, ws in raw['channels'].items() for p in phrases(ws)},
        phrases={p: gap for gap, ws in raw['phrases'].items() for p in phrases(ws)},
        recent=phrases(raw['recent']),
        small=phrases(raw['small']),
        large=phrases(raw['large']),
        km=re.compile(
            rf'(\d{{1,3}})\s*(?:{"|".join(re.escape(fold(k)) for k in raw["km"])})(?![^\W\d_])'
        ),
        categories=cats,
        stems=stems,
        taxonomy=taxonomy,
        token=token,
        cjk_known=known,
        longest=max(len(p) for p in [*cats, *taxonomy]),
    )


def tokens(
    text: str, pattern: re.Pattern[str], known: frozenset[str]
) -> tuple[list[str], list[tuple[int, int]]]:
    words: list[str] = []
    spans: list[tuple[int, int]] = []
    for m in pattern.finditer(text):
        w, (a, b) = m.group(0), m.span()
        # Unknown CJK runs (上海, 東京) come out one character at a time.
        lone = len(w) == 1 and w not in known and re.match(f'[{CJK}]', w)
        if lone and spans and spans[-1][1] == a and words[-1].startswith('\0'):
            words[-1] += w
            spans[-1] = (spans[-1][0], b)
        else:
            words.append(f'\0{w}' if lone else w)
            spans.append((a, b))
    return [w.lstrip('\0') for w in words], spans


@dataclass
class Intent:
    text: str
    categories: list[str] = field(default_factory=list)
    # Overture place types named directly ("cheese shop") when no category fits.
    types: list[str] = field(default_factory=list)
    # Words left over when nothing matched: searched as business names.
    terms: str | None = None
    place: str | None = None
    lat: float | None = None
    lon: float | None = None
    radius_km: float | None = None
    gaps: list[Gap] = field(default_factory=list)
    recent: bool = False
    size: str | None = None


class _Reader:
    def __init__(self, text: str) -> None:
        self.lex = lexicon()
        self.text = text
        folded, self.origin = fold_mapped(text)
        self.folded = folded
        lex = self.lex
        self.intent = Intent(text=text)
        if m := lex.km.search(folded):
            self.intent.radius_km = float(m.group(1))
            folded = folded[: m.start()] + ' ' * len(m.group(0)) + folded[m.end() :]
        if m := COORDS.search(folded):
            self.intent.lat, self.intent.lon = float(m.group(1)), float(m.group(2))
            folded = folded[: m.start()] + ' ' * len(m.group(0)) + folded[m.end() :]
        self.words, self.spans = tokens(folded, lex.token, lex.cjk_known)
        self.kinds = ['plain'] * len(self.words)

    def at(self, i: int, table: frozenset[Phrase] | Mapping[Phrase, str], words: list[str]) -> int:
        """Length of the longest phrase from table starting at words[i], or 0."""
        for n in range(min(self.lex.longest, len(words) - i), 0, -1):
            if tuple(words[i : i + n]) in table:
                return n
        return 0

    def original(self, idx: list[int]) -> str:
        a, b = self.spans[idx[0]][0], self.spans[idx[-1]][1]
        return self.text[self.origin[a] : self.origin[b]].strip(' ,.')

    def mark(self) -> None:
        lex, w, it = self.lex, self.words, self.intent
        i = 0
        while i < len(w):
            if n := self.at(i, lex.phrases, w):
                it.gaps.append(lex.phrases[tuple(w[i : i + n])])
                self.kinds[i : i + n] = ['gap'] * n
                i += n
                continue
            if n := self.at(i, lex.negations, w):
                j = i + n
                while j < len(w) and w[j] in ARTICLES:
                    j += 1
                if c := self.at(j, lex.channels, w):
                    it.gaps.append(lex.channels[tuple(w[j : j + c])])
                    self.kinds[i : j + c] = ['gap'] * (j + c - i)
                    i = j + c
                    continue
            c = self.at(i, lex.channels, w)
            if c and (a := self.at(i + c, lex.negations_after, w)):
                it.gaps.append(lex.channels[tuple(w[i : i + c])])
                self.kinds[i : i + c + a] = ['gap'] * (c + a)
                i += c + a
                continue
            if n := self.at(i, lex.categories, w):
                self.subject(lex.categories[tuple(w[i : i + n])], i, n)
                i += n
                continue
            if cid := self.stem(w[i]):
                self.subject(cid, i, 1)
                i += 1
                continue
            i += 1
        if not it.categories:
            i = 0
            while i < len(w):
                if self.kinds[i] == 'plain' and (n := self.at(i, lex.taxonomy, w)):
                    t = lex.taxonomy[tuple(w[i : i + n])]
                    if t not in it.types:
                        it.types.append(t)
                    self.kinds[i : i + n] = ['subject'] * n
                    i += n
                else:
                    i += 1

    def subject(self, cid: str, i: int, n: int) -> None:
        if cid not in self.intent.categories:
            self.intent.categories.append(cid)
        self.kinds[i : i + n] = ['subject'] * n

    def stem(self, word: str) -> str | None:
        if len(word) < 5:
            return None
        for cut in (2, 1):
            if (cid := self.lex.stems.get(word[: len(word) - cut])) is not None:
                return cid
        for stem, cid in self.lex.stems.items():
            if word.startswith(stem) and len(word) <= len(stem) + 5:
                return cid
        return None

    def modifier(self, idx: list[int], k: int, record: bool = True) -> int:
        words = [self.words[i] for i in idx]
        lex, it = self.lex, self.intent
        if n := self.at(k, lex.recent, words):
            it.recent = it.recent or record
        elif n := self.at(k, lex.small, words):
            it.size = 'small' if record else it.size
        elif n := self.at(k, lex.large, words):
            it.size = 'large' if record else it.size
        return n

    def glue(self, idx: list[int], k: int) -> int:
        words = [self.words[i] for i in idx]
        return self.at(k, self.lex.near, words) or self.at(k, self.lex.filler, words)

    def near(self, idx: list[int], k: int) -> int:
        return self.at(k, self.lex.near, [self.words[i] for i in idx])

    def trim(self, idx: list[int]) -> list[int]:
        """Drop prepositions and filler at both ends; keep them inside a
        name ("Trinidad and Tobago", "Rio de Janeiro")."""
        while idx and (n := self.glue(idx, 0)):
            idx = idx[n:]
        while idx:
            for n in range(min(3, len(idx)), 0, -1):
                if self.glue(idx[-n:], 0) == n:
                    idx = idx[:-n]
                    break
            else:
                break
        return idx

    def place(self) -> None:
        it = self.intent
        plain = [i for i, k in enumerate(self.kinds) if k == 'plain']
        subject = [i for i, k in enumerate(self.kinds) if k == 'subject']
        if subject:
            first, last = subject[0], subject[-1]
            before = [i for i in plain if i < first]
            between = [i for i in plain if first < i < last]
            after = [i for i in plain if i > last]
            k = 0
            while k < len(between):
                k += self.modifier(between, k) or 1
            # After the subject: modifiers ("boulangeries récentes"), then
            # where. Once past a preposition, "new" belongs to "New York".
            k = 0
            while k < len(after):
                if n := self.modifier(after, k):
                    k += n
                elif n := self.near(after, k):
                    k += n
                    break
                elif n := self.glue(after, k):
                    k += n
                else:
                    break
            where = self.trim(after[k:])
            # Before the subject counts as modifiers only when nothing else
            # is there: "new bakeries" is recent, "New York bakeries" a place.
            pre = self.trim(before)
            if pre and self.only_modifiers(pre):
                k = 0
                while k < len(pre):
                    k += self.modifier(pre, k) or self.glue(pre, k) or 1
                pre = []
            if where:
                it.place = self.original(where)
            elif pre:
                it.place = self.original(pre)
            return

        # No subject: "Tesla in Austin" splits on the first preposition after a word.
        for k in range(1, len(plain)):
            if n := self.near(plain, k):
                terms, where = self.trim(plain[:k]), self.trim(plain[k + n :])
                if terms and where:
                    it.terms, it.place = self.original(terms), self.original(where)
                    return
        while plain and (n := self.modifier(plain, 0)):
            plain = plain[n:]
        if words := self.trim(plain):
            it.terms = self.original(words)

    def only_modifiers(self, idx: list[int]) -> bool:
        k = 0
        while k < len(idx):
            n = self.modifier(idx, k, record=False) or self.glue(idx, k)
            if not n:
                return False
            k += n
        return True


def parse(text: str) -> Intent:
    reader = _Reader(text)
    reader.mark()
    reader.place()
    return reader.intent
