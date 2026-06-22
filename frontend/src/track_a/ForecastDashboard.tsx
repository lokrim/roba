import { useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Brain,
  Clock3,
  Eye,
  Gauge,
  GitBranch,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { apiDelete, apiPost } from "../api";
import {
  formatBaseline,
  formatQty,
  formatSimTime,
  itemName,
  latestForecasts,
} from "./helpers";
import type { EventLog, Forecast, ForecastAdjustment, ForecastJob, ForecastTrace, TrackASnapshot } from "./types";
import { EmptyState, Pill, TrackAShell } from "./ui";
import { useTrackAData } from "./useTrackAData";

type ReasonDetail = {
  forecast_id?: number;
  run_id?: string;
  menu_item_id?: number;
  item_name?: string;
  forecast_qty?: number;
  raw_qty?: number;
  explanations?: Record<string, string>;
  multipliers?: Record<string, number>;
  optimized?: boolean;
  hard_override?: number | null;
  trace?: Forecast["trace"];
};

type ConstraintView = {
  id: string;
  label: string;
  source: string;
  summary: string;
  expiresAt?: number | null;
  tone: "neutral" | "good" | "warn" | "bad" | "accent";
  deleteKind?: "override" | "signal";
  deleteId?: number | string;
};

type LedgerAdjustment = Pick<
  ForecastAdjustment,
  "stage" | "source" | "modifier_key" | "operation" | "value" | "reason" | "created_at"
> & {
  id?: number;
};

export function ForecastDashboard() {
  const { data, loading, error, refresh } = useTrackAData();
  const [busyAction, setBusyAction] = useState<"run" | "finalize" | null>(null);
  const [deletingConstraintId, setDeletingConstraintId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);

  async function runForecast() {
    setBusyAction("run");
    try {
      await apiPost("/api/track-a/forecast/run");
      await refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function queueLLMReview() {
    setBusyAction("finalize");
    try {
      await apiPost("/api/track-a/forecast/finalize");
      await refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteConstraint(constraint: ConstraintView) {
    if (!constraint.deleteKind || constraint.deleteId == null) return;
    setDeletingConstraintId(constraint.id);
    try {
      await apiDelete(
        `/api/track-a/constraints/${constraint.deleteKind}/${encodeURIComponent(String(constraint.deleteId))}`,
      );
      await apiPost("/api/track-a/forecast/run").catch(() => undefined);
      await refresh();
    } finally {
      setDeletingConstraintId(null);
    }
  }

  if (loading) {
    return (
      <TrackAShell eyebrow="Track A" title="Forecast">
        <EmptyState label="Loading forecasts" />
      </TrackAShell>
    );
  }

  if (error || !data) {
    return (
      <TrackAShell eyebrow="Track A" title="Forecast">
        <EmptyState label={error ?? "Forecast data unavailable"} />
      </TrackAShell>
    );
  }

  const forecasts = latestForecasts(data);
  const reasoningByForecast = buildReasoningMap(data);
  const selectedForecast =
    forecasts.find((forecast) => forecast.menu_item_id === selectedItemId) ?? forecasts[0] ?? null;
  const selectedReason = selectedForecast ? reasoningByForecast.get(selectedForecast.id) : undefined;
  const selectedTrace = selectedForecast ? traceForForecast(data, selectedForecast, selectedReason) : undefined;
  const selectedAdjustments = selectedForecast
    ? adjustmentsForForecast(data, selectedForecast, selectedTrace)
    : [];
  const constraints = activeConstraints(data);
  const chartData = forecasts.map((forecast) => ({
    name: itemName(data, forecast.menu_item_id),
    forecast: Math.round(forecast.forecast_qty),
    baseline: Number(forecast.baseline_qty.toFixed(1)),
    latent: Math.round(traceNumber(traceForForecast(data, forecast, reasoningByForecast.get(forecast.id)), "latent_demand_qty") ?? forecast.forecast_qty),
  }));
  const totalForecast = forecasts.reduce((sum, forecast) => sum + Math.round(forecast.forecast_qty), 0);
  const latentTotal = forecasts.reduce((sum, forecast) => {
    const trace = traceForForecast(data, forecast, reasoningByForecast.get(forecast.id));
    return sum + Math.round(traceNumber(trace, "latent_demand_qty") ?? forecast.forecast_qty);
  }, 0);
  const constrained = forecasts.filter((forecast) => {
    const reason = reasoningByForecast.get(forecast.id);
    return isConstrainedForecast(forecast, reason);
  }).length;
  const latestJob = latestForecastJob(data);
  return (
    <TrackAShell
      eyebrow={`${data.demo_mode} demand stack`}
      title="Forecast agent"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <JobStatusPill job={latestJob} />
          <button
            type="button"
            onClick={runForecast}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={16} className={busyAction === "run" ? "animate-spin" : ""} />
            Run forecast
          </button>
          <button
            type="button"
            onClick={queueLLMReview}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-2 rounded-md border border-accent/55 bg-primary/55 px-3 py-2 text-sm font-semibold text-text hover:border-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Sparkles size={16} className={busyAction === "finalize" ? "animate-pulse" : ""} />
            Queue LLM review
          </button>
        </div>
      }
    >
      {forecasts.length === 0 ? (
        <EmptyState label="No forecasts yet. Start the sim or run a manual forecast." />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Production plates" value={formatQty(totalForecast)} icon={<Gauge size={17} />} />
            <Metric label="Latent demand" value={formatQty(latentTotal)} icon={<GitBranch size={17} />} />
            <Metric label="Constrained items" value={formatQty(constrained)} icon={<Eye size={17} />} />
            <Metric label="Active constraints" value={formatQty(constraints.length)} icon={<ShieldCheck size={17} />} />
          </div>

          <ActiveConstraintsStrip
            constraints={constraints}
            deletingId={deletingConstraintId}
            onDelete={deleteConstraint}
          />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
            <div className="h-[348px] rounded-md border border-[#16426e] bg-[#101d39] p-3">
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData}>
                  <CartesianGrid stroke="#173760" vertical={false} />
                  <XAxis dataKey="name" stroke="#dce6f7" tick={{ fontSize: 11 }} />
                  <YAxis
                    allowDecimals={false}
                    stroke="#dce6f7"
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(124,92,255,0.12)" }}
                    contentStyle={{
                      background: "#10182f",
                      border: "1px solid #244b7c",
                      borderRadius: 6,
                      color: "#f4f7fb",
                    }}
                  />
                  <Legend />
                  <Bar dataKey="baseline" fill="#1f6f9f" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="latent" fill="#f4c95d" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="forecast" fill="#ef476f" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <SelectedForecastPanel
              data={data}
              forecast={selectedForecast}
              reason={selectedReason}
              trace={selectedTrace}
            />
          </div>
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-md border border-muted">
        <table className="w-full min-w-[980px] border-collapse text-left text-sm">
          <thead className="bg-primary/70 text-xs uppercase tracking-wide text-text/50">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Window</th>
              <th className="px-3 py-2">Generated</th>
              <th className="px-3 py-2">Baseline</th>
              <th className="px-3 py-2">Forecast</th>
              <th className="px-3 py-2">Multipliers</th>
              <th className="px-3 py-2">Sources</th>
              <th className="px-3 py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {forecasts.map((forecast) => {
              const reason = reasoningByForecast.get(forecast.id);
              const selected = selectedForecast?.menu_item_id === forecast.menu_item_id;
              return (
                <tr
                  key={forecast.id}
                  className={`cursor-pointer border-t border-muted/70 align-top hover:bg-primary/35 ${
                    selected ? "bg-accent/10" : ""
                  }`}
                  onClick={() => setSelectedItemId(forecast.menu_item_id)}
                >
                  <td className="px-3 py-3 font-medium">{itemName(data, forecast.menu_item_id)}</td>
                  <td className="px-3 py-3 text-text/65">
                    {forecast.daypart} - {formatSimTime(forecast.window.start)}
                  </td>
                  <td className="px-3 py-3 text-text/65">{formatSimTime(forecast.generated_at)}</td>
                  <td className="px-3 py-3">{formatBaseline(forecast.baseline_qty)}</td>
                  <td className="px-3 py-3 text-lg font-semibold text-accent">{formatQty(forecast.forecast_qty)}</td>
                  <td className="px-3 py-3">
                    <div className="flex max-w-xl flex-wrap gap-1.5">
                      {Object.entries(forecast.multipliers ?? {}).map(([key, value]) => (
                        <Pill key={key} tone={value > 1 ? "good" : value < 1 ? "warn" : "neutral"}>
                          {key.replace("_", " ")} x{Number(value).toFixed(2)}
                        </Pill>
                      ))}
                      <Pill tone="accent">
                        <Sparkles size={12} className="mr-1" />
                        {Math.round(forecast.confidence * 100)}%
                      </Pill>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <SourceBadges sources={sourceBadgesForForecast(data, forecast, reason)} />
                  </td>
                  <td className="max-w-md px-3 py-3 text-xs leading-5 text-text/65">
                    {reasonSummary(reason, forecast)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <AdjustmentLedgerPanel adjustments={selectedAdjustments} />
        <AgentActivityPanel data={data} />
      </div>

      <DishDrillDownControls
        data={data}
        forecasts={forecasts}
        reasoningByForecast={reasoningByForecast}
        selectedItemId={selectedForecast?.menu_item_id ?? null}
        onSelect={setSelectedItemId}
      />
    </TrackAShell>
  );
}

function Metric({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-md border border-[#1d4d7d] bg-[#0f1c35] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase text-text/45">{label}</div>
        <div className="text-[#7c5cff]">{icon}</div>
      </div>
      <div className="mt-2 text-2xl font-semibold text-text">{value}</div>
    </div>
  );
}

function latestForecastJob(data: TrackASnapshot): ForecastJob | null {
  const jobs = [...(data.forecast_jobs ?? [])];
  if (jobs.length === 0) return null;
  return jobs.sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0] ?? null;
}

function JobStatusPill({ job }: { job: ForecastJob | null }) {
  if (!job) {
    return <Pill tone="neutral">no jobs</Pill>;
  }
  const hasApprovals = Boolean(job.result?.needs_approval || (job.result?.approval_ids?.length ?? 0) > 0);
  const label =
    job.status === "succeeded" && hasApprovals
      ? "needs approval"
      : job.status === "succeeded"
        ? "completed"
        : job.status;
  const tone =
    label === "failed"
      ? "bad"
      : label === "stale"
        ? "warn"
        : label === "needs approval"
          ? "accent"
          : label === "running" || label === "queued"
            ? "warn"
            : "good";
  return (
    <Pill tone={tone}>
      {job.kind === "llm_finalizer" ? "LLM review" : "forecast"}: {label}
    </Pill>
  );
}

function PanelTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase text-text/45">
      <span className="text-[#7c5cff]">{icon}</span>
      {label}
    </div>
  );
}

function ActiveConstraintsStrip({
  constraints,
  deletingId,
  onDelete,
}: {
  constraints: ConstraintView[];
  deletingId: string | null;
  onDelete: (constraint: ConstraintView) => void;
}) {
  return (
    <div className="rounded-md border border-muted bg-primary/30 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <PanelTitle icon={<ShieldCheck size={15} />} label="Active constraints" />
        <Pill tone={constraints.length > 0 ? "warn" : "good"}>
          {constraints.length > 0 ? `${constraints.length} active` : "clear"}
        </Pill>
      </div>
      {constraints.length === 0 ? (
        <div className="text-sm text-text/55">No voice, inventory, staff, or authority constraints are active.</div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {constraints.map((constraint) => (
            <div key={constraint.id} className="rounded-md border border-muted bg-[#10182f] p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-sm font-semibold text-text">{constraint.label}</div>
                <div className="flex shrink-0 items-center gap-2">
                  <Pill tone={constraint.tone}>{constraint.source}</Pill>
                  {constraint.deleteKind ? (
                    <button
                      type="button"
                      onClick={() => onDelete(constraint)}
                      disabled={deletingId === constraint.id}
                      aria-label={`Remove ${constraint.label} constraint`}
                      title="Remove constraint"
                      className="inline-flex size-7 items-center justify-center rounded-md border border-muted bg-primary/55 text-text/60 hover:border-[#ef476f]/70 hover:bg-[#ef476f]/10 hover:text-[#ff8aa5] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 size={14} className={deletingId === constraint.id ? "animate-pulse" : ""} />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 text-xs leading-5 text-text/60">{constraint.summary}</div>
              {constraint.expiresAt != null ? (
                <div className="mt-2 flex items-center gap-1 text-xs text-text/45">
                  <Clock3 size={12} />
                  until {formatSimTime(constraint.expiresAt)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectedForecastPanel({
  data,
  forecast,
  reason,
  trace,
}: {
  data: TrackASnapshot;
  forecast: Forecast | null;
  reason: ReasonDetail | undefined;
  trace: ForecastTrace | undefined;
}) {
  if (!forecast) {
    return <EmptyState label="Select a forecast to inspect its drivers." />;
  }
  const baseline = Number(forecast.baseline_qty ?? 0);
  const constrainedRaw = traceNumber(trace, "constrained_raw_qty");
  const deterministic = traceRecordNumber(trace?.deterministic_recommendation, "forecast_qty") ?? forecast.forecast_qty;
  const latent = traceNumber(trace, "latent_demand_qty") ?? constrainedRaw ?? forecast.forecast_qty;
  const production = traceNumber(trace, "production_recommendation_qty") ?? forecast.forecast_qty;
  const zeroReason = traceString(trace, "zero_reason");

  return (
    <div className="h-[348px] min-h-0 overflow-y-auto rounded-md border border-muted bg-primary/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <PanelTitle icon={<GitBranch size={15} />} label="Forecast path" />
          <div className="mt-2 text-lg font-semibold text-text">{itemName(data, forecast.menu_item_id)}</div>
          <div className="mt-1 text-xs text-text/50">
            {forecast.daypart} - generated {formatSimTime(forecast.generated_at)}
          </div>
        </div>
        <SourceBadges sources={sourceBadgesForForecast(data, forecast, reason)} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <StepMetric label="Baseline" value={formatBaseline(baseline)} />
        <StepMetric label="Latent demand" value={formatQty(latent)} />
        <StepMetric label="Deterministic" value={formatQty(deterministic)} />
        <StepMetric label="Final" value={formatQty(production)} accent />
      </div>

      <div className="mt-4 rounded-md border border-muted bg-[#10182f] p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase text-text/45">Top reason</div>
          {zeroReason ? <Pill tone="bad">{zeroReason.replaceAll("_", " ")}</Pill> : null}
        </div>
        <div className="text-sm leading-6 text-text/75">{reasonSummary(reason, forecast)}</div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {Object.entries(forecast.multipliers ?? {}).map(([key, value]) => (
          <Pill key={key} tone={value > 1 ? "good" : value < 1 ? "warn" : "neutral"}>
            {key.replaceAll("_", " ")} x{Number(value).toFixed(2)}
          </Pill>
        ))}
      </div>
    </div>
  );
}

function StepMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-muted bg-[#10182f] p-3">
      <div className="text-xs font-semibold uppercase text-text/45">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${accent ? "text-accent" : "text-text"}`}>{value}</div>
    </div>
  );
}

function AdjustmentLedgerPanel({ adjustments }: { adjustments: LedgerAdjustment[] }) {
  return (
    <div className="rounded-md border border-muted bg-primary/30 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <PanelTitle icon={<ListChecks size={15} />} label="Adjustment ledger" />
        <Pill tone="neutral">{adjustments.length} rows</Pill>
      </div>
      {adjustments.length === 0 ? (
        <div className="text-sm text-text/55">No adjustment ledger is available for the selected forecast.</div>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="text-xs uppercase text-text/45">
              <tr>
                <th className="px-2 py-2">Stage</th>
                <th className="px-2 py-2">Source</th>
                <th className="px-2 py-2">Modifier</th>
                <th className="px-2 py-2">Operation</th>
                <th className="px-2 py-2">Value</th>
                <th className="px-2 py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((adjustment, index) => (
                <tr key={`${adjustment.modifier_key}-${index}`} className="border-t border-muted/70 align-top">
                  <td className="px-2 py-2 text-text/70">{adjustment.stage.replaceAll("_", " ")}</td>
                  <td className="px-2 py-2">
                    <Pill tone={toneForSource(adjustment.source)}>{adjustment.source}</Pill>
                  </td>
                  <td className="px-2 py-2 text-text">{adjustment.modifier_key.replaceAll("_", " ")}</td>
                  <td className="px-2 py-2 text-text/65">{adjustment.operation.replaceAll("_", " ")}</td>
                  <td className="px-2 py-2 text-text/65">{formatAdjustmentValue(adjustment.value)}</td>
                  <td className="px-2 py-2 text-xs leading-5 text-text/60">{adjustment.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AgentActivityPanel({ data }: { data: TrackASnapshot }) {
  const events = latestAgentEvents(data).slice(0, 5);
  return (
    <div className="rounded-md border border-muted bg-primary/30 p-3">
      <PanelTitle icon={<Brain size={15} />} label="Recent agent activity" />
      <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">
        {events.map((event) => (
          <div key={event.id} className="rounded-md border border-muted bg-[#10182f] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase text-text/45">{formatSimTime(event.sim_time)}</span>
              <Pill tone={(event.detail as ReasonDetail | null)?.optimized ? "accent" : "neutral"}>
                {(event.detail as ReasonDetail | null)?.optimized ? "llm" : event.category}
              </Pill>
            </div>
            <div className="mt-2 text-sm font-medium text-text">{event.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DishDrillDownControls({
  data,
  forecasts,
  reasoningByForecast,
  selectedItemId,
  onSelect,
}: {
  data: TrackASnapshot;
  forecasts: Forecast[];
  reasoningByForecast: Map<number, ReasonDetail>;
  selectedItemId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="mt-4 rounded-md border border-muted bg-primary/25 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <PanelTitle icon={<SlidersHorizontal size={15} />} label="Dish drill-down" />
        <div className="text-xs text-text/45">Select a dish to inspect forecast provenance.</div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {forecasts.map((forecast) => {
          const trace = traceForForecast(data, forecast, reasoningByForecast.get(forecast.id));
          const latent = traceNumber(trace, "latent_demand_qty") ?? forecast.forecast_qty;
          const selected = selectedItemId === forecast.menu_item_id;
          return (
            <button
              key={forecast.id}
              type="button"
              onClick={() => onSelect(forecast.menu_item_id)}
              className={`rounded-md border p-3 text-left transition hover:border-accent/70 ${
                selected ? "border-accent bg-accent/10" : "border-muted bg-[#10182f]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-text">{itemName(data, forecast.menu_item_id)}</div>
                <Pill tone={isConstrainedForecast(forecast, reasoningByForecast.get(forecast.id)) ? "warn" : "good"}>
                  {formatQty(forecast.forecast_qty)}
                </Pill>
              </div>
              <div className="mt-2 text-xs text-text/55">
                latent {formatQty(latent)} / baseline {formatBaseline(forecast.baseline_qty)}
              </div>
              <div className="mt-2 max-h-10 overflow-hidden text-xs leading-5 text-text/60">
                {reasonSummary(reasoningByForecast.get(forecast.id), forecast)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function buildReasoningMap(data: TrackASnapshot) {
  const map = new Map<number, ReasonDetail>();
  for (const event of data.forecast_reasoning ?? []) {
    if (event.category !== "forecast") continue;
    const detail = event.detail as ReasonDetail | null;
    if (!detail?.forecast_id) continue;
    if (!map.has(detail.forecast_id)) map.set(detail.forecast_id, detail);
  }
  return map;
}

function latestAgentEvents(data: TrackASnapshot): EventLog[] {
  return [...(data.forecast_reasoning ?? [])].sort((a, b) => b.sim_time - a.sim_time);
}

function activeConstraints(data: TrackASnapshot): ConstraintView[] {
  const now = data.sim_state?.sim_time ?? 0;
  const constraints: ConstraintView[] = [];
  const linkedSignalIds = new Set<string>();
  for (const override of data.forecast_overrides ?? []) {
    if (override.status !== "active") continue;
    if (override.valid_until != null && override.valid_until <= now) continue;
    const linkedSignalId = typeof override.evidence?.signal_id === "string" ? override.evidence.signal_id : null;
    if (linkedSignalId) linkedSignalIds.add(linkedSignalId);
    constraints.push({
      id: `override-${override.id}`,
      label: itemName(data, override.menu_item_id),
      source: override.source,
      summary: override.reason,
      expiresAt: override.valid_until,
      tone: override.source === "voice" ? "accent" : "warn",
      deleteKind: "override",
      deleteId: override.id,
    });
  }
  for (const signal of data.signals ?? []) {
    if (signal.status !== "live") continue;
    if (Number(signal.created_at ?? 0) > now) continue;
    if (signal.expires_at != null && Number(signal.expires_at) <= now) continue;
    const payload = signal.payload ?? {};
    if (signal.type === "STOCKOUT_RISK") {
      constraints.push({
        id: signal.signal_id,
        label: "Stockout risk",
        source: "inventory",
        summary: `Ingredient ${String(payload.ingredient_id ?? "unknown")} affects ${affectedNames(data, payload.affected_items)}`,
        expiresAt: signal.expires_at,
        tone: "bad",
        deleteKind: "signal",
        deleteId: signal.signal_id,
      });
    } else if (signal.type === "STAFF_COVERAGE" && payload.covered === false) {
      constraints.push({
        id: signal.signal_id,
        label: "Station coverage",
        source: "staff",
        summary: `Station ${String(payload.station_id ?? "unknown")} is not covered.`,
        expiresAt: signal.expires_at,
        tone: "warn",
        deleteKind: "signal",
        deleteId: signal.signal_id,
      });
    } else if (signal.type === "MENU_TOGGLE" && payload.action === "disable") {
      constraints.push({
        id: signal.signal_id,
        label: itemName(data, Number(payload.menu_item_id)),
        source: "menu",
        summary: String(payload.reason ?? "Menu item disabled."),
        expiresAt: signal.expires_at,
        tone: "bad",
        deleteKind: "signal",
        deleteId: signal.signal_id,
      });
    } else if (signal.type === "USER_FACT" && payload.intent === "set_operational_constraint") {
      if (linkedSignalIds.has(signal.signal_id)) continue;
      constraints.push({
        id: signal.signal_id,
        label: String(payload.entity_ref ?? "Voice constraint"),
        source: "voice",
        summary: String(payload.raw_text ?? payload.attribute ?? "Voice operational constraint"),
        expiresAt: signal.expires_at,
        tone: "accent",
        deleteKind: "signal",
        deleteId: signal.signal_id,
      });
    }
  }
  return constraints;
}

function affectedNames(data: TrackASnapshot, raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) return "menu items";
  return raw.slice(0, 3).map((id) => itemName(data, Number(id))).join(", ");
}

function traceForForecast(
  data: TrackASnapshot,
  forecast: Forecast,
  reason?: ReasonDetail,
): ForecastTrace | undefined {
  return (
    forecast.trace ??
    reason?.trace ??
    data.forecast_traces?.find((row) => row.forecast_id === forecast.id)?.trace
  ) ?? undefined;
}

function adjustmentsForForecast(
  data: TrackASnapshot,
  forecast: Forecast,
  trace?: ForecastTrace,
): LedgerAdjustment[] {
  const rows = data.forecast_adjustments?.filter((row) => row.forecast_id === forecast.id) ?? [];
  if (rows.length > 0) return rows;
  return (trace?.adjustments ?? []).map((entry) => ({
    stage: String(entry.stage ?? ""),
    source: String(entry.source ?? ""),
    modifier_key: String(entry.key ?? ""),
    operation: String(entry.operation ?? ""),
    value: { value: entry.value },
    reason: String(entry.reason ?? ""),
    created_at: Number(forecast.generated_at ?? 0),
  }));
}

function traceNumber(trace: ForecastTrace | undefined, key: string): number | undefined {
  const raw = trace?.final?.[key];
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function traceRecordNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : undefined;
}

function traceString(trace: ForecastTrace | undefined, key: string): string | undefined {
  const raw = trace?.final?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function isConstrainedForecast(forecast: Forecast, reason: ReasonDetail | undefined) {
  return reason?.hard_override === 0 || Object.values(forecast.multipliers ?? {}).some((value) => Number(value) === 0);
}

function sourceBadgesForForecast(
  data: TrackASnapshot,
  forecast: Forecast,
  reason?: ReasonDetail,
): string[] {
  const trace = traceForForecast(data, forecast, reason);
  const sources = new Set<string>();
  for (const entry of trace?.adjustments ?? []) {
    const source = String(entry.source ?? "");
    if (source && source !== "deterministic") sources.add(source);
  }
  for (const key of Object.keys(forecast.multipliers ?? {})) {
    if (key.includes("llm")) sources.add("llm");
    if (key.includes("authority")) sources.add("authority");
    if (key === "voice_constraint") sources.add("voice");
    if (["availability", "staff_coverage"].includes(key)) sources.add("constraint");
  }
  if (sources.size === 0) sources.add("deterministic");
  return Array.from(sources).slice(0, 4);
}

function SourceBadges({ sources }: { sources: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {sources.map((source) => (
        <Pill key={source} tone={toneForSource(source)}>
          {source.replaceAll("_", " ")}
        </Pill>
      ))}
    </div>
  );
}

function toneForSource(source: string): "neutral" | "good" | "warn" | "bad" | "accent" {
  if (source === "voice" || source === "authority" || source === "authority_resolver") return "accent";
  if (source === "llm") return "accent";
  if (source === "operational_constraint" || source === "constraint" || source === "inventory") return "warn";
  if (source === "staff") return "warn";
  return "neutral";
}

function formatAdjustmentValue(value: Record<string, unknown>) {
  const raw = value.value ?? value.qty ?? value;
  if (typeof raw === "number") return raw.toFixed(2);
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}

function reasonSummary(reason: ReasonDetail | undefined, forecast: Forecast) {
  const traceSummary = reason?.trace?.summary ?? forecast.trace?.summary;
  if (traceSummary) return traceSummary;
  if (!reason?.explanations) {
    return forecast.trigger_reason === "llm_manual"
      ? "Optimized forecast emitted through the LLM stack."
      : "Deterministic forecast emitted through the base stack.";
  }
  const multipliers = forecast.multipliers ?? {};
  const hardPriority = ["llm_override", "availability", "llm_target"];
  for (const key of hardPriority) {
    if (reason.explanations[key]) return reason.explanations[key];
  }
  if ((multipliers.staff_coverage ?? 1) < 0.99 && reason.explanations.staff_coverage) {
    return reason.explanations.staff_coverage;
  }
  const driverPriority = [
    "event",
    "settings_demand",
    "llm_overall",
    "weather",
    "recent_velocity",
    "competitor",
    "review",
  ];
  for (const key of driverPriority) {
    const value = Number(multipliers[key] ?? 1);
    if (reason.explanations[key] && Math.abs(value - 1) >= 0.03) {
      return reason.explanations[key];
    }
  }
  return forecast.trigger_reason === "llm_manual"
    ? "LLM optimization ran, with no major multiplier override for this item."
    : "Forecast generated with no major active demand driver.";
}
