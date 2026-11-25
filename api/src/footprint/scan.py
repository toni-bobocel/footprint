import re
import ssl
import time
from datetime import date
from urllib.parse import urlparse

import httpx
from selectolax.lexbor import LexborHTMLParser

from .models import Business, Footprint, Gap, Site

# One GET of the home page, the way a visitor's browser would make it. No
# crawling, no forms, no logins: what a prospect sees in their first second.

MAX_BYTES = 1_500_000
SLOW_MS = 3000

SOCIAL_HOSTS = {
    'instagram': ('instagram.com',),
    'facebook': ('facebook.com', 'fb.com'),
    'linkedin': ('linkedin.com',),
    'tiktok': ('tiktok.com',),
    'youtube': ('youtube.com', 'youtu.be'),
    'x': ('twitter.com', 'x.com'),
}
# Share buttons point at the network, not at the business.
SHARE = re.compile(r'/(?:sharer|share|intent|shareArticle)\b|[?&]u=', re.I)

TRACKERS = {
    'google_tag_manager': 'googletagmanager.com',
    'google_analytics': 'google-analytics.com',
    'meta_pixel': 'connect.facebook.net',
    'tiktok_pixel': 'analytics.tiktok.com',
    'linkedin_insight': 'snap.licdn.com',
}
REVIEW_HOSTS = {
    'google': (
        'g.page',
        'maps.google.',
        'google.com/maps',
        'goo.gl/maps',
        'maps.app.goo.gl',
        'search.google.com/local',
    ),
    'trustpilot': ('trustpilot.com',),
    'tripadvisor': ('tripadvisor.',),
    'yelp': ('yelp.',),
}
OLD_GENERATORS = re.compile(
    r'frontpage|dreamweaver|joomla!?\s*1\.|wordpress\s*[1-4]\.|wix\.com website builder 1', re.I
)
OLD_JQUERY = re.compile(r'jquery[.-]?(?:min\.)?(?:js)?\??(?:ver=)?1\.(?:[0-9]|1[01])\b', re.I)
UNDER_CONSTRUCTION = re.compile(
    r'under construction|coming soon|website is being built'
    r'|site en construction|en cours de construction',
    re.I,
)
# Year ranges are written with a hyphen or an en dash.
COPYRIGHT = re.compile(r'(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-\u2013]\s*)?(\d{4})', re.I)

PLATFORMS = {
    'wordpress': ('wp-content/', 'wp-includes/'),
    'wix': ('static.wixstatic.com', 'wix.com website builder'),
    'squarespace': ('static1.squarespace.com', 'squarespace'),
    'shopify': ('cdn.shopify.com',),
    'webflow': ('assets.website-files.com', 'webflow'),
    'jimdo': ('jimdo',),
    'godaddy': ('img1.wsimg.com',),
    'prestashop': ('prestashop',),
    'woocommerce': ('woocommerce',),
    'joomla': ('/media/jui/', 'joomla'),
    'drupal': ('drupal.settings', '/sites/default/files'),
    'framer': ('framerusercontent.com',),
}
BOOKING = {
    'calendly': 'calendly.com',
    'doctolib': 'doctolib.',
    'planity': 'planity.com',
    'treatwell': 'treatwell.',
    'thefork': 'thefork.',
    'opentable': 'opentable.',
    'resy': 'resy.com',
    'booksy': 'booksy.com',
    'fresha': 'fresha.com',
    'zenchef': 'zenchef',
    'booking.com': 'booking.com',
    'simplybook': 'simplybook',
    'acuity': 'acuityscheduling.com',
}
SHOPS = ('shopify', 'woocommerce', 'prestashop', 'add-to-cart', 'add_to_cart', 'snipcart', 'ecwid')
EMAIL = re.compile(r'^mailto:([^?\s]+@[^?\s]+)', re.I)

WEIGHTS: dict[Gap, int] = {
    'no_website': 40,
    'unreachable': 35,
    'not_secure': 15,
    'not_mobile': 15,
    'outdated': 10,
    'no_reviews': 10,
    'slow': 8,
    'no_instagram': 8,
    'no_tracking': 6,
    'no_facebook': 5,
    'no_linkedin': 4,
    'no_tiktok': 3,
    'weak_seo': 8,
    'no_contact': 6,
}


