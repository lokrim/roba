import pytest

from core.models import (
    Batch,
    DemandForecasterMemory,
    EventLog,
    Forecast,
    ForecastAdjustment,
    ForecastOverride,
    ForecastTrace,
    Signal,
    SimSettings,
)
from core.signals import SignalType
from track_a.agents.forecaster import DemandForecaster


class FakeSuggestionLLM:
    def complete(self, messages, json_schema=None, max_tokens=800, use_site="", **_kwargs):
        return {
            "summary": "resize_batches",
            "suggestions": [
                {
                    "action": "resize",
                    "menu_item_id": 1,
                    "reason": "demand above baseline",
                }
            ],
        }


class FakeOptimizerLLM:
    def complete(self, messages, json_schema=None, max_tokens=800, use_site="", **_kwargs):
        if use_site == "forecaster_optimization":
            return {
                "item_adjustments": [
                    {
                        "menu_item_id": 1,
                        "multipliers": {"weather": 2.0},
                        "hard_override_qty": None,
                        "reason": "Cold rain strongly favors pizza.",
                        "confidence": 0.9,
                    }
                ],
                "global_notes": [],
                "memory_updates": [],
                "confidence": 0.9,
            }
        return {"suggestions": [], "summary": "no_change"}


class FakeTargetForecastLLM:
    def complete(self, messages, json_schema=None, max_tokens=800, use_site="", **_kwargs):
        return {
            "item_adjustments": [
                {
                    "menu_item_id": 1,
                    "forecast": 3.6,
                    "reason": "Storm conditions soften dine-in demand.",
                    "confidence": 0.82,
                }
            ],
            "global_notes": ["Storm impact applied to the forecast."],
            "memory_updates": ["Cold storm pattern lowered demand for this run."],
            "confidence": 0.82,
        }


def test_forecast_applies_multipliers_and_explains(bus, session_factory, seeded):
    bus.emit(
        SignalType.USER_FACT,
        {
            "intent": "add_event",
            "entity_type": "event",
            "entity_ref": "parade",
            "attribute": "demand_multiplier",
            "value": 1.35,
            "effective_window": {"start": 28800.0, "end": 39600.0},
            "raw_text": "parade today",
        },
        source="test",
    )
    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        stored = session.query(Forecast).filter(Forecast.menu_item_id == 1).first()
        assert stored.baseline_qty == 10.0
        assert stored.multipliers["settings_demand"] == pytest.approx(0.396)
        assert stored.multipliers["event"] == 1.35
        assert stored.multipliers["weather"] == 1.18
        assert stored.forecast_qty == 6
        assert stored.confidence > 0
    finally:
        session.close()


def test_large_event_value_is_treated_as_attendance_not_multiplier(bus, session_factory, seeded):
    bus.emit(
        SignalType.USER_FACT,
        {
            "intent": "add_event",
            "entity_type": "event",
            "entity_ref": "food fest",
            "attribute": "demand_multiplier",
            "value": 800,
            "effective_window": {"start": 28800.0, "end": 39600.0},
            "raw_text": "Food fest from 09:00 for 800 people",
        },
        source="test",
    )
    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        stored = session.query(Forecast).filter(Forecast.menu_item_id == 1).first()
        assert stored.multipliers["event"] == pytest.approx(1.8)
        assert stored.forecast_qty < 100
        log = next(
            row for row in session.query(EventLog).filter(EventLog.category == "forecast").all()
            if row.detail.get("forecast_id") == stored.id
        )
        assert "food fest attendance 800" in log.detail["explanations"]["event"]
        assert "Station and qualified-staff capacity" not in str(log.detail["explanations"].values())
    finally:
        session.close()


def test_forecast_reflects_sim_settings_over_historical_baseline(bus, session_factory, seeded):
    session = session_factory()
    try:
        settings = session.get(SimSettings, 1)
        settings.base_orders_per_day = 200
        settings.velocity = 1.0
        settings.dish_mix_weights = {"1": 3.0, "2": 1.0}
        settings.daypart_curve = {"breakfast": 0.5}
        session.commit()
    finally:
        session.close()

    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        stored = session.query(Forecast).filter(Forecast.menu_item_id == 1).first()
        assert stored.baseline_qty == 10.0
        assert stored.multipliers["settings_demand"] == pytest.approx(2.474)
        assert stored.forecast_qty == 29
    finally:
        session.close()


