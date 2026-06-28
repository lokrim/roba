"""Smoke test for the voice read-query methods + inventory name/unit fix."""

import json

import pytest

from core.llm import LLMProvider
from core.seeding import Seeder
from core.voice import VoiceProcessor


@pytest.fixture
def voice(bus, session_factory, monkeypatch):
    for var in ("GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    llm = LLMProvider()
    llm._sleep = lambda *_a, **_k: None
    Seeder(llm, session_factory).load_preset("bellas_kitchen")
    bus.sim_time = 0.0
    return VoiceProcessor(llm, bus, session_factory)


def test_query_inventory_has_names_and_units(voice):
    out = voice.query_inventory()
    assert out["count"] > 0
    row = out["inventory"][0]
    assert set(["ingredient_id", "name", "unit", "on_hand"]).issubset(row)
    # every row resolves a non-empty name
    assert all(r["name"] and not str(r["name"]).isdigit() for r in out["inventory"])
    # units are base units
    assert all(r["unit"] in (None, "g", "ml", "each") for r in out["inventory"])
    print("INVENTORY SAMPLE:", json.dumps(out["inventory"][:3], indent=2))


def test_query_inventory_filter(voice):
    # pick a real ingredient name and filter by a substring of it
    first = voice.query_inventory()["inventory"][0]["name"]
    needle = first.split()[0]
    out = voice.query_inventory(needle)
    assert out["count"] >= 1
    assert any(needle.lower() in r["name"].lower() for r in out["inventory"])


def test_context_prompt_includes_names_and_units(voice):
    ctx = json.loads(voice._restaurant_context_for_prompt())
    inv = ctx["inventory"]
    assert inv, "inventory should not be empty"
    assert "name" in inv[0] and "unit" in inv[0]
    assert "inventory_units_rule" in ctx["guidance"]


def test_other_query_methods_shapes(voice):
    assert "forecasts" in voice.query_forecast()
    assert "competitors" in voice.query_competitors()
    assert "reviews" in voice.query_reviews()
    assert "staff" in voice.query_staff() and voice.query_staff()["count"] > 0
    assert "signals" in voice.query_signals()
    assert "batches" in voice.query_batches()
