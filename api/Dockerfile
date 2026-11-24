# Build from the repository root: the API reads shared/categories.json.
FROM python:3.13-slim AS deps
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app/api
COPY api/pyproject.toml api/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project

FROM python:3.13-slim
RUN useradd --create-home --uid 10001 footprint && mkdir /data && chown footprint /data
WORKDIR /app
COPY --from=deps /app/api/.venv /app/api/.venv
COPY shared /app/shared
COPY api/src /app/api/src
ENV PATH=/app/api/.venv/bin:$PATH \
    PYTHONPATH=/app/api/src \
    FOOTPRINT_CACHE=/data/footprint.db
USER footprint
# DuckDB downloads extensions on first use; do it once here instead.
RUN python -c "import duckdb; duckdb.connect().execute('INSTALL httpfs')"
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "footprint.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
