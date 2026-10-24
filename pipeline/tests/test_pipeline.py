"""Offline unit tests for the ingest/link helpers (no network)."""

import pytest

from pipeline.common import area_m2, distance_to_geom_m, normalize_name, representative_point
from pipeline.ingest_osm import _merge_rings, classify, element_geometry, parse_height
from pipeline.link_entities import kinds_compatible, name_sim, wd_kind

SQUARE = {"type": "Polygon", "coordinates": [[[-79.40, 43.66], [-79.39, 43.66], [-79.39, 43.67], [-79.40, 43.67], [-79.40, 43.66]]]}


@pytest.mark.parametrize("tags,kind", [
    ({"tourism": "artwork", "name": "x"}, "artwork"),
    ({"historic": "memorial", "memorial": "plaque"}, "plaque"),
    ({"historic": "memorial"}, "monument"),
    ({"amenity": "cafe"}, "food"),
    ({"tourism": "museum", "building": "yes"}, "building"),
    ({"tourism": "museum"}, "venue"),
    ({"amenity": "college"}, "area"),
    ({"highway": "residential"}, "street"),
    ({"highway": "motorway"}, None),
    ({"building": "yes"}, "building"),
])
def test_classify(tags, kind):
    assert classify(tags) == kind


@pytest.mark.parametrize("tags,expected", [
    ({"height": "12"}, (12.0, "osm:height")),
    ({"height": "12.5 m"}, (12.5, "osm:height")),
    ({"height": "100'"}, (30.5, "osm:height")),
    ({"building:levels": "4"}, (12.8, "osm:levels")),
    ({}, (None, None)),
])
def test_parse_height(tags, expected):
    assert parse_height(tags) == expected


def test_merge_rings_joins_reversed_segments():
    a = [[0, 0], [1, 0], [1, 1]]
    b = [[0, 0], [0, 1], [1, 1]]  # runs the other way round
    rings = _merge_rings([a, b])
    assert len(rings) == 1 and rings[0][0] == rings[0][-1] and len(rings[0]) == 5


def test_highway_ring_is_a_line_not_an_area():
    el = {"type": "way", "id": 1, "tags": {"highway": "footway"},
          "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]}
    assert element_geometry(el)["type"] == "LineString"


def test_geometry_helpers():
    lat, lon = representative_point(SQUARE)
    assert lat == pytest.approx(43.665) and lon == pytest.approx(-79.395)
    assert area_m2(SQUARE) == pytest.approx(806 * 1112, rel=0.02)
    assert distance_to_geom_m(43.665, -79.395, SQUARE) == 0
    assert distance_to_geom_m(43.665, -79.38, SQUARE) == pytest.approx(806, rel=0.02)


def test_names():
    assert normalize_name("The Royal Ontario Museum") == "royal ontario museum"
    assert name_sim("St. Basil's Church", "St Basils Church") > 0.9
    assert name_sim("Toronto Heliconian Club", "Heliconian Club") == 0.9
    assert name_sim("Hart House", "Robarts Library") < 0.5


@pytest.mark.parametrize("types,expected", [
    (["university building"], ("building", True)),
    (["public research university", "collegiate university"], (None, False)),  # "pub" must not match
    (["statue"], ("artwork", True)),
    (["watercourse"], ("river", True)),
    (["film festival edition"], (None, False)),
    (["urban park"], ("park", True)),
])
def test_wd_kind(types, expected):
    assert wd_kind({"instance_of": types}) == expected


def test_kind_compatibility():
    assert kinds_compatible("venue", "building")
    assert kinds_compatible("area", "building")  # college polygon vs "university building" item
    assert not kinds_compatible("street", "building")
    assert not kinds_compatible("food", "artwork")
