import { useEffect, useSyncExternalStore } from "react";
import { apiGet } from "../api";
import { wsClient } from "../ws";
import { store } from "../store";
import type { PosOrderEvent } from "../types";

// Shared POS stream (see docs/06). The buffer is a single module-level
// singleton — NOT per-component state — so it stays consistent as the user
// navigates between the Console and Panels pages (which mount/unmount the
// monitor). Key behaviours:
//  - Backfill runs ONCE, filtered to the current run (since=0 drops the seeded
//    negative-sim_time history). It does not re-run on remount, so navigating
//    pages never reloads stale orders.
//  - The order_created subscription + flush timer are installed once, on the
//    first monitor mount, and never torn down — so other pages stay consistent
//    and the lazy /menu page (which never mounts the monitor) never touches it.
//  - Incoming orders accumulate in a pending array and flush to subscribers on
//    a fixed interval, so a burst at high sim speed is one update per flush.
//  - Reset semantics: STOP keeps the buffer (the monitor stays viewable with
//    its window toggles). START (stopped → running) clears it for a clean run.
//    RESTART / reseed clear it via the backend's `pos_reset` event. None of
//    these re-backfill; the live stream repopulates on play.

const BUFFER_CAP = 120;
const BACKFILL_LIMIT = 50;
const FLUSH_INTERVAL_MS = 500;

export interface PosStream {
  /** Recent orders, newest-first (bounded ring buffer) — drives the live feed. */
  orders: PosOrderEvent[];
  /** Latest items/sec velocity per menu_item_id from the order_created stream. */
  velocity: Record<string, number>;
  ready: boolean;
}

// -- shared singleton state -------------------------------------------------

let buffer: PosOrderEvent[] = [];
let velocity: Record<string, number> = {};
let ready = false;
const seen = new Set<number>();
let pending: PosOrderEvent[] = [];
let pendingVelocity: Record<string, number> | null = null;
let initialized = false;
let lastStatus: string | null = null;

const listeners = new Set<() => void>();
// useSyncExternalStore requires a stable snapshot ref between changes.
let snapshot: { orders: PosOrderEvent[]; velocity: Record<string, number>; ready: boolean } = {
  orders: buffer,
  velocity,
  ready,
};

function emit(): void {
  snapshot = { orders: buffer, velocity, ready };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

/** `events` must be chronological (oldest → newest), matching the live order
 *  arrival order; flush reverses to keep the buffer newest-first. */
function ingest(event: PosOrderEvent): void {
  if (!event?.order || seen.has(event.order.id)) return;
  seen.add(event.order.id);
  pending.push(event);
  if (event.velocity) pendingVelocity = event.velocity;
}

function flush(): void {
  let changed = false;
  if (pending.length > 0) {
    buffer = [...pending.reverse(), ...buffer].slice(0, BUFFER_CAP);
    pending = [];
    if (seen.size > BUFFER_CAP * 4) {
      seen.clear();
      for (const e of buffer) seen.add(e.order.id);
    }
    changed = true;
  }
  if (pendingVelocity) {
    velocity = pendingVelocity;
    pendingVelocity = null;
    changed = true;
  }
  if (changed) emit();
}

function reset(): void {
  buffer = [];
  velocity = {};
  seen.clear();
  pending = [];
  pendingVelocity = null;
  emit();
}

/** Install WS subscriptions, the flush timer, and the one-time backfill. Guarded
 *  so it runs exactly once for the app lifetime, on the first monitor mount. */
function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  // Seed from the hydrated state so a later speed-change (running → running)
  // isn't mistaken for a start.
  lastStatus = store.getState().simState?.status ?? null;

  wsClient.on("order_created", (p) => ingest(p as unknown as PosOrderEvent));
  wsClient.on("sim_state_changed", (p) => {
    const status = (p as { status?: string }).status;
    // Clear on the transition INTO a fresh run (start after stop). Resuming
    // from a pause keeps the buffer; speed changes (running → running) too.
    if (status === "running" && lastStatus !== "running" && lastStatus !== "paused") {
      reset();
    }
    if (status) lastStatus = status;
  });
  // Restart / reseed wipe orders backend-side and emit this; clear to match.
  wsClient.on("pos_reset", () => reset());
  setInterval(flush, FLUSH_INTERVAL_MS);

  // Current-run orders only: since=0 excludes seeded negative-sim_time history.
  apiGet<PosOrderEvent[]>(`/api/orders?since=0&limit=${BACKFILL_LIMIT}`)
    .then((rows) => {
      // Backfill is newest-first; reverse so ingest order matches the live
      // (oldest → newest) convention flush expects.
      for (const row of [...rows].reverse()) ingest(row);
      ready = true;
      flush();
      emit();
    })
    .catch(() => {
      ready = true;
      emit();
    });
}

export function usePosStream(): PosStream {
  useEffect(() => {
    ensureInitialized();
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
