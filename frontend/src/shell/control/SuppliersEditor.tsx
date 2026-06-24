/** Suppliers + catalog editor — purpose-built. Calls /api/suppliers and /api/supplier-catalog. */
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../../api";
import type { Ingredient, SupplierCatalogRow, SupplierRow } from "../../types";
import { SectionHeading } from "./shared";

function SuppliersTable() {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [edits, setEdits] = useState<Record<number, Partial<SupplierRow>>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    apiGet<SupplierRow[]>("/api/suppliers").then(setSuppliers).catch(() => undefined);
  }, []);

  function patch(id: number, p: Partial<SupplierRow>) {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...p } }));
  }

  async function save(s: SupplierRow) {
    const p = edits[s.id];
    if (!p || Object.keys(p).length === 0) return;
    setBusyId(s.id);
    try {
      const updated = await apiPatch<SupplierRow>(`/api/suppliers/${s.id}`, p);
      setSuppliers((prev) => prev.map((r) => r.id === s.id ? { ...r, ...updated } : r));
      setEdits((prev) => { const n = { ...prev }; delete n[s.id]; return n; });
    } catch { /* ignore */ } finally { setBusyId(null); }
  }

  function val(s: SupplierRow, key: keyof SupplierRow) {
    return String((edits[s.id]?.[key] ?? s[key]) ?? "");
  }

  function NumCell({ s, k }: { s: SupplierRow; k: keyof SupplierRow }) {
    return (
      <input type="number" step="any" value={val(s, k)}
        onChange={(e) => patch(s.id, { [k]: Number(e.target.value) } as Partial<SupplierRow>)}
        className="w-20 bg-transparent outline-none focus:border-b focus:border-accent text-xs"
      />
    );
  }

  return (
    <div>
      <SectionHeading>Suppliers</SectionHeading>
      <div className="overflow-x-auto rounded-lg border border-muted">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-muted bg-surface/60">
              {["Name", "Lead (days)", "Reliability", "Min order ($)", "Contact", ""].map((h) => (
                <th key={h} className="px-2 py-1.5 font-medium text-text/50">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => {
              const hasPatch = Object.keys(edits[s.id] ?? {}).length > 0;
              return (
                <tr key={s.id} className="border-b border-muted/40 last:border-0 hover:bg-surface/20">
                  <td className="px-2 py-1">
                    <input value={val(s, "name")} onChange={(e) => patch(s.id, { name: e.target.value })}
                      className="w-32 bg-transparent outline-none focus:border-b focus:border-accent" />
                  </td>
                  <td className="px-2 py-1"><NumCell s={s} k="lead_time_days" /></td>
                  <td className="px-2 py-1"><NumCell s={s} k="reliability_score" /></td>
                  <td className="px-2 py-1"><NumCell s={s} k="min_order_value" /></td>
                  <td className="px-2 py-1">
                    <input value={val(s, "contact")} onChange={(e) => patch(s.id, { contact: e.target.value })}
                      className="w-32 bg-transparent outline-none focus:border-b focus:border-accent" />
                  </td>
                  <td className="px-2 py-1">
                    {hasPatch && (
                      <button type="button" onClick={() => void save(s)} disabled={busyId === s.id}
                        className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-white disabled:opacity-50">
                        {busyId === s.id ? "…" : "Save"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {suppliers.length === 0 && (
              <tr><td colSpan={6} className="py-4 text-center text-text/30">No suppliers. Load a seed.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CatalogTable() {
  const [catalog, setCatalog] = useState<SupplierCatalogRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [edits, setEdits] = useState<Record<number, Partial<SupplierCatalogRow>>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      apiGet<SupplierCatalogRow[]>("/api/supplier-catalog"),
      apiGet<SupplierRow[]>("/api/suppliers"),
      apiGet<Ingredient[]>("/api/ingredients"),
    ]).then(([cat, sup, ing]) => {
      setCatalog(cat);
      setSuppliers(sup);
      setIngredients(ing);
    }).catch(() => undefined);
  }, []);

  const supMap = new Map(suppliers.map((s) => [s.id, s.name]));
  const ingMap = new Map(ingredients.map((i) => [i.id, i.name]));

  function patch(id: number, p: Partial<SupplierCatalogRow>) {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...p } }));
  }

  async function save(row: SupplierCatalogRow) {
    const p = edits[row.id];
    if (!p || Object.keys(p).length === 0) return;
    setBusyId(row.id);
    try {
      const updated = await apiPatch<SupplierCatalogRow>(`/api/supplier-catalog/${row.id}`, p);
      setCatalog((prev) => prev.map((r) => r.id === row.id ? updated : r));
      setEdits((prev) => { const n = { ...prev }; delete n[row.id]; return n; });
    } catch { /* ignore */ } finally { setBusyId(null); }
  }

  function val(row: SupplierCatalogRow, key: keyof SupplierCatalogRow) {
    return String((edits[row.id]?.[key] ?? row[key]) ?? "");
  }

  return (
    <div>
      <SectionHeading>Supplier Catalog</SectionHeading>
      <p className="mb-3 text-[10px] text-text/40">
        Current prices and availability. Editing price here is reflected immediately in the optimizer's reorder scoring.
      </p>
      <div className="overflow-x-auto rounded-lg border border-muted">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-muted bg-surface/60">
              {["Supplier", "Ingredient", "Price", "Unit", "Pack size", "Availability", ""].map((h) => (
                <th key={h} className="px-2 py-1.5 font-medium text-text/50">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.map((row) => {
              const hasPatch = Object.keys(edits[row.id] ?? {}).length > 0;
              return (
                <tr key={row.id} className="border-b border-muted/40 last:border-0 hover:bg-surface/20">
                  <td className="px-2 py-1 text-text/70">{supMap.get(row.supplier_id) ?? `#${row.supplier_id}`}</td>
                  <td className="px-2 py-1 text-text/70">{ingMap.get(row.ingredient_id) ?? `#${row.ingredient_id}`}</td>
                  <td className="px-2 py-1">
                    <input type="number" step="0.01" value={val(row, "current_price")}
                      onChange={(e) => patch(row.id, { current_price: Number(e.target.value) })}
                      className="w-20 bg-transparent outline-none focus:border-b focus:border-accent" />
                  </td>
                  <td className="px-2 py-1 text-text/50">{row.unit}</td>
                  <td className="px-2 py-1">
                    <input type="number" step="any" value={val(row, "pack_size")}
                      onChange={(e) => patch(row.id, { pack_size: Number(e.target.value) })}
                      className="w-16 bg-transparent outline-none focus:border-b focus:border-accent" />
                  </td>
                  <td className="px-2 py-1">
                    <select value={val(row, "availability")}
                      onChange={(e) => patch(row.id, { availability: e.target.value as SupplierCatalogRow["availability"] })}
                      className="rounded border border-muted bg-primary px-1 py-0.5 text-xs text-text outline-none focus:border-accent">
                      <option value="in_stock">in_stock</option>
                      <option value="limited">limited</option>
                      <option value="out">out</option>
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    {hasPatch && (
                      <button type="button" onClick={() => void save(row)} disabled={busyId === row.id}
                        className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-white disabled:opacity-50">
                        {busyId === row.id ? "…" : "Save"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {catalog.length === 0 && (
              <tr><td colSpan={7} className="py-4 text-center text-text/30">No catalog entries. Load a seed.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NegotiateButton() {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [ingredientId, setIngredientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([apiGet<SupplierRow[]>("/api/suppliers"), apiGet<Ingredient[]>("/api/ingredients")])
      .then(([s, i]) => { setSuppliers(s); setIngredients(i); }).catch(() => undefined);
  }, []);

  async function negotiate() {
    if (!supplierId || !ingredientId) return;
    setBusy(true);
    setResult(null);
    try {
      await apiPost("/api/market/negotiate", {
        supplier_id: Number(supplierId),
        ingredient_id: Number(ingredientId),
      });
      setResult("Negotiation call requested — check Approval Inbox.");
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Failed to start negotiation");
    } finally { setBusy(false); }
  }

  return (
    <div>
      <SectionHeading>Trigger Negotiation</SectionHeading>
      <p className="mb-3 text-[10px] text-text/40">
        Manually initiate a price negotiation call with a supplier. Will appear in the Approval Inbox first.
      </p>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase text-text/40">Supplier</span>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
            className="rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent">
            <option value="">— select —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase text-text/40">Ingredient</span>
          <select value={ingredientId} onChange={(e) => setIngredientId(e.target.value)}
            className="rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent">
            <option value="">— select —</option>
            {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void negotiate()} disabled={busy || !supplierId || !ingredientId}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50">
          {busy ? "Requesting…" : "Negotiate"}
        </button>
      </div>
      {result && <p className="mt-2 text-xs text-text/70">{result}</p>}
    </div>
  );
}

export function SuppliersEditor() {
  return (
    <div className="space-y-8">
      <SuppliersTable />
      <CatalogTable />
      <NegotiateButton />
    </div>
  );
}
