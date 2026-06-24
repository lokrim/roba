import { DashboardView } from "../shell/DashboardView";

// Read-only second screen — unified domain-grouped dashboard, no control bar.
export default function PanelsPage() {
  return <DashboardView readOnly />;
}
