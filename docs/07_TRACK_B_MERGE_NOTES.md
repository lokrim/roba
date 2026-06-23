# 07 — Track B Merge Notes

> For developers joining after the merge. Covers what changed in core and how
> both tracks coexist. Read `02_TRACK_B.md` for the full Track B spec.

---

## What was merged

`origin/track_b` → `main` (commit `523d388`). Track B is the Inventory &
Procurement system. It adds three agents, a procurement service, approval
handlers, a mock forecaster, four frontend panels, and a full test suite.

---

## New Python packages

| Path | What it is |
|---|---|
| `track_b/agents/ledger.py` | `InventoryLedger` — FIFO depletion, receipts, expiry/waste signals |
| `track_b/agents/optimizer.py` | `InventoryOptimizer` — reorders, menu toggles, expiry promos |
| `track_b/agents/market_spectator.py` | `MarketSpectator` — supplier price monitoring, negotiation calls |
| `track_b/procurement/procurement.py` | `Procurement` service — PO lifecycle, delivery scheduling |
| `track_b/approval/handlers.py` | `ApprovalHandlers` — acts on `APPROVAL_RESOLVED` for PO and promo types |
| `track_b/mocks/mock_forecaster.py` | `MockForecaster` — standalone driver when `DEMO_MODE=track_b` |
| `track_b/tests/` | pytest suite (ledger, optimizer, market, procurement, approval, contract) |

## New frontend files

| Path | What it is |
|---|---|
| `frontend/src/track_b/InventoryDashboard.tsx` | Per-ingredient on-hand vs par levels, disabled items |
| `frontend/src/track_b/ExpiryView.tsx` | Lot expiry countdowns, at-risk highlights, active promos |
| `frontend/src/track_b/SupplierEditor.tsx` | Live supplier/catalog editor + "Negotiate" button |
| `frontend/src/track_b/ActivityLog.tsx` | `event_log` narrative feed (reorders, toggles, waste) |
| `frontend/src/track_b/index.ts` | `TRACK_B_PANELS` registry — maps tab names to components |
| `frontend/src/test/` | `vitest` setup, WS mock, relative-path helpers |
| `frontend/vitest.config.ts` | Vitest configuration for frontend unit tests |

---

## Core infrastructure changes

### `core/api.py` — dual-track bootstrap

`AppContext` now carries **both** `ctx.track_a` and `ctx.tracks`:

```python
ctx.track_a  # Dict populated by bootstrap_track_a() — Track A agents
ctx.tracks   # Dict[str, Dict] populated by _register_tracks() — Track B agents
             # e.g. ctx.tracks["track_b"]["market_spectator"]
```

Bootstrap order in `_bootstrap()`:
1. `bootstrap_track_a()` → fills `ctx.track_a` + wires `ForecastJobRunner`
2. `_register_tracks(demo_mode)` → calls `track_b.agents.register()` → fills `ctx.tracks["track_b"]`

Both are best-effort wrapped in try/except so neither track can crash the app at startup.

### New REST endpoint

```
POST /api/market/negotiate   { supplier_id, ingredient_id }
```
Routes to `ctx.tracks["track_b"]["market_spectator"].negotiate(...)`. Returns 503
if Track B is not wired (e.g. `DEMO_MODE=track_a`).

### Signal routing

A new loop in `_bootstrap()` subscribes `orchestrator.on_signal` to every
`SignalType`, so all signals now fan out to registered agents automatically:

```python
for _sig_type in SignalType:
    bus.subscribe(_sig_type, orchestrator.on_signal)
```

### `core/agent_base.py` — `log_event` now returns the row

`BaseAgent.log_event()` broadcasts `event_logged` over WS and returns the
`EventLog` row. Existing Track A agents that ignore the return value are
unaffected. The `_broadcast()` helper now delegates to `broadcast()`.

---

## DEMO_MODE

| Value | Track A agents | Track B agents | MockForecaster |
|---|---|---|---|
| `combined` (default) | Real | Real | Off |
| `track_a` | Real | Off | Off |
| `track_b` | Off | Real | **On** |

Set via the `DEMO_MODE` environment variable.

---

## Test paths

`pytest.ini` now runs three directories:

```ini
testpaths = tests track_a/tests track_b/tests
```

Run all tests: `pytest`. Run only Track B: `pytest track_b/tests/`.

---

## Conflict resolutions (what we kept from main)

- **LLM sampling params** (`temperature`, `top_p`) kept throughout `core/llm.py`
- **Track A models** (`ForecastOverride`, `ForecastTrace`, `ForecastAdjustment`,
  `ForecastJob`) kept in `core/models.py`
- **POS reset on sim play/restart/seed** (`pos_reset` WS events + `_wipe_live_orders`)
  kept; POS Monitor depends on these
- **Voice constraint helpers** (`_looks_like_unavailable_menu_constraint`,
  `_unavailable_target`) kept in `core/voice.py`
- **Routing structure in `App.tsx`** (`OperatorLayout` / `ConsolePage` /
  `ControlPage` / `PanelsPage`) kept; track_b's older single-page layout was
  superseded by main's structured routing

---

## Frontend wiring

`PanelsView.tsx` (the shared tab bar at `/` and `/panels`) now imports
`TRACK_B_PANELS` and renders the real components:

```tsx
import { TRACK_B_PANELS } from "../track_b";
// ...
function TrackBPanel({ label }) {
  const panel = TRACK_B_PANELS.find((p) => p.name === label);
  const Panel = panel.component;
  return <Panel />;
}
```

The four Track B tabs ("Inventory", "Expiry", "Suppliers", "Activity Log") are
live and no longer show placeholders.
