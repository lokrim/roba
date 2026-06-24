# 06 — Changelog

Reverse-chronological record of every significant commit. Entries include the short SHA, date, what changed functionally, and the files that matter. Read this before touching any system so you know what is actually wired versus stubbed.

---

## `4f9c49b` — 2026-06-24 — Frontend overhaul

**What changed:**
- Replaced `PanelsView.tsx` with `DashboardView.tsx`. The live dashboard is now a flat domain-grouped tab strip (Operations, Forecast, Staff, Inventory, Expiry, Competitors, Reviews, Suppliers, Activity, Signals). No "Track A / Track B" wording anywhere in the UI.
- Created `ControlDashboard.tsx` — a full-width 12-section settings page replacing the old empty `/control` placeholder. Sections: Simulation config, Seed & Restaurant, POS Generation, Anomalies, Weather, Menu & Recipes, Ingredients & Inventory, Suppliers, Staff & Stations, Competitors & Reviews, Forecast, Advanced.
- Retired `SettingsDrawer.tsx`. Its panels (POS mix, anomalies, scenarios, entities) were lifted into `shell/control/` and rewritten as purpose-built editors.
- `ControlBar.tsx` trimmed to live knobs only — transport, speed, velocity, voice, approvals. Weather/scenario/seed pickers moved to the Control page.
- `MenuPage.tsx` gained a `← Operator console` back-link.
- Backend: 4 new CRUD resources added to `_register_crud` — `stations`, `batch-definitions`, `recipe-lines`, `promotions`. New `PATCH /api/sim/state` endpoint writes `operating_window`, `skip_closed_hours`, `call_mode` to the `SimState` singleton and broadcasts `sim_state_changed`.
- `types.ts`: added `operating_window`, `skip_closed_hours` to `SimState`; added `Station`, `Recipe`, `RecipeLine`, `BatchDefinition` interfaces.

**Key files:**
```
frontend/src/shell/DashboardView.tsx           new — unified dashboard
frontend/src/shell/ControlDashboard.tsx        new — settings dashboard compositor
frontend/src/shell/control/                    new — 14 editor components
  AdvancedEntities.tsx  AnomaliesPanel.tsx  CompetitorsReviews.tsx
  ForecastControls.tsx  IngredientsInventory.tsx  MenuRecipeEditor.tsx
  PosMixPanel.tsx  ScenariosPanel.tsx  SeedManager.tsx  SimConfig.tsx
  StaffStations.tsx  SuppliersEditor.tsx  WeatherControl.tsx  shared.tsx
frontend/src/shell/SettingsDrawer.tsx          deleted
frontend/src/shell/ControlBar.tsx              modified — live-only
frontend/src/shell/ControlShell.tsx            modified — drawer removed
frontend/src/routes/ConsolePage.tsx            uses DashboardView
frontend/src/routes/ControlPage.tsx            uses ControlDashboard
frontend/src/routes/PanelsPage.tsx             uses DashboardView readOnly
frontend/src/menu/MenuPage.tsx                 back link added
frontend/src/types.ts                          SimState + new entity types
core/api.py                                    4 CRUD resources + PATCH /api/sim/state
```

**New REST endpoints:**
- `GET/POST/PATCH/DELETE /api/stations`
- `GET/POST/PATCH/DELETE /api/batch-definitions`
- `GET/POST/PATCH/DELETE /api/recipe-lines`
- `GET/POST/PATCH/DELETE /api/promotions`
- `PATCH /api/sim/state` — body: `{ operating_window?, skip_closed_hours?, call_mode? }`

---

## `3e438c4` — 2026-06-24 — Competitor market intelligence

