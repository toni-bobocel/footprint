import asyncio
import time
from typing import Any

import httpx

from ..models import Place

# Nominatim's usage policy: one request per second per application, and an
# identifying User-Agent. A process-wide lock enforces the first.
_lock = asyncio.Lock()
_last = 0.0


async def _polite() -> None:
    global _last
    async with _lock:
        wait = 1.05 - (time.monotonic() - _last)
        if wait > 0:
            await asyncio.sleep(wait)
        _last = time.monotonic()


def _place(row: dict[str, Any]) -> Place:
    bbox = row.get('boundingbox')
    address: dict[str, Any] = row.get('address') or {}
    return Place(
        name=str(row.get('display_name', '')),
        lat=float(row['lat']),
        lon=float(row['lon']),
        kind=str(row.get('addresstype') or row.get('type') or '') or None,
        country=str(address.get('country_code', '')).upper() or None,
        capital=(row.get('extratags') or {}).get('capital_city'),
        locality=next(
            (address[k] for k in ('city', 'town', 'village', 'municipality') if address.get(k)),
            None,
        ),
        importance=float(row.get('importance') or 0),
        bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])) if bbox else None,
    )


async def geocode(client: httpx.AsyncClient, base: str, text: str) -> Place | None:
    await _polite()
    res = await client.get(
        f'{base}/search',
        params={'q': text, 'format': 'jsonv2', 'limit': 1, 'addressdetails': 1, 'extratags': 1},
    )
    res.raise_for_status()
    rows = res.json()
    return _place(rows[0]) if rows else None


async def reverse(client: httpx.AsyncClient, base: str, lat: float, lon: float) -> Place | None:
    await _polite()
    res = await client.get(
        f'{base}/reverse',
        params={'lat': lat, 'lon': lon, 'format': 'jsonv2', 'zoom': 10, 'addressdetails': 1},
    )
    res.raise_for_status()
    row = res.json()
    if 'error' in row:
        return None
    place = _place(row)
    # The clicked point is the centre, not the town hall Nominatim snaps to.
    return place.model_copy(update={'lat': lat, 'lon': lon})
