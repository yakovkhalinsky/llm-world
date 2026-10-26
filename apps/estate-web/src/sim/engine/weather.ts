/** The sky over the estate — apps/estate/estate/engine/weather.py. */
import { intkey, R } from "../rules.ts";
import * as W from "../world.ts";
import type { Ev } from "./events.ts";

export function rollWeather(w: W.World, evs: Ev[]): void {
  const t = w.day;
  const season = W.seasonIndex(t);
  if (w.weather_left > 0) {
    w.weather_left -= 1;
    if (w.weather_left === 0 && w.weather !== "frost") w.weather = "clear";
    return;
  }
  if (season === R.weather.frost_week) {
    if (w.weather !== "frost") {
      w.weather = "frost";
      evs.push({ day: t, kind: "frost" });
    }
    return;
  }
  const rng = W.rngFor(w.seed, t, "weather");
  const prob = intkey(R.weather.rain_prob);
  const storms = intkey(R.weather.storm_prob);
  const heat = intkey(R.weather.heat_prob);
  const r = rng.random();
  const stormP = storms.get(season) ?? 0.0;
  const heatP = heat.get(season) ?? 0.0;
  if (r < stormP) {
    w.weather = "storm"; w.weather_left = 1;
    evs.push({ day: t, kind: "storm" });
  } else if (r < stormP + heatP) {
    w.weather = "heat"; w.weather_left = 1;
  } else if (r < stormP + heatP + (prob.get(season) ?? 0.0)) {
    w.weather = "rain"; w.weather_left = 1;
  } else {
    w.weather = "clear";
  }
}

export function updateWetStreak(w: W.World): number {
  w.wet_days = w.weather === "rain" || w.weather === "storm" ? (w.wet_days ?? 0) + 1 : 0;
  return w.wet_days;
}

export function wetness(w: W.World): number {
  return Math.min(1.0, (w.wet_days ?? 0) / 14.0);
}
