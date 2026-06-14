"""Weather provider (§9).

The provider owns the *fetch + map* of an external weather API into the
canonical struct (§9.1) and the demo override path. Everything about how the
weather is *used* is decided elsewhere (§18.5); this module only:

- ``fetch_and_store`` — GET current weather from Open-Meteo, map the provider
  ``weather_code`` into our 5 ``condition`` buckets, write a ``weather_log``
  row (``source='api'``) and emit ``WEATHER_UPDATE``. On any HTTP error it
  falls back (last row if present, else a hard-coded default) and never raises.
- ``override`` — write a ``weather_log`` row (``source='override'``) and emit
  ``WEATHER_UPDATE``. Overrides win until the next override / fetch.
- ``current`` — the latest ``weather_log`` row (the current weather, §9.1).
- ``register`` — register the ``WEATHER_FETCH_SIM_S`` interval trigger (§17).

Per §7 the implementer owns the concrete endpoint + parsing; the canonical
struct and its deterministic usage are fixed by the doc.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

from . import config
from .models import WeatherLog
from .signals import SignalType

logger = logging.getLogger(__name__)

# Hard-coded demo location (Houston, TX). The override path can change the
# conditions regardless, so a fixed location is sufficient for the demo (§9).
DEMO_LATITUDE = 29.76
DEMO_LONGITUDE = -95.37

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
# Open-Meteo returns wind_speed_10m in km/h by default, mapping straight onto
# our canonical ``wind_kph`` field.
CURRENT_FIELDS = "temperature_2m,precipitation,wind_speed_10m,weather_code"

# Demo-safe default when the API is unavailable and no prior row exists (§9).
DEFAULT_WEATHER: Dict[str, Any] = {
    "condition": "clear",
    "temp_c": 20.0,
    "precip_mm": 0.0,
    "wind_kph": 10.0,
    "source": "api",
}


def map_weather_code(code: int) -> str:
    """Map an Open-Meteo WMO ``weather_code`` into one of our 5 conditions.

    Documented mapping (§9):
      0–1 → clear; 2–3 → clouds; 51–67, 80–82 → rain; 71–77, 85–86 → snow;
      95–99 → storm. Anything else falls back to ``clouds``.
    """
    if code in (0, 1):
        return "clear"
    if code in (2, 3):
        return "clouds"
    if (51 <= code <= 67) or (80 <= code <= 82):
        return "rain"
    if (71 <= code <= 77) or (85 <= code <= 86):
        return "snow"
    if 95 <= code <= 99:
        return "storm"
    return "clouds"


class WeatherProvider:
    """Open-Meteo fetch + demo override over the ``weather_log`` table (§9)."""

    def __init__(
        self,
        bus: Any,
        db_session_factory: Callable[[], Any],
        clock: Any,
        latitude: float = DEMO_LATITUDE,
        longitude: float = DEMO_LONGITUDE,
        timeout_s: float = 10.0,
    ):
        self.bus = bus
        self.db_session_factory = db_session_factory
        self.clock = clock
        self.latitude = latitude
        self.longitude = longitude
        self.timeout_s = timeout_s
        # Optional WS broadcast sink ``fn(event, payload)``, wired by the API
        # layer; a no-op (None) in tests / headless runs.
        self.ws_broadcast: Optional[Callable[[str, Dict[str, Any]], Any]] = None

    # -- WS wiring ----------------------------------------------------------

    def set_ws_broadcast(self, fn: Callable[[str, Dict[str, Any]], Any]) -> None:
        """Wire the sink the provider pushes ``weather_updated`` events to."""
        self.ws_broadcast = fn

    def _broadcast(self, event: str, payload: Dict[str, Any]) -> None:
        if self.ws_broadcast is not None:
            self.ws_broadcast(event, payload)

    # -- public API ---------------------------------------------------------

    def fetch_and_store(self) -> WeatherLog:
        """GET current weather from Open-Meteo, map + store it, emit
        ``WEATHER_UPDATE``. Never raises — on HTTP error it reuses the last
        ``weather_log`` row (if any) or writes the demo default (§9)."""
        try:
            data = self._http_get(
                OPEN_METEO_URL,
                {
                    "latitude": self.latitude,
                    "longitude": self.longitude,
                    "current": CURRENT_FIELDS,
                },
            )
            current = data["current"]
            temp_c = float(current["temperature_2m"])
            precip_mm = float(current.get("precipitation") or 0.0)
            wind_kph = float(current.get("wind_speed_10m") or 0.0)
            condition = map_weather_code(int(current["weather_code"]))
            return self._store(temp_c, condition, precip_mm, wind_kph, source="api")
        except Exception as exc:  # network / parse error → demo-safe fallback
            logger.warning("Weather fetch failed (%s); falling back.", exc)
            last = self.current()
            if last is not None:
                # Reuse the last known weather; re-broadcast it so consumers
                # still see a current reading.
                self._emit_update(
                    last.temp_c, last.condition, last.precip_mm,
                    last.wind_kph, last.source,
                )
                return last
            d = DEFAULT_WEATHER
            return self._store(
                d["temp_c"], d["condition"], d["precip_mm"], d["wind_kph"],
                source=d["source"],
            )

    def override(
        self,
        temp_c: float,
        condition: str,
        precip_mm: float,
        wind_kph: float,
    ) -> WeatherLog:
        """Write a ``source='override'`` ``weather_log`` row and emit
        ``WEATHER_UPDATE``. The override wins until the next override / fetch."""
        return self._store(
            float(temp_c), str(condition), float(precip_mm), float(wind_kph),
            source="override",
        )

    def current(self) -> Optional[WeatherLog]:
        """The latest ``weather_log`` row (the current weather, §9.1)."""
        session = self.db_session_factory()
        try:
            row = (
                session.query(WeatherLog)
                .order_by(WeatherLog.id.desc())
                .first()
            )
            if row is not None:
                session.expunge(row)
            return row
        finally:
            session.close()

    # -- orchestrator registration (§9 / §17) ------------------------------

    def register(self, orchestrator: Any) -> Any:
        """Register the ``WEATHER_FETCH_SIM_S`` interval trigger (every 3
        sim-hours, §22) that drives :meth:`fetch_and_store`."""
        return orchestrator.register(
            "interval",
            self.fetch_and_store,
            interval_sim_s=config.WEATHER_FETCH_SIM_S,
            name="weather_fetch",
        )

    # -- internals ----------------------------------------------------------

    def _store(
        self,
        temp_c: float,
        condition: str,
        precip_mm: float,
        wind_kph: float,
        source: str,
    ) -> WeatherLog:
        """Persist a ``weather_log`` row and emit/broadcast the update."""
        now = float(self.bus.sim_time)
        session = self.db_session_factory()
        try:
            row = WeatherLog(
                sim_time=now,
                source=source,
                temp_c=temp_c,
                condition=condition,
                precip_mm=precip_mm,
                wind_kph=wind_kph,
                applied=1,
            )
            session.add(row)
            session.commit()
            session.refresh(row)
            session.expunge(row)
        finally:
            session.close()

        self._emit_update(temp_c, condition, precip_mm, wind_kph, source)
        return row

    def _emit_update(
        self,
        temp_c: float,
        condition: str,
        precip_mm: float,
        wind_kph: float,
        source: str,
    ) -> None:
        """Emit ``WEATHER_UPDATE`` (→ forecasting) + broadcast ``weather_updated``."""
        payload = {
            "temp_c": temp_c,
            "condition": condition,
            "precip_mm": precip_mm,
            "wind_kph": wind_kph,
            "source": source,
        }
        self.bus.emit(SignalType.WEATHER_UPDATE, payload, source="weather")
        self._broadcast("weather_updated", {"weather": payload})

    # -- HTTP seam (monkeypatchable in tests) ------------------------------

    def _http_get(self, url: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Issue one GET and return parsed JSON. Tests may monkeypatch this to
        inject a fake response or simulate a network error."""
        import httpx

        resp = httpx.get(url, params=params, timeout=self.timeout_s)
        resp.raise_for_status()
        return resp.json()
