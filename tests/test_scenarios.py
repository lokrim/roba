"""Tests for the scenario engine's windowed velocity surges (§18.9).

Velocity surges are applied as time-windowed ``anomaly_injections`` rather than
in-place ``sim_settings.velocity`` mutations, so successive surges spike and then
subside on their own without compounding.
"""

import pytest

from core.clock import SimClock
from core.models import SimSettings
from core.pos_simulator import WINDOW_SECONDS, POSSimulator
from core.scenarios import ScenarioEngine, _daypart_end_sim_time


def _engine(session_factory, bus):
    clock = SimClock(session_factory, bus)
    return ScenarioEngine(
        bus, session_factory, clock, pos_simulator=None, weather=None
    )


def _seed_settings(session_factory):
    session = session_factory()
    try:
        session.add(SimSettings(
            id=1, base_orders_per_day=300, velocity=1.0,
            dish_mix_weights={}, daypart_curve=None,
            channel_mix=None, anomaly_injections=None,
        ))
        session.commit()
    finally:
        session.close()


def test_daypart_end_sim_time():
    """The helper returns the end of the daypart containing the time, with
    closed-hours falling back to the operating-window close."""
    assert _daypart_end_sim_time(12 * 3600) == 15 * 3600        # lunch → 15:00
    assert _daypart_end_sim_time(19 * 3600) == 22 * 3600        # dinner → 22:00
    # Carries the day offset.
    assert _daypart_end_sim_time(86400 + 12 * 3600) == 86400 + 15 * 3600
    # 03:00 — closed → end of operating window (23:00).
    assert _daypart_end_sim_time(3 * 3600) == 23 * 3600


def test_velocity_mult_writes_window_not_velocity(session_factory, bus):
    """``_velocity_mult`` appends a daypart-bounded injection and leaves the
    user's ``sim_settings.velocity`` untouched."""
    _seed_settings(session_factory)
    engine = _engine(session_factory, bus)

    engine._velocity_mult({"mult": 1.6, "label": "Lunch rush"}, 41400.0)  # 11:30

    session = session_factory()
    try:
        settings = session.get(SimSettings, 1)
        assert settings.velocity == 1.0  # slider untouched
        injections = list(settings.anomaly_injections or [])
    finally:
        session.close()

    assert len(injections) == 1
    inj = injections[0]
    assert inj["velocity_mult"] == 1.6
    assert inj["start"] == 41400.0
    assert inj["end"] == 54000.0  # end of lunch (15:00)


def test_velocity_mult_respects_explicit_duration(session_factory, bus):
    """An explicit ``duration`` overrides the daypart-end window."""
    _seed_settings(session_factory)
    engine = _engine(session_factory, bus)

    engine._velocity_mult({"mult": 2.0, "duration": 1800.0}, 41400.0)

    session = session_factory()
    try:
        inj = list(session.get(SimSettings, 1).anomaly_injections)[0]
    finally:
        session.close()
    assert inj["end"] == 41400.0 + 1800.0


def test_velocity_surges_do_not_compound(session_factory, bus):
    """Lunch (×1.6) and dinner (×1.4) surges fired without revert events no
    longer compound: at 20:00 only the dinner window is active, so the rate is
    base ×1.4 — not ×2.24."""
    _seed_settings(session_factory)
    engine = _engine(session_factory, bus)

    engine._velocity_mult({"mult": 1.6, "label": "Lunch rush"}, 41400.0)   # 11:30
    engine._velocity_mult({"mult": 1.4, "label": "Dinner rush"}, 64800.0)  # 18:00

    clock = SimClock(session_factory, bus)
    sim = POSSimulator(bus, session_factory, clock)
    settings = sim._read_settings()

    t = 20 * 3600  # 20:00 — dinner window only (lunch ended at 15:00)
    base = (
        settings.base_orders_per_day * 1.0 * sim.daypart_weight(t) / WINDOW_SECONDS
    )
    assert sim._rate(t, settings) == pytest.approx(base * 1.4)

    # At 13:00 only the lunch window is active.
    t_lunch = 13 * 3600
    base_lunch = (
        settings.base_orders_per_day * 1.0 * sim.daypart_weight(t_lunch)
        / WINDOW_SECONDS
    )
    assert sim._rate(t_lunch, settings) == pytest.approx(base_lunch * 1.6)
