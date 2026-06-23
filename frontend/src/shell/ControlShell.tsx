import { useState, type ReactNode } from "react";
import { ControlBar } from "./ControlBar";
import { ApprovalInbox } from "./ApprovalInbox";
import { SettingsDrawer } from "./SettingsDrawer";

// The operator control surface shared by the Console and Control pages: the
// ControlBar plus the inbox/settings drawers and their open/close state.
// `children` render between the bar and the drawers (the Console page passes
// the panels here; the Control page passes a placeholder).
export function ControlShell({ children }: { children: ReactNode }) {
  const [inboxOpen, setInboxOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <ControlBar
        onToggleInbox={() => setInboxOpen((open) => !open)}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
      />
      {children}
      <ApprovalInbox open={inboxOpen} onClose={() => setInboxOpen(false)} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
