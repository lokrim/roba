import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../../api";
import type { AnomalyInjection, SimSettings } from "../../types";
import { Label, SectionHeading, ApplyButton } from "./shared";

function AnomalyRow({
  inj,
  onChange,
  onDelete,
}: {
  inj: AnomalyInjection;
  onChange: (updated: AnomalyInjection) => void;
  onDelete: () => void;
}) {
  function num(v: unknown): string { return v == null ? "" : String(v); }
  function parseNum(s: string): number | undefined {
    const n = parseFloat(s);
    return isNaN(n) ? undefined : n;
  }

  return (
    <div className="rounded-lg border border-muted bg-primary p-3">
      <div className="flex flex-wrap gap-2">
        {([
          { key: "start", label: "Start (sim-s)" },
          { key: "end", label: "End (sim-s)" },
          { key: "velocity_mult", label: "Velocity ×" },
        ] as const).map(({ key, label }) => (
          <label key={key} className="flex flex-col gap-0.5">
            <Label>{label}</Label>
            <input
              type="number" value={num(inj[key])}
              onChange={(e) => onChange({ ...inj, [key]: parseNum(e.target.value) })}
              placeholder="any"
              className="w-28 rounded-md border border-muted bg-surface px-2 py-1 text-sm text-text outline-none focus:border-accent"
            />
          </label>
        ))}
      </div>
      <div className="mt-2">
        <Label>Dish mix skew (JSON)</Label>
        <textarea
          rows={2}
          value={inj.dish_mix_skew ? JSON.stringify(inj.dish_mix_skew, null, 2) : ""}
          onChange={(e) => {
            try {
              const parsed = e.target.value ? JSON.parse(e.target.value) : undefined;
              onChange({ ...inj, dish_mix_skew: parsed });
            } catch { /* ignore malformed JSON while typing */ }
          }}
          placeholder='{"<item_id>": 2.0, ...}'
          className="mt-0.5 w-full rounded-md border border-muted bg-surface px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent"
        />
      </div>
      <button
        type="button" onClick={onDelete}
        className="mt-2 flex items-center gap-1 text-xs text-danger hover:text-danger/80"
      >
        <Trash2 size={12} /> Remove
      </button>
    </div>
  );
}

export function AnomaliesPanel() {
  const [injections, setInjections] = useState<AnomalyInjection[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<SimSettings>("/api/sim/pos")
      .then((s) => setInjections(s.anomaly_injections ?? []))
      .catch(() => undefined);
  }, []);

  function add() { setInjections((prev) => [...prev, {}]); }
  function update(idx: number, updated: AnomalyInjection) {
    setInjections((prev) => prev.map((inj, i) => (i === idx ? updated : inj)));
  }
  function remove(idx: number) {
    setInjections((prev) => prev.filter((_, i) => i !== idx));
  }

  async function apply() {
    setBusy(true);
    try {
      await apiPatch("/api/sim/pos", { anomaly_injections: injections });
      await apiPost("/api/track-a/forecast/run").catch(() => undefined);
    } catch { /* ignore */ } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <SectionHeading>Anomaly Injections</SectionHeading>
      <p className="text-[10px] text-text/40">
        Windowed velocity surges and dish-mix skews. Active when sim-time is within [start, end). Apply replaces the full list.
      </p>
      {injections.length === 0 && (
        <p className="text-sm text-text/40">No injections. Add one below.</p>
      )}
      {injections.map((inj, idx) => (
        <AnomalyRow
          key={idx} inj={inj}
          onChange={(updated) => update(idx, updated)}
          onDelete={() => remove(idx)}
        />
      ))}
      <button
        type="button" onClick={add}
        className="flex items-center gap-1 rounded-md border border-dashed border-muted px-3 py-2 text-sm text-text/60 hover:border-accent hover:text-text"
      >
        <Plus size={14} /> Add injection
      </button>
      <ApplyButton onClick={() => void apply()} busy={busy} />
    </div>
  );
}
