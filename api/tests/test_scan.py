import httpx
import pytest
import respx

from footprint.models import Business
from footprint.scan import analyse, footprint, scan_site

MODERN = b"""<!doctype html><html><head>
<meta name="viewport" content="width=device-width">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
</head><body>
<a href="https://www.instagram.com/maisonpozzoli/">Instagram</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
<a href="https://g.page/r/abc/review">Leave us a review</a>
<footer>&copy; 2026</footer></body></html>"""

OLD = b"""<html><head><meta name="generator" content="Microsoft FrontPage 4.0"></head>
<body><script src="/js/jquery-1.4.2.min.js"></script>
<p>Copyright 2011 Garage Martin</p></body></html>"""


def shop(**kw: object) -> Business:
    kw.setdefault('sources', ['openstreetmap'])
    return Business(id='osm:node/1', name='Shop', lat=45.76, lon=4.83, **kw)  # type: ignore[arg-type]


def test_modern_site() -> None:
    site = analyse('https://pozzoli.fr/', MODERN, 420, True)
    assert site.mobile
    assert site.https
    assert site.tracking == ['google_tag_manager']
    assert site.socials == {'instagram': 'https://www.instagram.com/maisonpozzoli/'}
    assert 'google' in site.reviews
    assert site.outdated == []


def test_old_site() -> None:
    site = analyse('http://garage-martin.fr/', OLD, 3900, None)
    assert site.mobile is False
    assert not site.https
    assert any('FrontPage' in o for o in site.outdated)
    assert 'jQuery 1.x' in site.outdated
    assert 'copyright 2011' in site.outdated

    fp = footprint(shop(website='garage-martin.fr'), site)
    assert {'not_secure', 'slow', 'not_mobile', 'outdated', 'no_tracking'} <= set(fp.gaps)


def test_share_buttons_are_not_a_profile() -> None:
    site = analyse('https://x.fr/', MODERN, 100, True)
    assert 'facebook' not in site.socials


def test_no_website_is_the_biggest_gap() -> None:
    fp = footprint(shop(), None)
    assert fp.website == 'missing'
    assert fp.gaps[0] == 'no_website'
    assert fp.opportunity >= 40


def test_socials_from_the_map_count() -> None:
    fp = footprint(shop(socials={'instagram': 'pozzoli'}), None)
    assert 'no_instagram' not in fp.gaps


def test_google_reviews_from_places() -> None:
    fp = footprint(shop(), None, (4.6, 212, 'https://maps.google.com/?cid=1'))
    assert fp.google_reviews == 212
    assert 'no_reviews' not in fp.gaps


@respx.mock
async def test_falls_back_to_plain_http() -> None:
    respx.get('https://old.example/').mock(side_effect=httpx.ConnectError('refused'))
    respx.get('http://old.example/').mock(return_value=httpx.Response(200, content=OLD))
    async with httpx.AsyncClient() as client:
        site = await scan_site(client, client, 'old.example', 2)
    assert site.reachable
    assert not site.https


@respx.mock
async def test_dead_site() -> None:
    respx.get('https://gone.example/').mock(return_value=httpx.Response(404))
    async with httpx.AsyncClient() as client:
        site = await scan_site(client, client, 'https://gone.example/', 2)
    assert not site.reachable
    assert footprint(shop(website='gone.example'), site).website == 'unreachable'


@pytest.mark.parametrize('years', ['© 2014\u20132019', '© 2014-2019'])
def test_copyright_ranges(years: str) -> None:
    site = analyse('https://x.fr/', f'<footer>{years}</footer>'.encode(), 100, True)
    assert 'copyright 2019' in site.outdated


def test_registry_only_is_unknown_not_missing() -> None:
    fp = footprint(shop(sources=['sirene']), None)
    assert fp.website == 'unknown'
    assert fp.gaps == []
