import re
from typing import Any

import httpx

from ..catalog import Category
from ..geo import distance_km
from ..models import Business

KINDS = ('shop', 'amenity', 'office', 'craft', 'tourism', 'leisure', 'healthcare')
SOCIAL_TAGS = {
    'instagram': ('contact:instagram', 'instagram'),
    'facebook': ('contact:facebook', 'facebook'),
    'linkedin': ('contact:linkedin', 'linkedin'),
    'tiktok': ('contact:tiktok', 'tiktok'),
    'youtube': ('contact:youtube', 'youtube'),
    'x': ('contact:twitter', 'twitter', 'contact:x'),
}
# Big radii make Overpass time out on public instances; 15 km already covers a city.
MAX_RADIUS_M = 15_000


class OverpassUnavailable(Exception):
    pass


def build(
    lat: float, lon: float, radius_km: float, cats: list[Category], terms: str | None, limit: int
) -> str:
    r = int(min(radius_km * 1000, MAX_RADIUS_M))
    around = f'(around:{r},{lat:.6f},{lon:.6f})'
    parts: list[str] = []
    for c in cats:
        for k, v in c.osm:
            parts.append(f'nwr["{k}"="{v}"]["name"]{around};')
    if terms and not cats:
        # Name search across anything that is a business.
        pattern = re.escape(terms).replace('"', '')
        kinds = '|'.join(KINDS)
        parts.append(f'nwr["name"~"{pattern}",i][~"^({kinds})$"~"."]{around};')
    body = ''.join(parts)
    return f'[out:json][timeout:40];({body});out center tags {limit};'


def _address(tags: dict[str, str]) -> str | None:
    street = ' '.join(p for p in (tags.get('addr:housenumber'), tags.get('addr:street')) if p)
    city = ' '.join(p for p in (tags.get('addr:postcode'), tags.get('addr:city')) if p)
    joined = ', '.join(p for p in (street, city) if p)
    return joined or None


def _category(tags: dict[str, str], cats: list[Category]) -> str | None:
    for c in cats:
        if any(tags.get(k) == v for k, v in c.osm):
            return c.id
    for k in KINDS:
        if k in tags:
            return f'{k}:{tags[k]}'
    return None


def parse(data: dict[str, Any], lat: float, lon: float, cats: list[Category]) -> list[Business]:
    out: list[Business] = []
    for el in data.get('elements', []):
        tags: dict[str, str] = el.get('tags', {})
        name = tags.get('name') or tags.get('brand')
        center = el.get('center') or el
        if not name or 'lat' not in center:
            continue
        socials = {}
        for network, keys in SOCIAL_TAGS.items():
            if value := next((tags[k] for k in keys if tags.get(k)), None):
                socials[network] = value
        out.append(
            Business(
                id=f'osm:{el["type"]}/{el["id"]}',
                name=name,
                category=_category(tags, cats),
                lat=center['lat'],
                lon=center['lon'],
                distance_km=round(distance_km(lat, lon, center['lat'], center['lon']), 3),
                address=_address(tags),
                phone=tags.get('phone') or tags.get('contact:phone'),
                website=tags.get('website') or tags.get('contact:website') or tags.get('url'),
                socials=socials,
                sources=['openstreetmap'],
            )
        )
    return out


async def search(
    client: httpx.AsyncClient,
    urls: list[str],
    timeout_s: float,
    lat: float,
    lon: float,
    radius_km: float,
    cats: list[Category],
    terms: str | None,
    limit: int,
) -> list[Business]:
    query = build(lat, lon, radius_km, cats, terms, limit)
    errors: list[str] = []
    for url in urls:
        try:
            res = await client.post(url, data={'data': query}, timeout=timeout_s)
        except httpx.TransportError as err:
            errors.append(f'{url}: {type(err).__name__}')
            continue
        if res.status_code in (429, 502, 503, 504):
            errors.append(f'{url}: {res.status_code}')
            continue
        res.raise_for_status()
        return parse(res.json(), lat, lon, cats)
    raise OverpassUnavailable('; '.join(errors))
