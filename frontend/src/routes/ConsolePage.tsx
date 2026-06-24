import { ControlShell } from "../shell/ControlShell";
import { DashboardView } from "../shell/DashboardView";

// Full operator console: live control bar + unified domain-grouped dashboard.
export default function ConsolePage() {
  return (
    <ControlShell>
      <DashboardView />
    </ControlShell>
  );
}
