import { ControlShell } from "../shell/ControlShell";
import { PanelsView } from "../shell/PanelsView";

// Full operator console: control bar + drawers + panels.
export default function ConsolePage() {
  return (
    <ControlShell>
      <PanelsView />
    </ControlShell>
  );
}