**What changed:**
- Competitor agent gained automated polling: probes a competitor's pricing and hours on a configurable schedule, emits `COMPETITOR_SIGNAL` events with price delta, hours delta, and a threat level.
- New `signal_engine.py` converts raw competitor observations into typed signals that feed the forecaster's demand adjustments.
- `probe.py` drives the synthetic competitor phone-research call (uses the voice pipeline). `web_scraper.py` does a simulated web price check.
- `schemas.py` formalises `CompetitorSnapshot`, `CompetitorSignal`, `PricePoint`.
- Forecaster tests expanded to cover competitor-signal-driven demand adjustment paths.
- Contract tests for Track A updated (`test_contract_a.py`).

**Key files:**
```
track_a/competitors/providers/probe.py         new — voice-based research call
track_a/competitors/providers/web_scraper.py   new — simulated web check
track_a/competitors/schemas.py                 new — snapshot / signal types
track_a/competitors/signal_engine.py           new — observation → signal
track_a/agents/competitor.py                   polling loop + signal emit
track_a/agents/forecaster.py                   competitor-signal demand adjustment
track_a/tests/test_competitor.py               expanded
track_a/tests/test_contract_a.py               new assertions
track_a/tests/test_forecaster.py               competitor-path coverage
```

---

## `b1970f8` — 2026-06-23 — Track B merge into main

**What changed:**
- `track_b/` merged wholesale onto `main`. Track B is the Inventory & Procurement system.
- Three agents wired: `InventoryLedger` (FIFO depletion, receipts, expiry/waste signals), `InventoryOptimizer` (reorders, menu toggles, expiry-to-promo), `MarketSpectator` (supplier price monitoring, negotiation calls).
- `Procurement` service manages PO lifecycle and delivery scheduling.
- `ApprovalHandlers` acts on `APPROVAL_RESOLVED` for PO and promo approval types.
- `MockForecaster` drives Track B standalone (`DEMO_MODE=track_b`).
- `AppContext` now carries `ctx.tracks["track_b"]` in addition to `ctx.track_a`. Both are bootstrapped in `_bootstrap()` with independent try/except guards.
- New REST endpoint: `POST /api/market/negotiate { supplier_id, ingredient_id }`.
- All signal types fan out through the orchestrator via a new subscription loop in `_bootstrap()`.
- `BaseAgent.log_event()` now returns the `EventLog` row (non-breaking).
- Four new frontend panels: `InventoryDashboard`, `ExpiryView`, `SupplierEditor`, `ActivityLog` — mounted under Track B tabs in the dashboard.
- Full pytest suite: ledger, optimizer, market, procurement, approval, contract.

**`DEMO_MODE` values:**

| Value | Track A | Track B | MockForecaster |
|-------|---------|---------|----------------|
| `combined` (default) | real | real | off |
| `track_a` | real | off | off |
| `track_b` | off | real | on |

**Key files:**
```
track_b/agents/ledger.py           InventoryLedger
track_b/agents/optimizer.py        InventoryOptimizer
track_b/agents/market_spectator.py MarketSpectator
track_b/procurement/procurement.py PO lifecycle
track_b/approval/handlers.py       approval resolution
track_b/mocks/mock_forecaster.py   standalone driver
track_b/tests/                     full pytest suite
frontend/src/track_b/InventoryDashboard.tsx
frontend/src/track_b/ExpiryView.tsx
frontend/src/track_b/SupplierEditor.tsx
frontend/src/track_b/ActivityLog.tsx
frontend/src/track_b/index.ts      TRACK_B_PANELS registry
core/api.py                        ctx.tracks bootstrap + negotiate endpoint
core/agent_base.py                 log_event returns row
pytest.ini                         testpaths += track_b/tests
```

**New REST endpoint:**
- `POST /api/market/negotiate` — body: `{ supplier_id, ingredient_id }`; returns 503 if Track B not wired.

---

## `dbc2a9f` — 2026-06-23 — Multi-page routing + POS Monitor + customer menu

