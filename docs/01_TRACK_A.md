# 01 — Track A Implementation Brief: Demand & Sensing
### Owner: Programmer A. Depends entirely on `00_ARCHITECTURE.md` (read it first).

---

## A0. How to read this (rules)
- `00_ARCHITECTURE.md` is authoritative for the **contracts** (signal envelope/types §14–15, DB schema §19, REST/WS §20–21, algorithms §18, constants §22). This file tells you **what Track A builds on top of them**. Where this file says "per §18.2", implement exactly that.
- **Hard boundary:** Track A may read **`core` tables** and **signals**, and write only its **own tables** (`forecasts`, `batches`, `competitor_offers`, `competitor_intel`, `review_insights`). It must **never** read or write Track B tables (`inventory_*`, `purchase_*`, `promotions`, `approval_requests`, `menu_toggles`, `negotiations`, `supplier_price_history`). Inventory state reaches Track A **only via signals** (`LOW_STOCK`, `STOCKOUT_RISK`, `MENU_TOGGLE`, `SUPPLIER_PRICE_UPDATE`).
- **Standalone:** in `DEMO_MODE=track_a`, `track_a/mocks/MockInventory` supplies the Track B signals A consumes. In `combined`, mocks are off and real Track B signals arrive — **no code change**.

## A1. Scope & deliverables
Four agents + one mock + five UI panels:
1. **Demand Forecaster** (the core mandate) — `track_a/agents/forecaster.py`
2. **Competitor Intelligence** (monitoring + undercover calls) — `track_a/agents/competitor.py`
3. **Review Analysis** — `track_a/agents/review.py`
4. **Staff** — `track_a/agents/staff.py`
5. **MockInventory** — `track_a/mocks/mock_inventory.py`
6. **UI:** Forecast dashboard, Competitor panel, Review panel, Staff panel, Signal Feed — `frontend/src/track_a/*` (mount into the core React shell §23).

## A2. Folder layout
```
track_a/                     # Python only
  agents/ forecaster.py  competitor.py  review.py  staff.py
  mocks/  mock_inventory.py
  tests/  test_forecaster.py  test_competitor.py  test_review.py  test_staff.py  test_contract_a.py
frontend/src/track_a/        # React panels (mounted by the core shell §23)
  ForecastDashboard.tsx  CompetitorPanel.tsx  ReviewPanel.tsx  StaffPanel.tsx  SignalFeed.tsx
```

## A3. What you consume from `core` (do not re-implement)
`BaseAgent` (subscribe/on_signal/emit/log_event), `bus` (emit/live/consume), `SimClock` (current sim_time, daypart, dow), `orchestrator.register_trigger(...)`, `llm.complete(...)` (with canned fallback), `calls.request_call(...)` (call subsystem §8), DB session + the core/reference tables. Read velocity from the formatter (exposed on `order_created` WS payload and via `formatter.item_velocity(menu_item_id)`).

---

## A4. Agents

### A4.1 Demand Forecaster (`forecaster.py`)
**Purpose:** rolling per-item forecasts + batch cook/skip decisions + periodic batch suggestions.
**Subscribe groups:** `forecasting`.
**Triggers (register all per §17 "Full Demand-Forecaster trigger set"):** interval `FORECAST_INTERVAL_SIM_S`; each `batch_definition.decide_by`; signals `WASTE_EVENT, STAFF_COVERAGE, COMPETITOR_UPDATE, COMPETITOR_INTEL, REVIEW_INSIGHT, WEATHER_UPDATE, USER_FACT(add_event)`; POS-velocity anomaly (> `VELOCITY_ANOMALY_PCT`); manual/scenario.
**Forecast (per active `menu_item`, per upcoming window) — implement §18.2 exactly:**
`forecast = baseline(item,daypart,dow) × Π multipliers`, multipliers = {event, competitor, review, staff_coverage(cap), weather, recent_velocity(clamp `VELOCITY_CLAMP`)}. Each multiplier is read from the **latest live signal / `USER_FACT` / weather** of the relevant type; default 1.0 if none. Write a `forecasts` row including the full `multipliers` dict and `confidence` (= 1/spread). Emit `DEMAND_FORECAST` (dedup_key `forecast:{item}:{window_start}`). Broadcast `forecast_updated`.
**Batch decision (at each `decide_by`) — implement §18.3:** cook if `f ≥ batch_size_min` AND item available (**no live `MENU_TOGGLE(disable)` and no live `STOCKOUT_RISK` covering its required ingredients**) AND station staffed (no live `STAFF_COVERAGE(covered=false)` for its station); `qty = clamp(round_to_step(f),min,max)`. Create `batches` row, emit `BATCH_DECISION`, log_event with the reason ("cooked 24 garlic-bread: lunch forecast 22, grill staffed, tomato OK").
**Suggestions (LLM, every `SUGGESTION_INTERVAL_SIM_S`) — §18.7:** send recent sell-through / waste / sellout stats; LLM returns JSON `{add:[],remove:[],retime:[],resize:[]}`; surface as non-blocking cards on the dashboard. Canned fallback `{}` ("no change").
**Explainability is mandatory:** every forecast and batch decision must produce a human-readable `event_log` line and expose its `multipliers`. This is the demo's headline.
**Edge cases:** sparse history → baseline fallback chain (§18.1); item disabled mid-window → stop forecasting/cooking it; conflicting multipliers → just multiply (no special-casing).

