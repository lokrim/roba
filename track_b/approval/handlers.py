"""Approval handlers — act on resolutions for Track B's own types (02 §B4.5).

The approval **queue, inbox UI, ``/approvals/*`` endpoints, TTL expiry, and the
``APPROVAL_RESOLVED`` emit all live in core** (§19.4, §23). Track B only
subscribes to ``APPROVAL_RESOLVED`` (group ``procurement``) and, on
``decision="approved"``, executes its own request types:
``purchase_order`` → ``procurement.place(po)``; ``promo`` →
``optimizer.activate_promo(promo_id)``; ``batch`` → advance batch status to
``"approved"``. ``outbound_call`` resolutions are handled by the core call
subsystem, not here; any other type is ignored.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from core.signals import SignalType

logger = logging.getLogger(__name__)

OWN_TYPES = {"purchase_order", "promo", "batch"}


class ApprovalHandlers:
    """Subscribes to ``APPROVAL_RESOLVED`` and dispatches Track B's own types."""

    def __init__(
        self,
        bus: Any,
        procurement: Any,
        optimizer: Any,
        db_session_factory: Optional[Callable[[], Any]] = None,
    ):
        self.bus = bus
        self.procurement = procurement
        self.optimizer = optimizer
        self.db_session_factory = db_session_factory
        bus.subscribe(SignalType.APPROVAL_RESOLVED, self.on_resolved)

    def on_resolved(self, signal: Any) -> None:
        payload = signal.payload or {}
        approval_type = payload.get("type")
        if approval_type not in OWN_TYPES:
            return  # outbound_call (core) / other — not ours

        decision = payload.get("decision")
        ref_id = payload.get("ref_id")

        if approval_type == "batch":
            # Advance the cook batch to "approved" on manager approval.
            # On rejection, the batch stays at "decided" and won't be queued.
            if decision == "approved" and ref_id is not None and self.db_session_factory:
                self._approve_batch(int(ref_id))
            return

        if decision != "approved":
            return  # rejected: the PO/promo simply stays unplaced/unactivated
        if ref_id is None:
            return
        if approval_type == "purchase_order":
            self.procurement.place(int(ref_id))
        elif approval_type == "promo":
            self.optimizer.activate_promo(int(ref_id))

    def _approve_batch(self, batch_id: int) -> None:
        """Advance a gated batch from 'decided' → 'approved' in the DB."""
        from core.models import Batch  # lazy import to avoid circular

        session = self.db_session_factory()
        try:
            row = session.get(Batch, batch_id)
            if row is not None and row.status == "decided":
                row.status = "approved"
                session.commit()
                logger.debug("Batch %d approved via manager approval", batch_id)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to approve batch %d", batch_id)
            session.rollback()
        finally:
            session.close()
