import httpx
import respx

from footprint.catalog import by_id
from footprint.sources import overture

BAKERY = by_id('bakery')
RESTAURANT = by_id('restaurant')
assert BAKERY
assert RESTAURANT


def row(**kw: object) -> tuple[object, ...]:
    base = {
        'id': '08f1',
        'name': 'Max Poilâne Perier',
        'primary': 'bakery',
        'hierarchy': ['food_and_drink', 'bakery'],
        'lat': 45.7424,
        'lon': 4.8212,
        'websites': ['http://www.max-poilane.fr'],
        'socials': ['https://www.facebook.com/677469289044795'],
        'phones': ['+33478427005'],
        'addresses': [{'freeform': '8 Rue Smith', 'locality': 'Lyon', 'postcode': '69002'}],
    }
    base.update(kw)
    return tuple(base.values())


def test_query_filters_on_the_taxonomy_tree() -> None:
    sql, params = overture.build('2026-11-18.0', 45.75, 4.83, 2, [RESTAURANT], None, 100)
    assert 'release/2026-11-18.0/theme=places' in sql
    assert 'list_has_any(taxonomy.hierarchy, ?)' in sql
    assert params[-1] == ['restaurant']
    assert params[0] < 4.83 < params[1]
    assert params[2] < 45.75 < params[3]


def test_name_search_is_a_parameter_not_sql() -> None:
    sql, params = overture.build('r', 0, 0, 1, [], "O'Hara", 10)
    assert "O'Hara" not in sql
    assert params[-1] == "%O'Hara%"


def test_parse_keeps_the_circle_and_reads_contacts() -> None:
    far = row(id='far', lat=45.80, lon=4.90)
    unnamed = row(id='x', name=None)
    found = overture.parse([row(), far, unnamed], 45.7578, 4.8320, 3, [BAKERY])
    assert [b.id for b in found] == ['overture:08f1']
    b = found[0]
    assert b.category == 'bakery'
    assert b.website == 'http://www.max-poilane.fr'
    assert b.socials == {'facebook': 'https://www.facebook.com/677469289044795'}
    assert b.address == '8 Rue Smith, 69002 Lyon'


def test_parse_names_unlisted_categories() -> None:
    found = overture.parse(
        [row(primary='cheese_shop', hierarchy=['shopping', 'cheese_shop'])], 45.7424, 4.8212, 1, []
    )
    assert found[0].category == 'overture:cheese_shop'


@respx.mock
async def test_finds_the_latest_release() -> None:
    listing = (
        '<Prefix>release/2026-09-23.1/</Prefix><Prefix>release/2026-11-18.0/</Prefix>'
        '<Prefix>release/2026-10-21.0/</Prefix>'
    )
    respx.get(overture.LISTING).mock(return_value=httpx.Response(200, text=listing))
    async with httpx.AsyncClient() as client:
        assert await overture.latest_release(client) == '2026-11-18.0'
