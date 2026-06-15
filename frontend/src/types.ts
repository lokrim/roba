// Shapes mirror the backend contracts (00 §19–§21). The frontend is a pure
// consumer of these; it never computes business logic over them.

export type SimStatus = "stopped" | "running" | "paused" | "call_frozen";

export type WeatherCondition = "clear" | "clouds" | "rain" | "storm" | "snow";

/** Snapshot of the sim clock, fed by GET /api/sim/state + the sim_tick WS event. */
export interface SimState {
  sim_time: number;
  day_number: number;
  day_of_week?: number;
  /** Present on sim_tick events; "HH:MM" within the operating day. */
  time_of_day?: string;
  speed: number;
  status: SimStatus;
  call_mode?: "freeze" | "slow";
}

/** Canonical weather struct (00 §9.1) as carried by weather_updated / GET /api/weather. */
export interface Weather {
  temp_c: number;
  condition: WeatherCondition;
  precip_mm: number;
  wind_kph: number;
  source: "api" | "override";
}

export type ApprovalType =
  | "purchase_order"
  | "menu_change"
  | "promo"
  | "outbound_call"
  | "other";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** approval_requests row (00 §19.3). */
export interface ApprovalRequest {
  id: number;
  type: ApprovalType;
  title: string;
  summary: string;
  payload: unknown;
  urgency: number | string | null;
  status: ApprovalStatus;
  created_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  ref_id: number | null;
}

export type CallStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "active"
  | "completed"
  | "failed"
  | "auto_resolved";

/** One streamed roleplay turn (call_turn WS event + calls.transcript entries). */
export interface CallTurn {
  role: "agent" | "counterparty";
  text: string;
  sim_ts?: number;
}

/** calls row (00 §19.3). */
export interface Call {
  id: number;
  agent: "market_spectator" | "competitor_intel";
  counterparty_type: "supplier" | "competitor";
  counterparty_id: number | null;
  purpose: string | null;
  status: CallStatus;
  approval_id: number | null;
  transcript: CallTurn[] | null;
  outcome: unknown;
  started_at: number | null;
  ended_at: number | null;
  clock_action: "freeze" | "slow" | null;
}

/** A scenario row + its events (GET /api/scenarios). */
export interface Scenario {
  id: number;
  name: string;
  description: string | null;
  is_active: number;
  events?: ScenarioEvent[];
}

/** A single timed event within a scenario. */
export interface ScenarioEvent {
  id: number;
  scenario_id: number;
  at_sim_time: number;
  event_type: string;
  payload: unknown;
  fired: number;
}

/** Valid event_type values the scenario engine dispatches. */
export const SCENARIO_EVENT_TYPES = [
  "inject_signal",
  "change_setting",
  "inject_review",
  "set_competitor",
  "call_in_sick",
  "supplier_change",
  "weather_set",
  "velocity_mult",
] as const;

export type ScenarioEventType = (typeof SCENARIO_EVENT_TYPES)[number];

/** sim_settings singleton row (GET/PATCH /api/sim/pos). */
export interface SimSettings {
  id: number;
  base_orders_per_day: number | null;
  velocity: number | null;
  dish_mix_weights: Record<string, number> | null;
  daypart_curve: Record<string, number> | null;
  channel_mix: Record<string, number> | null;
  anomaly_injections: AnomalyInjection[] | null;
}

/** One windowed POS anomaly injection (§10). */
export interface AnomalyInjection {
  start?: number;
  end?: number;
  velocity_mult?: number;
  dish_mix_skew?: Record<string, number>;
}

/** menu_items row (GET /api/menu). */
export interface MenuItem {
  id: number;
  name: string;
  category: string | null;
  station_id: number | null;
  dine_in_price: number | null;
  online_price: number | null;
  prep_time_min: number | null;
  is_batchable: number;
  active: number;
  weather_tags: unknown;
  description: string | null;
}

/** Generic entity row for the entity editor (columns vary per resource). */
export type EntityRow = Record<string, unknown>;