def normalize(url: str) -> str:
    # Try https first even when the listing says http, as browsers now do;
    # _plain_http falls back if the site really has no certificate.
    url = re.sub(r'^(?:https?:)?//', '', url.strip(), flags=re.I)
    return f'https://{url}'


async def _fetch(
    client: httpx.AsyncClient, url: str, limit_s: float
) -> tuple[httpx.Response, bytes, int]:
    started = time.monotonic()
    async with client.stream('GET', url, timeout=limit_s, follow_redirects=True) as res:
        elapsed = int((time.monotonic() - started) * 1000)
        body = b''
        async for chunk in res.aiter_bytes():
            body += chunk
            if len(body) >= MAX_BYTES:
                break
        return res, body, elapsed


async def scan_site(
    client: httpx.AsyncClient, insecure: httpx.AsyncClient, url: str, limit_s: float
) -> Site:
    url = normalize(url)
    ssl_valid: bool | None = True
    try:
        res, body, elapsed = await _fetch(client, url, limit_s)
    except httpx.ConnectError as err:
        # A bad certificate is worth knowing about, not a reason to give up.
        if not isinstance(err.__context__, ssl.SSLError) and 'CERTIFICATE' not in str(err).upper():
            return await _plain_http(insecure, url, limit_s)
        ssl_valid = False
        try:
            res, body, elapsed = await _fetch(insecure, url, limit_s)
        except httpx.HTTPError:
            return Site(reachable=False)
    except httpx.HTTPError:
        return await _plain_http(insecure, url, limit_s)

    if res.status_code >= 400:
        return Site(reachable=False, final_url=str(res.url), response_ms=elapsed)
    return analyse(str(res.url), body, elapsed, ssl_valid)


async def _plain_http(insecure: httpx.AsyncClient, url: str, limit_s: float) -> Site:
    """Some small sites still only answer on port 80."""
    plain = re.sub(r'^https://', 'http://', url, flags=re.I)
    try:
        res, body, elapsed = await _fetch(insecure, plain, limit_s)
    except httpx.HTTPError:
        return Site(reachable=False)
    if res.status_code >= 400:
        return Site(reachable=False, final_url=str(res.url), response_ms=elapsed)
    https = str(res.url).lower().startswith('https://')
    return analyse(str(res.url), body, elapsed, None if not https else True)


