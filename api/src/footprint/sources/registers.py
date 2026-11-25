from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import httpx

from ..catalog import Category
from ..models import Business, Place

# Official company registers that are open and can be searched by place and
# activity, beyond France's (sirene.py). Each returns businesses with a
# street address; the engine geocodes them. They share one activity
# vocabulary: the EU's NACE classes, which the French NAF codes extend.
#
# Registers that need a key stay off until one is set. Countries without an
# open register (most of them) rely on the map sources alone.

BRREG = 'https://data.brreg.no/enhetsregisteret/api'
PRH = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies'
COMPANIES_HOUSE = 'https://api.company-information.service.gov.uk/advanced-search/companies'
LIMIT = 80
# Country code -> source name used in events and on Business.sources.
SOURCE = {'NO': 'brreg', 'FI': 'prh', 'GB': 'companies_house'}


@dataclass
class Found:
    business: Business
    # Street address to geocode; the business has no coordinates yet.
    address: str


def nace(cats: list[Category]) -> list[str]:
    """'10.71C' -> '10.71'."""
    return sorted({code[:5] for c in cats for code in c.naf})


def tidy(name: str) -> str:
    return name.title() if name.isupper() else name


def _cat(code: str, cats: list[Category]) -> str | None:
    digits = code.replace('.', '')
    return next(
        (c.id for c in cats if any(digits.startswith(n.replace('.', '')[:4]) for n in c.naf)), None
    )


# Norway: Brønnøysundregistrene. Searches by municipality number and by
# activity code prefix at group level ('56.1'), so results are filtered
# down to the exact class afterwards.

_kommuner: dict[str, str] = {}


async def _kommune(client: httpx.AsyncClient, name: str) -> str | None:
    if not _kommuner:
        res = await client.get(f'{BRREG}/kommuner', params={'size': 1000})
        res.raise_for_status()
        for k in res.json().get('_embedded', {}).get('kommuner', []):
            _kommuner[k['navn'].lower()] = k['nummer']
    return _kommuner.get(name.lower())


async def norway(
    client: httpx.AsyncClient, place: Place, cats: list[Category], recent: bool, size: str | None
) -> list[Found]:
    if not place.locality or not (kommune := await _kommune(client, place.locality)):
        return []
    classes = nace(cats)
    params: dict[str, Any] = {'kommunenummer': kommune, 'size': 100}
    if classes:
        params['naeringskode'] = ','.join(sorted({c[:4] for c in classes}))
    if recent:
        params['fraStiftelsesdato'] = (date.today() - timedelta(days=365)).isoformat()
    res = await client.get(f'{BRREG}/enheter', params=params)
    res.raise_for_status()
    out: list[Found] = []
    for e in res.json().get('_embedded', {}).get('enheter', []):
        code = (e.get('naeringskode1') or {}).get('kode', '')
        if classes and not any(code.startswith(c) for c in classes):
            continue
        if e.get('konkurs') or e.get('underAvvikling') or e.get('slettedato'):
            continue
        staff = e.get('antallAnsatte')
        if size == 'small' and staff and staff >= 10:
            continue
        if size == 'large' and (not staff or staff < 10):
            continue
        a = e.get('forretningsadresse') or e.get('postadresse') or {}
        street = ', '.join(a.get('adresse') or [])
        out.append(
            Found(
                Business(
                    id=f'brreg:{e["organisasjonsnummer"]}',
                    name=tidy(e['navn']),
                    category=_cat(code, cats),
                    lat=0,
                    lon=0,
                    website=e.get('hjemmeside'),
                    size=str(staff) if staff else None,
                    founded=e.get('stiftelsesdato'),
                    address=f'{street}, {a.get("postnummer", "")} {a.get("poststed", "")}'.strip(
                        ', '
                    ),
                    sources=['brreg'],
                ),
                f'{street}, {a.get("postnummer", "")} {a.get("poststed", "")}, Norway',
            )
        )
    return out[:LIMIT]


# Finland: the Patent and Registration Office's open YTJ data. Searches by
# town name and five-digit TOL code; the four-digit NACE class is tried
# with the usual national suffixes.


async def finland(
    client: httpx.AsyncClient, place: Place, cats: list[Category], recent: bool, size: str | None
) -> list[Found]:
    if not place.locality:
        return []
    classes = [c.replace('.', '') for c in nace(cats)] or ['']
    since = (date.today() - timedelta(days=365)).isoformat()
    out: list[Found] = []
    seen: set[str] = set()
    for cls in classes:
        for line in [f'{cls}{d}' for d in '0129'] if cls else ['']:
            params = {'location': place.locality}
            if line:
                params['mainBusinessLine'] = line
            res = await client.get(PRH, params=params)
            if res.status_code != 200:
                continue
            for c in res.json().get('companies', []):
                bid = c['businessId']['value']
                if bid in seen or c.get('endDate'):
                    continue
                registered = c['businessId'].get('registrationDate') or ''
                if recent and registered < since:
                    continue
                seen.add(bid)
                names = [n for n in c.get('names', []) if not n.get('endDate')]
                a = next((x for x in c.get('addresses', []) if x.get('type') == 1), None)
                if not names or not a:
                    continue
                city = next(
                    (p['city'] for p in a.get('postOffices', []) if p.get('languageCode') == '1'),
                    '',
                )
                street = ' '.join(p for p in (a.get('street'), a.get('buildingNumber')) if p)
                address = f'{street.title()}, {a.get("postCode", "")} {city.title()}'
                out.append(
                    Found(
                        Business(
                            id=f'prh:{bid}',
                            name=names[0]['name'],
                            category=_cat(
                                line or (c.get('mainBusinessLine') or {}).get('type', ''), cats
                            ),
                            lat=0,
                            lon=0,
                            website=(c.get('website') or {}).get('url'),
                            founded=registered or None,
                            address=address,
                            sources=['prh'],
                        ),
                        f'{address}, Finland',
                    )
                )
            if len(out) >= LIMIT:
                return out[:LIMIT]
    return out


# United Kingdom: Companies House advanced search, by place name and SIC
# code (UK SIC 2007 = NACE class + one digit). Needs a free API key.


async def united_kingdom(
    client: httpx.AsyncClient,
    key: str,
    place: Place,
    cats: list[Category],
    recent: bool,
    size: str | None,
) -> list[Found]:
    if not place.locality:
        return []
    classes = [c.replace('.', '') for c in nace(cats)]
    params: dict[str, Any] = {
        'location': place.locality,
        'company_status': 'active',
        'size': 100,
    }
    if classes:
        params['sic_codes'] = ','.join(f'{c}{d}' for c in classes for d in '0129')
    if recent:
        params['incorporated_from'] = (date.today() - timedelta(days=365)).isoformat()
    res = await client.get(COMPANIES_HOUSE, params=params, auth=(key, ''))
    res.raise_for_status()
    out: list[Found] = []
    for c in res.json().get('items', []):
        a = c.get('registered_office_address') or {}
        address = ', '.join(
            p for p in (a.get('address_line_1'), a.get('locality'), a.get('postal_code')) if p
        )
        sic = (c.get('sic_codes') or [''])[0]
        out.append(
            Found(
                Business(
                    id=f'ch:{c["company_number"]}',
                    name=tidy(c['company_name']),
                    category=_cat(sic, cats),
                    lat=0,
                    lon=0,
                    founded=c.get('date_of_creation'),
                    address=address,
                    sources=['companies_house'],
                ),
                f'{address}, United Kingdom',
            )
        )
    return out[:LIMIT]
