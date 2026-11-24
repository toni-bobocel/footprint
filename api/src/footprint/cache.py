import asyncio
import json
import sqlite3
import time
from typing import Any

# Scans and searches are expensive for the people hosting the open data we
# use. A small key/value table keeps us from asking twice.


class Cache:
    def __init__(self, path: str) -> None:
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute('pragma journal_mode = wal')
        self._db.execute(
            'create table if not exists kv '
            '(ns text, key text, value text, at real, primary key (ns, key))'
        )
        self._lock = asyncio.Lock()

    async def get(self, ns: str, key: str, ttl_s: float) -> Any | None:
        async with self._lock:
            row = await asyncio.to_thread(
                lambda: self._db.execute(
                    'select value, at from kv where ns = ? and key = ?', (ns, key)
                ).fetchone()
            )
        if not row or time.time() - row[1] > ttl_s:
            return None
        return json.loads(row[0])

    async def put(self, ns: str, key: str, value: Any) -> None:
        payload = json.dumps(value)

        def write() -> None:
            self._db.execute(
                'insert or replace into kv values (?, ?, ?, ?)', (ns, key, payload, time.time())
            )
            self._db.commit()

        async with self._lock:
            await asyncio.to_thread(write)

    def close(self) -> None:
        self._db.close()
