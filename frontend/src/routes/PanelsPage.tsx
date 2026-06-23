import { PanelsView } from "../shell/PanelsView";

// Read-only dashboards only — no control bar. Intended for a second screen
// showing the live POS monitor and agent panels while another screen drives.
export default function PanelsPage() {
  return <PanelsView />;
}
