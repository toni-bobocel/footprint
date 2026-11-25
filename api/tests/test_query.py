import json
from pathlib import Path
from typing import Any

import pytest

from footprint.query import fold, parse

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / 'shared' / 'query-cases.json').read_text('utf-8')
)['cases']


@pytest.mark.parametrize('case', CASES, ids=[c['q'] for c in CASES])
def test_shared_case(case: dict[str, Any]) -> None:
    intent = parse(case['q'])
    assert intent.categories == case['categories']
    assert intent.types == case.get('types', [])
    assert intent.place == case['place']
    assert intent.terms == case.get('terms')
    assert intent.gaps == case.get('gaps', [])
    assert intent.recent == case.get('recent', False)
    assert intent.size == case.get('size')
    assert intent.radius_km == case.get('radius_km')
    assert intent.lat == case.get('lat')


def test_fold_keeps_japanese_and_cyrillic() -> None:
    assert fold('Près de') == 'pres de'
    assert fold('パン屋') == 'パン屋'
    assert fold('Москва') == 'москва'
