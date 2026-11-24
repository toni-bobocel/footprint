from datetime import date, timedelta

import httpx
import pytest
import respx

from footprint.catalog import by_id
from footprint.merge import merge
from footprint.models import Business
from footprint.sources import overpass, sirene

BAKERY = by_id('bakery')
assert BAKERY
LAST_MONTH = (date.today() - timedelta(days=30)).isoformat()

ELEMENTS = {
    'elements': [
        {
            'type': 'node',
            'id': 1,
            'lat': 45.7675,
            'lon': 4.8340,
            'tags': {
                'shop': 'bakery',
                'name': 'Maison Pozzoli',
                'website': 'https://pozzoli.fr',
                'contact:instagram': 'https://instagram.com/pozzoli',
                'addr:housenumber': '12',
                'addr:street': 'Rue Mercière',
                'addr:city': 'Lyon',
            },
        },
        {'type': 'way', 'id': 2, 'center': {'lat': 45.77, 'lon': 4.83}, 'tags': {'shop': 'bakery'}},
    ]
}


def test_overpass_query_is_bounded() -> None:
    q = overpass.build(45.76, 4.83, 80, [BAKERY], None, 300)
    assert '(around:15000,' in q
    assert 'nwr["shop"="bakery"]["name"]' in q
    assert q.endswith('out center tags 300;')


def test_everything_here_stays_small() -> None:
    q = overpass.build(45.76, 4.83, 10, [], None, 300)
    assert '(around:1500,' in q
    assert 'nwr["shop"]["name"]' in q


def test_overpass_parse_skips_nameless() -> None:
    found = overpass.parse(ELEMENTS, 45.76, 4.83, [BAKERY])
    assert len(found) == 1
    b = found[0]
    assert b.category == 'bakery'
    assert b.address == '12 Rue Mercière, Lyon'
    assert b.socials == {'instagram': 'https://instagram.com/pozzoli'}


@respx.mock
async def test_overpass_moves_to_the_next_mirror() -> None:
    respx.post('https://a.example/api').mock(return_value=httpx.Response(504))
    respx.post('https://b.example/api').mock(side_effect=httpx.ReadTimeout('slow'))
    respx.post('https://c.example/api').mock(return_value=httpx.Response(200, json=ELEMENTS))
    urls = ['https://a.example/api', 'https://b.example/api', 'https://c.example/api']
    async with httpx.AsyncClient() as client:
        found = await overpass.search(client, urls, 5, 45.76, 4.83, 2, [BAKERY], None, 50)
    assert [b.name for b in found] == ['Maison Pozzoli']


@respx.mock
async def test_overpass_all_down() -> None:
    respx.post('https://a.example/api').mock(return_value=httpx.Response(429))
    async with httpx.AsyncClient() as client:
        with pytest.raises(overpass.OverpassUnavailable):
            await overpass.search(client, ['https://a.example/api'], 5, 0, 0, 1, [BAKERY], None, 5)


def company(siren: str, **kw: object) -> dict[str, object]:
    row: dict[str, object] = {
        'siren': siren,
        'nom_complet': 'BOULANGERIE DU PARC',
        'etat_administratif': 'A',
        'activite_principale': '10.71C',
        'tranche_effectif_salarie': '01',
        'date_creation': LAST_MONTH,
        'opposition_diffusion_commerciale': False,
        'matching_etablissements': [
            {
                'siret': f'{siren}00012',
                'latitude': '45.7601',
                'longitude': '4.8402',
                'adresse': '3 Place du Parc 69006 Lyon',
                'etat_administratif': 'A',
                'liste_enseignes': None,
            }
        ],
    }
    row.update(kw)
    return row


@respx.mock
async def test_sirene_respects_opt_outs() -> None:
    respx.get('https://sirene.example/near_point').mock(
        return_value=httpx.Response(
            200,
            json={
                'results': [
                    company('111111111'),
                    company('222222222', opposition_diffusion_commerciale=True),
                    company('333333333', etat_administratif='C'),
                ],
                'total_pages': 1,
            },
        )
    )
    async with httpx.AsyncClient() as client:
        found = await sirene.search(
            client, 'https://sirene.example', 45.76, 4.84, 2, [BAKERY], False, None
        )
    assert [b.id for b in found] == ['siret:11111111100012']
    assert found[0].name == 'Boulangerie Du Parc'
    assert found[0].size == '1-2'


@respx.mock
async def test_sirene_size_and_age_filters() -> None:
    respx.get('https://sirene.example/near_point').mock(
        return_value=httpx.Response(
            200,
            json={
                'results': [
                    company('111111111', tranche_effectif_salarie='22'),
                    company('222222222', date_creation='1998-01-01'),
                ],
                'total_pages': 1,
            },
        )
    )
    async with httpx.AsyncClient() as client:
        small = await sirene.search(
            client, 'https://sirene.example', 45.76, 4.84, 2, [BAKERY], False, 'small'
        )
        recent = await sirene.search(
            client, 'https://sirene.example', 45.76, 4.84, 2, [BAKERY], True, None
        )
    assert [b.id for b in small] == ['siret:22222222200012']
    assert [b.id for b in recent] == ['siret:11111111100012']


def test_merge_joins_map_and_registry() -> None:
    from_map = Business(
        id='osm:node/1',
        name='Boulangerie du Parc',
        lat=45.7601,
        lon=4.8403,
        website='parc.fr',
        sources=['openstreetmap'],
    )
    from_registry = Business(
        id='siret:1',
        name='BOULANGERIE DU PARC SARL',
        lat=45.7602,
        lon=4.8401,
        size='1-2',
        founded='2025-09-01',
        sources=['sirene'],
    )
    far_twin = Business(id='osm:node/9', name='Boulangerie du Parc', lat=45.80, lon=4.90)
    merged = merge([from_map, from_registry, far_twin])
    assert len(merged) == 2
    assert merged[0].website == 'parc.fr'
    assert merged[0].size == '1-2'
    assert merged[0].sources == ['openstreetmap', 'sirene']
