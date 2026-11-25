import httpx
import respx

from footprint.catalog import by_id
from footprint.models import Place
from footprint.sources import registers, wikidata

BAKERY = by_id('bakery')
assert BAKERY
OSLO = Place(name='Oslo', lat=59.91, lon=10.75, country='NO', locality='Oslo')
HELSINKI = Place(name='Helsinki', lat=60.17, lon=24.94, country='FI', locality='Helsinki')


@respx.mock
async def test_norway_keeps_the_exact_class_and_drops_closed_companies() -> None:
    registers._kommuner.clear()
    respx.get(f'{registers.BRREG}/kommuner').mock(
        return_value=httpx.Response(
            200, json={'_embedded': {'kommuner': [{'navn': 'OSLO', 'nummer': '0301'}]}}
        )
    )

    def unit(no: str, code: str, **kw: object) -> dict[str, object]:
        return {
            'organisasjonsnummer': no,
            'navn': f'BAKERI {no}',
            'naeringskode1': {'kode': code},
            'forretningsadresse': {
                'adresse': ['Storgata 1'],
                'postnummer': '0155',
                'poststed': 'OSLO',
            },
            **kw,
        }

    route = respx.get(f'{registers.BRREG}/enheter').mock(
        return_value=httpx.Response(
            200,
            json={
                '_embedded': {
                    'enheter': [
                        unit('1', '10.710', hjemmeside='bakeri1.no', antallAnsatte=4),
                        unit('2', '10.730'),
                        unit('3', '10.710', konkurs=True),
                    ]
                }
            },
        )
    )
    async with httpx.AsyncClient() as client:
        found = await registers.norway(client, OSLO, [BAKERY], False, None)
    assert route.calls.last.request.url.params['naeringskode'] == '10.7'
    assert [f.business.id for f in found] == ['brreg:1']
    assert found[0].business.website == 'bakeri1.no'
    assert found[0].address == 'Storgata 1, 0155 OSLO, Norway'


@respx.mock
async def test_finland_skips_ended_companies() -> None:
    def company(bid: str, **kw: object) -> dict[str, object]:
        return {
            'businessId': {'value': bid, 'registrationDate': '2020-01-01'},
            'names': [{'name': f'Leipomo {bid}'}],
            'addresses': [
                {
                    'type': 1,
                    'street': 'MANNERHEIMINTIE',
                    'buildingNumber': '5',
                    'postCode': '00100',
                    'postOffices': [{'city': 'HELSINKI', 'languageCode': '1'}],
                }
            ],
            **kw,
        }

    respx.get(registers.PRH).mock(
        return_value=httpx.Response(
            200, json={'companies': [company('1'), company('2', endDate='2025-01-01')]}
        )
    )
    async with httpx.AsyncClient() as client:
        found = await registers.finland(client, HELSINKI, [BAKERY], False, None)
    assert [f.business.id for f in found] == ['prh:1']
    assert found[0].address == 'Mannerheimintie 5, 00100 Helsinki, Finland'
    assert found[0].business.address == 'Mannerheimintie 5, 00100 Helsinki'


@respx.mock
async def test_wikidata_reads_sites_and_accounts() -> None:
    def cell(v: str) -> dict[str, str]:
        return {'value': v}

    rows = [
        {
            'item': cell('http://www.wikidata.org/entity/Q1'),
            'itemLabel': cell('Maison Pozzoli'),
            'coord': cell('Point(4.83 45.76)'),
            'site': cell('https://pozzoli.fr'),
            'insta': cell('pozzoli'),
        },
        {'item': cell('http://www.wikidata.org/entity/Q2'), 'itemLabel': cell('Q2'),
         'coord': cell('Point(4.83 45.76)')},
    ]  # fmt: skip
    respx.get(wikidata.URL).mock(
        return_value=httpx.Response(200, json={'results': {'bindings': rows}})
    )
    async with httpx.AsyncClient() as client:
        found = await wikidata.search(client, 45.76, 4.83, 2, None)
    assert [b.name for b in found] == ['Maison Pozzoli']
    assert found[0].website == 'https://pozzoli.fr'
    assert found[0].socials == {'instagram': 'https://instagram.com/pozzoli'}
