import asyncio
import re
from math import cos, radians
from typing import Any

import duckdb
import httpx

from ..catalog import Category
from ..geo import distance_km
from ..models import Business

# Overture Maps publishes ~60 million places a month as GeoParquet on public
# S3, with websites, social links and phones already attached. DuckDB reads
# only the row groups whose bounding box overlaps ours, so a city-sized query
# costs a few megabytes and no third-party server has to be up for it.

BUCKET = 'overturemaps-us-west-2'
LISTING = f'https://{BUCKET}.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/'
MAX_RADIUS_KM = 15
EVERYTHING_RADIUS_KM = 1.5
MIN_CONFIDENCE = 0.45
SOCIAL_HOSTS = {
    'instagram': 'instagram.com',
    'facebook': 'facebook.com',
    'linkedin': 'linkedin.com',
    'tiktok': 'tiktok.com',
    'youtube': 'youtube.com',
    'x': 'twitter.com',
}
# Overture's taxonomy for "a place that sells something"; parks and bus stops are out.
EVERYTHING = (
    'food_and_drink',
    'shopping',
    'services_and_business',
    'health_care',
    'beauty_and_personal_care',
    'lodging',
    'sports_and_recreation',
    'education',
)


async def latest_release(client: httpx.AsyncClient) -> str:
    res = await client.get(LISTING)
    res.raise_for_status()
    releases = re.findall(r'<Prefix>release/([^<]+)/</Prefix>', res.text)
    if not releases:
        raise RuntimeError('no Overture release listed')
    return str(max(releases))


class Overture:
    def __init__(self, release: str | None = None) -> None:
        self.release = release
        self._db: duckdb.DuckDBPyConnection | None = None
        self._lock = asyncio.Lock()

    def _connect(self) -> duckdb.DuckDBPyConnection:
        if self._db is None:
            db = duckdb.connect()
            db.execute("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';")
            # Parquet footers are re-read on every query otherwise.
            db.execute('SET enable_http_metadata_cache = true; SET enable_object_cache = true;')
            self._db = db
        return self._db

    async def search(
        self,
        client: httpx.AsyncClient,
        lat: float,
        lon: float,
        radius_km: float,
        cats: list[Category],
        terms: str | None,
        limit: int,
        types: list[str] | None = None,
    ) -> list[Business]:
        if self.release is None:
            self.release = await latest_release(client)
        types = types or []
        everything = not cats and not terms and not types
        km = min(radius_km, EVERYTHING_RADIUS_KM if everything else MAX_RADIUS_KM)
        sql, params = build(self.release, lat, lon, km, cats, terms, limit, types)
        async with self._lock:
            rows = await asyncio.to_thread(self._query, sql, params)
        return parse(rows, lat, lon, km, cats)

    def _query(self, sql: str, params: list[Any]) -> list[tuple[Any, ...]]:
        return self._connect().cursor().execute(sql, params).fetchall()


def build(
    release: str,
    lat: float,
    lon: float,
    km: float,
    cats: list[Category],
    terms: str | None,
    limit: int,
    types: list[str] | None = None,
) -> tuple[str, list[Any]]:
    dlat = km / 110.574
    dlon = km / (111.320 * max(cos(radians(lat)), 0.01))
    where = [
        'bbox.xmin BETWEEN ? AND ?',
        'bbox.ymin BETWEEN ? AND ?',
        'confidence >= ?',
        "coalesce(operating_status, 'open') <> 'permanently_closed'",
    ]
    params: list[Any] = [lon - dlon, lon + dlon, lat - dlat, lat + dlat, MIN_CONFIDENCE]
    if cats or types:
        where.append('list_has_any(taxonomy.hierarchy, ?)')
        params.append(sorted({name for c in cats for name in c.overture} | set(types or [])))
    elif terms:
        where.append('names.primary ILIKE ?')
        params.append(f'%{terms}%')
    else:
        where.append('list_has_any(taxonomy.hierarchy, ?)')
        params.append(list(EVERYTHING))
    path = f's3://{BUCKET}/release/{release}/theme=places/type=place/*'
    sql = f"""
        SELECT id, names.primary, taxonomy.primary, taxonomy.hierarchy,
               (bbox.ymin + bbox.ymax) / 2, (bbox.xmin + bbox.xmax) / 2,
               websites, socials, phones, addresses
        FROM read_parquet('{path}', hive_partitioning = 1)
        WHERE {' AND '.join(where)}
        LIMIT {int(limit) * 2}
    """
    return sql, params


def _socials(urls: list[str] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for url in urls or []:
        for network, host in SOCIAL_HOSTS.items():
            if host in url.lower() and network not in out:
                out[network] = url
    return out


def _address(addresses: list[dict[str, Any]] | None) -> str | None:
    if not addresses:
        return None
    a = addresses[0]
    city = ' '.join(p for p in (a.get('postcode'), a.get('locality')) if p)
    return ', '.join(p for p in (a.get('freeform'), city) if p) or None


def parse(
    rows: list[tuple[Any, ...]], lat: float, lon: float, km: float, cats: list[Category]
) -> list[Business]:
    out: list[Business] = []
    for oid, name, primary, hierarchy, plat, plon, websites, socials, phones, addresses in rows:
        if not name:
            continue
        # The query box is a square; keep the circle.
        d = distance_km(lat, lon, plat, plon)
        if d > km:
            continue
        tree = set(hierarchy or [])
        category = next((c.id for c in cats if tree & set(c.overture)), None)
        out.append(
            Business(
                id=f'overture:{oid}',
                name=name,
                category=category or (f'overture:{primary}' if primary else None),
                lat=plat,
                lon=plon,
                distance_km=round(d, 3),
                address=_address(addresses),
                phone=(phones or [None])[0],
                website=(websites or [None])[0],
                socials=_socials(socials),
                sources=['overture'],
            )
        )
    out.sort(key=lambda b: b.distance_km)
    return out
