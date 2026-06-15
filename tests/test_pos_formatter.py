"""Integration tests for the POS simulator + data formatter (§10 / §16).

Gate (this session):
- POS sim + formatter + bus over a seeded DB produce ≥1 Order and ≥1 OrderLine.
- ``formatter.item_velocity`` returns a positive float after some orders.
- A voided line produces a ``WASTE_EVENT`` with ``waste_type='cancelled_order'``.
- ``bus.notify_order_line`` is called for each non-voided line.
"""

import random

import pytest

from core.clock import SimClock, get_or_create_sim_state
from core.formatter import DataFormatter
from core.models import (
    Ingredient,
    MenuItem,
    Order,
    OrderLine,
    Recipe,
    RecipeLine,
    SimSettings,
    Station,
)
from core.pos_simulator import WINDOW_SECONDS, POSSimulator, active_injections
from core.signals import SignalType


class _StubWeather:
    """Minimal weather provider stub: ``current()`` returns a row-like object
    carrying just the ``condition`` the POS reads for the channel shift."""

    def __init__(self, condition):
        self._row = type("W", (), {"condition": condition})()

    def current(self):
        return self._row


def _set_anomaly(session_factory, injections):
    session = session_factory()
    try:
        settings = session.get(SimSettings, 1)
        settings.anomaly_injections = injections
        session.commit()
    finally:
        session.close()


