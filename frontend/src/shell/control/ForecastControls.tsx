import { useState } from "react";
import { RefreshCw, Zap } from "lucide-react";
import { apiPost } from "../../api";
import { SectionHeading } from "./shared";

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

export function ForecastControls() {
  const [runBusy, setRunBusy] = useState(false);
  const [finBusy, setFinBusy] = useState(false);
  const [autoMode, setAutoMode] = useState<boolean | null>(null);
  const [autoMuteBusy, setAutoModeBusy] = useState(false);

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

  return (
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
          When enabled, the forecaster runs on every signal (weather, competitor intel, reviews, etc.) in addition to the interval timer.
        </p>
        <button
          type="button" onClick={() => void toggleAutoMode()} disabled={autoMuteBusy}
          className={"rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 " +
            (autoMode ? "bg-success/20 text-success hover:bg-success/30" : "bg-muted text-text hover:bg-muted/70")}
        >
          {autoMuteBusy ? "…" : autoMode ? "Auto-mode ON — click to disable" : "Auto-mode OFF — click to enable"}
        </button>
      </div>
    </div>
  );
}