### A4.2 Competitor Intelligence (`competitor.py`)  ← consolidates the old "Aggregator"
**Purpose:** (a) passively track competitors/offers; (b) run **approval-gated undercover research calls**.
**Subscribe groups:** `sensing`. **Triggers:** interval (re-check competitors) + manual ("Research" button via REST → agent method).
**Passive monitoring:** maintain `competitors` + `competitor_offers` (seeded; refreshed via discovery §8.4). On change in open-status or offers, emit `COMPETITOR_UPDATE` (dedup_key `competitor:{id}`). LLM (optional) interprets a competitor's combo text into `{similar_dish, aggressiveness}`; canned = no effect.
**Discovery:** build candidate list (real web/places call mapped to the canonical struct §8.4, else seed). Selection rule §8.4: within `COMPETITOR_RADIUS_KM`, shared cuisine, ranked by `rating×proximity`, top `COMPETITOR_CALL_TARGETS`.
**Undercover call flow (uses core call subsystem §8):**
1. Agent picks a target → `calls.request_call(agent="competitor_intel", counterparty_type="competitor", counterparty_id, purpose="ask favourite dish")` → core emits `CALL_REQUEST` + creates an approval card.
2. On approve (handled by core/§8): clock freezes, ROLEPLAY console opens ("You are playing: {Competitor}"), turn loop runs. **Agent persona = ordinary customer**; asks 2–4 questions to learn the most-popular/favourite dish (and prices if natural); **never reveals it is doing research / is an AI** (biases data). Turn text via `llm.complete` with the §8.3 competitor system prompt; canned = a scripted polite customer line.
3. On hangup, core extracts outcome (§8.5) → Track A writes `competitor_intel {method:"call", popular_dishes, price_points, call_id}` and emits `COMPETITOR_INTEL`.
4. Usage (§18.6): if a competitor favourite maps to one of our items, nudge that forecast ×1.05 and raise a Forecaster suggestion to promote/add it.
**Fallback:** if the presenter declines roleplay, core auto-resolves with an LLM-simulated competitor persona seeded from `competitor_offers`; the intel still lands.

### A4.3 Review Analysis (`review.py`)
**Purpose:** turn reviews into insights + signals.
**Subscribe groups:** `sensing`. **Triggers:** new unprocessed `reviews` row (seeded or injected via `/reviews` POST or scenario) → process.
**Logic:** for each new review, `llm.complete` (JSON) → `{sentiment, dish_mentions:[], severity, suggested_action}`; write `review_insights`; mark review processed; emit `REVIEW_INSIGHT` (dedup_key `review:{dish or theme}` so repeats collapse). Canned fallback = neutral sentiment, no action. Aggregate trend (e.g., 3+ negative on one dish in a window) bumps severity → the Forecaster's review multiplier (§18.2).
**UI interaction:** suggested actions appear on the Review panel; "send to forecaster" already happens via the signal (no extra wiring).

### A4.4 Staff (`staff.py`)
**Purpose:** station coverage → demand caps.
**Subscribe groups:** `forecasting`. **Triggers:** shift boundaries (interval); `USER_FACT(set_leave|set_attendance)`; the demo "call in sick" action.
**Logic (deterministic):** read `staff`, `staff_stations`, and the structured **`attendance`** table (core tables). Compute per-station, per-daypart coverage for the current + next shift: a staff member covers a station when a `staff_stations` row links them and they have no `attendance` row with `status ∈ {leave, sick}` for that `date_sim_day` (a null `daypart` means the whole day is affected; a set `daypart` scopes the absence to that daypart). Join `attendance` ⋈ `staff_stations` to answer queries like "is the grill staffed for the dinner daypart right now?". If a station that has active menu items is uncovered, emit `STAFF_COVERAGE {station_id, covered:false, affected_items, shortfall}` (dedup_key `coverage:{station}`). When coverage is restored, emit `covered:true`. The Forecaster applies `STAFF_CAP_FACTOR` to affected items (§18.2) and blocks batches for that station (§18.3). **`USER_FACT(set_leave)` is the trigger to recompute coverage** — voice writes the `attendance` rows, the Staff agent re-reads them on the signal. (`event_log` attendance rows are display-only and must never be queried for coverage.)
**Demo hook:** "call in sick" (button in Staff panel or core control bar) writes an attendance exception → re-run coverage.