def _set_sim_time(session_factory, sim_time):
    session = session_factory()
    try:
        state = get_or_create_sim_state(session)
        state.sim_time = sim_time
        state.day_number = int(sim_time // 86400)
        state.day_of_week = state.day_number % 7
        session.commit()
    finally:
        session.close()


def _seed(session_factory):
    """Tiny inline seed: 2 menu items, 1 recipe each, and POS settings."""
    session = session_factory()
    try:
        station = Station(name="line")
        session.add(station)
        session.flush()

        ing1 = Ingredient(
            name="tomato", category="produce", base_unit="g",
            perishable=1, shelf_life_days=5.0,
        )
        ing2 = Ingredient(
            name="bun", category="bakery", base_unit="each",
            perishable=1, shelf_life_days=3.0,
        )
        session.add_all([ing1, ing2])
        session.flush()

        item1 = MenuItem(
            name="Margherita", category="pizza", station_id=station.id,
            dine_in_price=12.0, online_price=14.0, prep_time_min=10.0,
            is_batchable=1, active=1,
        )
        item2 = MenuItem(
            name="Burger", category="main", station_id=station.id,
            dine_in_price=9.0, online_price=11.0, prep_time_min=8.0,
            is_batchable=0, active=1,
        )
        session.add_all([item1, item2])
        session.flush()

        recipe1 = Recipe(menu_item_id=item1.id)
        recipe2 = Recipe(menu_item_id=item2.id)
        session.add_all([recipe1, recipe2])
        session.flush()

        session.add_all([
            RecipeLine(recipe_id=recipe1.id, ingredient_id=ing1.id,
                       qty=100.0, unit="g", optional=0),
            RecipeLine(recipe_id=recipe2.id, ingredient_id=ing2.id,
                       qty=1.0, unit="each", optional=0),
        ])

        session.add(SimSettings(
            id=1,
            base_orders_per_day=300,
            velocity=1.0,
            dish_mix_weights={str(item1.id): 1.0, str(item2.id): 1.0},
            daypart_curve=None,
            channel_mix={"dine_in": 0.7, "delivery": 0.2, "takeout": 0.1},
            anomaly_injections=None,
        ))
        session.commit()
        return item1.id, item2.id
    finally:
        session.close()


@pytest.fixture
def wired(bus, session_factory):
    """A seeded DB wired with clock + formatter + POS simulator."""
    item_ids = _seed(session_factory)
    clock = SimClock(session_factory, bus)
    formatter = DataFormatter(bus, session_factory)
    sim = POSSimulator(bus, session_factory, clock, formatter=formatter)
    return sim, formatter, bus, session_factory, item_ids


def test_pos_sim_creates_orders_and_lines(wired):
    """10 ticks at 09:15 into a sim day create ≥1 Order and ≥1 OrderLine."""
    sim, formatter, bus, session_factory, _item_ids = wired

    sim_time = 28800 + 900  # 09:15
    bus.sim_time = sim_time
    for _ in range(10):
        sim.tick(sim_time)

    session = session_factory()
    try:
        orders = session.query(Order).count()
        lines = session.query(OrderLine).count()
    finally:
        session.close()

    assert orders >= 1
    assert lines >= 1


def test_item_velocity_positive_after_orders(wired):
    """After processing sold lines, item_velocity is a positive float."""
    sim, formatter, bus, session_factory, item_ids = wired
    item1_id, _item2_id = item_ids

    sim_time = 28800 + 900
    bus.sim_time = sim_time

    order = Order(sim_time=sim_time, service_mode="dine_in", channel="dine_in",
                  guest_count=1, status="closed", total=12.0)
    line = OrderLine(menu_item_id=item1_id, qty=2.0, unit_price=12.0,
                     line_total=24.0, status="sold", sim_time=sim_time)
    formatter.on_order(order, [line])

    velocity = formatter.item_velocity(item1_id)
    assert isinstance(velocity, float)
    assert velocity > 0.0


def test_voided_line_emits_cancelled_order_waste(wired):
    """A voided line produces a WASTE_EVENT(cancelled_order) on the bus and is
    NOT forwarded via notify_order_line; non-voided lines are forwarded."""
    sim, formatter, bus, session_factory, item_ids = wired
    item1_id, item2_id = item_ids

    forwarded = []
    bus.register_order_line_handler(lambda line: forwarded.append(line.menu_item_id))

    bus.sim_time = 28800 + 900
    order = Order(sim_time=bus.sim_time, service_mode="dine_in",
                  channel="dine_in", guest_count=1, status="closed", total=12.0)
    sold = OrderLine(menu_item_id=item1_id, qty=1.0, unit_price=12.0,
                     line_total=12.0, status="sold", sim_time=bus.sim_time)
    voided = OrderLine(menu_item_id=item2_id, qty=1.0, unit_price=9.0,
                       line_total=9.0, status="voided", sim_time=bus.sim_time)
    formatter.on_order(order, [sold, voided])

    waste_signals = bus.live(type=SignalType.WASTE_EVENT)
    assert any(
        s.payload.get("waste_type") == "cancelled_order"
        and s.payload.get("menu_item_id") == item2_id
        for s in waste_signals
    )
    # Cancelled-order routing: inventory + human only (§16).
    cancelled = next(
        s for s in waste_signals if s.payload.get("waste_type") == "cancelled_order"
    )
    assert set(cancelled.groups) == {"inventory", "human"}

    # notify_order_line fired for the sold line only.
    assert forwarded == [item1_id]


def test_interval_infinite_when_closed_no_zero_division(wired):
    """next_order_interval_sim_s returns +inf (not a ZeroDivisionError) when the
    daypart weight is 0 (closed hours)."""
    sim, _formatter, bus, session_factory, _ids = wired

    closed_time = 3 * 3600  # 03:00 — shut, weight 0
    _set_sim_time(session_factory, closed_time)
    bus.sim_time = closed_time

    assert sim.daypart_weight(closed_time) == 0.0
    interval = sim.next_order_interval_sim_s()
    assert interval == float("inf")


def test_tick_during_closed_hours_generates_nothing_and_recovers(wired):
    """Ticking during closed hours creates no orders and never wedges the loop:
    once the rate is positive again, arrivals resume."""
    sim, _formatter, bus, session_factory, _ids = wired

    closed_time = 3 * 3600  # 03:00 — shut
    bus.sim_time = closed_time
    for _ in range(10):
        assert sim.tick(closed_time) is None

    session = session_factory()
    try:
        assert session.query(Order).count() == 0
    finally:
        session.close()

    # next_order_due must stay finite so the loop can recover (not parked at inf).
    assert sim.next_order_due is not None
    import math as _math
    assert _math.isfinite(sim.next_order_due)

    # Reopen: a tick at 12:00 (lunch) now produces an order.
    open_time = 12 * 3600
    bus.sim_time = open_time
    order = sim.tick(open_time)
    assert order is not None

    session = session_factory()
    try:
        assert session.query(Order).count() == 1
    finally:
        session.close()


def test_daypart_weight_zero_outside_hours(wired):
    """Outside operating hours the daypart weight is 0 (no arrivals)."""
    sim, _formatter, _bus, _sf, _ids = wired
    # 03:00 into the day — closed.
    assert sim.daypart_weight(3 * 3600) == 0.0
    # 12:00 — lunch daypart, positive weight.
    assert sim.daypart_weight(12 * 3600) > 0.0


# -- weather channel shift (§18.5) -----------------------------------------

def test_weather_channel_shift_lookup(bus, session_factory):
    """``_weather_channel_shift`` maps the current condition to §18.5 factors;
    clear/clouds (and no provider / no row) yield no shift."""
    clock = SimClock(session_factory, bus)
    rain = POSSimulator(bus, session_factory, clock, weather=_StubWeather("rain"))
    assert rain._weather_channel_shift() == {"dine_in": 0.85, "delivery": 1.20}
    snow = POSSimulator(bus, session_factory, clock, weather=_StubWeather("snow"))
    assert snow._weather_channel_shift() == {"dine_in": 0.60, "delivery": 1.10}
    clear = POSSimulator(bus, session_factory, clock, weather=_StubWeather("clear"))
    assert clear._weather_channel_shift() == {}
    none = POSSimulator(bus, session_factory, clock, weather=None)
    assert none._weather_channel_shift() == {}


def test_rain_increases_delivery_share(bus, session_factory):
    """Over many orders, rain shifts the channel split toward delivery vs clear."""
    _seed(session_factory)
    clock = SimClock(session_factory, bus)
    sim_time = 12 * 3600  # lunch
    bus.sim_time = sim_time

    def delivery_share(condition):
        sim = POSSimulator(
            bus, session_factory, clock,
            rng=random.Random(123), weather=_StubWeather(condition),
        )
        deliveries = total = 0
        for _ in range(2000):
            order, _lines = sim.generate_order(sim_time)
            total += 1
            if order.channel == "delivery":
                deliveries += 1
        return deliveries / total

    assert delivery_share("rain") > delivery_share("clear")


# -- anomaly injections (§10) ----------------------------------------------

def test_active_injections_window_bounds():
    """``active_injections`` filters by ``[start, end)`` with open-ended bounds."""
    inj = [
        {"start": 100.0, "end": 200.0, "velocity_mult": 2.0},
        {"end": 50.0, "velocity_mult": 9.0},          # open start, ends at 50
        {"start": 300.0, "velocity_mult": 3.0},        # open end, starts at 300
    ]
    assert active_injections(inj, 150.0) == [inj[0]]
    assert active_injections(inj, 25.0) == [inj[1]]
    assert active_injections(inj, 500.0) == [inj[2]]
    assert active_injections(inj, 250.0) == []
    assert active_injections(None, 0.0) == []


def test_anomaly_velocity_mult_scales_rate(wired):
    """An active ``velocity_mult`` injection multiplies the Poisson rate; one
    outside the current window does not."""
    sim, _formatter, _bus, session_factory, _ids = wired
    t = 12 * 3600  # lunch

    base_rate = sim._rate(t, sim._read_settings())
    assert base_rate > 0.0

    _set_anomaly(session_factory, [{"start": 0.0, "end": 86400.0, "velocity_mult": 2.0}])
    assert sim._rate(t, sim._read_settings()) == pytest.approx(base_rate * 2.0)

    _set_anomaly(session_factory, [{"start": t + 1, "end": t + 100, "velocity_mult": 2.0}])
    assert sim._rate(t, sim._read_settings()) == pytest.approx(base_rate)


def test_anomaly_dish_skew_raises_item_share(bus, session_factory):
    """A ``dish_mix_skew`` on one item raises its share of generated lines."""
    item1_id, item2_id = _seed(session_factory)
    _set_anomaly(
        session_factory,
        [{"start": 0.0, "end": 86400.0, "dish_mix_skew": {str(item1_id): 10.0}}],
    )
    clock = SimClock(session_factory, bus)
    t = 12 * 3600
    bus.sim_time = t
    sim = POSSimulator(bus, session_factory, clock, rng=random.Random(7))

    counts = {item1_id: 0, item2_id: 0}
    for _ in range(2000):
        _order, lines = sim.generate_order(t)
        for line in lines:
            counts[line.menu_item_id] += 1

    # Base weights are uniform (1.0 each); a ×10 skew should dominate.
    assert counts[item1_id] > counts[item2_id]
