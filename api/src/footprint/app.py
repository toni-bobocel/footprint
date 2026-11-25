import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .cache import Cache
from .catalog import categories
from .config import Settings
from .search import Clients, Engine


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        headers = {'User-Agent': s.user_agent, 'Accept-Language': 'en'}
        limits = httpx.Limits(max_connections=40, max_keepalive_connections=20)
        async with (
            httpx.AsyncClient(headers=headers, limits=limits, timeout=20) as http,
            # Only used to look at a site whose certificate is broken, to report it.
            httpx.AsyncClient(headers=headers, limits=limits, timeout=20, verify=False) as insecure,
        ):
            cache = Cache(s.cache_path)
            app.state.engine = Engine(s, Clients(http, insecure), cache)
            yield
            cache.close()

    app = FastAPI(
        title='footprint', lifespan=lifespan, docs_url='/api/docs', openapi_url='/api/openapi.json'
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        # Any local dev server, whatever port it picked.
        allow_origin_regex=r'http://(localhost|127\.0\.0\.1)(:\d+)?',
        allow_methods=['GET'],
        allow_headers=['*'],
    )

    def engine() -> Engine:
        return app.state.engine  # type: ignore[no-any-return]

    @app.get('/api/health')
    async def health() -> dict[str, Any]:
        return {'ok': True, 'google_reviews': bool(s.google_places_key)}

    @app.get('/api/categories')
    async def list_categories() -> list[dict[str, str]]:
        return [{'id': c.id, 'label': c.label} for c in categories()]

    @app.get('/api/geocode')
    async def geocode(q: str = Query(min_length=2, max_length=200)) -> dict[str, Any]:
        place = await engine().geocode(q)
        if not place:
            raise HTTPException(404, 'place not found')
        return place.model_dump()

    @app.get('/api/reverse')
    async def reverse(
        lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)
    ) -> dict[str, Any]:
        place = await engine().reverse(lat, lon)
        if not place:
            raise HTTPException(404, 'nothing here, probably the sea')
        return place.model_dump()

    @app.get('/api/search')
    async def search(
        q: str = Query(min_length=2, max_length=300),
        lat: float | None = Query(default=None, ge=-90, le=90),
        lon: float | None = Query(default=None, ge=-180, le=180),
        radius_km: float | None = Query(default=None, gt=0, le=50),
        lang: str = Query(default='en', pattern='^[a-z]{2}$'),
    ) -> StreamingResponse:
        async def stream() -> AsyncIterator[str]:
            async for kind, data in engine().run(q, lat, lon, radius_km, lang):
                yield f'event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n'

        return StreamingResponse(
            stream(),
            media_type='text/event-stream',
            headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
        )

    return app


app = create_app()