---

## A5. Standalone placeholder — MockInventory (`mocks/mock_inventory.py`)
Active only when `DEMO_MODE=track_a`. Emits the Track B signals A consumes, on a believable schedule, payloads per §15:
- every ~3 sim-hours, pick a random low-priority active item and emit `MENU_TOGGLE(disable, reason="mock low stock")`; re-enable it ~1 sim-hour later → proves the Forecaster stops/resumes forecasting & batching it.
- occasionally emit `SUPPLIER_PRICE_UPDATE` and a `STOCKOUT_RISK` on one ingredient → proves availability gating on batches.
Keep it minimal and obviously fake (so it's clearly removed in `combined`).

---

## A6. UI panels (`frontend/src/track_a/*`, mount in core shell)
All are **WS consumers** using relative `/api` + `/ws`; no business logic in the UI.
- **ForecastDashboard** — table/chart per item: forecast vs actual-so-far; a **"why" breakdown** (the `multipliers` dict as labelled chips, e.g. `event ×1.35`, `staff ×0.5`); batch decisions (cook/skip + qty + reason); suggestion cards. Consumes `forecast_updated`, `batch_decided`, `order_created`.
- **CompetitorPanel** — competitor list (open status, offers), a **"Research" button** per competitor (→ `POST` that calls the agent → `CALL_REQUEST`), and intel results (popular dishes). Consumes `competitor` updates + `call_*` events.
- **ReviewPanel** — review stream with sentiment tags, extracted dish mentions, insights + suggested actions. Consumes `signal_emitted(REVIEW_INSIGHT)`.
- **StaffPanel** — roster by station, coverage status (green/red), leave/attendance, "call in sick". Consumes `signal_emitted(STAFF_COVERAGE)` + `event_logged`.
- **SignalFeed** — live signals filtered to A's groups, with type, source, priority, and an **expiry countdown**; clicking a signal shows its payload. Consumes `signal_emitted`.

---

## A7. Track A acceptance criteria (standalone, `DEMO_MODE=track_a`)
1. On play, forecasts appear for all active items each interval, each with a visible multiplier breakdown.
2. Injecting an event by voice ("parade Monday") raises the relevant forecasts ×~1.35 with `event` shown in the breakdown.
3. "Call in sick" for a grill cook caps grill items and skips their batches; restoring coverage reverses it.
4. MockInventory's `MENU_TOGGLE(disable)` makes the Forecaster stop forecasting/batching that item; re-enable resumes it.
5. A negative review injection produces a `REVIEW_INSIGHT` and nudges that dish's forecast down.
6. Clicking "Research" on a competitor creates an approval; approving freezes the clock, opens the ROLEPLAY console, runs a call, and writes `competitor_intel` + `COMPETITOR_INTEL`; the favourite dish nudges our forecast.
7. SignalFeed shows live signals with expiry countdowns; dedup collapses repeats.

## A8. Phase-2 integration (combined)
Set `DEMO_MODE=combined`: MockInventory off; real `MENU_TOGGLE`/`STOCKOUT_RISK`/`SUPPLIER_PRICE_UPDATE` now come from Track B. **No code changes** — only verify the same behaviors against real signals during the flagship "Friday Rush" scenario.

## A9. Tests (pytest unless noted)
- `test_forecaster`: baseline math; each multiplier applied; clamp; batch cook/skip truth table; explainability fields present.
- `test_competitor`: discovery selection rule; call request → outcome write; intel→forecast nudge.
- `test_review`: insight extraction (canned path); dedup; trend severity.
- `test_staff`: coverage computation; cap + batch block; restore.
- `test_contract_a`: every signal A emits validates against §15 payloads; A subscribes only to its groups; A never imports Track B modules (assert via import check).
- Frontend (vitest): panels render from sample WS payloads; relative paths only.

*End of 01_TRACK_A.md.*
