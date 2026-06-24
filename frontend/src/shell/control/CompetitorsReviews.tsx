import { useEffect, useState } from "react";
import { Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../api";
import type { EntityRow } from "../../types";
import { SectionHeading } from "./shared";

interface CompetitorRow extends EntityRow {
  id: number;
  name: string;
  distance_km: number | null;
  rating: number | null;
  is_open: number;
  price_tier: string | null;
  cuisine: unknown;
}

interface ReviewRow extends EntityRow {
  id: number;
  source: string | null;
  rating: number | null;
  text: string | null;
  sentiment: string | null;
  processed: number;
}

function CompetitorsPanel() {
  const [competitors, setCompetitors] = useState<CompetitorRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pollBusy, setPollBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  function load() {
    apiGet<CompetitorRow[]>("/api/competitors").then(setCompetitors).catch(() => undefined);
  }

  useEffect(() => { load(); }, []);

  async function research(id: number) {
    setBusyId(id);
    try { await apiPost(`/api/track-a/competitors/${id}/research`); }
    catch { /* ignore */ } finally { setBusyId(null); }
  }

  async function probe(id: number) {
    setBusyId(id * 1000); // different key from research
    try { await apiPost(`/api/track-a/competitors/${id}/probe`); }
    catch { /* ignore */ } finally { setBusyId(null); }
  }

  async function poll() {
    setPollBusy(true);
    try { await apiPost("/api/track-a/competitors/poll-aggregators"); }
    catch { /* ignore */ } finally { setPollBusy(false); }
  }

  async function toggleOpen(c: CompetitorRow) {
    const updated = await apiPatch<CompetitorRow>(`/api/competitors/${c.id}`, {
      is_open: c.is_open ? 0 : 1,
    });
    setCompetitors((prev) => prev.map((r) => r.id === c.id ? { ...r, ...updated } : r));
  }

  async function deleteComp(id: number) {
    if (!confirm("Delete this competitor?")) return;
    await apiDelete(`/api/competitors/${id}`);
    load();
  }

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await apiPost("/api/competitors", { name: newName.trim(), is_open: 1 });
      setNewName(""); load();
    } catch { /* ignore */ } finally { setCreating(false); }
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <SectionHeading>Competitors</SectionHeading>
        <button type="button" onClick={() => void poll()} disabled={pollBusy}
          className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-text hover:bg-muted/70 disabled:opacity-50">
          <RefreshCw size={12} className={pollBusy ? "animate-spin" : undefined} />
          Poll aggregators
        </button>
      </div>
      <div className="space-y-2">
        {competitors.map((c) => (
          <div key={c.id} className="rounded-lg border border-muted bg-surface">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="flex-1 text-sm font-medium text-text">{c.name}</span>
              <span className="text-xs text-text/40">{c.distance_km != null ? `${c.distance_km}km` : ""}</span>
              <span className="text-xs text-text/40">★ {c.rating ?? "?"}</span>
              <span className={"rounded px-1.5 py-0.5 text-[10px] font-medium " +
                (c.is_open ? "bg-success/20 text-success" : "bg-muted text-text/40")}>
                {c.is_open ? "open" : "closed"}
              </span>
              <button type="button" onClick={() => void toggleOpen(c)}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-text hover:bg-muted/70">
                Toggle
              </button>
              <button type="button" onClick={() => void research(c.id)} disabled={busyId === c.id}
                title="Request undercover call to this competitor"
                className="flex items-center gap-1 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/30 disabled:opacity-50">
                <Search size={10} /> Research
              </button>
              <button type="button" onClick={() => void probe(c.id)} disabled={busyId === c.id * 1000}
                title="Quick menu probe"
                className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-text hover:bg-muted/70 disabled:opacity-50">
                Probe
              </button>
              <button type="button" onClick={() => void deleteComp(c.id)}
                className="text-danger hover:text-danger/70"><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
        {competitors.length === 0 && <p className="text-sm text-text/40">No competitors. Load a seed.</p>}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
          placeholder="Competitor name…"
          className="flex-1 max-w-xs rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
        />
        <button type="button" onClick={() => void create()} disabled={creating || !newName.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50">
          <Plus size={14} className="inline mr-1" />{creating ? "…" : "Add"}
        </button>
      </div>
    </div>
  );
}

function ReviewsPanel() {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [processBusy, setProcessBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newText, setNewText] = useState("");
  const [newRating, setNewRating] = useState(3);
  const [newSource, setNewSource] = useState("manual");

  function load() {
    apiGet<ReviewRow[]>("/api/reviews").then(setReviews).catch(() => undefined);
  }

  useEffect(() => { load(); }, []);

  async function processAll() {
    setProcessBusy(true);
    try {
      await apiPost("/api/track-a/reviews/process");
      load();
    } catch { /* ignore */ } finally { setProcessBusy(false); }
  }

  async function create() {
    if (!newText.trim()) return;
    setCreating(true);
    try {
      await apiPost("/api/reviews", { text: newText.trim(), rating: newRating, source: newSource });
      setNewText(""); load();
    } catch { /* ignore */ } finally { setCreating(false); }
  }

  async function del(id: number) {
    await apiDelete(`/api/reviews/${id}`);
    load();
  }

  const sentimentColor = (s: string | null) => {
    if (s === "positive") return "text-success";
    if (s === "negative") return "text-danger";
    return "text-text/50";
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <SectionHeading>Reviews</SectionHeading>
        <button type="button" onClick={() => void processAll()} disabled={processBusy}
          className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-text hover:bg-muted/70 disabled:opacity-50">
          <RefreshCw size={12} className={processBusy ? "animate-spin" : undefined} />
          Process unprocessed
        </button>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {reviews.map((r) => (
          <div key={r.id} className="flex items-start gap-2 rounded border border-muted/60 bg-surface px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-medium text-text/60">{r.source ?? "?"}</span>
                <span className="text-xs text-text/60">★ {r.rating ?? "?"}</span>
                {r.sentiment && (
                  <span className={"text-[10px] font-medium " + sentimentColor(r.sentiment)}>
                    {r.sentiment}
                  </span>
                )}
                {r.processed ? (
                  <span className="rounded bg-success/20 px-1 text-[10px] text-success">processed</span>
                ) : (
                  <span className="rounded bg-muted px-1 text-[10px] text-text/40">unprocessed</span>
                )}
              </div>
              <p className="text-xs text-text/70 truncate">{r.text ?? "—"}</p>
            </div>
            <button type="button" onClick={() => void del(r.id)} className="text-danger/60 hover:text-danger shrink-0">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {reviews.length === 0 && <p className="text-sm text-text/40">No reviews. Load a seed or add one.</p>}
      </div>

      <div className="mt-4 rounded-lg border border-dashed border-muted p-3 space-y-2">
        <p className="text-xs font-medium text-text/60">Add review</p>
        <div className="flex flex-wrap gap-2">
          <input value={newSource} onChange={(e) => setNewSource(e.target.value)}
            placeholder="source"
            className="w-24 rounded border border-muted bg-primary px-2 py-1 text-xs text-text outline-none focus:border-accent" />
          <input type="number" min={1} max={5} value={newRating}
            onChange={(e) => setNewRating(Number(e.target.value))}
            className="w-14 rounded border border-muted bg-primary px-2 py-1 text-xs text-text outline-none focus:border-accent" />
        </div>
        <textarea value={newText} onChange={(e) => setNewText(e.target.value)} rows={2}
          placeholder="Review text…"
          className="w-full rounded border border-muted bg-primary px-2 py-1 text-xs text-text outline-none focus:border-accent"
        />
        <button type="button" onClick={() => void create()} disabled={creating || !newText.trim()}
          className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">
          {creating ? "…" : "Add Review"}
        </button>
      </div>
    </div>
  );
}

export function CompetitorsReviews() {
  return (
    <div className="space-y-8">
      <CompetitorsPanel />
      <ReviewsPanel />
    </div>
  );
}
