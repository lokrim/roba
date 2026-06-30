/**
 * ModelToggle — live model selector for the voice interface.
 *
 * Persisted in localStorage via useVoiceLive. Changing the model triggers a
 * WebSocket reconnect (handled by the useVoiceLive effect dependency on voiceModel).
 */

const MODELS: Array<{ id: string; label: string; description: string }> = [
  {
    id: "gemini-live-2.5-flash-native-audio",
    label: "Flash 2.5 Native Audio",
    description: "Natural voice, fast (Vertex AI Live)",
  },
];

const DEFAULT_MODEL = "gemini-live-2.5-flash-native-audio";

interface ModelToggleProps {
  voiceModel: string | undefined;
  onChange: (model: string | undefined) => void;
  disabled?: boolean;
}

export function ModelToggle({ voiceModel, onChange, disabled }: ModelToggleProps) {
  const current = voiceModel ?? DEFAULT_MODEL;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text/50 whitespace-nowrap">Model</span>
      <select
        disabled={disabled}
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === DEFAULT_MODEL ? undefined : v);
        }}
        className={[
          "rounded border border-muted bg-surface px-2 py-0.5 text-xs text-text",
          "focus:outline-none focus:ring-1 focus:ring-accent",
          disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
        ].join(" ")}
        title="Live model — changing reconnects the voice session"
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id} title={m.description}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}
