/**
 * Purpose-built editor for menu items, their recipes (ingredient lines),
 * and batch plans. Reads /api/menu, /api/recipes, /api/recipe-lines,
 * /api/batch-definitions, /api/ingredients, /api/stations.
 */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Save, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../api";
import { useSimState } from "../../store";
import type { BatchDefinition, Ingredient, MenuItem, Recipe, RecipeLine, Station } from "../../types";
import { Label, SectionHeading } from "./shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAYPARTS = ["breakfast", "lunch", "afternoon", "dinner", "late"] as const;

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-xs text-text/50">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function TextInput({
  value, onChange, placeholder, type = "text", className = "",
}: {
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <input
      type={type} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={"rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent " + className}
    />
  );
}

// ---------------------------------------------------------------------------
// Recipe line sub-editor
// ---------------------------------------------------------------------------

function RecipeLineEditor({
  lines, onAdd, onChange, onDelete, ingredients,
}: {
  lines: RecipeLine[];
  onAdd: () => void;
  onChange: (id: number, patch: Partial<RecipeLine>) => void;
  onDelete: (id: number) => void;
  ingredients: Ingredient[];
}) {
  return (
    <div className="space-y-2">
      {lines.map((line) => (
        <div key={line.id} className="flex flex-wrap items-center gap-2 rounded border border-muted/60 bg-primary/50 px-2 py-1.5">
          <select
            value={line.ingredient_id}
            onChange={(e) => onChange(line.id, { ingredient_id: Number(e.target.value) })}
            className="flex-1 min-w-[120px] rounded border border-muted bg-primary px-1 py-1 text-xs text-text outline-none focus:border-accent"
          >
            <option value={0}>— pick ingredient —</option>
            {ingredients.map((ing) => (
              <option key={ing.id} value={ing.id}>{ing.name} ({ing.base_unit})</option>
            ))}
          </select>
          <input
            type="number" min={0} step="any" value={line.qty ?? ""}
            onChange={(e) => onChange(line.id, { qty: Number(e.target.value) })}
            placeholder="qty"
            className="w-20 rounded border border-muted bg-primary px-1 py-1 text-xs text-text outline-none focus:border-accent"
          />
          <input
            value={line.unit ?? ""}
            onChange={(e) => onChange(line.id, { unit: e.target.value })}
            placeholder="unit"
            className="w-16 rounded border border-muted bg-primary px-1 py-1 text-xs text-text outline-none focus:border-accent"
          />
          <label className="flex items-center gap-1 text-[10px] text-text/50">
            <input
              type="checkbox" checked={line.optional === 1}
              onChange={(e) => onChange(line.id, { optional: e.target.checked ? 1 : 0 })}
              className="accent-accent"
            />
            optional
          </label>
          <button type="button" onClick={() => onDelete(line.id)} className="text-danger hover:text-danger/70">
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        type="button" onClick={onAdd}
        className="flex items-center gap-1 text-xs text-text/50 hover:text-text"
      >
        <Plus size={12} /> Add ingredient line
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Batch plan sub-editor (one per menu item)
// ---------------------------------------------------------------------------

function BatchPlanEditor({
  batch, onChange, stations,
}: {
  batch: BatchDefinition | null;
  onChange: (patch: Partial<BatchDefinition>) => void;
  stations: Station[];
}) {
  if (!batch) {
    return <p className="text-xs text-text/40">No batch plan. (Not batchable or not yet created.)</p>;
  }

  const selectedDayparts = (batch.dayparts ?? []) as string[];

  function toggleDaypart(dp: string) {
    const next = selectedDayparts.includes(dp)
      ? selectedDayparts.filter((d) => d !== dp)
      : [...selectedDayparts, dp];
    onChange({ dayparts: next });
  }

  return (
    <div className="space-y-3">
      <FieldRow label="Dayparts">
        <div className="flex flex-wrap gap-2">
          {DAYPARTS.map((dp) => (
            <label key={dp} className="flex items-center gap-1 text-xs text-text/70">
              <input
                type="checkbox" checked={selectedDayparts.includes(dp)}
                onChange={() => toggleDaypart(dp)}
                className="accent-accent"
              />
              {dp}
            </label>
          ))}
        </div>
      </FieldRow>
      <FieldRow label="Station">
        <select
          value={batch.station_id ?? ""}
          onChange={(e) => onChange({ station_id: e.target.value ? Number(e.target.value) : null })}
          className="rounded-md border border-muted bg-primary px-2 py-1 text-sm text-text outline-none focus:border-accent"
        >
          <option value="">— none —</option>
          {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </FieldRow>
      <FieldRow label="Prep lead (min)">
        <TextInput type="number" value={batch.prep_lead_time_min ?? ""} onChange={(v) => onChange({ prep_lead_time_min: Number(v) })} className="w-24" />
      </FieldRow>
      <FieldRow label="Size min / step / max">
        <div className="flex gap-2">
          <TextInput type="number" value={batch.batch_size_min ?? ""} onChange={(v) => onChange({ batch_size_min: Number(v) })} className="w-16" placeholder="min" />
          <TextInput type="number" value={batch.batch_size_step ?? ""} onChange={(v) => onChange({ batch_size_step: Number(v) })} className="w-16" placeholder="step" />
          <TextInput type="number" value={batch.batch_size_max ?? ""} onChange={(v) => onChange({ batch_size_max: Number(v) })} className="w-16" placeholder="max" />
        </div>
      </FieldRow>
      <FieldRow label="Decide by (min before)">
        <TextInput type="number" value={batch.decide_by_offset_min ?? ""} onChange={(v) => onChange({ decide_by_offset_min: Number(v) })} className="w-24" />
      </FieldRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu item expanded row
// ---------------------------------------------------------------------------

interface ItemState {
  patch: Partial<MenuItem>;
  recipe: Recipe | null;
  recipeLines: RecipeLine[];
  batch: BatchDefinition | null;
  batchPatch: Partial<BatchDefinition>;
  saving: boolean;
}

function MenuItemRow({
  item,
  ingredients,
  stations,
}: {
  item: MenuItem;
  ingredients: Ingredient[];
  stations: Station[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<ItemState>({
    patch: {},
    recipe: null,
    recipeLines: [],
    batch: null,
    batchPatch: {},
    saving: false,
  });
  const [loaded, setLoaded] = useState(false);

  async function loadDetails() {
    if (loaded) return;
    setLoaded(true);
    try {
      const [recipes, allLines, batches] = await Promise.all([
        apiGet<Recipe[]>("/api/recipes"),
        apiGet<RecipeLine[]>("/api/recipe-lines"),
        apiGet<BatchDefinition[]>("/api/batch-definitions"),
      ]);
      const recipe = recipes.find((r) => r.menu_item_id === item.id) ?? null;
      const recipeLines = recipe ? allLines.filter((l) => l.recipe_id === recipe.id) : [];
      const batch = batches.find((b) => b.menu_item_id === item.id) ?? null;
      setState((s) => ({ ...s, recipe, recipeLines, batch }));
    } catch { /* ignore */ }
  }

  function toggle() {
    setExpanded((v) => !v);
    if (!expanded) void loadDetails();
  }

  function patchItem(patch: Partial<MenuItem>) {
    setState((s) => ({ ...s, patch: { ...s.patch, ...patch } }));
  }

  function patchBatch(patch: Partial<BatchDefinition>) {
    setState((s) => ({ ...s, batchPatch: { ...s.batchPatch, ...patch } }));
  }

  async function addRecipeLine() {
    let recipe = state.recipe;
    if (!recipe) {
      // Create recipe first
      recipe = await apiPost<Recipe>("/api/recipes", { menu_item_id: item.id });
      setState((s) => ({ ...s, recipe }));
    }
    const line = await apiPost<RecipeLine>("/api/recipe-lines", {
      recipe_id: recipe!.id, ingredient_id: 0, qty: 0, unit: "", optional: 0,
    });
    setState((s) => ({ ...s, recipeLines: [...s.recipeLines, line] }));
  }

  async function updateRecipeLine(lineId: number, patch: Partial<RecipeLine>) {
    const updated = await apiPatch<RecipeLine>(`/api/recipe-lines/${lineId}`, patch);
    setState((s) => ({ ...s, recipeLines: s.recipeLines.map((l) => l.id === lineId ? updated : l) }));
  }

  async function deleteRecipeLine(lineId: number) {
    await apiDelete(`/api/recipe-lines/${lineId}`);
    setState((s) => ({ ...s, recipeLines: s.recipeLines.filter((l) => l.id !== lineId) }));
  }

  async function save() {
    setState((s) => ({ ...s, saving: true }));
    try {
      // Save menu item patch
      if (Object.keys(state.patch).length > 0) {
        await apiPatch(`/api/menu/${item.id}`, state.patch);
        setState((s) => ({ ...s, patch: {} }));
      }
      // Save batch plan patch
      if (Object.keys(state.batchPatch).length > 0) {
        if (state.batch) {
          await apiPatch(`/api/batch-definitions/${state.batch.id}`, state.batchPatch);
        } else {
          const created = await apiPost<BatchDefinition>("/api/batch-definitions", {
            menu_item_id: item.id, ...state.batchPatch,
          });
          setState((s) => ({ ...s, batch: created }));
        }
        setState((s) => ({ ...s, batchPatch: {} }));
      }
    } catch { /* ignore */ } finally {
      setState((s) => ({ ...s, saving: false }));
    }
  }

  const merged: MenuItem = { ...item, ...state.patch };
  const hasPendingChanges = Object.keys(state.patch).length > 0 || Object.keys(state.batchPatch).length > 0;

  return (
    <div className="rounded-lg border border-muted bg-surface">
      {/* Row header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={toggle} className="text-text/40 hover:text-text">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className={"flex-1 text-sm font-medium " + (merged.active ? "text-text" : "text-text/40 line-through")}>
          {merged.name || "Unnamed item"}
        </span>
        <span className="text-xs text-text/40">{merged.category ?? ""}</span>
        <span className={"rounded px-1.5 py-0.5 text-[10px] font-medium " +
          (merged.active ? "bg-success/20 text-success" : "bg-muted text-text/40")}>
          {merged.active ? "active" : "disabled"}
        </span>
        <span className="text-xs tabular-nums text-text/60">
          ${(merged.dine_in_price ?? 0).toFixed(2)}
        </span>
        {hasPendingChanges && (
          <button type="button" onClick={() => void save()} disabled={state.saving}
            className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[10px] text-white disabled:opacity-50">
            <Save size={10} /> {state.saving ? "…" : "Save"}
          </button>
        )}
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="border-t border-muted/40 px-4 py-4 space-y-6">
          {/* Basic fields */}
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase text-text/40">Item Details</p>
            <div className="space-y-2">
              <FieldRow label="Name">
                <TextInput value={merged.name} onChange={(v) => patchItem({ name: v })} className="w-full max-w-xs" />
              </FieldRow>
              <FieldRow label="Category">
                <TextInput value={merged.category ?? ""} onChange={(v) => patchItem({ category: v })} className="w-full max-w-xs" />
              </FieldRow>
              <FieldRow label="Station">
                <select
                  value={merged.station_id ?? ""}
                  onChange={(e) => patchItem({ station_id: e.target.value ? Number(e.target.value) : null })}
                  className="rounded-md border border-muted bg-primary px-2 py-1 text-sm text-text outline-none focus:border-accent"
                >
                  <option value="">— none —</option>
                  {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </FieldRow>
              <FieldRow label="Dine-in price">
                <TextInput type="number" value={merged.dine_in_price ?? ""} onChange={(v) => patchItem({ dine_in_price: Number(v) })} className="w-28" />
              </FieldRow>
              <FieldRow label="Online price">
                <TextInput type="number" value={merged.online_price ?? ""} onChange={(v) => patchItem({ online_price: Number(v) })} className="w-28" />
              </FieldRow>
              <FieldRow label="Prep time (min)">
                <TextInput type="number" value={merged.prep_time_min ?? ""} onChange={(v) => patchItem({ prep_time_min: Number(v) })} className="w-20" />
              </FieldRow>
              <FieldRow label="Active">
                <input type="checkbox" checked={merged.active === 1}
                  onChange={(e) => patchItem({ active: e.target.checked ? 1 : 0 })}
                  className="h-4 w-4 accent-accent" />
              </FieldRow>
              <FieldRow label="Batchable">
                <input type="checkbox" checked={merged.is_batchable === 1}
                  onChange={(e) => patchItem({ is_batchable: e.target.checked ? 1 : 0 })}
                  className="h-4 w-4 accent-accent" />
              </FieldRow>
              <FieldRow label="Description">
                <textarea value={merged.description ?? ""}
                  onChange={(e) => patchItem({ description: e.target.value })}
                  rows={2}
                  className="w-full max-w-xs rounded-md border border-muted bg-primary px-2 py-1 text-sm text-text outline-none focus:border-accent"
                />
              </FieldRow>
            </div>
          </div>

          {/* Recipe / ingredient lines */}
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase text-text/40">Recipe (Ingredient Lines)</p>
            <RecipeLineEditor
              lines={state.recipeLines}
              onAdd={() => void addRecipeLine()}
              onChange={(id, patch) => void updateRecipeLine(id, patch)}
              onDelete={(id) => void deleteRecipeLine(id)}
              ingredients={ingredients}
            />
          </div>

          {/* Batch plan */}
          {merged.is_batchable === 1 && (
            <div>
              <p className="mb-3 text-[10px] font-semibold uppercase text-text/40">Batch Plan</p>
              <BatchPlanEditor
                batch={state.batch ? { ...state.batch, ...state.batchPatch } : null}
                onChange={patchBatch}
                stations={stations}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New item form
// ---------------------------------------------------------------------------

function NewItemForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await apiPost("/api/menu", {
        name: name.trim(),
        category: category.trim() || null,
        dine_in_price: price ? Number(price) : null,
        active: 1,
        is_batchable: 0,
      });
      setName(""); setCategory(""); setPrice(""); setOpen(false);
      onCreated();
    } catch { /* ignore */ } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md border border-dashed border-muted px-3 py-2 text-sm text-text/60 hover:border-accent hover:text-text">
        <Plus size={14} /> Add menu item
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-accent/40 bg-surface p-4 space-y-3">
      <p className="text-xs font-semibold text-text">New Menu Item</p>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          <Label>Name *</Label>
          <TextInput value={name} onChange={setName} placeholder="e.g. Margherita Pizza" className="w-48" />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Category</Label>
          <TextInput value={category} onChange={setCategory} placeholder="e.g. Pasta" className="w-32" />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Dine-in price ($)</Label>
          <TextInput type="number" value={price} onChange={setPrice} placeholder="0.00" className="w-24" />
        </label>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => void create()} disabled={busy || !name.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={() => setOpen(false)}
          className="rounded-md bg-muted px-3 py-1.5 text-sm text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function MenuRecipeEditor() {
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const activeSeedId = useSimState()?.active_seed_id ?? null;

  function load() {
    Promise.all([
      apiGet<MenuItem[]>("/api/menu"),
      apiGet<Ingredient[]>("/api/ingredients"),
      apiGet<Station[]>("/api/stations"),
    ]).then(([items, ings, sts]) => {
      setMenuItems(items);
      setIngredients(ings);
      setStations(sts);
    }).catch(() => undefined);
  }

  useEffect(() => { load(); }, [activeSeedId]);

  async function deleteItem(id: number, name: string) {
    if (!confirm(`Delete "${name}"? This will also remove its recipe lines.`)) return;
    await apiDelete(`/api/menu/${id}`);
    load();
  }

  const displayed = showInactive ? menuItems : menuItems.filter((m) => m.active);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeading>Menu Items & Recipes</SectionHeading>
        <label className="flex items-center gap-2 text-xs text-text/50">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-accent" />
          Show disabled items
        </label>
      </div>

      <div className="space-y-2">
        {displayed.map((item) => (
          <div key={item.id} className="relative group">
            <MenuItemRow item={item} ingredients={ingredients} stations={stations} />
            <button
              type="button"
              onClick={() => void deleteItem(item.id, item.name)}
              className="absolute right-2 top-2 hidden group-hover:flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/20"
            >
              <Trash2 size={10} /> Delete
            </button>
          </div>
        ))}
        {displayed.length === 0 && (
          <p className="text-sm text-text/40">No items. Add one below.</p>
        )}
      </div>
      <NewItemForm onCreated={load} />
    </div>
  );
}
