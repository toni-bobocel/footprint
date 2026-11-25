from typing import Any

import httpx

from ..geo import distance_km
from ..models import Business

# Wikidata knows the larger companies of every country, often with their
# official website and social accounts. Used for "everything here" and name
# searches, where its coverage of headquarters and chains complements the
# maps. One SPARQL query; the public endpoint asks for a descriptive UA.

URL = 'https://query.wikidata.org/sparql'
QUERY = """
SELECT ?item ?itemLabel ?coord ?site ?insta ?fb ?li ?x ?staff ?born WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(%(lon)f %(lat)f)"^^geo:wktLiteral ;
                    wikibase:radius "%(km)f" .
  }
  # A fixed list of business types: walking subclass* times out the endpoint.
  VALUES ?type { wd:Q4830453 wd:Q783794 wd:Q6881511 wd:Q891723 wd:Q1589009 wd:Q167037
                 wd:Q507619 wd:Q11707 wd:Q213441 wd:Q27686 wd:Q30022 wd:Q187456 wd:Q1631129
                 wd:Q658255 wd:Q1664720 wd:Q2085381 wd:Q15911314 wd:Q4382945 wd:Q1137809 }
  ?item wdt:P31 ?type .
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
  OPTIONAL { ?item wdt:P856 ?site }
  OPTIONAL { ?item wdt:P2003 ?insta }
  OPTIONAL { ?item wdt:P2013 ?fb }
  OPTIONAL { ?item wdt:P4264 ?li }
  OPTIONAL { ?item wdt:P2002 ?x }
  OPTIONAL { ?item wdt:P1128 ?staff }
  OPTIONAL { ?item wdt:P571 ?born }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "%(lang)s,en,mul" . }
}
LIMIT 400
"""
TIMEOUT = 30


def _v(row: dict[str, Any], key: str) -> str | None:
    cell = row.get(key)
    return cell['value'] if cell else None


async def search(
    client: httpx.AsyncClient,
    lat: float,
    lon: float,
    radius_km: float,
    terms: str | None,
    lang: str = 'en',
) -> list[Business]:
    km = min(radius_km, 15)
    res = await client.get(
        URL,
        params={'query': QUERY % {'lat': lat, 'lon': lon, 'km': km, 'lang': lang}},
        headers={'Accept': 'application/sparql-results+json'},
        timeout=TIMEOUT,
    )
    res.raise_for_status()
    found: dict[str, Business] = {}
    for row in res.json()['results']['bindings']:
        qid = _v(row, 'item').rsplit('/', 1)[-1]  # type: ignore[union-attr]
        name = _v(row, 'itemLabel') or qid
        if name == qid:
            continue  # no label in any language we asked for
        if terms and terms.lower() not in name.lower():
            continue
        point = _v(row, 'coord') or ''
        try:
            plon, plat = (float(x) for x in point.removeprefix('Point(').rstrip(')').split())
        except ValueError:
            continue
        b = found.get(qid)
        if b is None:
            staff = _v(row, 'staff')
            b = found[qid] = Business(
                id=f'wikidata:{qid}',
                name=name,
                lat=plat,
                lon=plon,
                distance_km=round(distance_km(lat, lon, plat, plon), 3),
                website=_v(row, 'site'),
                size=str(int(float(staff))) if staff else None,
                founded=(_v(row, 'born') or '')[:10] or None,
                sources=['wikidata'],
            )
        for key, net, prefix in (
            ('insta', 'instagram', 'https://instagram.com/'),
            ('fb', 'facebook', 'https://facebook.com/'),
            ('li', 'linkedin', 'https://linkedin.com/company/'),
            ('x', 'x', 'https://x.com/'),
        ):
            if (handle := _v(row, key)) and net not in b.socials:
                b.socials[net] = prefix + handle
    return sorted(found.values(), key=lambda b: b.distance_km)
