import { useState, useEffect, useRef } from "react";
import { CheckCircle2, XCircle, Bell, Send, RefreshCw, Check, X } from "lucide-react";
import { useVoiceLive } from "./useVoiceLive";
import { MicButton } from "./MicButton";
import { PlanConfirmCard } from "./PlanConfirmCard";
import { ForecastCard } from "./ForecastCard";
import { ModeToggle } from "./ModeToggle";
import { MicModeToggle } from "./MicModeToggle";
import { ModelToggle } from "./ModelToggle";
import { apiGet, apiPost } from "../api";
import type { ApprovalRequest } from "../types";

// ---------------------------------------------------------------------------
// Approval inbox item
// ---------------------------------------------------------------------------

// Batch suggestion payload shape from the advisor
interface BatchProposalPayload {
  proposal_type?: string;
  dish_name?: string;
  target_window_start?: number;
  target_qty?: number;
  forecast_demand?: number;
  projected_benefit?: string;
  reasoning?: string;
}

function fmtSimClock(secs: number): string {
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function ApprovalItem({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest;
  onResolve: (id: number, decision: "approve" | "reject") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const isBatch = approval.type === "batch";
  const payload = isBatch ? (approval.payload as BatchProposalPayload | null) : null;

  return (
    <div className="rounded-lg border border-muted/60 bg-surface p-3 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-text/50">
            {approval.type.replace(/_/g, " ")}
          </span>
          <p className="mt-0.5 text-sm font-medium text-text">{approval.title}</p>
          {approval.summary && (
            <p className="text-xs text-text/60 mt-0.5 line-clamp-2">{approval.summary}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 items-end">
          <div className="flex gap-1.5">
            <button
              disabled={busy}
              onClick={() => { setBusy(true); onResolve(approval.id, "approve"); }}
              className="rounded-md bg-success/20 px-2 py-1 text-xs font-medium text-success hover:bg-success/30 disabled:opacity-40"
            >
              <CheckCircle2 size={12} className="inline mr-0.5" />
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() => { setBusy(true); onResolve(approval.id, "reject"); }}
              className="rounded-md bg-danger/20 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/30 disabled:opacity-40"
            >
              <XCircle size={12} className="inline mr-0.5" />
              Reject
            </button>
          </div>
          {isBatch && payload && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="text-xs text-text/40 hover:text-text/70"
            >
              {expanded ? "Hide detail ▲" : "See reasoning ▼"}
            </button>
          )}
        </div>
      </div>

      {/* Batch suggestion detail panel */}
      {isBatch && payload && expanded && (
        <div className="border-t border-muted/30 pt-2 space-y-1.5 text-xs">
          {payload.proposal_type && (
            <div className="flex gap-2">
              <span className="text-text/40 w-28 shrink-0">Type</span>
              <span className="text-text font-medium capitalize">{payload.proposal_type.replace(/_/g, " ")}</span>
            </div>
          )}
          {payload.dish_name && (
            <div className="flex gap-2">
              <span className="text-text/40 w-28 shrink-0">Dish</span>
              <span className="text-text font-medium">{payload.dish_name}</span>
            </div>
          )}
          {payload.target_window_start != null && (
            <div className="flex gap-2">
              <span className="text-text/40 w-28 shrink-0">Target window</span>
              <span className="text-text">{fmtSimClock(payload.target_window_start)}</span>
            </div>
          )}
          {payload.target_qty != null && (
            <div className="flex gap-2">
              <span className="text-text/40 w-28 shrink-0">Suggested qty</span>
              <span className="text-text">{payload.target_qty} portions</span>
            </div>
          )}
          {payload.forecast_demand != null && (
            <div className="flex gap-2">
              <span className="text-text/40 w-28 shrink-0">Forecast demand</span>
              <span className="text-text">{payload.forecast_demand.toFixed(1)} portions</span>
            </div>
          )}
          {payload.projected_benefit && (
            <div className="flex gap-2">
              <span className="text-text/40 w-28 shrink-0">Benefit</span>
              <span className="text-accent">{payload.projected_benefit}</span>
            </div>
          )}
          {payload.reasoning && (
            <div className="mt-1 rounded bg-muted/30 p-2 text-text/70 leading-relaxed">
              {payload.reasoning}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text input fallback (shown when Gemini Live is unavailable)
// ---------------------------------------------------------------------------

function TextFallback({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSend(text.trim());
        setText("");
      }}
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a note for Roba…"
        className="flex-1 rounded-lg border border-muted bg-surface px-3 py-2 text-sm text-text placeholder:text-text/30 focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="rounded-lg bg-accent px-3 py-2 text-white hover:bg-accent/90 disabled:opacity-40"
      >
        <Send size={16} />
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ManagerVoice
// ---------------------------------------------------------------------------

export function ManagerVoice() {
  const live = useVoiceLive("manager");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [showDev, setShowDev] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () =>
      apiGet<ApprovalRequest[]>("/api/approvals?status=pending")
        .then(setApprovals)
        .catch(() => undefined);
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [live.transcript]);

  async function handleResolve(id: number, decision: "approve" | "reject") {
    try {
      await apiPost(`/api/approvals/${id}/${decision}`);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // keep in list
    }
  }

  async function handleClarify(planId: string, answer: string) {
    try {
      await apiPost("/api/voice/clarify", { plan_id: planId, answer });
      live.setDone("Clarification submitted.");
    } catch { /* ignore */ }
  }

  const isUnavailable = live.state === "unavailable";

  return (
    <div className="flex flex-col gap-5">
      {/* Header row: mode toggles */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-text/40">Plan mode</span>
          <ModeToggle mode={live.mode} onChange={live.setMode} disabled={live.state === "listening"} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-text/40">Mic mode</span>
          <MicModeToggle micMode={live.micMode} onChange={live.setMicMode} disabled={live.state === "listening"} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-text/40">Voice model</span>
          <ModelToggle voiceModel={live.voiceModel} onChange={live.setVoiceModel} disabled={live.state === "listening"} />
        </div>
      </div>

      {/* Error / info strip */}
      {live.lastError && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <span className="flex-1">{live.lastError}</span>
          <button
            className="shrink-0 text-warning/60 hover:text-warning"
            onClick={() => window.location.reload()}
            aria-label="Retry"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      )}

      {/* Main interaction area */}
      {isUnavailable ? (
        <div className="flex flex-col gap-3">
          <TextFallback onSend={live.sendText} />
        </div>
      ) : (
        <div className="flex justify-center py-4">
          <MicButton
            state={live.state}
            micMode={live.micMode}
            size="lg"
            onStart={live.startListening}
            onStop={live.stopListening}
          />
        </div>
      )}

      {/* Pending plan / confirm card */}
      {live.pendingPlan && (
        <PlanConfirmCard
          plan={live.pendingPlan}
          clarification={live.clarification}
          onConfirm={live.confirmPlan}
          onCancel={live.cancelPlan}
          onClarify={handleClarify}
          status={live.cardStatus}
        />
      )}

      {/* Auto-mode done card — brief confirmation of what was just applied */}
      {!live.pendingPlan && live.lastApplied && (
        <div className="flex items-center gap-3 rounded-xl border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-text">
          <Check size={16} className="shrink-0 text-green-500" />
          <span className="flex-1">{live.lastApplied.summary}</span>
          <button
            onClick={live.clearLastApplied}
            className="shrink-0 text-text/30 hover:text-text/60"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Voice answer card */}
      {live.lastStatus && (
        <div className="rounded-xl border border-accent/30 bg-surface p-4">
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-accent">Answer</span>
            <button onClick={live.clearStatus} className="text-text/30 hover:text-text/60 text-xs">✕</button>
          </div>
          {live.lastStatus.summary != null && <p className="text-sm text-text">{String(live.lastStatus.summary)}</p>}
        </div>
      )}

      {/* Interval forecast card (voice: forecast_demand tool result) */}
      {live.lastForecast && (
        <ForecastCard forecast={live.lastForecast} onDismiss={live.clearForecast} />
      )}

      {/* Approvals inbox */}
      {approvals.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-1.5">
            <Bell size={13} className="text-warning" />
            <span className="text-xs font-semibold uppercase tracking-wide text-text/50">
              Needs approval ({approvals.length})
            </span>
          </div>
          <div className="space-y-2">
            {approvals.map((a) => (
              <ApprovalItem key={a.id} approval={a} onResolve={handleResolve} />
            ))}
          </div>
        </section>
      )}

      {/* Transcript */}
      {live.transcript.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-text/40">Transcript</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDev(v => !v)}
                className={`px-2 py-1 text-xs rounded border ${showDev ? "bg-zinc-700 border-zinc-500 text-white" : "border-zinc-600 text-zinc-400 hover:text-zinc-200"}`}
              >
                Dev
              </button>
              <button onClick={live.clearTranscript} className="text-xs text-text/30 hover:text-text/60">
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto rounded-lg border border-muted/40 bg-surface/50 p-3 space-y-2">
            {live.transcript.slice(-20).map((line) => (
              <div key={line.id} className={line.role === "user" ? "text-right" : "text-left"}>
                <span
                  className={[
                    "inline-block rounded-xl px-3 py-1.5 text-sm max-w-[85%]",
                    line.role === "user" ? "bg-accent/20 text-text" : "bg-muted text-text/80",
                  ].join(" ")}
                >
                  {line.text}
                </span>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
          {showDev && (
            <section className="mt-2 border border-zinc-700 rounded-lg bg-zinc-950 p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-400 font-mono">Raw transcript frames ({live.rawFrames.length})</span>
                <button onClick={live.clearRawFrames} className="text-xs text-zinc-500 hover:text-zinc-300">Clear</button>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-0.5 font-mono text-xs">
                {live.rawFrames.length === 0 && (
                  <div className="text-zinc-600">No frames yet — speak something.</div>
                )}
                {live.rawFrames.map((f, i) => (
                  <div key={i} className={`leading-tight ${f.role === "user" ? "text-blue-300" : "text-green-300"}`}>
                    <span className="text-zinc-500">[{f.ts}]</span>{" "}
                    <span className={f.final ? "font-semibold" : "opacity-70"}>[{f.role}]</span>{" "}
                    {f.final ? "✓" : "…"}{" "}
                    <span className="text-zinc-400">turn={f.turn_id.slice(0,8)}</span>{" "}
                    "{f.text}"
                  </div>
                ))}
              </div>
            </section>
          )}
        </section>
      )}

      {/* Text fallback also available when unavailable (shown above) but also offer
          a secondary text box when voice is available, for silent environments */}
      {!isUnavailable && live.state !== "listening" && (
        <details className="text-xs text-text/30">
          <summary className="cursor-pointer hover:text-text/50">Type instead</summary>
          <div className="mt-2">
            <TextFallback onSend={live.sendText} />
          </div>
        </details>
      )}
    </div>
  );
}
