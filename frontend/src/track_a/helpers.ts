import type { Forecast, MenuItem, SignalRow, TrackASnapshot } from "./types";

export function itemName(data: TrackASnapshot, id: number) {
  return data.menu_items.find((item) => item.id === id)?.name ?? `Item ${id}`;
}

export function stationName(data: TrackASnapshot, id: number) {
  return data.stations.find((station) => station.id === id)?.name ?? `Station ${id}`;
}

export function latestForecasts(data: TrackASnapshot) {
  const now = data.sim_state?.sim_time;
  const liveForecasts = forecastsFromLiveSignals(data);
  const source =
    liveForecasts.length > 0
      ? liveForecasts
      : data.forecasts.filter((forecast) => now == null || forecast.generated_at <= now);
  const byItem = new Map<number, Forecast>();
  for (const forecast of source) {
    const previous = byItem.get(forecast.menu_item_id);
    if (!previous || forecast.generated_at > previous.generated_at || forecast.id > previous.id) {
      byItem.set(forecast.menu_item_id, forecast);
    }
  }
  return Array.from(byItem.values()).sort((a, b) => a.menu_item_id - b.menu_item_id);
}

function forecastsFromLiveSignals(data: TrackASnapshot): Forecast[] {
  return data.signals
    .filter((signal) => signal.type === "DEMAND_FORECAST" && signal.status === "live")
    .map((signal, index) => {
      const payload = signal.payload;
      const menuItemId = Number(payload.menu_item_id);
      const window = payload.window as Forecast["window"] | undefined;
      return {
        id: -index - 1,
        menu_item_id: menuItemId,
        window: window ?? { start: signal.created_at, end: signal.expires_at ?? signal.created_at },
        daypart: String(payload.daypart ?? ""),
        forecast_qty: Number(payload.qty ?? 0),
        baseline_qty: Number(payload.baseline ?? 0),
        multipliers: (payload.multipliers as Record<string, number> | undefined) ?? {},
        confidence: Number(payload.confidence ?? 0),
        generated_at: Number(signal.created_at ?? 0),
        trigger_reason: "live_signal",
        run_id: typeof payload.run_id === "string" ? payload.run_id : null,
        trace: (payload.trace as Forecast["trace"] | undefined) ?? null,
      };
    })
    .filter((forecast) => Number.isFinite(forecast.menu_item_id));
}

export function menuByStation(data: TrackASnapshot, stationId: number): MenuItem[] {
  return data.menu_items.filter((item) => item.station_id === stationId && item.active);
}

export function latestCoverageSignals(data: TrackASnapshot): SignalRow[] {
  const byStation = new Map<number, SignalRow>();
  for (const signal of data.signals) {
    if (signal.type !== "STAFF_COVERAGE") continue;
    const stationId = Number(signal.payload.station_id);
    if (!byStation.has(stationId)) byStation.set(stationId, signal);
  }
  return Array.from(byStation.values());
}

export function formatSimTime(value: number | null | undefined) {
  if (value == null) return "n/a";
  const day = Math.floor(value / 86400);
  const seconds = Math.floor(value % 86400);
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  return `D${day} ${h}:${m}`;
}

export function formatQty(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "0";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function formatBaseline(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "0";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
}
