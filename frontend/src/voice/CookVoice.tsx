import { useState, useEffect, useRef, useCallback } from "react";
import {
  Loader2, ChefHat, Trash2, Send, RefreshCw, Check, X,
  ChevronDown, ChevronUp, BookOpen, CheckSquare,
} from "lucide-react";
import { useVoiceLive } from "./useVoiceLive";
import { MicButton } from "./MicButton";
import { PlanConfirmCard } from "./PlanConfirmCard";
import { ModeToggle } from "./ModeToggle";
import { MicModeToggle } from "./MicModeToggle";
import { apiGet, apiPost } from "../api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstructionStep {
  ingredient: string;
  qty: number;
  unit: string;
  optional: boolean;
}

interface BoardBatch {
  id: number;
  menu_item_id: number;
  dish: string;
  decision: string;
  status: string;
  state: "cooked" | "ready_to_cook" | "awaiting_approval" | "skipped";
  planned_qty: number | null;
  actual_made_qty: number | null;
  cook_by: number | null;
  serve_end: number | null;
  cooked_at: number | null;
  prep_lead_time_min: number | null;
  required_skill: string | null;
  station_id: number | null;
  instructions: InstructionStep[];
}

interface KitchenBoard {
  generated_at_sim: number;
  clock: string;
  counts: { cooked: number; approved: number; pending: number; skipped: number };
  batches: BoardBatch[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtSimTime(secs: number): string {
  return `${String(Math.floor(secs / 3600) % 24).padStart(2, "0")}:${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}`;
}

/** Returns relative time string: "in 14 min", "overdue 5 min", "now" */
function relativeTime(cookBy: number, nowSim: number): string {
  const diff = cookBy - nowSim;
  const mins = Math.round(diff / 60);
  if (Math.abs(mins) <= 1) return "now";
  if (mins > 0) return `in ${mins} min`;
  return `overdue ${Math.abs(mins)} min`;
}

const STATE_PILL: Record<string, { label: string; cls: string }> = {
  cooked:            { label: "Cooked",        cls: "bg-success/20 text-success" },
  ready_to_cook:     { label: "Ready to cook", cls: "bg-accent/20 text-accent" },
  awaiting_approval: { label: "Awaiting",      cls: "bg-warning/20 text-warning" },
  skipped:           { label: "Cancelled",     cls: "bg-muted/60 text-text/40" },
};

// ---------------------------------------------------------------------------
// BatchCard — one card per batch in the scrollable list
// ---------------------------------------------------------------------------

function BatchCard({
  batch,
  nowSim,
  onCheck,
}: {
  batch: BoardBatch;
  nowSim: number;
  onCheck: (batch: BoardBatch, qty: number) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [qty, setQty] = useState(String(batch.planned_qty ?? 0));
  const pill = STATE_PILL[batch.state] ?? { label: batch.state, cls: "bg-muted/40 text-text/50" };
  const isCancelled = batch.state === "skipped";
  const isCooked = batch.state === "cooked";
  const canCheck = !isCooked && !isCancelled;

  return (
    <div
      className={[
        "rounded-xl border p-4 shadow-sm transition-opacity",
        isCancelled
          ? "border-muted/30 bg-surface/30 opacity-60"
          : "border-muted/50 bg-surface",
      ].join(" ")}
    >
      {/* Header row: dish name + state pill */}
      <div className="flex items-start justify-between gap-3">
        <h3
          className={[
            "text-lg font-bold leading-tight",
            isCancelled ? "line-through text-text/40" : "text-text",
          ].join(" ")}
        >
          {batch.dish}
        </h3>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${pill.cls}`}>
          {pill.label}
        </span>
      </div>

      {/* Time-to-prep row */}
      {batch.cook_by != null && !isCancelled && (
        <div className="mt-2 flex items-center gap-3 text-sm">
          <span className="font-semibold text-text">
            {fmtSimTime(batch.cook_by)}
          </span>
          <span className="text-text/40 text-xs">
            {relativeTime(batch.cook_by, nowSim)}
          </span>
          {batch.prep_lead_time_min != null && (
            <span className="ml-auto text-xs text-text/40">
              {batch.prep_lead_time_min} min prep
            </span>
          )}
        </div>
      )}

      {/* Qty row */}
      {!isCancelled && (
        <div className="mt-2 text-xs text-text/50">
          {isCooked
            ? `Made: ${batch.actual_made_qty ?? "?"} / ${batch.planned_qty ?? "?"}`
            : `Planned: ${batch.planned_qty ?? "?"}`}
        </div>
      )}

      {/* Action row: Detail + Check */}
      <div className="mt-3 flex items-center gap-2">
        {/* Detail button */}
        <button
          onClick={() => setDetailOpen(v => !v)}
          className="flex items-center gap-1 rounded-lg border border-muted/60 px-2.5 py-1.5 text-xs text-text/60 hover:bg-muted/30 transition-colors"
        >
          <BookOpen size={12} />
          Detail
          {detailOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>

        {/* Check / mark-cooked area */}
        {canCheck && (
          <div className="ml-auto flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="w-16 rounded-lg border border-muted bg-primary/60 px-2 py-1 text-sm text-text text-center focus:border-accent focus:outline-none"
              title="Actual qty made"
            />
            <button
              onClick={() => onCheck(batch, Number(qty) || Number(batch.planned_qty) || 0)}
              className="flex items-center gap-1.5 rounded-lg bg-success/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-success transition-colors"
            >
              <CheckSquare size={13} />
              Check
            </button>
          </div>
        )}
      </div>

      {/* Detail panel: recipe instructions */}
      {detailOpen && (
        <div className="mt-3 border-t border-muted/30 pt-3 space-y-2">
          {batch.required_skill && (
            <p className="text-xs text-text/40">
              <span className="font-medium text-text/60">Skill required: </span>{batch.required_skill}
            </p>
          )}
          {batch.instructions.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-text/50 mb-1.5 uppercase tracking-wide">Recipe</p>
              <ul className="space-y-1">
                {batch.instructions.map((step, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-xs">
                    <span className="text-text/30 w-4 shrink-0 text-right">{i + 1}.</span>
                    <span className={step.optional ? "text-text/40 italic" : "text-text/70"}>
                      {step.qty > 0 && (
                        <span className="font-medium text-text/80">{step.qty} {step.unit} </span>
                      )}
                      {step.ingredient}
                      {step.optional && " (optional)"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-text/30 italic">No recipe on file.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text fallback
// ---------------------------------------------------------------------------

function TextFallback({ onSend }: { onSend: (t: string) => void }) {
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
        placeholder='e.g. "I made 12 burgers, throwing 3 away"'
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
// CookVoice
// ---------------------------------------------------------------------------

export function CookVoice() {
  const live = useVoiceLive("cook");
  const [board, setBoard] = useState<KitchenBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDev, setShowDev] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Scrollable batch list container + per-card refs for auto-scroll
  const listRef = useRef<HTMLDivElement>(null);
  const batchRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Track whether user has manually scrolled (suppress auto-scroll if so)
  const userScrolled = useRef(false);

  const loadBoard = useCallback(() =>
    apiGet<KitchenBoard>("/api/kitchen/board?window_hours=16")
      .then((b) => {
        if (b) setBoard(b);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false)),
  []);

  useEffect(() => {
    void loadBoard();
    const id = setInterval(() => void loadBoard(), 5000);
    return () => clearInterval(id);
  }, [loadBoard]);

  // Auto-scroll to the first batch with cook_by >= (now - 30min) on initial load
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (!board || didInitialScroll.current || userScrolled.current) return;
    const nowSim = board.generated_at_sim;
    const threshold = nowSim - 30 * 60;
    const sorted = [...board.batches]
      .filter(b => b.cook_by != null)
      .sort((a, b2) => (a.cook_by ?? 0) - (b2.cook_by ?? 0));
    const target = sorted.find(b => (b.cook_by ?? 0) >= threshold);
    if (target) {
      const el = batchRefs.current.get(target.id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        didInitialScroll.current = true;
      }
    }
  }, [board]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [live.transcript]);

  async function handleCheck(batch: BoardBatch, qty: number) {
    try {
      await apiPost(`/api/kitchen/batches/${batch.id}/cooked`, { actual_made_qty: qty });
      setBoard(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          batches: prev.batches.map(b =>
            b.id === batch.id
              ? { ...b, status: "ready", state: "cooked" as const, actual_made_qty: qty, cooked_at: prev.generated_at_sim }
              : b
          ),
          counts: {
            ...prev.counts,
            cooked: prev.counts.cooked + 1,
            approved: Math.max(0, prev.counts.approved - 1),
          },
        };
      });
    } catch { /* next poll will correct */ }
  }

  async function handleClarify(planId: string, answer: string) {
    try {
      await apiPost("/api/voice/clarify", { plan_id: planId, answer });
      live.setDone("Clarification submitted.");
    } catch { /* ignore */ }
  }

  const isUnavailable = live.state === "unavailable";
  const nowSim = board?.generated_at_sim ?? 0;

  // Sort batches ascending by cook_by (nulls last)
  const sortedBatches = board
    ? [...board.batches].sort((a, b) => {
        if (a.cook_by == null && b.cook_by == null) return 0;
        if (a.cook_by == null) return 1;
        if (b.cook_by == null) return -1;
        return a.cook_by - b.cook_by;
      })
    : [];

  // Next upcoming non-cooked/non-cancelled batch for quick actions
  const nextBatch = sortedBatches.find(
    b => b.state === "ready_to_cook" || b.state === "awaiting_approval"
  ) ?? null;

  // -------------------------------------------------------------------------
  // Shared sub-components for the voice (right) pane
  // -------------------------------------------------------------------------

  /** Mode toggles row — compact single-line on wide screens */
  const modeToggles = (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 shrink-0">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text/40">Plan</span>
        <ModeToggle mode={live.mode} onChange={live.setMode} disabled={live.state === "listening"} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text/40">Mic</span>
        <MicModeToggle micMode={live.micMode} onChange={live.setMicMode} disabled={live.state === "listening"} />
      </div>
    </div>
  );

  /** Mic button + quick actions */
  const micArea = isUnavailable ? (
    <div className="shrink-0">
      <TextFallback onSend={live.sendText} />
    </div>
  ) : (
    <div className="shrink-0 flex flex-col items-center gap-3">
      <MicButton
        state={live.state}
        micMode={live.micMode}
        size="md"
        onStart={live.startListening}
        onStop={live.stopListening}
      />
      {nextBatch && (
        <div className="flex gap-2">
          <button
            disabled={live.state === "listening" || live.state === "thinking"}
            onClick={() => live.sendText(`I cooked the ${nextBatch.dish}, made ${nextBatch.planned_qty}`)}
            className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-3 py-1.5 text-sm text-success hover:bg-success/20 disabled:opacity-40"
          >
            <ChefHat size={13} />
            Batch done
          </button>
          <button
            disabled={live.state === "listening" || live.state === "thinking"}
            onClick={() => live.sendText(`I threw away some ${nextBatch.dish}`)}
            className="flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-sm text-danger hover:bg-danger/20 disabled:opacity-40"
          >
            <Trash2 size={13} />
            Report waste
          </button>
        </div>
      )}
    </div>
  );

  /** Status / plan / done cards — shrink-0 section between mic and transcript */
  const voiceCards = (
    <>
      {/* Error strip */}
      {live.lastError && (
        <div className="shrink-0 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
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

      {/* Voice answer card */}
      {live.lastStatus && (
        <div className="shrink-0 rounded-xl border border-accent/30 bg-surface p-3 shadow-md">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-accent">Answer</span>
            <button onClick={live.clearStatus} className="text-text/30 hover:text-text/60 text-xs" aria-label="Dismiss">✕</button>
          </div>
          {live.lastStatus.summary != null && (
            <p className="text-sm font-medium text-text mb-1.5">{String(live.lastStatus.summary)}</p>
          )}
          {live.lastStatus.answer != null && (
            <div className="flex flex-wrap gap-2">
              {(() => {
                const ans = live.lastStatus.answer as {
                  prepared?: boolean; should_cook?: boolean;
                  awaiting_approval?: boolean; made_qty?: number | null;
                };
                if (ans.prepared) return (
                  <>
                    <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-success/20 text-success">Cooked</span>
                    {ans.made_qty != null && <span className="text-xs text-text/60">{ans.made_qty} made</span>}
                  </>
                );
                if (ans.should_cook) return <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-accent/20 text-accent">Should cook now</span>;
                if (ans.awaiting_approval) return <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-warning/20 text-warning">Awaiting approval</span>;
                return null;
              })()}
            </div>
          )}
          {live.lastStatus.counts != null && live.lastStatus.answer == null && (
            <div className="flex gap-3 text-xs">
              {(live.lastStatus.counts as { cooked?: number }).cooked != null && (
                <span className="text-success">{(live.lastStatus.counts as { cooked: number }).cooked} cooked</span>
              )}
              {(live.lastStatus.counts as { approved?: number }).approved != null && (
                <span className="text-accent">{(live.lastStatus.counts as { approved: number }).approved} to cook</span>
              )}
              {(live.lastStatus.counts as { pending?: number }).pending != null && (
                <span className="text-warning">{(live.lastStatus.counts as { pending: number }).pending} pending</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Plan / clarification */}
      {live.pendingPlan && (
        <div className="shrink-0">
          <PlanConfirmCard
            plan={live.pendingPlan}
            clarification={live.clarification}
            onConfirm={live.confirmPlan}
            onCancel={live.cancelPlan}
            onClarify={handleClarify}
            status={live.cardStatus}
          />
        </div>
      )}

      {/* Auto-mode done card */}
      {!live.pendingPlan && live.lastApplied && (
        <div className="shrink-0 flex items-center gap-3 rounded-xl border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-text">
          <Check size={16} className="shrink-0 text-green-500" />
          <span className="flex-1">{live.lastApplied.summary}</span>
          <button onClick={live.clearLastApplied} className="shrink-0 text-text/30 hover:text-text/60" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );

  /** Transcript section */
  const transcriptSection = (
    <section className="flex flex-col min-h-0 flex-1">
      {live.transcript.length > 0 ? (
        <>
          <div className="shrink-0 mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-text/40">Transcript</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDev(v => !v)}
                className={`px-2 py-0.5 text-xs rounded border ${showDev ? "bg-zinc-700 border-zinc-500 text-white" : "border-zinc-600 text-zinc-400 hover:text-zinc-200"}`}
              >
                Dev
              </button>
              <button onClick={live.clearTranscript} className="text-xs text-text/30 hover:text-text/60">
                Clear
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-muted/40 bg-surface/50 p-3 space-y-2">
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
            <section className="shrink-0 mt-2 border border-zinc-700 rounded-lg bg-zinc-950 p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-400 font-mono">Raw frames ({live.rawFrames.length})</span>
                <button onClick={live.clearRawFrames} className="text-xs text-zinc-500 hover:text-zinc-300">Clear</button>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-0.5 font-mono text-xs">
                {live.rawFrames.length === 0 && (
                  <div className="text-zinc-600">No frames yet — speak something.</div>
                )}
                {live.rawFrames.map((f, i) => (
                  <div key={i} className={`leading-tight ${f.role === "user" ? "text-blue-300" : "text-green-300"}`}>
                    <span className="text-zinc-500">[{f.ts}]</span>{" "}
                    <span className={f.final ? "font-semibold" : "opacity-70"}>[{f.role}]</span>{" "}
                    {f.final ? "✓" : "…"}{" "}
                    <span className="text-zinc-400">turn={f.turn_id.slice(0, 8)}</span>{" "}
                    "{f.text}"
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        /* Placeholder so the pane doesn't collapse when transcript is empty */
        <div className="flex-1 flex items-center justify-center text-xs text-text/20 select-none">
          No transcript yet
        </div>
      )}
    </section>
  );

  /** Type-instead fallback link */
  const typeFallback = !isUnavailable && live.state !== "listening" && (
    <details className="shrink-0 text-xs text-text/30">
      <summary className="cursor-pointer hover:text-text/50">Type instead</summary>
      <div className="mt-2">
        <TextFallback onSend={live.sendText} />
      </div>
    </details>
  );

  // -------------------------------------------------------------------------
  // Batches panel (shared — rendered in left column on lg, above voice on sm)
  // -------------------------------------------------------------------------
  const batchesPanel = (
    <section className="flex flex-col min-h-0 rounded-xl border border-muted/40 bg-surface/60 overflow-hidden">
      {/* Header with counts */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-muted/30">
        <div className="flex items-center gap-2">
          <ChefHat size={14} className="text-accent" />
          <span className="text-sm font-semibold text-text">Batches</span>
          {board?.clock && (
            <span className="text-xs text-text/30 font-normal">{board.clock}</span>
          )}
        </div>
        {board && (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs justify-end">
            {board.counts.cooked > 0 && (
              <span className="text-success font-medium">{board.counts.cooked} cooked</span>
            )}
            {board.counts.approved > 0 && (
              <span className="text-accent font-medium">{board.counts.approved} to cook</span>
            )}
            {board.counts.pending > 0 && (
              <span className="text-warning font-medium">{board.counts.pending} awaiting</span>
            )}
            {board.counts.skipped > 0 && (
              <span className="text-text/30">{board.counts.skipped} cancelled</span>
            )}
          </div>
        )}
      </div>

      {/* Scrollable batch list — fills the remaining height of the pane */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3"
        onScroll={() => { userScrolled.current = true; }}
      >
        {loading ? (
          <div className="flex items-center justify-center py-10 text-text/40">
            <Loader2 size={20} className="animate-spin mr-2" />
            Loading batches…
          </div>
        ) : sortedBatches.length === 0 ? (
          <div className="py-10 text-center text-sm text-text/30">
            No batches scheduled today.
          </div>
        ) : (
          sortedBatches.map((b) => (
            <div
              key={b.id}
              ref={(el) => {
                if (el) batchRefs.current.set(b.id, el);
                else batchRefs.current.delete(b.id);
              }}
            >
              <BatchCard batch={b} nowSim={nowSim} onCheck={handleCheck} />
            </div>
          ))
        )}
      </div>
    </section>
  );

  // -------------------------------------------------------------------------
  // Page layout
  //
  // lg+:  two columns — batches (left, fills height) | voice (right, fills height)
  // <lg:  single column — mic/controls on top, batches fills the middle,
  //       transcript is a compact collapsible so small screens never overflow
  // -------------------------------------------------------------------------
  return (
    <>
      {/* ── LARGE screens: side-by-side ───────────────────────────────────── */}
      <div className="hidden lg:grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4 h-full min-h-0">
        {/* Left — scrollable batch list */}
        {batchesPanel}

        {/* Right — voice pane. overflow-hidden so transcript's flex-1 fills
             the remaining height rather than the whole column scrolling. */}
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
          {modeToggles}
          {micArea}
          {voiceCards}
          {transcriptSection}
          {typeFallback}
        </div>
      </div>

      {/* ── SMALL / MEDIUM screens: stacked ──────────────────────────────── */}
      <div className="flex flex-col gap-3 h-full min-h-0 lg:hidden">
        {/* Mic + controls on top (always visible) */}
        <div className="shrink-0 flex flex-col gap-3">
          {modeToggles}
          {micArea}
          {voiceCards}
        </div>

        {/* Batches fills the available middle space */}
        <div className="flex-1 min-h-0">
          {batchesPanel}
        </div>

        {/* Transcript — collapsible to keep small screens clean */}
        {live.transcript.length > 0 && (
          <details className="shrink-0 group" open>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-text/40 hover:text-text/60 select-none mb-1.5">
              Transcript ({live.transcript.length})
            </summary>
            <div className="max-h-36 overflow-y-auto rounded-lg border border-muted/40 bg-surface/50 p-3 space-y-2">
              {live.transcript.slice(-10).map((line) => (
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
          </details>
        )}

        {typeFallback}
      </div>
    </>
  );
}
