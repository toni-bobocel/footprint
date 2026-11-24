import os
from dataclasses import dataclass, field


def _list(name: str, default: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, default).split(',') if v.strip()]


@dataclass(frozen=True)
class Settings:
    # Public Overpass instances are shared and often saturated; we walk the
    # list in order and move on after a timeout or a 429/5xx.
    overpass_urls: list[str] = field(
        default_factory=lambda: _list(
            'OVERPASS_URLS',
            'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter',
        )
    )
    overpass_timeout_s: float = float(os.environ.get('OVERPASS_TIMEOUT_S', '25'))
    nominatim_url: str = os.environ.get('NOMINATIM_URL', 'https://nominatim.openstreetmap.org')
    sirene_url: str = os.environ.get('SIRENE_URL', 'https://recherche-entreprises.api.gouv.fr')
    # Identifies the tool to the open-data operators, as their usage policies ask.
    user_agent: str = os.environ.get(
        'FOOTPRINT_USER_AGENT', 'footprint/0.1 (+https://github.com/toni-bobocel/footprint)'
    )
    cache_path: str = os.environ.get('FOOTPRINT_CACHE', 'footprint.db')
    scan_concurrency: int = int(os.environ.get('SCAN_CONCURRENCY', '12'))
    scan_timeout_s: float = float(os.environ.get('SCAN_TIMEOUT_S', '8'))
    max_results: int = int(os.environ.get('MAX_RESULTS', '300'))
    google_places_key: str | None = os.environ.get('GOOGLE_PLACES_KEY') or None
    cors_origins: list[str] = field(
        default_factory=lambda: _list(
            'CORS_ORIGINS', 'http://localhost:5173,https://toni-bobocel.github.io'
        )
    )
