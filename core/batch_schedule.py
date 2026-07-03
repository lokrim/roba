"""Utility to materialise a realistic full-day batch schedule for the demo.

The ``batches`` table is populated by the forecaster's ``decide_batches()``
at runtime, but that only fires during the matching daypart (lunch/dinner by
default).  This module lets us seed a whole day's worth of staggered batch
rows immediately — useful for demos and for the cook's Batches panel to have
content from the moment the sim starts.

Usage::

    from core.batch_schedule import seed_day_schedule
    seed_day_schedule(session, now=sim_time)
"""
from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional

from . import models
from .clock import DAY_CLOSE_OFFSET, DAY_OPEN_OFFSET, SECONDS_PER_DAY


def _round_qty(qty: float, defn: models.BatchDefinition) -> int:
    step = float(defn.batch_size_step or 1.0)
    lo = float(defn.batch_size_min or 0.0)
    hi = float(defn.batch_size_max or max(qty, lo))
    rounded = round(qty / step) * step if step > 0 else math.floor(qty + 0.5)
    return int(max(0, min(hi, max(lo, rounded))))


def _latest_forecast_qty(
    session: Any,
    menu_item_id: int,
    defn: models.BatchDefinition,
) -> int:
    """Return planned qty based on the most recent forecast, or fall back to batch_size_min."""
    row = (
        session.query(models.Forecast)
        .filter(models.Forecast.menu_item_id == menu_item_id)
        .order_by(models.Forecast.generated_at.desc(), models.Forecast.id.desc())
        .first()
    )
    raw = float(row.forecast_qty) if row else float(defn.batch_size_min or 4)
    return max(_round_qty(raw, defn), int(defn.batch_size_min or 1))


def _build_recipe_instructions(session: Any, menu_item_id: int, defn: models.BatchDefinition) -> List[Dict[str, Any]]:
    """Return ordered recipe lines as instruction steps.

    Each step is {"ingredient": name, "qty": float, "unit": str, "optional": bool}.
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

    # Bulk-load ingredient names
    ing_ids = {rl.ingredient_id for rl in lines if rl.ingredient_id}
    names: Dict[int, str] = {}
    if ing_ids:
        ings = session.query(models.Ingredient).filter(models.Ingredient.id.in_(ing_ids)).all()
        names = {i.id: i.name for i in ings}

    return [
        {
            "ingredient": names.get(rl.ingredient_id, f"Ingredient #{rl.ingredient_id}"),
            "qty": float(rl.qty or 0),
            "unit": str(rl.unit or ""),
            "optional": bool(rl.optional),
        }
        for rl in lines
    ]


def seed_day_schedule(
    session: Any,
    *,
    now: float,
    clear: bool = True,
) -> List[models.Batch]:
    """Materialise a full-day batch schedule from the current BatchDefinitions.

    Generates one Batch row per cadence-slot for every active batchable item,
    spanning the whole operating day (08:00–22:00).  Statuses are assigned
    relative to *now* so the cook panel immediately shows a mix of cooked,
    ready-to-cook, and upcoming batches.

    Injects a couple of ``decision="skip"`` (forecaster-cancelled) slots
    spread across the day so the "Cancelled" styling is demonstrable.

    Args:
        session: SQLAlchemy session to use (caller owns its lifecycle).
        now: Current sim-time in seconds.
        clear: When True, delete today's existing batch rows first (idempotent).

    Returns:
        List of newly created (flushed, not yet committed) Batch rows.
    """
    day_num = int(now // SECONDS_PER_DAY)
    day_open = day_num * SECONDS_PER_DAY + DAY_OPEN_OFFSET   # 08:00
    day_close = day_num * SECONDS_PER_DAY + DAY_CLOSE_OFFSET  # 23:00

    if clear:
        # Delete batches decided on or after the start of this operating day.
        session.query(models.Batch).filter(
            models.Batch.decided_at >= day_open - 3600,
        ).delete()
        session.flush()

    definitions = (
        session.query(models.BatchDefinition)
        .order_by(models.BatchDefinition.id.asc())
        .all()
    )

    created: List[models.Batch] = []

    for defn in definitions:
        item = session.get(models.MenuItem, defn.menu_item_id)
        if item is None or not item.active:
            continue
        if not getattr(item, "is_batchable", True):
            # Gracefully skip if the column exists and is False
            if hasattr(item, "is_batchable") and not item.is_batchable:
                continue

        cadence_s = float(defn.default_cadence_min or 120) * 60
        prep_s = float(defn.prep_lead_time_min or 20) * 60
        planned_qty = _latest_forecast_qty(session, defn.menu_item_id, defn)

        # Build slot list for the full operating day
        slots: List[float] = []
        t = day_open
        while t < day_close - cadence_s / 2:
            slots.append(t)
            t += cadence_s

        if not slots:
            continue

        # Pick 2 slots to cancel — spread one early, one late
        n = len(slots)
        skip_indices = set()
        if n >= 4:
            skip_indices.add(n // 4)         # ~25% through day
            skip_indices.add(n * 3 // 4)     # ~75% through day
        elif n >= 2:
            skip_indices.add(n - 1)

        for i, slot_start in enumerate(slots):
            slot_end = slot_start + cadence_s
            decided_at = max(day_open, slot_start - prep_s)

            if i in skip_indices:
                # Forecaster-cancelled slot
                batch = models.Batch(
                    batch_definition_id=defn.id,
                    menu_item_id=defn.menu_item_id,
                    decided_at=decided_at,
                    serve_window={"start": float(slot_start), "end": float(slot_end)},
                    decision="skip",
                    planned_qty=0.0,
                    actual_made_qty=0.0,
                    sold_qty=0.0,
                    wasted_qty=0.0,
                    status="decided",
                    by="agent",
                )
            elif slot_end <= now:
                # Already past — mark as cooked
                batch = models.Batch(
                    batch_definition_id=defn.id,
                    menu_item_id=defn.menu_item_id,
                    decided_at=decided_at,
                    serve_window={"start": float(slot_start), "end": float(slot_end)},
                    decision="cook",
                    planned_qty=float(planned_qty),
                    actual_made_qty=float(max(1, round(planned_qty * 0.92))),
                    sold_qty=0.0,
                    wasted_qty=0.0,
                    status="ready",
                    cooked_at=slot_start + cadence_s * 0.5,
                    by="agent",
                )
            elif slot_start <= now + cadence_s * 1.5:
                # Current window or next one — ready to cook
                batch = models.Batch(
                    batch_definition_id=defn.id,
                    menu_item_id=defn.menu_item_id,
                    decided_at=decided_at,
                    serve_window={"start": float(slot_start), "end": float(slot_end)},
                    decision="cook",
                    planned_qty=float(planned_qty),
                    actual_made_qty=0.0,
                    sold_qty=0.0,
                    wasted_qty=0.0,
                    status="approved",
                    by="agent",
                )
            else:
                # Future slot — awaiting approval
                batch = models.Batch(
                    batch_definition_id=defn.id,
                    menu_item_id=defn.menu_item_id,
                    decided_at=decided_at,
                    serve_window={"start": float(slot_start), "end": float(slot_end)},
                    decision="cook",
                    planned_qty=float(planned_qty),
                    actual_made_qty=0.0,
                    sold_qty=0.0,
                    wasted_qty=0.0,
                    status="decided",
                    by="agent",
                )

            session.add(batch)
            created.append(batch)

    session.flush()
    return created
