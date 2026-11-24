import asyncio
from datetime import date, timedelta
from typing import Any

import httpx

from ..catalog import Category
from ..geo import distance_km
from ..models import Business

# recherche-entreprises.api.gouv.fr: every registered French company,
# shopfront or not, with headcount bands and creation dates. No key.

# INSEE headcount bands.
BANDS = {
    'NN': None,
    '00': '0',
    '01': '1-2',
    '02': '3-5',
    '03': '6-9',
    '11': '10-19',
    '12': '20-49',
    '21': '50-99',
    '22': '100-199',
    '31': '200-249',
    '32': '250-499',
    '41': '500-999',
    '42': '1000-1999',
    '51': '2000-4999',
    '52': '5000-9999',
    '53': '10000+',
}
SMALL = {'NN', '00', '01', '02', '03'}
MAX_RADIUS_KM = 50
PAGES = 4
PER_PAGE = 25


async def search(
    client: httpx.AsyncClient,
    base: str,
    lat: float,
    lon: float,
    radius_km: float,
    cats: list[Category],
    recent: bool,
    size: str | None,
) -> list[Business]:
    naf = sorted({code for c in cats for code in c.naf})
    if not naf:
        return []
    params: dict[str, str | int | float] = {
        'lat': lat,
        'long': lon,
        'radius': min(radius_km, MAX_RADIUS_KM),
        'activite_principale': ','.join(naf),
        'per_page': PER_PAGE,
    }
    out: list[Business] = []
    for page in range(1, PAGES + 1):
        res = await client.get(f'{base}/near_point', params={**params, 'page': page})
        res.raise_for_status()
        body = res.json()
        out.extend(_parse(body.get('results', []), lat, lon, cats, recent, size))
        if page >= body.get('total_pages', 1):
            break
        # The API allows 7 calls a second; stay well under it.
        await asyncio.sleep(0.2)
    return out


def _parse(
    rows: list[dict[str, Any]],
    lat: float,
    lon: float,
    cats: list[Category],
    recent: bool,
    size: str | None,
) -> list[Business]:
    since = (date.today() - timedelta(days=365)).isoformat()
    out: list[Business] = []
    for row in rows:
        # A company that opted out of commercial prospecting is never shown.
        if row.get('opposition_diffusion_commerciale') or row.get('etat_administratif') != 'A':
            continue
        band = str(row.get('tranche_effectif_salarie') or 'NN')
        if size == 'small' and band not in SMALL:
            continue
        if size == 'large' and band in SMALL:
            continue
        founded = str(row.get('date_creation') or '') or None
        if recent and (not founded or founded < since):
            continue
        naf = str(row.get('activite_principale') or '')
        category = next((c.id for c in cats if naf in c.naf), None)
        for site in row.get('matching_etablissements') or []:
            if site.get('etat_administratif') not in (None, 'A'):
                continue
            try:
                slat, slon = float(site['latitude']), float(site['longitude'])
            except (KeyError, TypeError, ValueError):
                continue
            signs = site.get('liste_enseignes') or []
            name = signs[0] if signs else str(row.get('nom_complet') or '')
            out.append(
                Business(
                    id=f'siret:{site.get("siret")}',
                    name=name.title() if name.isupper() else name,
                    category=category,
                    lat=slat,
                    lon=slon,
                    distance_km=round(distance_km(lat, lon, slat, slon), 3),
                    address=site.get('adresse'),
                    size=BANDS.get(band),
                    founded=founded,
                    sources=['sirene'],
                )
            )
    return out
