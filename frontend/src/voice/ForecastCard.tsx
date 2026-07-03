/**
 * ForecastCard — voice-triggered interval forecast result card.
 *
 * Shown when the voice agent calls forecast_demand(...) and the tool_result
 * frame arrives.  Displays total qty, a bar chart of demand by day (or daypart
 * for single-daypart forecasts), and a per-item table.
 *
 * Dismissible via the X button; auto-dismissed when a new forecast arrives.
 */

import { X, TrendingUp } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { IntervalForecastResult, HorizonDay } from "../track_a/types";

interface ForecastCardProps {
  forecast: IntervalForecastResult;
  onDismiss: () => void;
}

function granularityLabel(g: string): string {
  switch (g) {
    case "week": return "7-Day Forecast";
    case "day": return "Daily Forecast";
    case "daypart": return "Daypart Forecast";
    default: return "Interval Forecast";
  }
}

function dayLabel(d: HorizonDay): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (!d.start) return `Day ${d.day_index + 1}`;
  const date = new Date(d.start * 1000);
  return d.day_index === 0 ? "Today" : d.day_index === 1 ? "Tmrw" : days[date.getDay()];
}

export function ForecastCard({ forecast, onDismiss }: ForecastCardProps) {
  const byDay = forecast.by_day ?? [];
  const byDaypart = forecast.by_daypart ?? {};
  const items = forecast.items ?? [];
  const isMultiDay = byDay.length > 1;

  // Chart data: prefer day breakdown for multi-day, daypart for single-day
  const chartData = isMultiDay
    ? byDay.map((d) => ({ name: dayLabel(d), qty: Math.round(d.qty) }))
    : Object.entries(byDaypart).map(([dp, v]) => ({
        name: dp.charAt(0).toUpperCase() + dp.slice(1),
        qty: Math.round(v.qty),
      }));

  // Top items
  const topItems = [...items]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);

  if (forecast.status === "empty" || forecast.status === "error") {
    return (
      <div className="rounded-2xl border-2 border-muted bg-surface shadow-md overflow-hidden">
        <div className="flex items-center gap-3 bg-accent/10 px-5 py-3">
          <TrendingUp size={20} className="shrink-0 text-accent" />
          <span className="flex-1 text-sm font-bold uppercase tracking-wide text-accent">
            Forecast
          </span>
          <button
            onClick={onDismiss}
            className="rounded-full p-1 text-accent/50 hover:bg-accent/20 hover:text-accent transition-colors"
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 text-text/60 text-sm">
          {forecast.status === "error"
            ? `Error: ${forecast.error ?? "Unknown error"}`
            : `No demand expected in this window (${forecast.reason ?? "closed hours"}).`}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-accent/30 bg-surface shadow-md overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 bg-accent/10 px-5 py-3">
        <TrendingUp size={20} className="shrink-0 text-accent" />
        <span className="flex-1 text-sm font-bold uppercase tracking-wide text-accent">
          {granularityLabel(forecast.granularity)}
        </span>
        <button
          onClick={onDismiss}
          className="rounded-full p-1 text-accent/50 hover:bg-accent/20 hover:text-accent transition-colors"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Hero total */}
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-text">
            {forecast.total_qty.toLocaleString()}
          </span>
          <span className="text-text/50 text-sm">portions forecast</span>
        </div>

        {/* Chart */}
        {chartData.length > 0 && (
          <div className="h-36">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "rgba(255,255,255,0.5)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "rgba(255,255,255,0.5)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface, #1e1e2e)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Bar dataKey="qty" fill="var(--color-accent, #8b5cf6)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Per-item table */}
        {topItems.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-text/40">
              Top Items
            </p>
            <div className="space-y-1">
              {topItems.map((item) => (
                <div
                  key={item.menu_item_id}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-text/80 truncate flex-1 min-w-0 pr-2">
                    {item.name}
                  </span>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-text font-semibold tabular-nums">
                      {Math.round(item.qty)}
                    </span>
                    {item.confidence !== undefined && (
                      <span className="text-text/30 text-xs tabular-nums w-10 text-right">
                        {Math.round(item.confidence * 100)}%
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {items.length > 8 && (
                <p className="text-xs text-text/30 pt-1">
                  +{items.length - 8} more items
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
