import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import duckdb
import httpx

from .cache import Cache
from .catalog import Category, by_id
from .config import Settings
from .geo import radius_for_bbox
from .merge import merge
from .models import Business, Footprint, Place, Site
from .query import Intent, parse
from .scan import footprint, scan_site
from .sources import nominatim, overpass, places, sirene
from .sources.overture import Overture

DAY = 86_400
OSM_BUSY = 'OpenStreetMap is overloaded right now; showing what else I found.'
# Rough box around metropolitan France and Corsica; the registry only covers France.
FRANCE = (41.2, 51.2, -5.3, 9.7)


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

    async def geocode(self, text: str) -> Place | None:
        if hit := await self.cache.get('geocode', text.lower(), 30 * DAY):
            return Place(**hit)
        place = await nominatim.geocode(self.c.http, self.s.nominatim_url, text)
        if place:
            await self.cache.put('geocode', text.lower(), place.model_dump())
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
        self, text: str, lat: float | None, lon: float | None, radius_km: float | None
    ) -> AsyncIterator[tuple[str, Any]]:
        started = time.monotonic()
        intent = parse(text)
        cats = [c for c in (by_id(i) for i in intent.categories) if c]
        yield 'intent', _describe(intent, cats)

        place = await self._where(intent, lat, lon)
        if place is None:
            yield (
                'problem',
                {
                    'code': 'no_place',
                    'message': 'Tell me where: a city, a country, or click the globe.',
                },
            )
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

        async def source(name: str, job: Any) -> None:
            try:
                batch: list[Business] = await job
                status[name] = 'ok'
            except overpass.OverpassUnavailable:
                status[name] = 'unavailable'
                await events.put(
                    (
                        'notice',
                        {
                            'source': name,
                            'message': OSM_BUSY,
                        },
                    )
                )
                return
            except (httpx.HTTPError, duckdb.Error) as err:
                status[name] = 'error'
                await events.put(
                    (
                        'notice',
                        {
                            'source': name,
                            'message': f'{name} did not answer ({type(err).__name__}).',
                        },
                    )
                )
                return
            found[:] = merge([*found, *batch])[: self.s.max_results]
            await events.put(
                ('businesses', {'source': name, 'items': [b.model_dump() for b in found]})
            )
            for b in found:
                if b.id not in scanned:
                    scanned.add(b.id)
                    scans.append(asyncio.create_task(scan(b)))

        jobs = [source('openstreetmap', self._osm(place, radius, cats, intent.terms))]
        if self.overture:
            jobs.append(source('overture', self._overture(place, radius, cats, intent.terms)))
        else:
            status['overture'] = 'off'
        # A name search goes to the map only: the registry can't search names by distance.
        if not intent.terms and _in_france(place):
            jobs.append(source('sirene', self._sirene(place, radius, cats, intent)))
        else:
            status['sirene'] = 'skipped'

        async def drive() -> None:
            await asyncio.gather(*jobs)
            # New scans keep being added while sources land; wait for all of them.
            while scans:
                pending = [t for t in scans if not t.done()]
                if not pending:
                    break
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
            return await self.geocode(intent.place)
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
        self, place: Place, radius: float, cats: list[Category], terms: str | None
    ) -> list[Business]:
        assert self.overture
        key = f'{",".join(c.id for c in cats)}|{terms}|{place.lat:.3f}|{place.lon:.3f}|{radius:.1f}'
        if hit := await self.cache.get('overture', key, 7 * DAY):
            return [Business(**b) for b in hit]
        found = await self.overture.search(
            self.c.http, place.lat, place.lon, radius, cats, terms, self.s.max_results
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


def _radius(requested: float | None, place: Place) -> float:
    if requested:
        return max(0.2, min(requested, 50))
    if place.bbox and place.kind not in ('country', 'state', 'region'):
        return round(max(1.0, min(radius_for_bbox(place.lat, place.lon, place.bbox), 15)), 1)
    return 5.0


def _in_france(place: Place) -> bool:
    if place.country:
        return place.country == 'FR'
    south, north, west, east = FRANCE
    return south <= place.lat <= north and west <= place.lon <= east


def _describe(intent: Intent, cats: list[Category]) -> dict[str, Any]:
    return {
        'text': intent.text,
        'categories': [{'id': c.id, 'label': c.label} for c in cats],
        'terms': intent.terms,
        'place': intent.place,
        'gaps': intent.gaps,
        'recent': intent.recent,
        'size': intent.size,
        'everything': not cats and not intent.terms,
    }
