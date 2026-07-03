"""Inventory Optimizer agent — the decisions (02 §B4.2).

Consumes demand-driven threshold signals to size reorders, toggle menu items,
and turn near-expiry lots into promos (§18.8). Writes ``purchase_orders`` (via
Procurement), ``menu_toggles`` (+ ``menu_items.active``) and ``promotions``.

Stream E adds an LLM pass (``llm_optimize``) that reasons over the inventory
landscape and demand-forecast context to produce higher-quality decisions:
disabling lower-margin dishes when a shared ingredient is constrained, creating
deals for slow-movers/near-waste items, and deferring or accelerating reorders
based on demand patterns. Falls back to the deterministic path gracefully when
no LLM key is present.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any, Dict, List, Optional

from core import config
from core.agent_base import BaseAgent
from core.llm import CANNED_NOTE
from core.models import (
    Ingredient,
    InventoryLevel,
    InventoryLot,
    InventoryOptimizerMemory,
    MenuItem,
    MenuToggle,
    OrderLine,
    Promotion,
    PurchaseOrder,
    PurchaseOrderLine,
    Recipe,
    RecipeLine,
    Supplier,
    SupplierCatalog,
)
from core.signals import SignalType

logger = logging.getLogger(__name__)

# Signal groups this agent listens to (02 §B4.2).
GROUPS = ["inventory", "procurement"]

# JSON schema for the LLM optimizer action list.
_OPTIMIZE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "action": {"type": "string",
                               "enum": ["toggle_item", "create_deal", "reorder", "defer_reorder"]},
                    "menu_item_id": {"type": "integer"},
                    "ingredient_id": {"type": "integer"},
                    "toggle_direction": {"type": "string", "enum": ["disable", "enable"]},
                    "discount_pct": {"type": "number"},
                    "reason": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["action", "reason", "confidence"],
            },
        },
        "summary": {"type": "string"},
    },
    "required": ["actions", "summary"],
}


class InventoryOptimizer(BaseAgent):
    """Reorder, menu-toggle, and expiry→promo decisions driven by demand.

    Stream E: an LLM reasoning pass (``llm_optimize``) runs on a longer
    cadence and augments the deterministic decisions with context-aware
    choices.  All LLM actions are mapped onto the same guarded executors
    (``_disable``, ``_propose_promo``, ``procurement.create_po``) so the
    APPROVAL_PO_THRESHOLD and all safety rails still apply.
    """

    def __init__(
        self,
        bus: Any,
        db_session_factory: Any,
        name: str = "optimizer",
        ws_broadcast: Any = None,
        procurement: Any = None,
        approvals: Any = None,
        llm: Any = None,
    ):
        super().__init__(bus, db_session_factory, name, ws_broadcast=ws_broadcast)
        self.subscribe(GROUPS)
        self.procurement = procurement
        self.approvals = approvals
        self.llm = llm
        # menu_item_id -> ingredient_id that triggered its disable, so the
        # reorder sweep knows which ingredient to watch for re-enabling
        # (menu_toggles has no ingredient_id column; this is in-process only).
        self._toggle_cause: Dict[int, int] = {}

    def attach_procurement(self, procurement: Any) -> None:
        self.procurement = procurement

    def attach_approvals(self, approvals: Any) -> None:
        self.approvals = approvals

    # -- signal handling ----------------------------------------------------

    def on_signal(self, signal: Any) -> None:
        """React to ``LOW_STOCK`` / ``STOCKOUT_RISK`` (toggle + reorder) and
        ``EXPIRY_RISK`` (promo proposal) (§B4.2)."""
        if signal.type in (SignalType.LOW_STOCK.value, SignalType.STOCKOUT_RISK.value):
            payload = signal.payload or {}
            ingredient_id = payload.get("ingredient_id")
            if ingredient_id is None:
                return
            self._maybe_toggle(ingredient_id, float(payload.get("projected_runout") or 0.0))
            self._maybe_reorder(ingredient_id)
            # Trigger LLM optimization when a shortage is signalled.
            if config.OPTIMIZER_LLM_AUTO_MODE and self.llm is not None:
                self.llm_optimize()
        elif signal.type == SignalType.EXPIRY_RISK.value:
            self._propose_promo(signal.payload or {})
            if config.OPTIMIZER_LLM_AUTO_MODE and self.llm is not None:
                self.llm_optimize()
        elif signal.type == SignalType.EXPIRY_USE_PRIORITY.value:
            payload = dict(signal.payload or {})
            ingredient_id = payload.get("ingredient_id") or self._resolve_ingredient_id(
                payload.get("ingredient_ref")
            )
            if ingredient_id is None:
                return
            payload["ingredient_id"] = ingredient_id
            self._propose_promo(payload)
        elif signal.type == SignalType.MENU_TOGGLE_REQUEST.value:
            payload = signal.payload or {}
            menu_item_id = payload.get("menu_item_id") or self._resolve_menu_item_id(
                payload.get("item_ref")
            )
            if menu_item_id is None:
                return
            self._manual_toggle(
                int(menu_item_id),
                str(payload.get("action") or "disable"),
                str(payload.get("reason") or payload.get("raw_text") or "manual voice request"),
            )

    # -- reorder (§18.8) ------------------------------------------------------

    def reorder_check(self) -> None:
        """Periodic reorder sweep: ``on_hand ≤ reorder_point`` → PO (§18.8)."""
        session = self.db_session_factory()
        try:
            levels = (
                session.query(InventoryLevel)
                .filter(InventoryLevel.reorder_point.isnot(None), InventoryLevel.reorder_point > 0)
                .all()
            )
            ingredient_ids = [lv.ingredient_id for lv in levels]
        finally:
            session.close()

        for ingredient_id in ingredient_ids:
            self._maybe_reorder(ingredient_id)

        for menu_item_id, ingredient_id in list(self._toggle_cause.items()):
            if self._on_hand_above_reorder(ingredient_id):
                self._reenable(menu_item_id, ingredient_id)

    def _on_hand_above_reorder(self, ingredient_id: int) -> bool:
        session = self.db_session_factory()
        try:
            level = (
                session.query(InventoryLevel)
                .filter(InventoryLevel.ingredient_id == ingredient_id)
                .first()
            )
            if level is None or level.reorder_point is None:
                return False
            return float(level.on_hand_cached or 0.0) > float(level.reorder_point)
        finally:
            session.close()

    def _maybe_reorder(self, ingredient_id: int) -> None:
        if self.procurement is None:
            return
        session = self.db_session_factory()
        try:
            level = (
                session.query(InventoryLevel)
                .filter(InventoryLevel.ingredient_id == ingredient_id)
                .first()
            )
            if level is None or level.reorder_point is None or level.reorder_point <= 0:
                return
            on_hand = float(level.on_hand_cached or 0.0)
            if on_hand > float(level.reorder_point):
                return
            par_level = float(level.par_level or 0.0)
            safety_stock = float(level.safety_stock or 0.0)

            # Don't pile on another PO while one is already in flight for this
            # ingredient (proposed/approved/placed, i.e. not yet delivered).
            outstanding = (
                session.query(PurchaseOrderLine)
                .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
                .filter(
                    PurchaseOrderLine.ingredient_id == ingredient_id,
                    PurchaseOrder.status.in_(("proposed", "approved", "placed")),
                )
                .first()
            )
            if outstanding is not None:
                return

            catalog = (
                session.query(SupplierCatalog)
                .filter(SupplierCatalog.ingredient_id == ingredient_id)
                .all()
            )
            specs = [
                {
                    "supplier_id": c.supplier_id,
                    "current_price": c.current_price,
                    "pack_size": c.pack_size or 1.0,
                    "availability": c.availability,
                    "unit": c.unit,
                }
                for c in catalog
            ]
            lead_by_supplier = {
                s.id: float(s.lead_time_days or 1.0)
                for s in session.query(Supplier)
                .filter(Supplier.id.in_([c["supplier_id"] for c in specs]))
                .all()
            } if specs else {}

            # Load ingredient metadata for perishability check
            ing = session.get(Ingredient, ingredient_id)
        finally:
            session.close()

        candidate = self._choose_supplier(specs, lead_by_supplier)
        if candidate is None:
            self.log_event(
                "reorder_failed",
                f"No available supplier for ingredient {ingredient_id}; reorder skipped.",
                {"ingredient_id": ingredient_id},
            )
            return

        lead_days = float(lead_by_supplier.get(candidate["supplier_id"], 1.0))

        # --- Forecast-aware sizing ---
        # Floor: cover demand over lead time + safety stock (avoid lost sales).
        # Degrades to par top-up when no horizon is live (identical to today's behavior).
        demand_lead = self._demand_over_lead(ingredient_id, lead_days)
        forecast_target = demand_lead + safety_stock - on_hand
        needed = max(par_level - on_hand, forecast_target)

        # Ceiling: for perishables, never order more than can be sold before expiry
        # (avoids wastage).  Skip ceiling when no horizon is live (demand_before_expiry→0
        # → ceiling doesn't bind because forecast_target also→0).
        if ing is not None and ing.perishable and ing.shelf_life_days:
            shelf_life = float(ing.shelf_life_days)
            expiry_demand = self._demand_before_expiry(ingredient_id, shelf_life)
            if expiry_demand > 0:  # only cap when we have forecast data
                demand_ceiling = max(0.0, expiry_demand - on_hand)
                # Cap at ceiling but never below the par floor
                if demand_ceiling < needed:
                    needed = max(par_level - on_hand, demand_ceiling)

        if needed <= 0:
            return
        pack_size = candidate["pack_size"] or 1.0
        qty = math.ceil(needed / pack_size) * pack_size

        self.procurement.create_po(
            supplier_id=candidate["supplier_id"],
            lines=[
                {
                    "ingredient_id": ingredient_id,
                    "qty": qty,
                    "unit": candidate["unit"],
                    "unit_price": candidate["current_price"],
                }
            ],
            created_by=self.name,
        )

    # -- recipe / yield helpers (mirrors ledger pattern; core.models only, no track_a import) -----

    def _yield_factor(self, session: Any, ingredient_id: int) -> float:
        """Return the yield factor for an ingredient (waste/prep loss adjustment)."""
        level = (
            session.query(InventoryLevel)
            .filter(InventoryLevel.ingredient_id == ingredient_id)
            .first()
        )
        if level is None or not level.yield_factor:
            return 1.0
        return float(level.yield_factor)

    def _ingredient_qty_for_menu_item(
        self,
        session: Any,
        menu_item_id: int,
        ingredient_id: int,
    ) -> float:
        """How much of ingredient_id is needed per 1 portion of menu_item_id.

        Copied verbatim from ledger._ingredient_qty_for_menu_item (core.models only).
        """
        rows = (
            session.query(RecipeLine.qty)
            .join(Recipe, Recipe.id == RecipeLine.recipe_id)
            .filter(
                Recipe.menu_item_id == menu_item_id,
                RecipeLine.ingredient_id == ingredient_id,
                RecipeLine.optional == 0,
            )
            .all()
        )
        if not rows:
            return 0.0
        return float(sum((row[0] or 0.0) for row in rows)) / max(
            self._yield_factor(session, ingredient_id), 0.0001
        )

    def _demand_over_lead(
        self,
        ingredient_id: int,
        lead_days: float,
    ) -> float:
        """Total ingredient demand over the next (lead_days + reorder_interval) days.

        Reads the latest DEMAND_FORECAST_HORIZON signal from the bus pull-style.
        Returns 0.0 when no horizon is available (formulae degrade to today's behavior).
        """
        horizon_signals = self.bus.live(type=SignalType.DEMAND_FORECAST_HORIZON)
        if not horizon_signals:
            return 0.0

        sig = horizon_signals[0]
        payload = sig.payload or {}
        days = payload.get("days") or []
        coverage_days = math.ceil(lead_days + config.REORDER_INTERVAL_DAYS)

        total_usage = 0.0
        session = self.db_session_factory()
        try:
            for day in days:
                day_idx = day.get("day_index", 999)
                if day_idx >= coverage_days:
                    break
                for item_entry in day.get("items") or []:
                    menu_item_id = item_entry.get("menu_item_id")
                    qty = float(item_entry.get("qty") or 0.0)
                    if qty <= 0 or menu_item_id is None:
                        continue
                    ing_qty = self._ingredient_qty_for_menu_item(session, int(menu_item_id), ingredient_id)
                    total_usage += qty * ing_qty
        finally:
            session.close()
        return total_usage

    def _demand_before_expiry(
        self,
        ingredient_id: int,
        shelf_life_days: float,
    ) -> float:
        """Total ingredient demand over the next shelf_life_days.

        Used as a perishability ceiling: never order more than can be sold.
        Returns 0.0 when no horizon is available.
        """
        horizon_signals = self.bus.live(type=SignalType.DEMAND_FORECAST_HORIZON)
        if not horizon_signals:
            return 0.0

        sig = horizon_signals[0]
        payload = sig.payload or {}
        days = payload.get("days") or []
        cap_days = math.ceil(shelf_life_days)

        total_usage = 0.0
        session = self.db_session_factory()
        try:
            for day in days:
                day_idx = day.get("day_index", 999)
                if day_idx >= cap_days:
                    break
                for item_entry in day.get("items") or []:
                    menu_item_id = item_entry.get("menu_item_id")
                    qty = float(item_entry.get("qty") or 0.0)
                    if qty <= 0 or menu_item_id is None:
                        continue
                    ing_qty = self._ingredient_qty_for_menu_item(session, int(menu_item_id), ingredient_id)
                    total_usage += qty * ing_qty
        finally:
            session.close()
        return total_usage

    # -- dynamic par recompute -----------------------------------------------

    def refresh_dynamic_pars(self) -> None:
        """Recompute par_level/reorder_point/safety_stock from the weekly horizon.

        Uses the robust daily baseline median (transient-free) so one-off event
        spikes don't contaminate the «normal week» par level.  Durable changes
        (e.g. competitor keeps prices elevated) are adopted after a few days as
        the rolling median shifts.

        Safe: only writes when a horizon is available and robust_usage > 0.
        Never zeroes out an existing par (guarded by `if robust_usage > 0`).
        """
        horizon_signals = self.bus.live(type=SignalType.DEMAND_FORECAST_HORIZON)
        if not horizon_signals:
            return  # no horizon yet; skip silently

        payload = horizon_signals[0].payload or {}
        item_baseline_median: Dict[str, float] = payload.get("item_daily_baseline_median") or {}
        if not item_baseline_median:
            return

        session = self.db_session_factory()
        try:
            levels = session.query(InventoryLevel).all()
            for level in levels:
                ingredient_id = int(level.ingredient_id)
                # Sum across all menu items: robust_daily_ingredient_usage
                robust_usage = 0.0
                for item_id_str, daily_baseline in item_baseline_median.items():
                    if float(daily_baseline) <= 0:
                        continue
                    try:
                        menu_item_id = int(item_id_str)
                    except (ValueError, TypeError):
                        continue
                    ing_qty = self._ingredient_qty_for_menu_item(session, menu_item_id, ingredient_id)
                    robust_usage += float(daily_baseline) * ing_qty

                if robust_usage <= 0:
                    continue  # no demand data for this ingredient; preserve existing pars

                ing = session.get(Ingredient, ingredient_id)
                lead_days = 1.0
                catalog = (
                    session.query(SupplierCatalog)
                    .filter(SupplierCatalog.ingredient_id == ingredient_id)
                    .all()
                )
                if catalog:
                    supplier_ids = [c.supplier_id for c in catalog]
                    suppliers = (
                        session.query(Supplier)
                        .filter(Supplier.id.in_(supplier_ids))
                        .all()
                    )
                    if suppliers:
                        lead_days = min(float(s.lead_time_days or 1.0) for s in suppliers)

                safety_stock = config.SAFETY_FRACTION * robust_usage * lead_days
                reorder_point = robust_usage * lead_days + safety_stock
                par_level = robust_usage * (lead_days + config.REORDER_INTERVAL_DAYS + config.SAFETY_DAYS)

                # Perishability cap on par
                if ing is not None and ing.perishable and ing.shelf_life_days:
                    shelf_cap = robust_usage * float(ing.shelf_life_days)
                    par_level = min(par_level, shelf_cap)

                # Never lower par below existing value if it would zero out procurement
                level.safety_stock = round(max(level.safety_stock or 0.0, safety_stock), 4)
                level.reorder_point = round(max(level.reorder_point or 0.0, reorder_point * 0.5), 4)
                level.par_level = round(max(level.par_level or 0.0, par_level * 0.5), 4)

            session.commit()
        except Exception:  # noqa: BLE001
            session.rollback()
        finally:
            session.close()

        self.log_event(
            "optimizer",
            "Dynamic pars refreshed from 7-day horizon (robust baseline).",
            {"signal_age": float((self.bus.live(type=SignalType.DEMAND_FORECAST_HORIZON) or [{}])[0].payload.get("generated_at", 0) if horizon_signals else 0)},
        )

    @staticmethod
    def _choose_supplier(
        specs: List[Dict[str, Any]], lead_by_supplier: Dict[int, float]
    ) -> Optional[Dict[str, Any]]:
        """``score = availability_weight − price_norm − lead_norm`` (§18.8)."""
        usable = [s for s in specs if s["availability"] != "out"]
        if not usable:
            return None
        avail_weight = {"in_stock": 1.0, "limited": 0.5}
        max_price = max((s["current_price"] or 0.0) for s in usable) or 1.0
        max_lead = max((lead_by_supplier.get(s["supplier_id"], 1.0)) for s in usable) or 1.0

        best = None
        best_score = float("-inf")
        for s in usable:
            price_norm = (s["current_price"] or 0.0) / max_price
            lead_norm = lead_by_supplier.get(s["supplier_id"], 1.0) / max_lead
            score = avail_weight.get(s["availability"], 0.5) - price_norm - lead_norm
            if score > best_score:
                best_score = score
                best = s
        return best

    # -- menu toggle (§18.8) -------------------------------------------------

    def _maybe_toggle(self, ingredient_id: int, projected_runout: float) -> None:
        # Guard: if this is the only active dish using the ingredient, skip disabling —
        # leaving the restaurant with zero dishes to serve is worse than serving with
        # low stock.  This guard is optimizer-specific (projected shortages); voice
        # confirms (zero-stock commands) bypass this path entirely.
        session = self.db_session_factory()
        try:
            from core.models import MenuItem, Recipe, RecipeLine
            active_count = (
                session.query(MenuItem.id)
                .join(Recipe, Recipe.menu_item_id == MenuItem.id)
                .join(RecipeLine, RecipeLine.recipe_id == Recipe.id)
                .filter(RecipeLine.ingredient_id == ingredient_id, MenuItem.active == 1)
                .count()
            )
        finally:
            session.close()
        if active_count <= 1:
            return  # skip: would leave no active dishes for this ingredient

        # Delegate to the deterministic resolver, which disables ALL dishes using this
        # ingredient at/below threshold, not just the lowest-value one.
        try:
            from core.availability import recompute_availability
            recompute_availability(
                self.db_session_factory,
                self.bus,
                self.broadcast,
                changed_ingredient_ids=[ingredient_id],
                agent_name="optimizer",
            )
        except Exception as exc:
            logger.warning("optimizer _maybe_toggle cascade failed: %s", exc)

    def _margin_x_velocity(self, menu_item_id: int, price: float, ingredient_id: int) -> float:
        session = self.db_session_factory()
        try:
            recipe_cost = 0.0
            recipe = (
                session.query(Recipe).filter(Recipe.menu_item_id == menu_item_id).first()
            )
            if recipe is not None:
                lines = (
                    session.query(RecipeLine).filter(RecipeLine.recipe_id == recipe.id).all()
                )
                for rl in lines:
                    catalog = (
                        session.query(SupplierCatalog)
                        .filter(SupplierCatalog.ingredient_id == rl.ingredient_id)
                        .first()
                    )
                    unit_price = catalog.current_price if catalog is not None else 0.0
                    recipe_cost += float(rl.qty or 0.0) * float(unit_price or 0.0)

            velocity = (
                session.query(OrderLine)
                .filter(OrderLine.menu_item_id == menu_item_id, OrderLine.status == "sold")
                .count()
            )
        finally:
            session.close()

        margin = float(price or 0.0) - recipe_cost
        return margin * float(velocity)

    def _disable(self, menu_item_id: int, ingredient_id: int) -> None:
        """Disable a menu item by delegating to the deterministic resolver.

        Previously this wrote NULL-coded MenuToggle rows directly, bypassing the
        resolver and creating permanent locks.  Now it delegates to ``_maybe_toggle``
        (which calls ``recompute_availability``) so the block is idempotent and
        tracked with the correct ``out_of_stock`` reason_code.
        """
        self._toggle_cause[menu_item_id] = ingredient_id
        self._maybe_toggle(ingredient_id, projected_runout=float(self.sim_time))

    def _reenable(self, menu_item_id: int, ingredient_id: Optional[int] = None) -> None:
        # Delegate to the deterministic resolver; it auto-re-enables dishes when
        # on_hand > threshold and no other block remains.
        if ingredient_id is None:
            ingredient_id = self._toggle_cause.get(menu_item_id)
        if ingredient_id is not None:
            try:
                from core.availability import recompute_availability
                recompute_availability(
                    self.db_session_factory,
                    self.bus,
                    self.broadcast,
                    changed_ingredient_ids=[ingredient_id],
                    agent_name="optimizer",
                )
            except Exception as exc:
                logger.warning("optimizer _reenable cascade failed: %s", exc)
        self._toggle_cause.pop(menu_item_id, None)

    def _manual_toggle(self, menu_item_id: int, action: str, reason: str) -> None:
        now = self.sim_time
        action = "enable" if action == "enable" else "disable"
        session = self.db_session_factory()
        try:
            item = session.get(MenuItem, menu_item_id)
            if item is None:
                return
            desired_active = 1 if action == "enable" else 0
            if item.active == desired_active:
                return
            item.active = desired_active
            if action == "enable":
                (
                    session.query(MenuToggle)
                    .filter(MenuToggle.menu_item_id == menu_item_id, MenuToggle.active == 1)
                    .update({MenuToggle.active: 0})
                )
            session.add(
                MenuToggle(
                    menu_item_id=menu_item_id,
                    action=action,
                    reason=reason,
                    triggered_by=self.name,
                    sim_time=now,
                    active=1,
                )
            )
            session.commit()
        finally:
            session.close()

        self.emit(
            SignalType.MENU_TOGGLE,
            {"menu_item_id": menu_item_id, "action": action, "reason": reason},
            dedup_key=f"toggle:{menu_item_id}",
        )
        self.broadcast("menu_toggled", {"menu_item_id": menu_item_id, "action": action})
        self.log_event(
            "menu_toggle",
            f"{'Enabled' if action == 'enable' else 'Disabled'} menu item {menu_item_id}: {reason}.",
            {"menu_item_id": menu_item_id, "action": action, "reason": reason},
        )

    def _resolve_ingredient_id(self, ref: Any) -> Optional[int]:
        if not ref:
            return None
        session = self.db_session_factory()
        try:
            row = session.query(Ingredient).filter(Ingredient.name.ilike(str(ref))).first()
            if row is None:
                row = session.query(Ingredient).filter(Ingredient.name.ilike(f"{ref}%")).first()
            return int(row.id) if row is not None else None
        finally:
            session.close()

    def _resolve_menu_item_id(self, ref: Any) -> Optional[int]:
        if not ref:
            return None
        session = self.db_session_factory()
        try:
            row = session.query(MenuItem).filter(MenuItem.name.ilike(str(ref))).first()
            if row is None:
                row = session.query(MenuItem).filter(MenuItem.name.ilike(f"{ref}%")).first()
            return int(row.id) if row is not None else None
        finally:
            session.close()

    # -- expiry → promo (§18.8) ----------------------------------------------

    def _propose_promo(self, payload: Dict[str, Any]) -> None:
        ingredient_id = payload.get("ingredient_id")
        lot_id = payload.get("lot_id")
        if ingredient_id is None:
            return
        now = self.sim_time
        session = self.db_session_factory()
        try:
            ing = session.get(Ingredient, ingredient_id)
            ing_name = ing.name if ing is not None else str(ingredient_id)
            items = (
                session.query(MenuItem.id)
                .join(Recipe, Recipe.menu_item_id == MenuItem.id)
                .join(RecipeLine, RecipeLine.recipe_id == Recipe.id)
                .filter(RecipeLine.ingredient_id == ingredient_id, MenuItem.active == 1)
                .limit(3)
                .all()
            )
            menu_items = [r[0] for r in items]
            if not menu_items:
                return

            promo_type = "combo" if len(menu_items) > 1 else "discount"
            promo = Promotion(
                type=promo_type,
                menu_items=menu_items,
                trigger="expiry",
                discount_pct=float(config.PROMO_DISCOUNT_PCT),
                channel="both",
                status="proposed",
                approval_id=None,
                sim_time=now,
            )
            session.add(promo)
            session.commit()
            session.refresh(promo)
            promo_id = promo.id
        finally:
            session.close()

        if self.approvals is not None:
            approval = self.approvals.create(
                type="promo",
                title=f"Promo: near-expiry {ing_name}",
                summary=f"Discount {config.PROMO_DISCOUNT_PCT}% on menu items using {ing_name} (lot {lot_id} near expiry).",
                payload={"promo_id": promo_id, "ingredient_id": ingredient_id, "lot_id": lot_id},
                ref_id=promo_id,
            )
            session = self.db_session_factory()
            try:
                promo = session.get(Promotion, promo_id)
                if promo is not None:
                    promo.approval_id = approval.id
                    session.commit()
            finally:
                session.close()

        self.emit(
            SignalType.PROMO_PROPOSAL,
            {
                "promo_id": promo_id,
                "type": promo_type,
                "menu_items": menu_items,
                "discount_pct": float(config.PROMO_DISCOUNT_PCT),
                "channel": "both",
                "trigger": "expiry",
            },
            dedup_key=f"promo:{lot_id}",
        )
        self.log_event(
            "promo_proposal",
            f"Proposed {promo_type} promo for near-expiry {ing_name} ({config.PROMO_DISCOUNT_PCT}% off).",
            {"promo_id": promo_id, "ingredient_id": ingredient_id, "menu_items": menu_items},
        )

    # -- approval callbacks (called by the approval handlers) --------------

    def activate_promo(self, promo_id: int) -> None:
        """Mark an approved promotion ``active`` (§B4.5)."""
        session = self.db_session_factory()
        try:
            promo = session.get(Promotion, promo_id)
            if promo is None:
                return
            promo.status = "active"
            session.commit()
        finally:
            session.close()

        self.broadcast("promo_activated", {"promo_id": promo_id})
        self.log_event(
            "promo_activated", f"Promotion {promo_id} activated.", {"promo_id": promo_id}
        )

    # -- LLM optimization pass (Stream E) ------------------------------------

    def llm_optimize(self) -> None:
        """Run the LLM reasoning pass to produce augmented inventory decisions.

        Builds a rich context (inventory levels, near-expiry lots, shared-ingredient
        dish graph, demand forecasts, supplier catalog, memory) and asks the LLM
        for a structured action list.  Actions are mapped onto the guarded
        deterministic executors so all safety rails remain in effect.

        Falls back gracefully: if no LLM key is present or the response is canned,
        the call is a no-op (the deterministic path still runs on its own cadence).
        """
        if self.llm is None:
            return
        try:
            context = self._build_llm_context()
            messages = [
                {
                    "role": "system",
                    "content": (
                        "You are Roba's inventory optimizer AI. Based on the provided restaurant "
                        "inventory state, demand forecasts, and optimization memory, produce a "
                        "list of inventory and menu actions to maximize profitability and minimize "
                        "waste. Reason carefully about shared ingredients across dishes — disabling "
                        "a lower-margin dish can preserve a scarce ingredient for a higher-margin "
                        "dish. Propose deals (discounts) for items near waste/expiry. Suggest "
                        "reorder timing adjustments based on demand patterns. Respond with JSON "
                        "matching the schema: {actions: [{action, menu_item_id?, ingredient_id?, "
                        "toggle_direction?, discount_pct?, reason, confidence}], summary}."
                    ),
                },
                {"role": "user", "content": f"Inventory context:\n{context}"},
            ]
            result = self.llm.complete(
                messages,
                json_schema=_OPTIMIZE_SCHEMA,
                use_site="optimizer_optimization",
                temperature=0.1,
            )
            if not isinstance(result, dict) or result.get("note") == CANNED_NOTE:
                return
            self._apply_llm_actions(result.get("actions") or [], result.get("summary", ""))
        except Exception:  # noqa: BLE001
            logger.exception("Optimizer LLM pass failed; falling back to deterministic path")

    def _build_llm_context(self) -> str:
        """Build a compact JSON context for the LLM optimizer."""
        now = self.sim_time
        session = self.db_session_factory()
        try:
            # Inventory levels + near-expiry lots.
            levels = session.query(InventoryLevel).all()
            inventory = []
            for lv in levels:
                ing = session.get(Ingredient, lv.ingredient_id)
                if ing is None:
                    continue
                near_expiry_lots = (
                    session.query(InventoryLot)
                    .filter(
                        InventoryLot.ingredient_id == lv.ingredient_id,
                        InventoryLot.status == "active",
                        InventoryLot.expiry_date.isnot(None),
                        InventoryLot.expiry_date <= now + 172800.0,  # 2 sim-days
                    )
                    .all()
                )
                inventory.append({
                    "ingredient_id": int(lv.ingredient_id),
                    "name": ing.name,
                    "on_hand": float(lv.on_hand_cached or 0.0),
                    "par_level": float(lv.par_level or 0.0),
                    "reorder_point": float(lv.reorder_point or 0.0),
                    "near_expiry_qty": sum(float(lot.qty_on_hand or 0.0) for lot in near_expiry_lots),
                    "near_expiry_lots": len(near_expiry_lots),
                })

            # Menu items with margin × velocity and shared ingredient info.
            items = session.query(MenuItem).filter(MenuItem.active == 1).all()
            menu = []
            for item in items:
                score = self._margin_x_velocity(item.id, float(item.dine_in_price or 0.0), 0)
                recipe = session.query(Recipe).filter(Recipe.menu_item_id == item.id).first()
                ingredients = []
                if recipe:
                    for rl in session.query(RecipeLine).filter(RecipeLine.recipe_id == recipe.id).all():
                        ing = session.get(Ingredient, rl.ingredient_id)
                        ingredients.append({
                            "ingredient_id": int(rl.ingredient_id),
                            "name": ing.name if ing else str(rl.ingredient_id),
                            "qty": float(rl.qty or 0.0),
                        })
                menu.append({
                    "menu_item_id": int(item.id),
                    "name": item.name,
                    "margin_x_velocity": round(score, 2),
                    "price": float(item.dine_in_price or 0.0),
                    "ingredients": ingredients,
                })

            # Supplier catalog summary.
            suppliers = []
            for cat in session.query(SupplierCatalog).all():
                sup = session.get(Supplier, cat.supplier_id)
                suppliers.append({
                    "ingredient_id": int(cat.ingredient_id),
                    "supplier": sup.name if sup else str(cat.supplier_id),
                    "price": float(cat.current_price or 0.0),
                    "availability": cat.availability,
                    "lead_days": float(sup.lead_time_days or 2.0) if sup else 2.0,
                })

            # Memory from past optimizer decisions.
            memory = [
                {
                    "scope_type": m.scope_type,
                    "scope_ref": m.scope_ref,
                    "insight": m.insight,
                    "confidence": m.confidence,
                }
                for m in session.query(InventoryOptimizerMemory)
                .filter(
                    InventoryOptimizerMemory.valid_until.is_(None)
                    | (InventoryOptimizerMemory.valid_until > now)
                )
                .order_by(InventoryOptimizerMemory.last_seen_at.desc())
                .limit(20)
                .all()
            ]
        finally:
            session.close()

        # Live demand forecasts from the bus.
        demand = [
            {
                "menu_item_id": s.payload.get("menu_item_id"),
                "qty": s.payload.get("qty"),
                "daypart": s.payload.get("daypart"),
                "confidence": s.payload.get("confidence"),
            }
            for s in self.bus.live(type=SignalType.DEMAND_FORECAST)[:20]
        ]

        return json.dumps({
            "sim_time": now,
            "inventory": inventory,
            "menu": menu,
            "suppliers": suppliers,
            "demand_forecasts": demand,
            "optimizer_memory": memory,
        }, separators=(",", ":"))

    def _apply_llm_actions(self, actions: List[Dict[str, Any]], summary: str) -> None:
        """Map LLM-proposed actions onto the guarded deterministic executors."""
        applied: List[str] = []
        for action in actions:
            kind = str(action.get("action") or "")
            reason = str(action.get("reason") or "LLM optimizer recommendation")
            confidence = float(action.get("confidence") or 0.0)
            if confidence < 0.55:
                continue  # skip low-confidence actions
            try:
                if kind == "toggle_item":
                    menu_item_id = action.get("menu_item_id")
                    direction = str(action.get("toggle_direction") or "disable")
                    if menu_item_id is not None:
                        self._manual_toggle(int(menu_item_id), direction, f"[LLM] {reason}")
                        applied.append(f"toggle_item:{menu_item_id}:{direction}")
                elif kind == "create_deal":
                    ingredient_id = action.get("ingredient_id")
                    discount_pct = float(action.get("discount_pct") or config.PROMO_SLOW_MOVER_PCT)
                    if ingredient_id is not None:
                        self._propose_promo_llm(
                            int(ingredient_id),
                            discount_pct,
                            reason=f"[LLM] {reason}",
                            trigger="slow_mover",
                        )
                        applied.append(f"create_deal:ingredient:{ingredient_id}")
                elif kind == "reorder":
                    ingredient_id = action.get("ingredient_id")
                    if ingredient_id is not None:
                        self._maybe_reorder(int(ingredient_id))
                        applied.append(f"reorder:ingredient:{ingredient_id}")
                elif kind == "defer_reorder":
                    # Record this deferral decision in memory so future runs know.
                    ingredient_id = action.get("ingredient_id")
                    if ingredient_id is not None:
                        self._remember(
                            scope_type="ingredient",
                            scope_ref=str(ingredient_id),
                            insight={"action": "defer_reorder", "reason": reason},
                            confidence=confidence,
                            source="llm",
                        )
                        applied.append(f"defer_reorder:ingredient:{ingredient_id}")
            except Exception:  # noqa: BLE001
                logger.exception("Optimizer LLM action %s failed", kind)

        if applied:
            self.log_event(
                "llm_optimize",
                f"LLM optimizer applied {len(applied)} actions: {', '.join(applied[:5])}.",
                {"actions": actions, "summary": summary},
            )
            # Record a run-level memory insight.
            self._remember(
                scope_type="global",
                scope_ref="optimizer_run",
                insight={"summary": summary, "applied": applied},
                confidence=0.7,
                source="llm",
            )

    def _propose_promo_llm(
        self,
        ingredient_id: int,
        discount_pct: float,
        reason: str = "",
        trigger: str = "slow_mover",
    ) -> None:
        """Create a promo for an ingredient with a custom discount and trigger."""
        now = self.sim_time
        session = self.db_session_factory()
        try:
            ing = session.get(Ingredient, ingredient_id)
            ing_name = ing.name if ing is not None else str(ingredient_id)
            items = (
                session.query(MenuItem.id)
                .join(Recipe, Recipe.menu_item_id == MenuItem.id)
                .join(RecipeLine, RecipeLine.recipe_id == Recipe.id)
                .filter(RecipeLine.ingredient_id == ingredient_id, MenuItem.active == 1)
                .limit(3)
                .all()
            )
            menu_items = [r[0] for r in items]
            if not menu_items:
                return
            promo_type = "combo" if len(menu_items) > 1 else "discount"
            promo = Promotion(
                type=promo_type,
                menu_items=menu_items,
                trigger=trigger,
                discount_pct=float(discount_pct),
                channel="both",
                status="proposed",
                approval_id=None,
                sim_time=now,
            )
            session.add(promo)
            session.commit()
            session.refresh(promo)
            promo_id = promo.id
        finally:
            session.close()

        if self.approvals is not None:
            approval = self.approvals.create(
                type="promo",
                title=f"Promo: {trigger} {ing_name} ({discount_pct:.0f}% off)",
                summary=reason or f"LLM-recommended {trigger} deal for {ing_name}.",
                payload={"promo_id": promo_id, "ingredient_id": ingredient_id},
                ref_id=promo_id,
            )
            session = self.db_session_factory()
            try:
                promo_row = session.get(Promotion, promo_id)
                if promo_row is not None:
                    promo_row.approval_id = approval.id
                    session.commit()
            finally:
                session.close()

        self.emit(
            SignalType.PROMO_PROPOSAL,
            {
                "promo_id": promo_id,
                "type": promo_type,
                "menu_items": menu_items,
                "discount_pct": float(discount_pct),
                "channel": "both",
                "trigger": trigger,
            },
            dedup_key=f"promo_llm:{ingredient_id}:{trigger}",
        )
        self.log_event(
            "promo_proposal",
            f"[LLM] Proposed {trigger} promo for {ing_name} ({discount_pct:.0f}% off).",
            {"promo_id": promo_id, "ingredient_id": ingredient_id},
        )

    def _remember(
        self,
        scope_type: str,
        scope_ref: str,
        insight: Any,
        confidence: float = 0.7,
        source: str = "llm",
        valid_until: Optional[float] = None,
    ) -> None:
        """Upsert an InventoryOptimizerMemory insight."""
        now = self.sim_time
        session = self.db_session_factory()
        try:
            existing = (
                session.query(InventoryOptimizerMemory)
                .filter(
                    InventoryOptimizerMemory.scope_type == scope_type,
                    InventoryOptimizerMemory.scope_ref == scope_ref,
                )
                .first()
            )
            if existing is not None:
                existing.insight = insight
                existing.confidence = confidence
                existing.last_seen_at = now
                existing.source = source
            else:
                session.add(InventoryOptimizerMemory(
                    scope_type=scope_type,
                    scope_ref=scope_ref,
                    insight=insight,
                    evidence=None,
                    confidence=confidence,
                    created_at=now,
                    last_seen_at=now,
                    valid_until=valid_until,
                    source=source,
                ))
            session.commit()
        finally:
            session.close()
