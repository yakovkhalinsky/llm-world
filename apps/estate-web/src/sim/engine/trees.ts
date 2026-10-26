/** The trees — apps/estate/estate/engine/trees.py. */
import { R } from "../rules.ts";
import * as W from "../world.ts";
import type { Ev } from "./events.ts";

export function buildShade(w: W.World): void {
  const grid: number[][] = Array.from({ length: w.height }, () => new Array<number>(w.width).fill(0.0));
  for (const f of Object.values(w.fixtures)) {
    if (f.kind !== "tree" || f.condition <= 0) continue;
    for (const dy of [-1, 0, 1]) {
      for (const dx of [-1, 0, 1]) {
        const x = f.x + dx, y = f.y + dy;
        if (W.inBounds(w, x, y)) grid[y]![x]! += !(dx || dy) ? 0.30 : 0.12;
      }
    }
  }
  for (let y = 0; y < w.height; y++) {
    for (let x = 0; x < w.width; x++) w.cells[y]![x]!.shade = Math.min(1.0, grid[y]![x]!);
  }
}

export function updateTrees(w: W.World, evs: Ev[]): void {
  const rng = W.rngFor(w.seed, w.day, "trees");
  const storm = w.weather === "storm";
  for (const f of Object.values(w.fixtures)) {
    const spec = R.fixtures[f.kind]!;
    if (!spec.living) continue;
    f.age = (f.age as number) + 1;
    if (storm && rng.random() < (spec.storm_fall ?? 0.0)) {
      delete w.fixtures[String(f.id)];
      evs.push({ day: w.day, kind: "tree_down", x: f.x, y: f.y });
    }
  }
  buildShade(w);
}
