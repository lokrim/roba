import { useState, type ReactNode } from "react";
import { ControlBar } from "./ControlBar";
import { ApprovalInbox } from "./ApprovalInbox";

// The operator control surface shared by the Console and Control pages: the
// live ControlBar (transport, speed, velocity, voice, approvals) plus the
// approval inbox drawer. Advanced settings live on the /control route via
// ControlDashboard — the SettingsDrawer has been retired.
export function ControlShell({ children }: { children: ReactNode }) {
  const [inboxOpen, setInboxOpen] = useState(false);

  return (
    <>
      <ControlBar onToggleInbox={() => setInboxOpen((open) => !open)} />
      {children}
      <ApprovalInbox open={inboxOpen} onClose={() => setInboxOpen(false)} />
    </>
  );
}
