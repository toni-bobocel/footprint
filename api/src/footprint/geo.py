from math import asin, cos, radians, sin, sqrt

EARTH_KM = 6371.0088


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance; good to a few metres, which is all a map needs."""
    p1, p2 = radians(lat1), radians(lat2)
    dlat = p2 - p1
    dlon = radians(lon2 - lon1)
    h = sin(dlat / 2) ** 2 + cos(p1) * cos(p2) * sin(dlon / 2) ** 2
    return 2 * EARTH_KM * asin(sqrt(h))


def radius_for_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> float:
    """Radius that covers a place's bounding box from its centre: a city, not its whole region."""
    south, north, west, east = bbox
    corners = [(south, west), (south, east), (north, west), (north, east)]
    return max(distance_km(lat, lon, la, lo) for la, lo in corners)
