import { useEffect, useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { apiGet, apiPost } from "../../api";
import { SectionHeading } from "./shared";

function PresetLoader() {
  const [presets, setPresets] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    apiGet<string[]>("/api/seed/presets")
      .then((rows) => {
        setPresets(rows);
        if (rows.length > 0) setSelected(rows[0]);
      })
      .catch(() => undefined);
  }, []);

  async function load() {
    if (!selected || loading) return;
    setLoading(true);
    try {
      await apiPost(`/api/seed/preset/${selected}`);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] text-text/40">
        Load a curated restaurant preset. This wipes and re-seeds all data.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
        >
          {presets.length === 0 && <option value="">no presets</option>}
          {presets.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          type="button" onClick={() => void load()}
          disabled={!selected || loading}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50"
        >
          {loading ? "Loading…" : done ? "✓ Loaded" : "Load Preset"}
        </button>
      </div>
    </div>
  );
}

function LLMGenerator() {
  const [cuisine, setCuisine] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!cuisine.trim() || loading) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await apiPost<Record<string, unknown>>("/api/seed/generate", { cuisine: cuisine.trim() });
      const summary = Object.entries(res)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => `${k}: ${(v as unknown[]).length}`)
        .join(", ");
      setResult(summary || "Generated successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] text-text/40">
        Use the LLM to generate a restaurant from scratch. Takes 20–60 s. Requires an LLM API key.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={cuisine}
          onChange={(e) => setCuisine(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void generate(); }}
          placeholder='e.g. "Italian trattoria" or "Modern Thai"'
          className="flex-1 rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
        />
        <button
          type="button" onClick={() => void generate()}
          disabled={!cuisine.trim() || loading}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50"
        >
          <Sparkles size={14} /> {loading ? "Generating…" : "Generate"}
        </button>
      </div>
      {result && <p className="text-xs text-success">{result}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function RestartButton() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function restart() {
    if (!confirm("Restart the simulation? This will re-seed from the active preset and reset to day 0.")) return;
    setBusy(true);
    try {
      await apiPost("/api/sim/restart");
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch { /* ignore */ } finally { setBusy(false); }
  }

  return (
    <button
      type="button" onClick={() => void restart()} disabled={busy}
      className="flex items-center gap-1 rounded-md border border-danger/40 px-3 py-2 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"
    >
      <RotateCcw size={14} className={busy ? "animate-spin" : undefined} />
      {busy ? "Restarting…" : done ? "✓ Restarted" : "Restart Simulation"}
    </button>
  );
}

export function SeedManager() {
  return (
    <div className="space-y-8">
      <div>
        <SectionHeading>Load Preset</SectionHeading>
        <PresetLoader />
      </div>
      <div>
        <SectionHeading>Generate with AI</SectionHeading>
        <LLMGenerator />
      </div>
      <div>
        <SectionHeading>Restart</SectionHeading>
        <p className="mb-3 text-[10px] text-text/40">
          Re-seed from the active preset and reset the simulation clock to day 0.
        </p>
        <RestartButton />
      </div>
    </div>
  );
}
