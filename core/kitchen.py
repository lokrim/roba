"""Shared kitchen-state builders used by both the REST API and the voice processor."""
from __future__ import annotations
import json
import re
from typing import Any

from . import models


def _derive_state(decision: str, status: str, cooked_at: Any) -> str:
    """Map raw Batch fields to a plain-English state string."""
    if decision == "skip":
        return "skipped"
    if status == "ready" or cooked_at is not None:
        return "cooked"
    if status == "approved":
        return "ready_to_cook"
    return "awaiting_approval"  # status == "decided"


def _sim_to_clock(sim_time: float) -> str:
    """Return e.g. 'Day 3, 14:35' from a sim_time float (seconds from midnight day 1)."""
    day = int(sim_time // 86400) + 1
    h = int((sim_time % 86400) // 3600)
    m = int((sim_time % 3600) // 60)
    return f"Day {day}, {h:02d}:{m:02d}"


def _recipe_instructions(session: Any, menu_item_id: int) -> list:
    """Return ordered recipe lines as instruction steps for the Detail view.

    Each step: {"ingredient": name, "qty": float, "unit": str, "optional": bool}.
    """
    recipe = (
        session.query(models.Recipe)
        .filter(models.Recipe.menu_item_id == menu_item_id)
        .first()
    )
    if recipe is None:
        return []

    lines = (
        session.query(models.RecipeLine)
        .filter(models.RecipeLine.recipe_id == recipe.id)
        .order_by(models.RecipeLine.id.asc())
        .all()
    )
    ing_ids = {rl.ingredient_id for rl in lines if rl.ingredient_id}
    ing_names: dict[int, str] = {}
    if ing_ids:
        ings = session.query(models.Ingredient).filter(models.Ingredient.id.in_(ing_ids)).all()
        ing_names = {i.id: i.name for i in ings}

    return [
        {
            "ingredient": ing_names.get(rl.ingredient_id, f"Ingredient #{rl.ingredient_id}"),
            "qty": float(rl.qty or 0),
            "unit": str(rl.unit or ""),
            "optional": bool(rl.optional),
        }
        for rl in lines
    ]


def batch_board(session, *, now: float, window_sim_s: float | None = None, limit: int = 40) -> dict:
    """Return a full board snapshot: counts + batch list with dish names resolved.

    Each batch row now includes ``prep_lead_time_min``, ``required_skill``,
    ``station_id``, and ``instructions`` (recipe lines) for the cook's Detail view.
    """
    query = session.query(models.Batch)
    if window_sim_s is not None:
        query = query.filter(models.Batch.decided_at >= now - window_sim_s)
    batches = query.order_by(models.Batch.decided_at.desc()).limit(limit).all()

    # Batch-load menu item names to avoid N+1
    item_ids = {b.menu_item_id for b in batches if b.menu_item_id}
    names: dict[int, str] = {}
    if item_ids:
        items = session.query(models.MenuItem).filter(models.MenuItem.id.in_(item_ids)).all()
        names = {mi.id: mi.name for mi in items}

    # Batch-load BatchDefinitions to avoid N+1
    def_ids = {b.batch_definition_id for b in batches if b.batch_definition_id}
    definitions: dict[int, Any] = {}
    if def_ids:
        defs = session.query(models.BatchDefinition).filter(models.BatchDefinition.id.in_(def_ids)).all()
        definitions = {d.id: d for d in defs}

    # Cache recipe instructions per menu_item_id (built once per unique item)
    instructions_cache: dict[int, list] = {}

    rows = []
    counts = {"cooked": 0, "approved": 0, "pending": 0, "skipped": 0}
    for b in batches:
        decision = str(b.decision or "")
        status = str(b.status or "")
        state = _derive_state(decision, status, b.cooked_at)

        # serve_window is stored as JSON {"start":..., "end":...}
        cook_by = None
        serve_end = None
        if b.serve_window:
            try:
                sw = json.loads(b.serve_window) if isinstance(b.serve_window, str) else b.serve_window
                cook_by = sw.get("start")
                serve_end = sw.get("end")
            except Exception:
                pass

        # BatchDefinition metadata
        defn = definitions.get(b.batch_definition_id) if b.batch_definition_id else None
        prep_lead_time_min = float(defn.prep_lead_time_min) if defn and defn.prep_lead_time_min else None
        required_skill = str(defn.required_skill) if defn and defn.required_skill else None
        station_id = int(defn.station_id) if defn and defn.station_id else None

        # Recipe instructions (cached per item)
        mid = b.menu_item_id
        if mid is not None and mid not in instructions_cache:
            instructions_cache[mid] = _recipe_instructions(session, mid)
        instructions = instructions_cache.get(mid, [])

        rows.append({
            "id": b.id,
            "menu_item_id": b.menu_item_id,
            "batch_definition_id": b.batch_definition_id,
            "dish": names.get(b.menu_item_id, f"Item #{b.menu_item_id}"),
            "decision": decision,
            "status": status,
            "state": state,
            "planned_qty": b.planned_qty,
            "actual_made_qty": b.actual_made_qty,
            "sold_qty": b.sold_qty,
            "wasted_qty": b.wasted_qty,
            "decided_at": b.decided_at,
            "cooked_at": b.cooked_at,
            "cook_by": cook_by,
            "serve_end": serve_end,
            "approval_id": b.approval_id,
            "prep_lead_time_min": prep_lead_time_min,
            "required_skill": required_skill,
            "station_id": station_id,
            "instructions": instructions,
        })

        if state == "cooked":
            counts["cooked"] += 1
        elif state == "ready_to_cook":
            counts["approved"] += 1
        elif state == "awaiting_approval":
            counts["pending"] += 1
        elif state == "skipped":
            counts["skipped"] += 1

    return {
        "generated_at_sim": now,
        "clock": _sim_to_clock(now),
        "counts": counts,
        "batches": rows,
    }


def _resolve_menu_item(session, dish: str) -> models.MenuItem | None:
    """Resolve a dish reference (id, '#3', 'dish 3', name substring) to a MenuItem."""
    text = dish.strip()
    # Numeric or '#N' or 'dish N' → look up by ID
    m = re.fullmatch(r"#?(?:dish\s*)?(\d+)", text, re.IGNORECASE)
    if m:
        return session.get(models.MenuItem, int(m.group(1)))
    # Case-insensitive exact name
    item = session.query(models.MenuItem).filter(
        models.MenuItem.name.ilike(text)
    ).first()
    if item:
        return item
    # Substring
    return session.query(models.MenuItem).filter(
        models.MenuItem.name.ilike(f"%{text}%")
    ).first()


def dish_status(session, dish: str, *, now: float) -> dict:
    """Return detailed status for a single dish, including answer fields."""
    mi = _resolve_menu_item(session, dish)
    if mi is None:
        return {
            "resolved": False,
            "menu_item": None,
            "batches": [],
            "latest_forecast": None,
            "pending_approval": None,
            "answer": {"prepared": False, "made_qty": None, "should_cook": False, "awaiting_approval": False},
        }

    # All batches for this dish in the last ~8 h window (wide enough to catch today's batches)
    window_s = 8 * 3600
    board = batch_board(session, now=now, window_sim_s=window_s, limit=60)
    dish_batches = [b for b in board["batches"] if b["menu_item_id"] == mi.id]

    prepared = any(b["state"] == "cooked" for b in dish_batches)
    made_qty = next((b["actual_made_qty"] for b in dish_batches if b["state"] == "cooked"), None)
    should_cook = any(b["state"] == "ready_to_cook" for b in dish_batches)
    awaiting = any(b["state"] == "awaiting_approval" for b in dish_batches)

    # Latest forecast
    forecast_row = (
        session.query(models.Forecast)
        .filter(models.Forecast.menu_item_id == mi.id)
        .order_by(models.Forecast.generated_at.desc())
        .first()
    )
    latest_forecast = None
    if forecast_row:
        latest_forecast = {
            "forecast_qty": forecast_row.forecast_qty,
            "daypart": forecast_row.daypart,
            "confidence": forecast_row.confidence,
        }

    # Pending approval for this dish (via batch ref_id)
    pending_approval = None
    for b in dish_batches:
        if b["state"] == "awaiting_approval" and b["approval_id"]:
            ar = session.get(models.ApprovalRequest, b["approval_id"])
            if ar and ar.status == "pending":
                pending_approval = {"id": ar.id, "title": ar.title, "urgency": ar.urgency}
                break

    return {
        "resolved": True,
        "menu_item": {
            "id": mi.id,
            "name": mi.name,
            "category": mi.category,
            "active": bool(mi.active),
            "dine_in_price": mi.dine_in_price,
            "online_price": mi.online_price,
        },
        "batches": dish_batches,
        "latest_forecast": latest_forecast,
        "pending_approval": pending_approval,
        "answer": {
            "prepared": prepared,
            "made_qty": made_qty,
            "should_cook": should_cook,
            "awaiting_approval": awaiting,
        },
    }