def analyse(final_url: str, body: bytes, elapsed_ms: int, ssl_valid: bool | None) -> Site:
    html = body.decode('utf-8', errors='replace')
    tree = LexborHTMLParser(html)
    https = urlparse(final_url).scheme == 'https'

    viewport = tree.css_first('meta[name="viewport" i]')
    generator_node = tree.css_first('meta[name="generator" i]')
    generator = generator_node.attributes.get('content') if generator_node else None

    socials: dict[str, str] = {}
    reviews: dict[str, str] = {}
    emails: list[str] = []
    contact: set[str] = set()
    for a in tree.css('a[href]'):
        href = (a.attributes.get('href') or '').strip()
        lowered = href.lower()
        if m := EMAIL.match(href):
            contact.add('email')
            if m.group(1).lower() not in emails and len(emails) < 3:
                emails.append(m.group(1).lower())
        elif lowered.startswith('tel:'):
            contact.add('phone')
        elif lowered.startswith(('https://wa.me', 'https://api.whatsapp.com', 'whatsapp:')):
            contact.add('whatsapp')
        for network, hosts in SOCIAL_HOSTS.items():
            if (
                network not in socials
                and any(h in lowered for h in hosts)
                and not SHARE.search(href)
            ):
                socials[network] = href
        for site, hosts in REVIEW_HOSTS.items():
            if site not in reviews and any(h in lowered for h in hosts):
                reviews[site] = href

    lowered_html = html.lower()
    if tree.css_first('form input[type="email" i], form textarea'):
        contact.add('form')

    platform = next(
        (name for name, marks in PLATFORMS.items() if any(m in lowered_html for m in marks)), None
    )
    if not platform and generator:
        platform = generator.split()[0].lower()
    booking = [name for name, host in BOOKING.items() if host in lowered_html]
    shop = next((s for s in SHOPS if s in lowered_html), None)

    title_node = tree.css_first('title')
    title = (title_node.text(strip=True) if title_node else '') or None
    desc_node = tree.css_first('meta[name="description" i]')
    description = ((desc_node.attributes.get('content') or '').strip() if desc_node else '') or None
    seo_missing = [
        name
        for name, ok in (
            ('title', bool(title)),
            ('description', bool(description)),
            ('h1', tree.css_first('h1') is not None),
        )
        if not ok
    ]
    structured = (
        'application/ld+json' in lowered_html or 'itemtype="http://schema.org' in lowered_html
    )

    tracking = [name for name, marker in TRACKERS.items() if marker in lowered_html]
    if 'fbq(' in html and 'meta_pixel' not in tracking:
        tracking.append('meta_pixel')

    outdated: list[str] = []
    if generator and OLD_GENERATORS.search(generator):
        outdated.append(f'old generator: {generator}')
    if OLD_JQUERY.search(html):
        outdated.append('jQuery 1.x')
    if '.swf' in lowered_html or '<embed' in lowered_html:
        outdated.append('Flash content')
    text = tree.body.text(separator=' ') if tree.body else ''
    if UNDER_CONSTRUCTION.search(text[:5000]):
        outdated.append('under construction')
    years = [int(y) for y in COPYRIGHT.findall(html) if 1995 <= int(y) <= date.today().year]
    if years and max(years) < date.today().year - 3:
        outdated.append(f'copyright {max(years)}')

    return Site(
        reachable=True,
        final_url=final_url,
        https=https,
        ssl_valid=ssl_valid if https else None,
        response_ms=elapsed_ms,
        mobile=viewport is not None,
        generator=generator,
        outdated=outdated,
        socials=socials,
        tracking=tracking,
        reviews=reviews,
        platform=platform,
        title=title[:200] if title else None,
        description=description[:300] if description else None,
        seo_missing=seo_missing,
        emails=emails,
        contact=sorted(contact),
        booking=booking,
        shop=shop,
        structured_data=structured,
    )


def footprint(
    business: Business,
    site: Site | None,
    google: tuple[float | None, int | None, str | None] | None = None,
) -> Footprint:
    socials = dict(business.socials)
    reviews: dict[str, str] = {}
    if site:
        for k, v in site.socials.items():
            socials.setdefault(k, v)
        reviews.update(site.reviews)
    rating, count, maps_url = google or (None, None, None)
    if maps_url:
        reviews.setdefault('google', maps_url)

    gaps: list[Gap] = []
    # Map sources record websites when they exist; the register never does.
    if not business.website and not {'openstreetmap', 'overture'} & set(business.sources):
        return Footprint(
            business_id=business.id,
            website='unknown',
            socials=socials,
            reviews=reviews,
            google_rating=rating,
            google_reviews=count,
        )
    if not business.website:
        state = 'missing'
        gaps.append('no_website')
    elif not site or not site.reachable:
        state = 'unreachable'
        gaps.append('unreachable')
    else:
        state = 'ok'
        if not site.https or site.ssl_valid is False:
            gaps.append('not_secure')
        if site.response_ms and site.response_ms > SLOW_MS:
            gaps.append('slow')
        if site.mobile is False:
            gaps.append('not_mobile')
        if site.outdated:
            gaps.append('outdated')
        if not site.tracking:
            gaps.append('no_tracking')
        if site.seo_missing:
            gaps.append('weak_seo')
        if not site.contact and not business.phone:
            gaps.append('no_contact')
    for network in ('instagram', 'facebook', 'linkedin', 'tiktok'):
        if network not in socials:
            gaps.append(f'no_{network}')  # type: ignore[arg-type]
    if not reviews and not count:
        gaps.append('no_reviews')

    return Footprint(
        business_id=business.id,
        website=state,  # type: ignore[arg-type]
        site=site,
        socials=socials,
        reviews=reviews,
        google_rating=rating,
        google_reviews=count,
        gaps=gaps,
        opportunity=min(100, sum(WEIGHTS[g] for g in gaps)),
    )