def test_forecast_prorates_to_remaining_window(bus, session_factory, seeded):
    bus.sim_time = 34200.0  # 09:30, halfway through the 08:00-11:00 breakfast window.

    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        stored = session.query(Forecast).filter(Forecast.menu_item_id == 1).first()
        assert stored.window == {"start": 34200.0, "end": 39600.0}
        assert stored.baseline_qty == 5.0
        assert stored.multipliers["settings_demand"] == pytest.approx(0.396)
        assert stored.forecast_qty == 2
    finally:
        session.close()


def test_batch_skip_truth_table_for_stockout_and_staff(bus, session_factory, seeded):
    bus.emit(
        SignalType.STOCKOUT_RISK,
        {"ingredient_id": 1, "on_hand": 1.0, "projected_runout": 30000.0, "affected_items": [1]},
        source="test",
    )
    bus.emit(
        SignalType.STAFF_COVERAGE,
        {"station_id": 2, "covered": False, "affected_items": [2], "shortfall": 1.0},
        source="test",
        ttl=3600.0,
    )
    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        decisions = {row.menu_item_id: row.decision for row in session.query(Batch).all()}
        assert decisions[1] == "skip"
        assert decisions[2] == "skip"
    finally:
        session.close()


def test_hard_constraints_preserve_latent_demand_in_trace(bus, session_factory, seeded):
    bus.emit(
        SignalType.STOCKOUT_RISK,
        {"ingredient_id": 1, "on_hand": 1.0, "projected_runout": 30000.0, "affected_items": [1]},
        source="test",
    )
    bus.emit(
        SignalType.STAFF_COVERAGE,
        {"station_id": 2, "covered": False, "affected_items": [2], "shortfall": 1.0},
        source="test",
        ttl=3600.0,
    )
    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        logs = {
            row.detail["menu_item_id"]: row.detail
            for row in session.query(EventLog).filter(EventLog.category == "forecast").all()
            if isinstance(row.detail, dict) and row.detail.get("menu_item_id") in {1, 2}
        }

        stockout_final = logs[1]["trace"]["final"]
        assert logs[1]["forecast_qty"] == 0
        assert stockout_final["zero_reason"] == "availability_blocked"
        assert stockout_final["latent_demand_qty"] > 0
        assert stockout_final["constrained_raw_qty"] == 0

        staff_final = logs[2]["trace"]["final"]
        assert logs[2]["forecast_qty"] == 0
        assert staff_final["zero_reason"] == "staff_unavailable"
        assert staff_final["latent_demand_qty"] > 0
        assert staff_final["constrained_raw_qty"] == 0
    finally:
        session.close()


def test_batch_decision_ignores_stale_forecast_window(bus, session_factory, seeded):
    session = session_factory()
    try:
        session.add(
            Forecast(
                menu_item_id=1,
                window={"start": 28800.0, "end": 39600.0},
                daypart="breakfast",
                forecast_qty=20.0,
                baseline_qty=10.0,
                multipliers={"event": 2.0},
                confidence=0.9,
                generated_at=28800.0,
                trigger_reason="stale",
            )
        )
        session.commit()
    finally:
        session.close()

    bus.sim_time = 34200.0
    agent = DemandForecaster(bus, session_factory)
    agent.decide_batches("test")

    session = session_factory()
    try:
        decision = session.query(Batch).filter(Batch.menu_item_id == 1).one()
        assert decision.decision == "skip"
        log = next(
            row for row in session.query(EventLog).filter(EventLog.category == "batch").all()
            if row.detail.get("menu_item_id") == 1
        )
        assert log.detail["forecast_id"] is None
        assert "no current-window forecast" in log.detail["reasons"]
    finally:
        session.close()


