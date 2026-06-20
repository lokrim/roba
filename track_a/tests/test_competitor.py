from core.models import Call, CompetitorIntel, CompetitorOffer
from core.signals import SignalType
from track_a.agents.competitor import CompetitorAgent


def test_discovery_selection_and_call_outcome_write(bus, session_factory, seeded):
    agent = CompetitorAgent(bus, session_factory)
    targets = agent.discover_targets()
    assert [target["id"] for target in targets] == [1]

    session = session_factory()
    try:
        call = Call(agent="competitor_intel", counterparty_type="competitor", counterparty_id=1, purpose="ask favourite dish", status="completed", approval_id=None, transcript=[], outcome=None, started_at=0.0, ended_at=1.0, clock_action="freeze")
        session.add(call)
        session.commit()
        call_id = call.id
    finally:
        session.close()

    signal = bus.emit(
        SignalType.CALL_OUTCOME,
        {"call_id": call_id, "counterparty_type": "competitor", "outcome": {"popular_dishes": ["Margherita Pizza"], "price_points": {"Margherita Pizza": 11.5}}},
        source="calls",
    )
    row = agent.handle_call_outcome(signal)
    assert row is not None
    assert agent.map_popular_to_menu_item("Margherita Pizza") == 1

    session = session_factory()
    try:
        assert session.query(CompetitorIntel).count() == 1
    finally:
        session.close()


def test_passive_monitor_flags_offer_changes(bus, session_factory, seeded):
    agent = CompetitorAgent(bus, session_factory)

    first = agent.passive_monitor()
    assert first[0]["offers_changed"] is False

    session = session_factory()
    try:
        offer = session.get(CompetitorOffer, 1)
        offer.price = 9.99
        offer.updated_at = 123.0
        session.commit()
    finally:
        session.close()

    second = agent.passive_monitor()
    mario = next(row for row in second if row["competitor_id"] == 1)
    assert mario["offers_changed"] is True
