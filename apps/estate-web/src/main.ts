/**
 * PR 1's page: plant an estate in the worker and draw its plan. The 3D
 * page (page3d) is wired to the worker in PR 3.
 */
import type { FromWorker, ToWorker } from "./worker/protocol.ts";
import { counts, type World } from "./sim/world.ts";

const SITE_COLOUR: Record<string, string> = {
  building: "#8a7f74", lawn: "#9cc47a", path: "#d8d2c4", paved: "#c9c3b6",
  play: "#e9c98a", road: "#77736c", water: "#7fb0d6", yard: "#bfb8a8",
  bench: "#b07b45", bus_stop: "#2f6db3", lamp: "#e8d36a", playground: "#e2a13b",
  school: "#7a4fa0", shop: "#c4574a", table: "#a0683a", tree: "#4f7f3a",
};
const fmt = new Intl.NumberFormat("en-AU"); // comma thousands

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const worker = new Worker(new URL("./worker/sim.worker.ts", import.meta.url), { type: "module" });

function draw(w: World): void {
  const s = 14;
  const cv = $<HTMLCanvasElement>("plan");
  cv.width = w.width * s;
  cv.height = w.height * s;
  const g = cv.getContext("2d")!;
  for (let y = 0; y < w.height; y++) {
    for (let x = 0; x < w.width; x++) {
      const c = w.cells[y]![x]!;
      g.fillStyle = SITE_COLOUR[c.site] ?? "#ccc";
      g.fillRect(x * s, y * s, s, s);
    }
  }
  for (const f of Object.values(w.fixtures)) {
    g.fillStyle = SITE_COLOUR[f.kind] ?? "#333";
    g.beginPath();
    g.arc(f.x * s + s / 2, f.y * s + s / 2, s / 3, 0, Math.PI * 2);
    g.fill();
  }
}

function facts(w: World, hash: string, ms: number): void {
  const people = Object.keys(w.residents).length;
  const homes = Object.entries(counts(w)).map(([k, n]) => `${k.replace("_", " ")} ${fmt.format(n)}`).join(", ");
  const blocks = Object.values(w.buildings).map((b) => `${b.name}${b.floors ? ` (${b.floors} floors)` : ""}`).join(", ");
  $("facts").innerHTML = `
    <p><b>${fmt.format(people)}</b> people in ${fmt.format(Object.keys(w.households).length)} households</p>
    <p>${homes}</p>
    <p>${blocks}</p>
    <p>${fmt.format(w.waiting.length)} on the waiting list</p>
    <p><code>world ${hash}</code> · planted in ${ms.toFixed(0)} ms</p>`;
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  if (m.type === "error") { $("status").textContent = m.message; return; }
  $("status").textContent = "";
  draw(m.world);
  facts(m.world, m.hash, m.ms);
};

function plant(): void {
  const seed = Number($<HTMLInputElement>("seed").value) || 0;
  $("status").textContent = "planting…";
  worker.postMessage({ type: "gen", seed } satisfies ToWorker);
}
$("plant").addEventListener("click", plant);
plant();