def test_forecast_emits_run_trace_for_explanations(bus, session_factory, seeded):
    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        stored = session.query(Forecast).filter(Forecast.menu_item_id == 1).first()
        signal = next(
            row for row in session.query(Signal).filter(Signal.type == SignalType.DEMAND_FORECAST.value).all()
            if row.payload.get("menu_item_id") == 1
        )
        assert signal.payload["run_id"].startswith("fr:28800:breakfast")
        assert signal.payload["trace"]["run_id"] == signal.payload["run_id"]
        assert signal.payload["trace"]["scope"]["menu_item_id"] == 1
        assert signal.payload["trace"]["adjustments"]

        log = next(
            row for row in session.query(EventLog).filter(EventLog.category == "forecast").all()
            if row.detail.get("forecast_id") == stored.id
        )
        assert log.detail["trace"]["summary"]
        assert log.detail["trace"]["final"]["production_recommendation_qty"] == stored.forecast_qty
    finally:
        session.close()


def test_forecast_writes_durable_trace_ledger(bus, session_factory, seeded):
    agent = DemandForecaster(bus, session_factory)
    agent.run_forecast("test")

    session = session_factory()
    try:
        forecast_ids = {row.id for row in session.query(Forecast).all()}
        traces = session.query(ForecastTrace).all()
        assert {row.forecast_id for row in traces} == forecast_ids

        trace = next(row for row in traces if row.menu_item_id == 1)
        assert trace.run_id.startswith("fr:28800:breakfast")
        assert trace.trace["scope"]["menu_item_id"] == 1
        assert trace.summary == trace.trace["summary"]

        adjustments = (
            session.query(ForecastAdjustment)
            .filter(ForecastAdjustment.forecast_id == trace.forecast_id)
            .all()
        )
        keys = {row.modifier_key for row in adjustments}
        assert {"settings_demand", "weather", "recent_velocity"}.issubset(keys)
        assert all(row.run_id == trace.run_id for row in adjustments)
    finally:
        session.close()


def test_forecaster_suggestions_use_llm(bus, session_factory, seeded):
    agent = DemandForecaster(bus, session_factory, llm=FakeSuggestionLLM())
    agent.run_forecast("test")
    result = agent.generate_suggestions()
    assert result["summary"] == "resize_batches"
    assert result["suggestions"][0]["action"] == "resize"


def test_manual_llm_optimization_writes_memory(bus, session_factory, seeded):
    agent = DemandForecaster(bus, session_factory, llm=FakeOptimizerLLM())
    agent.optimize_forecast("test")

    session = session_factory()
    try:
        stored = session.query(Forecast).filter(Forecast.menu_item_id == 1).first()
        assert stored.multipliers["weather"] == 2.0
        assert stored.forecast_qty == 8
        memories = session.query(DemandForecasterMemory).all()
        assert any(row.source == "llm" for row in memories)
    finally:
        session.close()


def test_manual_llm_optimization_accepts_direct_forecast_targets(bus, session_factory, seeded):
    agent = DemandForecaster(bus, session_factory, llm=FakeTargetForecastLLM())
    agent.optimize_forecast("test")

    session = session_factory()
    try:
        stored = session.query(Forecast).filter(Forecast.menu_item_id == 1).first()
        assert stored.forecast_qty == 4
        assert stored.multipliers["llm_target"] == 1.0
        memories = session.query(DemandForecasterMemory).all()
        assert any("Cold storm pattern" in str(row.insight) for row in memories)
    finally:
        session.close()


def test_manual_llm_target_persists_as_active_override(bus, session_factory, seeded):
    agent = DemandForecaster(bus, session_factory, llm=FakeTargetForecastLLM())
    agent.optimize_forecast()

    session = session_factory()
    try:
        override = session.query(ForecastOverride).filter(ForecastOverride.menu_item_id == 1).one()
        assert override.operation == "set_target"
        assert override.value == {"qty": 4}
        assert override.status == "active"
        assert override.valid_until == 39600.0
    finally:
        session.close()

    agent.run_forecast("interval")

    session = session_factory()
    try:
        latest = (
            session.query(Forecast)
            .filter(Forecast.menu_item_id == 1)
            .order_by(Forecast.generated_at.desc(), Forecast.id.desc())
            .first()
        )
        assert latest.forecast_qty == 4
        assert latest.trigger_reason == "interval"

        log = next(
            row for row in session.query(EventLog).filter(EventLog.category == "forecast").all()
            if row.detail.get("forecast_id") == latest.id
        )
        assert log.detail["multipliers"]["authority_override"] == 1.0
        assert log.detail["trace"]["summary"] == "Storm conditions soften dine-in demand."
    finally:
        session.close()
