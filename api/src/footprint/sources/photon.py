import asyncio

import httpx

# Registers give street addresses, not coordinates. Photon (Komoot's public
# geocoder over OpenStreetMap) has no hard rate limit, only fair use, so
# lookups go four at a time and the engine caches every answer.

URL = 'https://photon.komoot.io/api/'
_gate = asyncio.Semaphore(4)


async def locate(
    client: httpx.AsyncClient, address: str, near: tuple[float, float]
) -> tuple[float, float] | None:
    async with _gate:
        res = await client.get(
            URL, params={'q': address, 'limit': 1, 'lat': near[0], 'lon': near[1]}
        )
    if res.status_code != 200:
        return None
    features = res.json().get('features') or []
    if not features:
        return None
    lon, lat = features[0]['geometry']['coordinates']
    return float(lat), float(lon)
