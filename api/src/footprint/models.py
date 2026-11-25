from typing import Literal

from pydantic import BaseModel, Field

Gap = Literal[
    'no_website',
    'unreachable',
    'not_secure',
    'slow',
    'not_mobile',
    'outdated',
    'no_instagram',
    'no_facebook',
    'no_linkedin',
    'no_tiktok',
    'no_reviews',
    'no_tracking',
    'weak_seo',
    'no_contact',
]

SOCIALS = ('instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'x')


class Place(BaseModel):
    name: str
    lat: float
    lon: float
    kind: str | None = None
    country: str | None = None
    # Set for countries and regions, where searching the geometric centre is useless.
    capital: str | None = None
    # City or municipality name, for registers that search by it.
    locality: str | None = None
    # Nominatim's 0-1 prominence: tells "Moldova" (a country) from "Tesla" (a hamlet).
    importance: float = 0
    # south, north, west, east
    bbox: tuple[float, float, float, float] | None = None


class Business(BaseModel):
    id: str
    name: str
    category: str | None = None
    lat: float
    lon: float
    distance_km: float = 0
    address: str | None = None
    phone: str | None = None
    website: str | None = None
    socials: dict[str, str] = Field(default_factory=dict)
    size: str | None = None
    founded: str | None = None
    sources: list[str] = Field(default_factory=list)


class Site(BaseModel):
    reachable: bool
    final_url: str | None = None
    https: bool = False
    ssl_valid: bool | None = None
    response_ms: int | None = None
    mobile: bool | None = None
    generator: str | None = None
    outdated: list[str] = Field(default_factory=list)
    socials: dict[str, str] = Field(default_factory=dict)
    tracking: list[str] = Field(default_factory=list)
    reviews: dict[str, str] = Field(default_factory=dict)
    # What the site is built with, when it says so: wordpress, wix, shopify...
    platform: str | None = None
    title: str | None = None
    description: str | None = None
    # Search basics missing: title, meta description, a main heading.
    seo_missing: list[str] = Field(default_factory=list)
    # Business addresses published as mailto: links on the home page.
    emails: list[str] = Field(default_factory=list)
    contact: list[str] = Field(default_factory=list)
    booking: list[str] = Field(default_factory=list)
    shop: str | None = None
    structured_data: bool = False


class Footprint(BaseModel):
    business_id: str
    # 'unknown' when only the company registry knows the business: registries
    # don't record websites, so absence there proves nothing.
    website: Literal['ok', 'missing', 'unreachable', 'unknown']
    site: Site | None = None
    socials: dict[str, str] = Field(default_factory=dict)
    reviews: dict[str, str] = Field(default_factory=dict)
    google_rating: float | None = None
    google_reviews: int | None = None
    gaps: list[Gap] = Field(default_factory=list)
    # How much there is to offer this business, 0 (nothing) to 100 (everything).
    opportunity: int = 0
