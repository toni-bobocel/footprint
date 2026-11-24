import pytest

from footprint.query import parse


@pytest.mark.parametrize(
    ('text', 'categories', 'place', 'gaps'),
    [
        ('bakeries in Lyon without a website', ['bakery'], 'lyon', ['no_website']),
        (
            'Plumbers near Manchester with no Instagram and no reviews',
            ['plumber'],
            'manchester',
            ['no_instagram', 'no_reviews'],
        ),
        ('cafes in Lyon that have no website', ['cafe'], 'lyon', ['no_website']),
        ('pet shops in Trinidad and Tobago', ['pet'], 'trinidad and tobago', []),
        ('dentists in São Paulo not mobile friendly', ['dentist'], 'são paulo', ['not_mobile']),
        ('hair salons', ['hairdresser'], None, []),
    ],
)
def test_reads_what_and_where(
    text: str, categories: list[str], place: str | None, gaps: list[str]
) -> None:
    intent = parse(text)
    assert intent.categories == categories
    assert intent.place == place
    assert intent.gaps == gaps


def test_new_in_a_place_name_is_not_a_filter() -> None:
    intent = parse('coffee shops in New York')
    assert intent.place == 'new york'
    assert not intent.recent
    assert parse('new coffee shops in Brooklyn, New York').recent


def test_longest_phrase_wins() -> None:
    assert parse('coffee shops in Rome').categories == ['cafe']


def test_coordinates_and_radius() -> None:
    intent = parse('small law firms within 20 km of 48.8566, 2.3522')
    assert intent.categories == ['lawyer']
    assert (intent.lat, intent.lon, intent.radius_km) == (48.8566, 2.3522, 20.0)
    assert intent.size == 'small'


def test_unknown_words_become_a_name_search() -> None:
    intent = parse('Tesla in Austin')
    assert intent.categories == []
    assert intent.terms == 'tesla'
    assert intent.place == 'austin'
