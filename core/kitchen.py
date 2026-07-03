"""Shared kitchen-state builders used by both the REST API and the voice processor."""
from __future__ import annotations
import json
import re
from typing import Any, List, Optional

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


def batch_ingredient_block(session, menu_item_id: int) -> Optional[str]:
    """Return a short reason string if any required ingredient is out of stock, else None.

    Checks non-optional RecipeLine ingredients for this dish against
    InventoryLevel.on_hand_cached.  Returns e.g. "out of: Tomato, Mozzarella" or None.
    """
    recipe = (
        session.query(models.Recipe)
        .filter(models.Recipe.menu_item_id == menu_item_id)
        .first()
    )
    if recipe is None:
        return None  # no recipe → can't block

    lines = (
        session.query(models.RecipeLine)
        .filter(
            models.RecipeLine.recipe_id == recipe.id,
            models.RecipeLine.optional == 0,  # only required lines
        )
        .all()
    )
    ing_ids = [rl.ingredient_id for rl in lines if rl.ingredient_id]
    if not ing_ids:
        return None

    ings = session.query(models.Ingredient).filter(models.Ingredient.id.in_(ing_ids)).all()
    ing_names = {i.id: i.name for i in ings}

    inv_rows = (
        session.query(models.InventoryLevel)
        .filter(models.InventoryLevel.ingredient_id.in_(ing_ids))
        .all()
    )
    on_hand: dict[int, float] = {r.ingredient_id: float(r.on_hand_cached or 0) for r in inv_rows}

    missing = [
        ing_names.get(iid, f"ingredient #{iid}")
        for iid in ing_ids
        if on_hand.get(iid, 0) <= 0
    ]
    if not missing:
        return None
    return "out of: " + ", ".join(missing)


def cancel_pending_batches_for_items(
    session,
    item_ids: List[int],
    now: float,
    reason: str = "ingredient unavailable",
) -> List[int]:
    """Cancel all pending cook batches for the given menu item IDs.

    Sets decision='skip', planned_qty=0 for batches that are:
      - menu_item_id in item_ids
      - decision == 'cook'
      - status in ('decided', 'approved')
      - cooked_at is None
      - serve_window end > now (not yet past)

    Returns list of cancelled batch IDs.
    """
    if not item_ids:
        return []

    cancelled: List[int] = []
    batches = (
        session.query(models.Batch)
        .filter(
            models.Batch.menu_item_id.in_(item_ids),
            models.Batch.decision == "cook",
            models.Batch.status.in_(["decided", "approved"]),
            models.Batch.cooked_at.is_(None),
        )
        .all()
    )
    for b in batches:
        # Check that the serve window hasn't already ended
        try:
            sw = json.loads(b.serve_window) if isinstance(b.serve_window, str) else (b.serve_window or {})
            if float(sw.get("end", 0)) <= now:
                continue  # already past — leave as-is
        except Exception:  # noqa: BLE001
            pass
        b.decision = "skip"
        b.planned_qty = 0.0
        cancelled.append(int(b.id))
    return cancelled


def batch_board(session, *, now: float, window_sim_s: float | None = None, limit: int = 40) -> dict:
    """Return a full board snapshot: counts + batch list with dish names resolved.

    Each batch row now includes ``prep_lead_time_min``, ``required_skill``,
    ``station_id``, and ``instructions`` (recipe lines) for the cook's Detail view.
    """
    query = session.query(models.Batch)
    if window_sim_s is not None:
        query = query.filter(models.Batch.decided_at >= now - window_sim_s)
    batches = query.order_by(models.Batch.decided_at.desc()).limit(limit).all()

    # Batch-load menu item names + active flag to avoid N+1
    item_ids = {b.menu_item_id for b in batches if b.menu_item_id}
    names: dict[int, str] = {}
    item_active: dict[int, bool] = {}
    if item_ids:
        items = session.query(models.MenuItem).filter(models.MenuItem.id.in_(item_ids)).all()
        names = {mi.id: mi.name for mi in items}
        item_active = {mi.id: bool(mi.active) for mi in items}

    # Batch-load BatchDefinitions to avoid N+1
    def_ids = {b.batch_definition_id for b in batches if b.batch_definition_id}
    definitions: dict[int, Any] = {}
    if def_ids:
        defs = session.query(models.BatchDefinition).filter(models.BatchDefinition.id.in_(def_ids)).all()
        definitions = {d.id: d for d in defs}

    # Cache recipe instructions and ingredient-block results per menu_item_id
    instructions_cache: dict[int, list] = {}
    ingredient_block_cache: dict[int, Optional[str]] = {}

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

        # Feasibility: cook batches that haven't been cooked yet need ingredient check
        feasible = True
        blocked_reason: Optional[str] = None
        if decision == "cook" and b.cooked_at is None and mid is not None:
            if not item_active.get(mid, True):
                feasible = False
                blocked_reason = "item disabled"
            else:
                if mid not in ingredient_block_cache:
                    ingredient_block_cache[mid] = batch_ingredient_block(session, mid)
                ing_block = ingredient_block_cache[mid]
                if ing_block:
                    feasible = False
                    blocked_reason = ing_block

        rows.append({
            "id": b.id,
            "menu_item_id": b.menu_item_id,
            "batch_definition_id": b.batch_definition_id,
            "dish": names.get(b.menu_item_id, f"Item #{b.menu_item_id}"),
            "decision": decision,
            "status": status,
            "state": state,
            "feasible": feasible,
            "blocked_reason": blocked_reason,
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
            if feasible:
                counts["approved"] += 1
        elif state == "awaiting_approval":
            if feasible:
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
