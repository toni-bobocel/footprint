import re
import unicodedata

from .geo import distance_km
from .models import Business

LEGAL = re.compile(
    r'\b(?:sarl|sas|sasu|eurl|sa|sci|snc|ei|eirl|ltd|limited|llc|inc|gmbh|ag|bv|srl|spa|plc|co)\b\.?'
)
SAME_PLACE_KM = 0.2


def _key(name: str) -> str:
    plain = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    plain = LEGAL.sub(' ', plain)
    return re.sub(r'[^a-z0-9]+', '', plain)


def _same_name(a: str, b: str) -> bool:
    if not a or not b:
        return False
    # "boulangeriepozzoli" and "maisonpozzoliboulangerie" are not equal, but
    # one registry name inside a shop sign is a strong enough hint nearby.
    return a == b or (min(len(a), len(b)) > 4 and (a in b or b in a))


def merge(businesses: list[Business]) -> list[Business]:
    """One row per real-world business: the map entry and the registry entry
    for the same bakery become one, keeping the map's contact details and the
    registry's size and founding date."""
    kept: list[Business] = []
    for b in businesses:
        key = _key(b.name)
        twin = next(
            (
                k
                for k in kept
                if k.id == b.id
                or (
                    _same_name(key, _key(k.name))
                    and distance_km(k.lat, k.lon, b.lat, b.lon) < SAME_PLACE_KM
                )
            ),
            None,
        )
        if twin is None:
            kept.append(b)
            continue
        twin.size = twin.size or b.size
        twin.founded = twin.founded or b.founded
        twin.website = twin.website or b.website
        twin.phone = twin.phone or b.phone
        twin.address = twin.address or b.address
        twin.category = twin.category or b.category
        for k, v in b.socials.items():
            twin.socials.setdefault(k, v)
        twin.sources = sorted(set(twin.sources) | set(b.sources))
    return kept
