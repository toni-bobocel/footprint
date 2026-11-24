import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

# The catalogue is shared with the web client; the repo root holds the one copy.
_DEFAULT = Path(__file__).resolve().parents[3] / 'shared' / 'categories.json'


@dataclass(frozen=True)
class Category:
    id: str
    label: str
    words: tuple[str, ...]
    osm: tuple[tuple[str, str], ...]
    naf: tuple[str, ...]


@cache
def categories(path: Path = _DEFAULT) -> tuple[Category, ...]:
    raw = json.loads(path.read_text(encoding='utf-8'))
    return tuple(
        Category(
            id=c['id'],
            label=c['label'],
            words=tuple(w.lower() for w in c['words']),
            osm=tuple((k, v) for k, v in c['osm']),
            naf=tuple(c['naf']),
        )
        for c in raw['categories']
    )


def by_id(category_id: str) -> Category | None:
    return next((c for c in categories() if c.id == category_id), None)
