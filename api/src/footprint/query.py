import re
from dataclasses import dataclass, field

from .catalog import categories
from .models import Gap

# Deterministic on purpose: the same sentence always means the same search,
# and anyone can read this file to see why a query matched what it matched.

FILTERS: list[tuple[str, Gap]] = [
    (r'(?:without|no|lacking)\s+(?:a\s+)?(?:website|web\s*site|site)', 'no_website'),
    (r'(?:without|no|not\s+on)\s+instagram', 'no_instagram'),
    (r'(?:without|no|not\s+on)\s+facebook', 'no_facebook'),
    (r'(?:without|no|not\s+on)\s+linkedin', 'no_linkedin'),
    (r'(?:without|no|not\s+on)\s+tiktok', 'no_tiktok'),
    (r'(?:without|no)\s+(?:google\s+)?reviews?', 'no_reviews'),
    (r'(?:not\s+secure|insecure|without\s+https|no\s+https)', 'not_secure'),
    (r'(?:not\s+mobile(?:[\s-]friendly)?|no\s+mobile\s+site)', 'not_mobile'),
    (r'(?:slow\s+(?:web)?sites?)', 'slow'),
    (r'(?:outdated|old)\s+(?:web)?sites?', 'outdated'),
    (r'(?:no|without)\s+(?:ads|advertising|tracking|pixel)', 'no_tracking'),
]

RECENT = (
    r'\b(?:new|newly\s+(?:created|opened)|recently\s+(?:created|opened)'
    r'|just\s+opened|(?:opened|created)\s+this\s+year)\b'
)
SMALL = r'\b(?:small|tiny|solo|independent|one[-\s]person)\b'
LARGE = r'\b(?:large|big|major|corporate)\b'
PLACE = re.compile(r'\b(?:in|near|around|close\s+to|within\s+\d+\s*km\s+of)\s+(.+)$')
COORDS = re.compile(r'(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)')
RADIUS = re.compile(r'\b(?:within\s+)?(\d{1,3})\s*km\b')


@dataclass
class Intent:
    text: str
    categories: list[str] = field(default_factory=list)
    # Words left over when no category matched: searched as business names.
    terms: str | None = None
    place: str | None = None
    lat: float | None = None
    lon: float | None = None
    radius_km: float | None = None
    gaps: list[Gap] = field(default_factory=list)
    recent: bool = False
    size: str | None = None


def parse(text: str) -> Intent:
    q = ' '.join(text.lower().split())
    intent = Intent(text=text)

    for pattern, gap in FILTERS:
        if re.search(pattern, q):
            intent.gaps.append(gap)
            q = re.sub(pattern, ' ', q)
    if m := RADIUS.search(q):
        intent.radius_km = float(m.group(1))
        q = q[: m.start()] + q[m.end() :]
    if m := COORDS.search(q):
        intent.lat, intent.lon = float(m.group(1)), float(m.group(2))
        q = q[: m.start()] + q[m.end() :]

    # The place is cut off before anything else touches the text, so names
    # like "New York" or "Trinidad and Tobago" arrive whole.
    if m := PLACE.search(q):
        tail = r'(?:\s*\b(?:with|and|that|which|have|has|who)\b)+[\s,.]*$'
        place = re.sub(tail, '', m.group(1)).strip(' ,.')
        if place:
            intent.place = place
        q = q[: m.start()]
    q = re.sub(r'\b(?:in|near|around|at|within|of)\s*$', '', q.strip())

    if re.search(RECENT, q):
        intent.recent = True
        q = re.sub(RECENT, ' ', q)
    if re.search(SMALL, q):
        intent.size = 'small'
        q = re.sub(SMALL, ' ', q)
    elif re.search(LARGE, q):
        intent.size = 'large'
        q = re.sub(LARGE, ' ', q)
    q = re.sub(
        r'\b(?:with|and|that|which|have|has|the|a|an|all|every|any|companies|businesses)\b', ' ', q
    )

    # Longest phrases first, so "coffee shops" wins over "shops".
    words = sorted(
        ((w, c.id) for c in categories() for w in c.words), key=lambda p: len(p[0]), reverse=True
    )
    for word, cid in words:
        if re.search(rf'\b{re.escape(word)}\b', q):
            if cid not in intent.categories:
                intent.categories.append(cid)
            q = re.sub(rf'\b{re.escape(word)}\b', ' ', q)

    leftover = ' '.join(q.split()).strip(' ,.')
    if leftover and not intent.categories:
        intent.terms = leftover
    return intent
