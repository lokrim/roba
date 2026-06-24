/** Scenario + event editor — lifted verbatim from the retired SettingsDrawer. */
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../api";
import type { Scenario, ScenarioEvent, ScenarioEventType } from "../../types";
import { SCENARIO_EVENT_TYPES } from "../../types";
import { Label, SectionHeading } from "./shared";

// ---------------------------------------------------------------------------
// EventForm
// ---------------------------------------------------------------------------

function EventForm({
  scenarioId,
  event,
  onSaved,
  onCancel,
}: {
  scenarioId: number;
  event?: ScenarioEvent;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [atSimTime, setAtSimTime] = useState(event?.at_sim_time ?? 0);
  const [eventType, setEventType] = useState<ScenarioEventType>(
    (event?.event_type as ScenarioEventType) ?? "change_setting",
  );
  const [payloadStr, setPayloadStr] = useState(
    event?.payload ? JSON.stringify(event.payload, null, 2) : "{}",
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    let payload: unknown;
    try { payload = JSON.parse(payloadStr); }
    catch { alert("Payload must be valid JSON."); return; }
    setBusy(true);
    try {
      if (event) {
        await apiPatch(`/api/scenario_events/${event.id}`, {
          at_sim_time: atSimTime, event_type: eventType, payload,
        });
      } else {
        await apiPost("/api/scenario_events", {
          scenario_id: scenarioId, at_sim_time: atSimTime,
          event_type: eventType, payload, fired: 0,
        });
      }
      onSaved();
    } catch { /* ignore */ } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-accent/40 bg-surface p-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-0.5">
          <Label>Sim time (s)</Label>
          <input
            type="number" value={atSimTime}
            onChange={(e) => setAtSimTime(Number(e.target.value))}
            className="w-28 rounded-md border border-muted bg-primary px-2 py-1 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <Label>Event type</Label>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value as ScenarioEventType)}
            className="rounded-md border border-muted bg-primary px-2 py-1 text-sm text-text outline-none focus:border-accent"
          >
            {SCENARIO_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-2">
        <Label>Payload (JSON)</Label>
        <textarea
          rows={4} value={payloadStr}
          onChange={(e) => setPayloadStr(e.target.value)}
          className="mt-0.5 w-full rounded-md border border-muted bg-primary px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent"
        />
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void save()} disabled={busy}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel}
          className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScenarioCard
// ---------------------------------------------------------------------------

function ScenarioCard({ scenario, onRefresh }: { scenario: Scenario; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const [editingEvent, setEditingEvent] = useState<number | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(scenario.name);

  async function toggleActive() {
    const action = scenario.is_active ? "deactivate" : "activate";
    await apiPost(`/api/scenarios/${scenario.id}/${action}`).catch(() => undefined);
    onRefresh();
  }

  async function saveName() {
    if (name === scenario.name) { setEditingName(false); return; }
    await apiPatch(`/api/scenarios/${scenario.id}`, { name }).catch(() => undefined);
    setEditingName(false);
    onRefresh();
  }

  async function deleteScenario() {
    if (!confirm(`Delete scenario "${scenario.name}"?`)) return;
    await apiDelete(`/api/scenarios/${scenario.id}`).catch(() => undefined);
    onRefresh();
  }

  async function deleteEvent(eventId: number) {
    await apiDelete(`/api/scenario_events/${eventId}`).catch(() => undefined);
    onRefresh();
  }

  const events = scenario.events ?? [];

  return (
    <div className="rounded-lg border border-muted bg-surface">
      <div className="flex items-center gap-2 p-3">
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className={"flex-1 text-left text-sm font-medium text-text " + (expanded ? "text-accent" : "")}>
          {editingName ? (
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") { setName(scenario.name); setEditingName(false); }
              }}
              onClick={(e) => e.stopPropagation()}
              className="rounded border border-accent bg-primary px-1 py-0.5 text-sm outline-none"
            />
          ) : (
            <span onDoubleClick={() => setEditingName(true)}>{scenario.name}</span>
          )}
        </button>
        <span className={"rounded px-1.5 py-0.5 text-[10px] font-medium " +
          (scenario.is_active ? "bg-success/20 text-success" : "bg-muted text-text/40")}>
          {scenario.is_active ? "active" : "inactive"}
        </span>
        <button type="button" onClick={() => void toggleActive()}
          className="rounded-md bg-muted px-2 py-1 text-xs text-text hover:bg-muted/70">
          {scenario.is_active ? "Deactivate" : "Activate"}
        </button>
        <button type="button" onClick={() => void deleteScenario()} className="text-danger hover:text-danger/70">
          <Trash2 size={14} />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-muted/40 px-3 pb-3 pt-2">
          <p className="mb-2 text-[10px] uppercase text-text/40">Events</p>
          {events.length === 0 && <p className="mb-2 text-xs text-text/30">No events yet.</p>}
          <div className="space-y-2">
            {events.map((ev) =>
              editingEvent === ev.id ? (
                <EventForm key={ev.id} scenarioId={scenario.id} event={ev}
                  onSaved={() => { setEditingEvent(null); onRefresh(); }}
                  onCancel={() => setEditingEvent(null)}
                />
              ) : (
                <div key={ev.id} className="flex items-start gap-2 rounded border border-muted/40 px-2 py-1.5">
                  <div className="flex-1 text-xs">
                    <span className="font-mono text-text/50">{ev.at_sim_time}s</span>{" "}
                    <span className="rounded bg-muted px-1 py-0.5 text-text/70">{ev.event_type}</span>
                    {ev.fired ? <span className="ml-1 text-[10px] text-success">fired</span> : null}
                  </div>
                  <button type="button" onClick={() => setEditingEvent(ev.id)}
                    className="text-[10px] text-accent hover:underline">Edit</button>
                  <button type="button" onClick={() => void deleteEvent(ev.id)}
                    className="text-danger hover:text-danger/70"><Trash2 size={12} /></button>
                </div>
              ),
            )}
          </div>
          {addingEvent ? (
            <div className="mt-2">
              <EventForm scenarioId={scenario.id}
                onSaved={() => { setAddingEvent(false); onRefresh(); }}
                onCancel={() => setAddingEvent(false)}
              />
            </div>
          ) : (
            <button type="button" onClick={() => setAddingEvent(true)}
              className="mt-2 flex items-center gap-1 text-xs text-text/50 hover:text-text">
              <Plus size={12} /> Add event
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScenariosPanel (root export)
// ---------------------------------------------------------------------------

export function ScenariosPanel() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [creatingName, setCreatingName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyCreate, setBusyCreate] = useState(false);

  function load() {
    apiGet<Scenario[]>("/api/scenarios").then(setScenarios).catch(() => undefined);
  }

  useEffect(() => { load(); }, []);

  async function createScenario() {
    if (!creatingName.trim()) return;
    setBusyCreate(true);
    try {
      await apiPost("/api/scenarios", { name: creatingName.trim(), is_active: 0 });
      setCreatingName(""); setCreating(false); load();
    } catch { /* ignore */ } finally { setBusyCreate(false); }
  }

  return (
    <div className="space-y-4">
      <SectionHeading>Scenarios</SectionHeading>
      <div className="space-y-3">
        {scenarios.map((s) => <ScenarioCard key={s.id} scenario={s} onRefresh={load} />)}
        {scenarios.length === 0 && <p className="text-sm text-text/40">No scenarios. Create one below.</p>}
      </div>
      {creating ? (
        <div className="flex items-center gap-2">
          <input autoFocus value={creatingName}
            onChange={(e) => setCreatingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createScenario();
              if (e.key === "Escape") { setCreating(false); setCreatingName(""); }
            }}
            placeholder="Scenario name…"
            className="flex-1 rounded-md border border-accent bg-primary px-2 py-1.5 text-sm text-text outline-none"
          />
          <button type="button" onClick={() => void createScenario()}
            disabled={busyCreate || !creatingName.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {busyCreate ? "…" : "Create"}
          </button>
          <button type="button" onClick={() => { setCreating(false); setCreatingName(""); }}
            className="rounded-md bg-muted px-3 py-1.5 text-sm text-text">Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setCreating(true)}
          className="flex items-center gap-1 rounded-md border border-dashed border-muted px-3 py-2 text-sm text-text/60 hover:border-accent hover:text-text">
          <Plus size={14} /> New scenario
        </button>
      )}
    </div>
  );
}
