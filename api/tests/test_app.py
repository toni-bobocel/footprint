import json
from pathlib import Path

import httpx
import respx
from fastapi.testclient import TestClient

from footprint.app import create_app
from footprint.config import Settings

LYON = {
    'display_name': 'Lyon, Métropole de Lyon, France',
    'lat': '45.7578',
    'lon': '4.8320',
    'addresstype': 'city',
    'boundingbox': ['45.7073', '45.8082', '4.7718', '4.8983'],
    'address': {'country_code': 'fr'},
}
OSM = {
    'elements': [
        {
            'type': 'node',
            'id': 1,
            'lat': 45.7601,
            'lon': 4.8403,
            'tags': {'shop': 'bakery', 'name': 'Au Pain Doré'},
        },
        {
            'type': 'node',
            'id': 2,
            'lat': 45.7621,
            'lon': 4.8303,
            'tags': {'shop': 'bakery', 'name': 'Pozzoli', 'website': 'https://pozzoli.example'},
        },
    ]
}


def events(body: str) -> list[tuple[str, dict[str, object]]]:
    out = []
    for block in body.strip().split('\n\n'):
        lines = dict(line.split(': ', 1) for line in block.splitlines())
        out.append((lines['event'], json.loads(lines['data'])))
    return out


@respx.mock
def test_search_streams_place_businesses_and_footprints(tmp_path: Path) -> None:
    respx.get('https://nominatim.example/search').mock(
        return_value=httpx.Response(200, json=[LYON])
    )
    respx.post('https://overpass.example/api').mock(return_value=httpx.Response(200, json=OSM))
    respx.get('https://sirene.example/near_point').mock(
        return_value=httpx.Response(200, json={'results': [], 'total_pages': 1})
    )
    respx.get('https://pozzoli.example').mock(
        return_value=httpx.Response(200, html='<meta name="viewport" content="width=device-width">')
    )
    settings = Settings(
        overpass_urls=['https://overpass.example/api'],
        nominatim_url='https://nominatim.example',
        sirene_url='https://sirene.example',
        cache_path=str(tmp_path / 'cache.db'),
        overture=False,
    )
    with TestClient(create_app(settings)) as client:
        res = client.get('/api/search', params={'q': 'bakeries in Lyon without a website'})
    assert res.status_code == 200
    stream = events(res.text)
    kinds = [k for k, _ in stream]
    assert kinds[:2] == ['intent', 'place']
    assert kinds[-1] == 'done'
    assert stream[0][1]['gaps'] == ['no_website']

    footprints = {d['business_id']: d for k, d in stream if k == 'footprint'}
    assert footprints['osm:node/1']['website'] == 'missing'
    assert footprints['osm:node/2']['website'] == 'ok'
    assert stream[-1][1]['count'] == 2


def test_search_needs_a_place(tmp_path: Path) -> None:
    settings = Settings(cache_path=str(tmp_path / 'cache.db'), overture=False)
    with TestClient(create_app(settings)) as client:
        res = client.get('/api/search', params={'q': 'bakeries'})
    stream = events(res.text)
    assert stream[-1][0] == 'problem'
    assert stream[-1][1]['code'] == 'no_place'
