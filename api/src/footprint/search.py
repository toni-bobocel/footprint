import asyncio
import time
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import duckdb
import httpx

from .cache import Cache
from .catalog import Category, by_id
from .config import Settings
from .geo import distance_km, radius_for_bbox
from .merge import merge
from .models import Business, Footprint, Place, Site
from .query import Intent, parse
from .scan import footprint, scan_site
from .sources import nominatim, overpass, photon, places, registers, sirene, wikidata
from .sources.overture import Overture

DAY = 86_400
# After Overpass fails, leave it alone for a while instead of making every
# search wait for its timeouts.
OVERPASS_REST_S = 600
BROAD = ('country', 'state', 'region', 'province')
# Places a name could plausibly be, as opposed to a hamlet that happens to
# share a company's name ("Tesla", Bulgaria). Nominatim's importance, 0 to 1.
PROMINENT = 0.45


@dataclass
class Clients:
    http: httpx.AsyncClient
    insecure: httpx.AsyncClient


class Engine:
    def __init__(self, settings: Settings, clients: Clients, cache: Cache) -> None:
        self.s = settings
        self.c = clients
        self.cache = cache
        self.overture = Overture(settings.overture_release) if settings.overture else None
        # monotonic() counts from boot, so 0 would read as a recent failure on a fresh machine.
        self._overpass_failed_at = float('-inf')

    async def geocode(self, text: str) -> Place | None:
        key = text.lower()
        if hit := await self.cache.get('place', key, 30 * DAY):
            return Place(**hit)
        place = await nominatim.geocode(self.c.http, self.s.nominatim_url, text)
        if place:
            await self.cache.put('place', key, place.model_dump())
        return place

    async def reverse(self, lat: float, lon: float) -> Place | None:
        key = f'{lat:.3f},{lon:.3f}'
        if hit := await self.cache.get('reverse', key, 30 * DAY):
            return Place(**hit)
        place = await nominatim.reverse(self.c.http, self.s.nominatim_url, lat, lon)
        if place:
            await self.cache.put('reverse', key, place.model_dump())
        return place

    async def run(
        self,
        text: str,
        lat: float | None,
        lon: float | None,
        radius_km: float | None,
        lang: str = 'en',
    ) -> AsyncIterator[tuple[str, Any]]:
        started = time.monotonic()
        intent = parse(text)
        place = await self._where(intent, lat, lon)
        cats = [c for c in (by_id(i) for i in intent.categories) if c]
        yield 'intent', _describe(intent, cats)
        if place is None:
            yield 'problem', {'code': 'no_place'}
            return
        radius = _radius(radius_km or intent.radius_km, place)
        yield 'place', {**place.model_dump(), 'radius_km': radius}

        events: asyncio.Queue[tuple[str, Any] | None] = asyncio.Queue()
        found: list[Business] = []
        scanned: set[str] = set()
        scans: list[asyncio.Task[None]] = []
        gate = asyncio.Semaphore(self.s.scan_concurrency)
        status: dict[str, str] = {}

        async def scan(b: Business) -> None:
            async with gate:
                fp = await self._footprint(b)
            await events.put(('footprint', fp.model_dump()))

        async def source(name: str, job: Awaitable[list[Business]]) -> None:
            try:
                batch = await job
                status[name] = 'ok'
            except overpass.OverpassUnavailable:
                self._overpass_failed_at = time.monotonic()
                status[name] = 'unavailable'
                await events.put(('notice', {'source': name, 'code': 'busy'}))
                return
            except (httpx.HTTPError, duckdb.Error, ValueError) as err:
                status[name] = 'error'
                await events.put(('notice', {'source': name, 'code': type(err).__name__}))
                return
            found[:] = merge([*found, *batch])[: self.s.max_results]
            await events.put(
                ('businesses', {'source': name, 'items': [b.model_dump() for b in found]})
            )
            for b in found:
                if b.id not in scanned:
                    scanned.add(b.id)
                    scans.append(asyncio.create_task(scan(b)))

        jobs: list[Awaitable[None]] = []
        # OSM tags only cover the catalogue; a bare Overture type ("cheese_shop") skips it.
        if intent.types and not cats:
            status['openstreetmap'] = 'skipped'
        elif time.monotonic() - self._overpass_failed_at < OVERPASS_REST_S:
            status['openstreetmap'] = 'resting'
        else:
            jobs.append(source('openstreetmap', self._osm(place, radius, cats, intent.terms)))
        if self.overture:
            jobs.append(source('overture', self._overture(place, radius, cats, intent)))
        # Registers search by activity code; a name or an Overture type can't be expressed.
        if not intent.terms and not (intent.types and not cats):
            if place.country == 'FR':
                jobs.append(source('sirene', self._sirene(place, radius, cats, intent)))
            elif job := self._register(place, radius, cats, intent):
                jobs.append(source(registers.SOURCE[place.country or ''], job))
        if not cats and not intent.types:
            jobs.append(source('wikidata', self._wikidata(place, radius, intent.terms, lang)))

        async def drive() -> None:
            await asyncio.gather(*jobs)
            # New scans keep being added while sources land; wait for all of them.
            while pending := [t for t in scans if not t.done()]:
                await asyncio.gather(*pending)
            await events.put(None)

        driver = asyncio.create_task(drive())
        try:
            while (event := await events.get()) is not None:
                yield event
        finally:
            driver.cancel()
            for t in scans:
                t.cancel()
        yield (
            'done',
            {
                'count': len(found),
                'elapsed_ms': int((time.monotonic() - started) * 1000),
                'sources': status,
            },
        )

    async def _where(self, intent: Intent, lat: float | None, lon: float | None) -> Place | None:
        if lat is not None and lon is not None:
            return await self.reverse(lat, lon) or Place(
                name=f'{lat:.4f}, {lon:.4f}', lat=lat, lon=lon
            )
        if intent.lat is not None and intent.lon is not None:
            return await self.reverse(intent.lat, intent.lon) or Place(
                name=f'{intent.lat:.4f}, {intent.lon:.4f}', lat=intent.lat, lon=intent.lon
            )
        if intent.place:
            return await self._settle(intent.place)
        if intent.terms:
            return await self._guess(intent)
        return None

    async def _settle(self, text: str) -> Place | None:
        place = None
        # Inflected Russian place names ("в Москве", "в Казани"): Nominatim
        # fuzzy-matches them to the wrong thing, so the nominative goes first.
        for variant in _uninflect(text):
            candidate = await self.geocode(variant)
            if candidate and candidate.importance >= PROMINENT:
                place = candidate
                break
        place = place or await self.geocode(text)
        # The middle of Moldova is fields; its businesses are in Chișinău.
        if place and place.capital and place.kind in BROAD:
            city = await self.geocode(f'{place.capital}, {text}')
            return city or place
        return place

    async def _guess(self, intent: Intent) -> Place | None:
        """No category and no preposition: "Moldova", "Tesla Austin". Try
        the whole text as a place, then its last or first words."""
        assert intent.terms
        words = intent.terms.split()
        splits = [(intent.terms, '')]
        for k in (1, 2):
            if len(words) > k:
                splits.append((' '.join(words[-k:]), ' '.join(words[:-k])))
                splits.append((' '.join(words[:k]), ' '.join(words[k:])))
        for where, rest in splits:
            place = await self.geocode(where)
            if place and place.importance >= PROMINENT:
                intent.place, intent.terms = where, rest or None
                return await self._settle(where) if place.kind in BROAD else place
        return None

    async def _osm(
        self, place: Place, radius: float, cats: list[Category], terms: str | None
    ) -> list[Business]:
        key = f'{",".join(c.id for c in cats)}|{terms}|{place.lat:.3f}|{place.lon:.3f}|{radius:.1f}'
        if hit := await self.cache.get('osm', key, DAY / 4):
            return [Business(**b) for b in hit]
        found = await overpass.search(
            self.c.http,
            self.s.overpass_urls,
            self.s.overpass_timeout_s,
            place.lat,
            place.lon,
            radius,
            cats,
            terms,
            self.s.max_results,
        )
        await self.cache.put('osm', key, [b.model_dump() for b in found])
        return found

    async def _overture(
        self, place: Place, radius: float, cats: list[Category], intent: Intent
    ) -> list[Business]:
        assert self.overture
        what = ','.join([c.id for c in cats] + intent.types)
        key = f'{what}|{intent.terms}|{place.lat:.3f}|{place.lon:.3f}|{radius:.1f}'
        if hit := await self.cache.get('overture', key, 7 * DAY):
            return [Business(**b) for b in hit]
        found = await self.overture.search(
            self.c.http,
            place.lat,
            place.lon,
            radius,
            cats,
            intent.terms,
            self.s.max_results,
            types=intent.types,
        )
        await self.cache.put('overture', key, [b.model_dump() for b in found])
        return found

    async def _sirene(
        self, place: Place, radius: float, cats: list[Category], intent: Intent
    ) -> list[Business]:
        return await sirene.search(
            self.c.http,
            self.s.sirene_url,
            place.lat,
            place.lon,
            radius,
            cats,
            intent.recent,
            intent.size,
        )

    def _register(
        self, place: Place, radius: float, cats: list[Category], intent: Intent
    ) -> Awaitable[list[Business]] | None:
        country = place.country or ''
        if country == 'GB' and not self.s.companies_house_key:
            return None
        if country not in registers.SOURCE:
            return None

        async def job() -> list[Business]:
            what = ','.join(c.id for c in cats)
            key = f'{country}|{what}|{place.locality}|{intent.recent}|{intent.size}'
            if not (hit := await self.cache.get('register', key, DAY)):
                if country == 'NO':
                    rows = await registers.norway(
                        self.c.http, place, cats, intent.recent, intent.size
                    )
                elif country == 'FI':
                    rows = await registers.finland(
                        self.c.http, place, cats, intent.recent, intent.size
                    )
                else:
                    assert self.s.companies_house_key
                    rows = await registers.united_kingdom(
                        self.c.http,
                        self.s.companies_house_key,
                        place,
                        cats,
                        intent.recent,
                        intent.size,
                    )
                hit = [{'business': r.business.model_dump(), 'address': r.address} for r in rows]
                await self.cache.put('register', key, hit)
            return await self._locate(place, radius, hit)

        return job()

    async def _locate(
        self, place: Place, radius: float, rows: list[dict[str, Any]]
    ) -> list[Business]:
        """Registers give addresses; put them on the map and keep the circle."""

        async def one(row: dict[str, Any]) -> Business | None:
            b = Business(**row['business'])
            key = row['address'].lower()
            if (point := await self.cache.get('photon', key, 90 * DAY)) is None:
                try:
                    located = await photon.locate(
                        self.c.http, row['address'], (place.lat, place.lon)
                    )
                except httpx.HTTPError:
                    return None
                point = list(located) if located else []
                await self.cache.put('photon', key, point)
            if not point:
                return None
            b.lat, b.lon = point
            b.distance_km = round(distance_km(place.lat, place.lon, b.lat, b.lon), 3)
            return b if b.distance_km <= radius * 1.2 else None

        located = await asyncio.gather(*(one(r) for r in rows))
        return [b for b in located if b]

    async def _wikidata(
        self, place: Place, radius: float, terms: str | None, lang: str
    ) -> list[Business]:
        key = f'{terms}|{place.lat:.3f}|{place.lon:.3f}|{radius:.1f}|{lang}'
        if hit := await self.cache.get('wikidata', key, 7 * DAY):
            return [Business(**b) for b in hit]
        found = await wikidata.search(self.c.http, place.lat, place.lon, radius, terms, lang)
        await self.cache.put('wikidata', key, [b.model_dump() for b in found])
        return found

    async def _footprint(self, b: Business) -> Footprint:
        site = None
        if b.website:
            domain = urlparse(b.website if '//' in b.website else f'//{b.website}').netloc.lower()
            if hit := await self.cache.get('site', domain, 3 * DAY):
                site = Site(**hit)
            else:
                site = await scan_site(
                    self.c.http, self.c.insecure, b.website, self.s.scan_timeout_s
                )
                await self.cache.put('site', domain, site.model_dump())
        google = None
        if self.s.google_places_key:
            try:
                google = await places.lookup(self.c.http, self.s.google_places_key, b)
            except httpx.HTTPError:
                google = None
        return footprint(b, site, google)


def _uninflect(text: str) -> list[str]:
    """Nominative guesses for a Russian locative or genitive place name."""
    # Only the Cyrillic endings a locative or genitive leaves (ie, i, u).
    if not text or text[-1] not in 'еиу':
        return []
    stem = text[:-1]
    # Cyrillic endings on purpose: nominative forms of a locative.
    endings = ('а', 'ь', '', 'я', 'ы')  # noqa: RUF001
    return [stem + ending for ending in endings]


def _radius(requested: float | None, place: Place) -> float:
    if requested:
        return max(0.2, min(requested, 50))
    if place.bbox and place.kind not in BROAD:
        return round(max(1.0, min(radius_for_bbox(place.lat, place.lon, place.bbox), 15)), 1)
    return 5.0


def _describe(intent: Intent, cats: list[Category]) -> dict[str, Any]:
    return {
        'text': intent.text,
        'categories': [{'id': c.id, 'label': c.label, 'labels': c.labels} for c in cats],
        'types': intent.types,
        'terms': intent.terms,
        'place': intent.place,
        'gaps': intent.gaps,
        'recent': intent.recent,
        'size': intent.size,
        'everything': not cats and not intent.types and not intent.terms,
    }
