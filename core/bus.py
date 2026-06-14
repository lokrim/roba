"""The signal bus (§14): emit / query / consume / expire with dedup, cooldown,
and cascade safety.

The bus is the *only* inter-component communication channel (Layer 2). It
writes ``signals`` rows, enforces the §14.3 dedup rule, the §14.5 cooldown +
max-cascade-depth guards, and queues WS broadcasts for the API tick loop to
drain. It also carries the in-process order-line callback (§10) and the current
``sim_time`` (set by the clock each tick; read by ``BaseAgent``).
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Callable, Dict, List, Optional, Union

from pydantic import BaseModel, ValidationError

from . import config
from .models import Signal
from .signals import SIGNAL_PAYLOADS, SIGNAL_REGISTRY, SignalType

logger = logging.getLogger(__name__)

SignalTypeArg = Union[SignalType, str]
PayloadArg = Union[BaseModel, Dict[str, Any]]


def _coerce_type(type_: SignalTypeArg) -> SignalType:
    """Accept a :class:`SignalType` or its string value; return the enum."""
    if isinstance(type_, SignalType):
        return type_
    return SignalType(type_)


def _validate_payload(sig_type: SignalType, payload: PayloadArg) -> Dict[str, Any]:
    """Validate ``payload`` against the registered ``<Type>Payload`` model and
    return its normalized dict form.

    Accepts either a mapping or a pydantic model instance. If no payload model
    is registered for the type, the input is passed through as a plain dict. On
    validation failure a :class:`ValueError` is raised naming the signal type
    and the offending field(s).
    """
    model = SIGNAL_PAYLOADS.get(sig_type)
    if model is None:
        if isinstance(payload, BaseModel):
            return payload.model_dump(mode="json")
        return dict(payload)

    try:
        validated = model.model_validate(payload)
    except ValidationError as exc:
        fields = ", ".join(
            ".".join(str(loc) for loc in err["loc"]) or "<root>"
            for err in exc.errors()
        )
        raise ValueError(
            f"Invalid payload for {sig_type.value}: offending field(s): {fields} "
            f"({exc.error_count()} error(s))"
        ) from exc
    # mode="json" guarantees the stored dict is JSON-native for the JSON column.
    return validated.model_dump(mode="json")


def _cascade_depth(correlation_id: Optional[str]) -> int:
    """Parse the depth counter from a ``correlation_id`` suffix ``:N``.

    Returns ``0`` when no numeric suffix is present.
    """
    if not correlation_id or ":" not in correlation_id:
        return 0
    suffix = correlation_id.rsplit(":", 1)[-1]
    try:
        return int(suffix)
    except (TypeError, ValueError):
        return 0


class SignalBus:
    """Typed, grouped, expiring, deduped message bus over the ``signals`` table."""

    def __init__(self, db_session_factory: Callable[[], Any]):
        self.db_session_factory = db_session_factory
        self._pending_broadcasts: List[Signal] = []
        self._order_line_handlers: List[Callable[[Any], None]] = []
        self._sim_time: float = 0.0

    # -- clock bridge -------------------------------------------------------

    @property
    def sim_time(self) -> float:
        """Current sim-time (seconds). Set by the clock each tick."""
        return self._sim_time

    @sim_time.setter
    def sim_time(self, value: float) -> None:
        self._sim_time = float(value)

    # -- emit ---------------------------------------------------------------

    def emit(
        self,
        type: SignalTypeArg,
        payload: PayloadArg,
        source: str,
        groups: Optional[List[str]] = None,
        priority: Optional[int] = None,
        ttl: Optional[float] = None,
        dedup_key: Optional[str] = None,
        correlation_id: Optional[str] = None,
        now: Optional[float] = None,
    ) -> Optional[Signal]:
        """Emit a signal, applying registry defaults and §14 safety rules.

        Returns the (new or refreshed/existing) :class:`Signal`, or ``None`` if
        the emit was rejected by the cascade-depth guard.
        """
        sig_type = _coerce_type(type)
        registry = SIGNAL_REGISTRY[sig_type]

        if groups is None:
            groups = list(registry["groups"])
        if priority is None:
            priority = registry["priority"]
        if ttl is None:
            ttl = registry["default_ttl_sim_s"]
        if now is None:
            now = self.sim_time

        payload_dict = _validate_payload(sig_type, payload)

        # §14.5 cascade depth guard.
        depth = _cascade_depth(correlation_id)
        if depth > config.MAX_CASCADE_DEPTH:
            logger.warning(
                "Dropping %s emit: cascade depth %d exceeds MAX_CASCADE_DEPTH %d "
                "(correlation_id=%s)",
                sig_type.value, depth, config.MAX_CASCADE_DEPTH, correlation_id,
            )
            return None

        expires_at = (now + ttl) if ttl is not None else None
        session = self.db_session_factory()
        try:
            if dedup_key:
                existing = (
                    session.query(Signal)
                    .filter(Signal.dedup_key == dedup_key, Signal.status == "live")
                    .order_by(Signal.created_at.desc())
                    .first()
                )
                if existing is not None:
                    identical = existing.payload == payload_dict
                    within_cooldown = (
                        now - (existing.created_at or 0.0)
                    ) < config.SIGNAL_COOLDOWN_SIM_S

                    # §14.3 / §14.5: materially identical payload -> no-op.
                    # (Covers both the dedup "latest is the same" case and the
                    # cooldown "same key within window, unchanged" case.)
                    if identical:
                        if within_cooldown:
                            logger.debug(
                                "Cooldown no-op for %s dedup_key=%s",
                                sig_type.value, dedup_key,
                            )
                        session.refresh(existing)
                        session.expunge(existing)
                        return existing

                    # §14.3: payload changed -> refresh expiry + replace payload,
                    # do NOT insert a duplicate (latest wins).
                    existing.payload = payload_dict
                    existing.expires_at = expires_at
                    existing.priority = priority
                    existing.groups = list(groups)
                    existing.source = source
                    session.commit()
                    session.refresh(existing)
                    session.expunge(existing)
                    self._notify(existing)
                    return existing

            signal = Signal(
                signal_id=str(uuid.uuid4()),
                type=sig_type.value,
                source=source,
                groups=list(groups),
                priority=priority,
                payload=payload_dict,
                created_at=now,
                expires_at=expires_at,
                dedup_key=dedup_key,
                status="live",
                correlation_id=correlation_id,
            )
            session.add(signal)
            session.commit()
            session.refresh(signal)
            session.expunge(signal)
            self._notify(signal)
            return signal
        finally:
            session.close()

    # -- query / lifecycle --------------------------------------------------

    def live(
        self,
        groups: Optional[List[str]] = None,
        type: Optional[SignalTypeArg] = None,
    ) -> List[Signal]:
        """Return current ``status='live'`` signals, optionally filtered.

        ``groups`` filters to signals whose groups intersect the given set;
        ``type`` filters to a single signal type.
        """
        session = self.db_session_factory()
        try:
            query = session.query(Signal).filter(Signal.status == "live")
            if type is not None:
                query = query.filter(Signal.type == _coerce_type(type).value)
            results = query.order_by(Signal.created_at.asc()).all()

            if groups is not None:
                wanted = set(groups)
                results = [
                    s for s in results
                    if wanted.intersection(set(s.groups or []))
                ]

            session.expunge_all()
            return results
        finally:
            session.close()

    def consume(self, signal_id: str) -> Optional[Signal]:
        """Mark a signal ``status='consumed'`` and return the updated row."""
        session = self.db_session_factory()
        try:
            signal = session.get(Signal, signal_id)
            if signal is None:
                return None
            signal.status = "consumed"
            session.commit()
            session.refresh(signal)
            session.expunge(signal)
            return signal
        finally:
            session.close()

    def sweep(self, now: float) -> None:
        """Flip ``status='expired'`` for live signals whose TTL has elapsed."""
        session = self.db_session_factory()
        try:
            (
                session.query(Signal)
                .filter(
                    Signal.status == "live",
                    Signal.expires_at.isnot(None),
                    Signal.expires_at <= now,
                )
                .update({Signal.status: "expired"}, synchronize_session=False)
            )
            session.commit()
        finally:
            session.close()

    # -- order-line callback (§10) -----------------------------------------

    def register_order_line_handler(self, fn: Callable[[Any], None]) -> None:
        """Register a callback invoked for each created order line (§10)."""
        self._order_line_handlers.append(fn)

    def notify_order_line(self, line: Any) -> None:
        """Invoke every registered order-line handler with ``line`` (§10)."""
        for handler in self._order_line_handlers:
            handler(line)

    # -- WS broadcast queue -------------------------------------------------

    def _notify(self, signal: Signal) -> None:
        """Queue a signal for WS broadcast; the API tick loop drains this."""
        self._pending_broadcasts.append(signal)

    def pending_broadcasts(self) -> List[Signal]:
        """Return the currently queued broadcasts (not cleared)."""
        return list(self._pending_broadcasts)

    def clear_broadcasts(self) -> None:
        """Clear the pending-broadcast queue (called after draining)."""
        self._pending_broadcasts.clear()
