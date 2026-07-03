import { useState, useEffect } from "react";
import { RefreshCw, Zap, TrendingUp } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../../api";
import { SectionHeading } from "./shared";
import { ForecastCard } from "../../voice/ForecastCard";
import type { IntervalForecastResult, HorizonForecast } from "../../track_a/types";

function ActionButton({
  label, description, icon, onClick, busy,
}: {
  label: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg border border-muted bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-accent">{icon}</span>
        <span className="text-sm font-medium text-text">{label}</span>
      </div>
      <p className="mb-3 text-xs text-text/50">{description}</p>
      <button
        type="button" onClick={onClick} disabled={busy}
        className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50"
      >
        <RefreshCw size={14} className={busy ? "animate-spin" : undefined} />
        {busy ? "Running…" : label}
      </button>
    </div>
  );
}

type RangePreset = "week" | "day" | "daypart" | "custom";

function HorizonHistoryRow({ row }: { row: HorizonForecast }) {
  const label = row.label ?? row.granularity ?? "forecast";
  const total = row.total_qty ?? 0;
  return (
    <div className="flex items-center justify-between text-xs py-1 border-b border-muted/30 last:border-0">
      <span className="text-text/60 truncate flex-1">{label}</span>
      <span className="text-text font-medium tabular-nums ml-2">{Math.round(total).toLocaleString()} portions</span>
    </div>
  );
}

