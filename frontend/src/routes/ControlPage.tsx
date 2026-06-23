import { ControlShell } from "../shell/ControlShell";

// Operator inputs only — control bar + drawers, no dashboards. Intended for a
// dedicated presenter screen driving the demo (settings open via the drawer).
export default function ControlPage() {
  return (
    <ControlShell>
      <main className="px-4 py-6 text-sm text-text/50">
        Control surface. Use the bar above to drive the sim; open the inbox or
        settings from the bar. Dashboards live on the{" "}
        <span className="text-text/70">Panels</span> screen.
      </main>
    </ControlShell>
  );
}
