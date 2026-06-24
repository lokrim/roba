import { ControlShell } from "../shell/ControlShell";
import { ControlDashboard } from "../shell/ControlDashboard";

// Full settings + live control surface. The live ControlBar (transport, speed,
// velocity, voice) sits above the full-featured ControlDashboard with
// purpose-built editors for every simulation parameter.
export default function ControlPage() {
  return (
    <ControlShell>
      <ControlDashboard />
    </ControlShell>
  );
}
