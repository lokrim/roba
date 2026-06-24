/** Shared primitive components used across all control-page sections. */

import type { ReactNode } from "react";

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wide text-text/40">
      {children}
    </span>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text/50">
      {children}
    </h3>
  );
}

export function ApplyButton({
  onClick,
  busy,
  label,
}: {
  onClick: () => void;
  busy?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="mt-4 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50"
    >
      {busy ? "Applying…" : (label ?? "Apply")}
    </button>
  );
}

export function CardSection({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-muted bg-surface p-4 space-y-4">
      {children}
    </div>
  );
}