**What changed:**
- App split from a single page into four addressable routes. `react-router-dom` added. `main.tsx` wraps in `<BrowserRouter>`.
- `OperatorLayout.tsx` owns the single WS lifecycle (`wsClient.connect()`) and sim/weather hydration. Navigating between operator routes does not reconnect the socket.
- `/menu` (`MenuPage`) lazy-loaded outside `OperatorLayout` — never opens the WS.
- `PosMonitor.tsx` added as the "Operations" tab. Two data sources: windowed backend stats (`usePosStats` → `GET /api/pos/stats`) and a live ring-buffer order ticker (`usePosStream` → `order_created` WS events). Buffer cap 120, flushed to React state every 500ms.
- Window selector: Today / Last hour / Last 6 hours / This week. Stats computed server-side.
- `MenuPage` displays active and inactive items grouped by category. Polls `GET /api/menu` every 10s, no WS.

**Key files:**
```
frontend/src/App.tsx                     route table
frontend/src/routes/OperatorLayout.tsx   WS lifecycle + nav
frontend/src/routes/ConsolePage.tsx      / — ControlShell + panels
frontend/src/routes/ControlPage.tsx      /control — controls only
frontend/src/routes/PanelsPage.tsx       /panels — panels only
frontend/src/shell/ControlShell.tsx      shared ControlBar + drawers
frontend/src/pos/usePosStream.ts         live order ring buffer
frontend/src/pos/usePosStats.ts          windowed backend stats
frontend/src/pos/PosMonitor.tsx          the monitor view
frontend/src/menu/MenuPage.tsx           public customer menu (lazy)
```

---

## `7ccea81` — 2026-06-23 — POS read APIs + clock reset handling

**What changed:**
- `GET /api/orders?limit=N&since=<sim_time>` — newest-first order + lines backfill. Lines fetched in one `IN` query. Shared serializers with the WS `order_created` payload via `core/formatter.py`.
- `GET /api/pos/stats?since=<sim_time>` — returns `{orders, revenue, lines, voided_lines, channel_split, top_items, buckets}`. `since` clamped `>= 0` so seeded negative-`sim_time` history is excluded.
- `pos_reset` WS event emitted on: stop→play transition, restart, reseed. Frontend buffer clears on this event.
- `SimClock.stop()`/`restart()` call `Orchestrator.reset_schedules()`, which re-anchors interval trigger `next_due` after a clock rewind — without this, no orders generate after pressing play following a stop.
- `POSSimulator.tick()` detects a backward `sim_time` jump and resets the arrival schedule.

**Key files:**
```
core/api.py           GET /api/orders, GET /api/pos/stats, pos_reset broadcasts
core/formatter.py     module-level order_to_dict / line_to_dict
core/clock.py         stop()/restart() → reset_schedules(); active_seed_id in current_state()
core/orchestrator.py  reset_schedules() — re-anchors interval triggers
core/pos_simulator.py backward sim_time guard
```

---

## `dbac28c` — 2026-06-22 — Voice context + schema validation + POS robustness

**What changed:**
- Voice extraction given richer context: current menu items, on-hand inventory levels, and staff roster injected into the system prompt.
- Pydantic schema validation expanded across voice extraction response shapes — malformed LLM output is caught and surfaced as a structured error rather than crashing.
- POS simulator made robust to missing or zero dish-mix weights (falls back to equal-weight uniform sampling).
- `ForecastDashboard.tsx` gained a batch-decision breakdown panel.
- New tests: `test_api_session_lifecycle.py`, `test_pos_formatter.py`, expanded `test_voice.py` and `test_forecaster.py`.

**Key files:**
```
core/voice.py                              richer extraction context
track_a/agents/forecaster.py              schema validation + batch breakdown
track_a/forecast_jobs.py                  validation guards
frontend/src/track_a/ForecastDashboard.tsx batch breakdown panel
tests/test_api_session_lifecycle.py        new
tests/test_pos_formatter.py               new
```

---

## `54e0256` — 2026-06-20 — Async ForecastJobRunner