export function IntervalForecastPanel() {
  const [range, setRange] = useState<RangePreset>("week");
  const [dayOffset, setDayOffset] = useState(0);
  const [daypart, setDaypart] = useState("dinner");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IntervalForecastResult | null>(null);
  const [horizons, setHorizons] = useState<HorizonForecast[]>([]);

  // Fetch saved horizon headers on mount
  useEffect(() => {
    apiGet<{ horizons: HorizonForecast[] }>("/api/track-a/forecast/horizons")
      .then((d) => setHorizons(d.horizons ?? []))
      .catch(() => {});
  }, []);

  async function generate() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { range, day_offset: dayOffset };
      if (range === "daypart") body.daypart = daypart;
      const data = await apiPost("/api/track-a/forecast/horizon", body);
      const r = data as IntervalForecastResult;
      setResult(r);
      // Refresh history list
      apiGet<{ horizons: HorizonForecast[] }>("/api/track-a/forecast/horizons")
        .then((d) => setHorizons(d.horizons ?? []))
        .catch(() => {});
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeading>On-Demand Interval Forecast</SectionHeading>
      <p className="text-[10px] text-text/40">
        Generate a demand forecast for any future interval. Results are saved and can be used by the inventory optimizer.
      </p>

      {/* Range picker */}
      <div className="grid grid-cols-4 gap-1.5">
        {(["week", "day", "daypart", "custom"] as RangePreset[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={
              "rounded-md px-2 py-1.5 text-xs font-medium transition-colors " +
              (range === r
                ? "bg-accent text-white"
                : "bg-muted text-text/70 hover:bg-muted/70")
            }
          >
            {r === "week" ? "7-Day" : r === "day" ? "Day" : r === "daypart" ? "Daypart" : "Custom"}
          </button>
        ))}
      </div>

      {/* Contextual inputs */}
      {range !== "week" && (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-xs text-text/40 block mb-1">Day offset</label>
            <select
              value={dayOffset}
              onChange={(e) => setDayOffset(Number(e.target.value))}
              className="w-full rounded-md bg-muted/50 border border-muted px-2 py-1.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value={0}>Today</option>
              <option value={1}>Tomorrow</option>
              <option value={2}>Day +2</option>
              <option value={3}>Day +3</option>
              <option value={6}>Day +6</option>
            </select>
          </div>
          {range === "daypart" && (
            <div className="flex-1">
              <label className="text-xs text-text/40 block mb-1">Daypart</label>
              <select
                value={daypart}
                onChange={(e) => setDaypart(e.target.value)}
                className="w-full rounded-md bg-muted/50 border border-muted px-2 py-1.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {["breakfast", "lunch", "afternoon", "dinner", "late"].map((dp) => (
                  <option key={dp} value={dp}>{dp.charAt(0).toUpperCase() + dp.slice(1)}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void generate()}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50 w-full justify-center"
      >
        <TrendingUp size={15} className={busy ? "animate-pulse" : undefined} />
        {busy ? "Generating…" : "Generate Forecast"}
      </button>

      {/* Result card */}
      {result && (
        <ForecastCard forecast={result} onDismiss={() => setResult(null)} />
      )}

      {/* Saved history */}
      {horizons.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-text/30">Recent forecasts</p>
          <div className="rounded-lg border border-muted bg-surface/50 p-3">
            {horizons.slice(0, 6).map((h, i) => (
              <HorizonHistoryRow key={h.id ?? i} row={h} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ForecastControls() {
  const [runBusy, setRunBusy] = useState(false);
  const [finBusy, setFinBusy] = useState(false);
  const [autoMode, setAutoMode] = useState<boolean | null>(null);
  const [autoMuteBusy, setAutoModeBusy] = useState(false);
  const [batchAutoQty, setBatchAutoQty] = useState<boolean>(false);
  const [batchQtyBusy, setBatchQtyBusy] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);

  // Load current batch_auto_qty setting on mount
  useEffect(() => {
    apiGet<{ batch_auto_qty?: number | boolean }>("/api/sim/pos")
      .then((d) => {
        if (d?.batch_auto_qty != null) setBatchAutoQty(Boolean(d.batch_auto_qty));
      })
      .catch(() => {});
  }, []);

  async function runForecast() {
    setRunBusy(true);
    try { await apiPost("/api/track-a/forecast/run"); }
    catch { /* ignore */ } finally { setRunBusy(false); }
  }

  async function finalizeForecast() {
    setFinBusy(true);
    try { await apiPost("/api/track-a/forecast/finalize"); }
    catch { /* ignore */ } finally { setFinBusy(false); }
  }

  async function toggleAutoMode() {
    const next = autoMode === null ? true : !autoMode;
    setAutoModeBusy(true);
    try {
      await apiPost("/api/track-a/forecast/auto-mode", { enabled: next });
      setAutoMode(next);
    } catch { /* ignore */ } finally { setAutoModeBusy(false); }
  }

  async function toggleBatchAutoQty() {
    const next = !batchAutoQty;
    setBatchQtyBusy(true);
    try {
      await apiPatch("/api/sim/pos", { batch_auto_qty: next });
      setBatchAutoQty(next);
    } catch { /* ignore */ } finally { setBatchQtyBusy(false); }
  }

  async function seedBatches() {
    setSeedBusy(true);
    try { await apiPost("/api/dev/seed-batches"); }
    catch { /* ignore */ } finally { setSeedBusy(false); }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
      <SectionHeading>Forecast Controls</SectionHeading>
      <p className="text-[10px] text-text/40">
        Manually trigger forecast runs or configure auto-mode. The forecaster runs every 30 sim-minutes automatically when the sim is running.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <ActionButton
          label="Run Deterministic Forecast"
          description="Re-runs the baseline × multiplier forecast immediately for all active menu items and triggers batch decisions."
          icon={<RefreshCw size={16} />}
          onClick={() => void runForecast()}
          busy={runBusy}
        />
        <ActionButton
          label="LLM Finalize Forecast"
          description="Sends the current forecast to the LLM for narrative suggestions and priority adjustments."
          icon={<Zap size={16} />}
          onClick={() => void finalizeForecast()}
          busy={finBusy}
        />
      </div>

      <div className="rounded-lg border border-muted bg-surface p-4">
        <p className="mb-1 text-sm font-medium text-text">Auto-mode</p>
        <p className="mb-3 text-xs text-text/50">
          When enabled, the forecaster runs on every signal (weather, competitor intel, reviews, etc.) in addition to the interval timer. The start-of-day batch advisor also activates.
        </p>
        <button
          type="button" onClick={() => void toggleAutoMode()} disabled={autoMuteBusy}
          className={"rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 " +
            (autoMode ? "bg-success/20 text-success hover:bg-success/30" : "bg-muted text-text hover:bg-muted/70")}
        >
          {autoMuteBusy ? "…" : autoMode ? "Auto-mode ON — click to disable" : "Auto-mode OFF — click to enable"}
        </button>
      </div>

      <div className="rounded-lg border border-muted bg-surface p-4">
        <p className="mb-1 text-sm font-medium text-text">Batch quantities</p>
        <p className="mb-3 text-xs text-text/50">
          When enabled, the forecaster's start-of-day advisor can adjust batch quantities automatically without requiring manager approval. Structural changes (add / retime) always require approval.
        </p>
        <button
          type="button" onClick={() => void toggleBatchAutoQty()} disabled={batchQtyBusy}
          className={"rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 " +
            (batchAutoQty ? "bg-success/20 text-success hover:bg-success/30" : "bg-muted text-text hover:bg-muted/70")}
        >
          {batchQtyBusy ? "…" : batchAutoQty ? "Auto qty ON — click to require approval" : "Auto qty OFF — click to enable"}
        </button>
      </div>

      <div className="rounded-lg border border-muted bg-surface p-4">
        <p className="mb-1 text-sm font-medium text-text">Seed batch schedule</p>
        <p className="mb-3 text-xs text-text/50">
          Regenerate today's full batch schedule from the loaded batch definitions. Useful after a preset change or to reset the cook panel.
        </p>
        <button
          type="button" onClick={() => void seedBatches()} disabled={seedBusy}
          className="flex items-center gap-1 rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-text hover:bg-muted/70 disabled:opacity-50"
        >
          <RefreshCw size={14} className={seedBusy ? "animate-spin" : undefined} />
          {seedBusy ? "Seeding…" : "Seed batches"}
        </button>
      </div>
      </div>
      <IntervalForecastPanel />
    </div>
  );
}
