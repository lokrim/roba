import { useState } from "react";
import { apiPost } from "../../api";
import { useWeather } from "../../store";
import type { WeatherCondition } from "../../types";
import { SectionHeading } from "./shared";

const CONDITIONS: WeatherCondition[] = ["clear", "clouds", "rain", "storm", "snow"];

export function WeatherControl() {
  const weather = useWeather();
  const [temp, setTemp] = useState(20);
  const [condition, setCondition] = useState<WeatherCondition>("clear");
  const [precip, setPrecip] = useState(0);
  const [wind, setWind] = useState(5);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);

  async function apply() {
    setBusy(true);
    try {
      await apiPost("/api/weather/override", {
        temp_c: temp,
        condition,
        precip_mm: precip,
        wind_kph: wind,
      });
      setApplied(true);
      setTimeout(() => setApplied(false), 2000);
    } catch { /* ignore; weather_updated WS event reflects the applied value */ } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeading>Weather Override</SectionHeading>
      <p className="text-[10px] text-text/40">
        Override the simulated weather. Affects channel mix (rain → more delivery) and demand multipliers for weather-tagged dishes.
        Current: <span className="text-text/70">{weather ? `${weather.condition}, ${weather.temp_c}°C` : "—"}</span>
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase text-text/40">Temperature (°C)</span>
          <input
            type="number" value={temp}
            onChange={(e) => setTemp(Number(e.target.value))}
            className="rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase text-text/40">Condition</span>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as WeatherCondition)}
            className="rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
          >
            {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase text-text/40">Precip (mm)</span>
          <input
            type="number" min={0} value={precip}
            onChange={(e) => setPrecip(Number(e.target.value))}
            className="rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase text-text/40">Wind (kph)</span>
          <input
            type="number" min={0} value={wind}
            onChange={(e) => setWind(Number(e.target.value))}
            className="rounded-md border border-muted bg-primary px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
      </div>
      <button
        type="button" onClick={() => void apply()} disabled={busy}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50"
      >
        {busy ? "Applying…" : applied ? "✓ Applied" : "Set Weather"}
      </button>
    </div>
  );
}