**What changed:**
- `ForecastJobRunner` in `track_a/forecast_jobs.py` decouples forecast runs from the request thread. Jobs enqueue and run in a background thread pool; the HTTP response returns a job ID immediately.
- Job states: `queued → running → done | failed`. WS events: `forecast_job_queued`, `forecast_job_done`, `forecast_job_failed`.
- `POST /api/track-a/forecast/run` now enqueues rather than blocking.
- Auto-mode: `POST /api/track-a/forecast/auto { enabled: bool }` — self-schedules runs on the orchestrator tick when on.
- Forecaster substantially reworked: full deterministic algorithm with weather, competitor-signal, staff-coverage, and batch-decision logic.

**Key files:**
```
track_a/forecast_jobs.py               ForecastJobRunner + job model
track_a/agents/forecaster.py           full deterministic algorithm
core/api.py                            async forecast endpoints
frontend/src/track_a/useTrackAData.ts  job polling
frontend/src/types.ts                  ForecastJob type
```

---

## `7663319` — 2026-06-20 — Forecast trace + LLM sampling params

**What changed:**
- Each forecast run now records a `ForecastTrace` row (full decision log: inputs, adjustments, per-dish outputs, batch decisions, reasoning). Exposed via `GET /api/track-a/forecast/trace/<job_id>`.
- `ForecastAdjustment` rows written per-dish per-run with factor, source, and confidence.
- LLM sampling params (`temperature`, `top_p`, `max_tokens`) exposed in `core/config.py` and threaded through all LLM call sites.
- Competitor agent wired to use the LLM path for research call summarisation.
- `frontend/src/track_a/types.ts` formalised with `ForecastTrace`, `ForecastAdjustment`, `ForecastOverride`, `CompetitorSignal`.

**Key files:**
```
track_a/agents/forecaster.py    trace + adjustment recording
track_a/agents/competitor.py    LLM summarisation wired
core/api.py                     GET /api/track-a/forecast/trace/<id>
core/config.py                  LLM sampling params
core/models.py                  ForecastTrace, ForecastAdjustment, ForecastOverride
frontend/src/track_a/types.ts   formalised Track A types
```

---

## `305de9d` — 2026-06-20 — Track A merge into main

**What changed:**
- `track_a/` merged wholesale onto `main`. Track A is the Demand & Sensing system.
- Four agents: `Forecaster`, `CompetitorIntelligence`, `ReviewAgent`, `StaffAgent`.
- `MockInventory` provides a lightweight inventory stub for Track A tests.
- pytest suite: competitor, contract, forecaster, review, staff.
- Frontend panels: `ForecastDashboard`, `CompetitorPanel`, `ReviewPanel`, `StaffPanel`.
- `AppContext.track_a` dict populated by `bootstrap_track_a()`.
- `BaseAgent` in `core/agent_base.py` provides shared signal subscription, event logging, approval request, and deferred action helpers.

**Track A REST surface (all under `/api/track-a/`):**
- `POST /forecast/run`, `/finalize`, `/optimize`; `GET /forecast/jobs/<id>`, `/trace/<id>`
- `GET /forecast/auto`; `POST /forecast/auto`
- `POST /competitors/research`, `/probe`; `GET /competitors`
- `POST /reviews/process`; `GET /reviews`
- `POST /staff/call-in-sick`; `GET /staff`

**Key files:**
```
track_a/agents/forecaster.py      Forecaster
track_a/agents/competitor.py      CompetitorIntelligence
track_a/agents/review.py          ReviewAgent
track_a/agents/staff.py           StaffAgent
track_a/mocks/mock_inventory.py   test stub
track_a/tests/                    full pytest suite
frontend/src/track_a/ForecastDashboard.tsx
frontend/src/track_a/CompetitorPanel.tsx
frontend/src/track_a/ReviewPanel.tsx
frontend/src/track_a/StaffPanel.tsx
core/agent_base.py                BaseAgent
```

---

## `dcfa1a9` — 2026-06-20 — Deferred agent action refactor

