import httpx

from ..models import Business

# Google reviews are only available through the paid Places API; scraping
# Google Maps breaks its terms and gets blocked anyway. This adapter is off
# unless GOOGLE_PLACES_KEY is set, and then asks for three fields only.

URL = 'https://places.googleapis.com/v1/places:searchText'
FIELDS = 'places.displayName,places.rating,places.userRatingCount,places.googleMapsUri'


async def lookup(
    client: httpx.AsyncClient, key: str, business: Business
) -> tuple[float | None, int | None, str | None]:
    res = await client.post(
        URL,
        headers={'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS},
        json={
            'textQuery': f'{business.name} {business.address or ""}'.strip(),
            'locationBias': {
                'circle': {
                    'center': {'latitude': business.lat, 'longitude': business.lon},
                    'radius': 150.0,
                }
            },
            'maxResultCount': 1,
        },
    )
    res.raise_for_status()
    places = res.json().get('places') or []
    if not places:
        return None, None, None
    p = places[0]
    return p.get('rating'), p.get('userRatingCount'), p.get('googleMapsUri')