**What changed:**
- Agent LLM calls were blocking the signal bus dispatch loop. `BaseAgent` gained `defer(fn)` to submit slow work to a thread-pool executor, keeping signal handlers synchronous.
- Competitor, Forecaster, Review, and Staff agents updated to use `defer()` for all LLM paths.

**Key files:**
```
core/agent_base.py           defer() added
track_a/agents/competitor.py LLM path deferred
track_a/agents/forecaster.py LLM path deferred
track_a/agents/review.py     LLM path deferred
track_a/agents/staff.py      LLM path deferred
```

---

## `3608b27` — 2026-06-18 — Voice pipeline + forecasting engine + LLM integration

**What changed:**
- Full deterministic forecasting engine: baseline demand from historical attach rates, weather multiplier, event multiplier, competitor-price delta, staff coverage ratio, promotion effect, and time-of-day curve.
- LLM integration for: voice fact injection into forecast context, natural-language explanation generation, and LLM-driven batch decision override.
- `core/voice.py` pipeline finalised: transcribe → extract structured facts → validate schema → inject into agent context.
- `ForecastDashboard.tsx` shows deterministic output and LLM explanation side by side.

**Key files:**
```
track_a/agents/forecaster.py          deterministic algorithm + LLM overlay
core/voice.py                         extract → validate → inject pipeline
frontend/src/track_a/ForecastDashboard.tsx
frontend/src/track_a/types.ts         forecast + voice types
scripts/llm_smoke.py                  connectivity smoke test
```

---

## `cd8caae` — 2026-06-17 — Major agent revamp

**What changed:**
- All four Track A agents substantially rewritten from stub/heuristic to real decision logic.
- `Forecaster`: multi-factor demand model, per-dish confidence scores, batch-size calculation.
- `CompetitorIntelligence`: pricing and hours gap detection, threat-level classification, signal emission.
- `ReviewAgent`: sentiment scoring, per-dish demand modifier, time-decay weighting.
- `StaffAgent`: coverage gap detection, service-quality impact, shift-recommendation generation.

**Key files:**
```
track_a/agents/competitor.py     pricing/hours gap logic
track_a/agents/forecaster.py     multi-factor model
track_a/agents/review.py         sentiment + time-decay
track_a/agents/staff.py          coverage gap logic
track_a/mocks/mock_inventory.py  full interface coverage
```

---

## Before `cd8caae` — Initial scaffold

The scaffold (`core/`) was built before Track A work began. It is fully implemented and stable. See `docs/00_ARCHITECTURE.md` for the authoritative spec.

| Module | What it does |
|--------|-------------|
| `core/clock.py` | `SimClock` state machine: stopped / running / paused / call_frozen. Drives orchestrator ticks at configurable real-time speed. |
| `core/orchestrator.py` | Tick loop, interval trigger scheduling, signal fan-out. |
| `core/signal_bus.py` | Typed pub/sub bus. All inter-agent communication goes through here — never direct calls. |
| `core/models.py` | 38 SQLAlchemy tables covering every entity in the simulation. |
| `core/pos_simulator.py` | Poisson-arrival order generator. Reads channel mix, daypart curve, and dish-mix weights from `SimPosConfig`; emits `order_created` WS events. |
| `core/voice.py` | Voice call pipeline: LLM transcription → fact extraction → structured payload. |
| `core/weather.py` | Weather state with override support; emits `weather_updated`. |
| `core/seeder.py` | Loads restaurant presets from `seeds/`; seeds all 38 tables in a transaction. |
| `core/llm.py` | Thin Anthropic SDK wrapper; all LLM calls go through here. |
| `core/api.py` | FastAPI app: REST endpoints + WebSocket hub (`/ws`). Generic CRUD factory `_register_crud` covers most entity tables with one dict entry each. |
| `core/db.py` | SQLite + SQLAlchemy session management; `DB_LOCK` for write serialisation. |
