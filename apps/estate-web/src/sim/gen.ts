/**
 * Seeded, deterministic estate generation — apps/estate/estate/gen.py.
 *
 * Every draw comes from (seed, 0, "gen") in the same order as the Python,
 * so the same seed plants the same estate, cell for cell and name for
 * name. The parity test holds it to that. Sets of cells are keyed "x,y";
 * gen's sets are only ever asked for membership, never iterated.
 */
import { divmod, floordiv, pyRound, range } from "../py/num.ts";
import type { PyRandom } from "../py/random.ts";
import { moveIn } from "./engine/households.ts";
import { R } from "./rules.ts";
import * as W from "./world.ts";

export const BLOCK_NAMES = ["Ash", "Elm", "Lime", "Maple", "Willow", "Hawthorn"] as const;

/** the largest side a plan may have */
export const MAX_SIDE = 200;

type P = readonly [number, number];
const key = (x: number, y: number): string => `${x},${y}`;

function rect(cells: W.Cell[][], x0: number, y0: number, x1: number, y1: number, site: string): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (0 <= y && y < cells.length && 0 <= x && x < cells[0]!.length) cells[y]![x] = W.newCell(site);
    }
  }
}

function ring(x0: number, y0: number, x1: number, y1: number): string[] {
  const out: string[] = [];
  for (let y = y0 - 1; y < y1 + 2; y++) for (let x = x0 - 1; x < x1 + 2; x++) out.push(key(x, y));
  return out;
}

function walkOf(site: string): number | null {
  return R.sites[site]!.walk;
}

export function generate(seed: number, width?: number | null, height?: number | null): W.World {
  const rng: PyRandom = W.rngFor(seed, 0, "gen");
  const g = R.gen;
  const w = width == null ? R.world.width : width;
  const h = height == null ? R.world.height : height;
  if (w <= 0 || h <= 0) throw new RangeError("sizes must be positive");
  if (w > MAX_SIDE || h > MAX_SIDE) {
    throw new RangeError(
      `at most ${MAX_SIDE}×${MAX_SIDE}: the page and the search are sized for a neighbourhood, not a city`,
    );
  }
  const st = W.newState(seed, w, h);
  st.biome = "estate";
  const cells: W.Cell[][] = [];
  for (let y = 0; y < h; y++) {
    const row: W.Cell[] = [];
    for (let x = 0; x < w; x++) row.push(W.newCell("lawn"));
    cells.push(row);
  }

  // --- the ring road
  const rw = g.road_width;
  rect(cells, rw, rw, w - rw - 1, rw + rw - 1, "road");
  rect(cells, rw, h - rw - rw, w - rw - 1, h - rw - 1, "road");
  rect(cells, rw, rw, rw + rw - 1, h - rw - 1, "road");
  rect(cells, w - rw - rw, rw, w - rw - 1, h - rw - 1, "road");

  // --- the courtyard
  const layout = g.layout ?? "quad";
  let cy0 = floordiv(h, 2) - 2;
  if (layout === "row") cy0 = Math.min(cy0, rw + rw + g.block_gap + 6 + 1);
  const cy1 = cy0 + 3;
  const cx0 = rw + 6;
  const cx1 = w - rw - 7;
  rect(cells, cx0, cy0, cx1, cy1, "paved");

  // --- the blocks
  const bw = 12;
  const bh = 6;
  const gap = g.block_gap;
  const blocks: [number, number][] = [];
  if (layout === "row") {
    const n = g.blocks;
    const span = n * bw + Math.max(0, n - 1) * gap;
    const bx = floordiv(w - span, 2);
    const by = rw + rw + gap;
    if (bx < rw * 2 || bx + span > w - rw * 2 || by + bh > h - rw * 2) {
      throw new RangeError(
        `the recipe asks for ${n} blocks in a row ${span} cells wide but this ${w}×${h} plan's ` +
          `inner ground is only ${Math.max(0, w - 4 * rw)} wide — widen the plan or lower gen.blocks`,
      );
    }
    for (let i = 0; i < n; i++) blocks.push([bx + i * (bw + gap), by]);
  } else if (layout === "quad") {
    const byTop = rw + rw + gap;
    const byBot = h - rw - rw - bh - gap;
    const bxLeft = rw + rw + gap;
    const bxRight = w - rw - rw - bw - gap - 1;
    for (const [bx, by] of [[bxLeft, byTop], [bxRight, byTop], [bxLeft, byBot], [bxRight, byBot]] as const) {
      if (bx + bw >= w - rw || by + bh >= h - rw || bx < rw || by < rw) continue;
      blocks.push([bx, by]);
    }
  } else {
    throw new RangeError(`gen.layout is '${layout}' — expected 'row' or 'quad'`);
  }
  if (blocks.length !== g.blocks) {
    throw new RangeError(
      `the recipe asks for ${g.blocks} blocks in a ${layout} but this plan holds ${blocks.length} — ` +
        `widen the plan or lower gen.blocks`,
    );
  }

  st.buildings = {};
  st.units = {};
  const buildings: W.Building[] = [];
  blocks.forEach(([bx, by], n) => {
    rect(cells, bx, by, bx + bw - 1, by + bh - 1, "building");
    const floors = rng.randint(g.block_floors[0], g.block_floors[1]);
    const per = rng.randint(g.units_per_floor[0], g.units_per_floor[1]);
    const door: P = by < floordiv(h, 2)
      ? [bx + floordiv(bw, 2), by + bh]
      : [bx + floordiv(bw, 2), by - 1];
    const bid = st.next_id; st.next_id += 1;
    const b = W.newBuilding(bid, `${BLOCK_NAMES[n % BLOCK_NAMES.length]} Block`, "block", bx, by, bw, bh, floors, door);
    for (let f = 1; f <= floors; f++) {
      for (let k = 0; k < per; k++) {
        const uid = st.next_id; st.next_id += 1;
        const u = W.newUnit(uid, bid, f, rng.choice([2, 2, 3, 4]));
        st.units[String(uid)] = u;
        b.units.push(uid);
      }
    }
    st.buildings[String(bid)] = b;
    buildings.push(b);
    const edge = by < floordiv(h, 2) ? cy1 : cy0;
    rect(cells, door[0], Math.min(door[1], edge), door[0], Math.max(door[1], edge), "path");
  });

  // --- the perimeter footpath
  if (g.perimeter_path) {
    const inner = rw * 2 + 1;
    const farX = w - rw * 2 - 2;
    const farY = h - rw * 2 - 2;
    rect(cells, inner, inner, farX, inner, "path");
    rect(cells, inner, farY, farX, farY, "path");
    rect(cells, inner, inner, inner, farY, "path");
    rect(cells, farX, inner, farX, farY, "path");
  }

  // --- the shop and the playground, apart, either side of the middle
  const mid = floordiv(cx0 + cx1, 2);
  const clear = new Set<string>();
  let shopB: W.Building | null = null;
  if (g.shop) {
    const sx = mid - 4;
    const sy = cy0;
    rect(cells, sx, sy, sx + 2, sy + 1, "building");
    const bid = st.next_id; st.next_id += 1;
    shopB = W.newBuilding(bid, "The Shop", "shop", sx, sy, 3, 2, 1, [sx + 1, sy + 2]);
    st.buildings[String(bid)] = shopB;
    for (const c of ring(sx, sy, sx + 2, sy + 1)) clear.add(c);
  }

  // --- the pond, and the playground
  if (g.pond) {
    const px = cx0;
    const py = cy1 - 1;
    rect(cells, px, py, px + 3, py + 1, "water");
  }
  let playAt: P | null = null;
  if (g.playgrounds) {
    const px = mid + 3;
    const py = cy0;
    rect(cells, px, py, px + 3, py + 1, "play");
    playAt = [px, py];
    for (const c of ring(px, py, px + 3, py + 1)) clear.add(c);
  }
  for (let y = cy0; y <= cy1; y++) for (let x = mid; x < mid + 2; x++) clear.add(key(x, y));

  // --- the school, and the way to the bus
  const reserved = new Set<string>();
  let schoolB: W.Building | null = null;
  if (g.school) {
    const sbw = 7;
    const sbh = 4;
    const yw = 6;
    const sx = mid - sbw + 1;
    const sy = cy1 + 3;
    const far = h - rw * 2 - 2;
    if (sy + sbh > far || sx + sbw + yw > w - rw * 2 - 2 || sx < rw * 2) {
      throw new RangeError(
        `the recipe asks for a school but this ${w}×${h} plan has no room for it south of the ` +
          `courtyard — widen the plan or set gen.school to False`,
      );
    }
    rect(cells, sx, sy, sx + sbw - 1, sy + sbh - 1, "building");
    rect(cells, sx + sbw, sy, sx + sbw + yw - 1, sy + sbh - 1, "yard");
    const door: P = [sx + floordiv(sbw, 2), sy - 1];
    const gate: P = [sx + sbw, sy - 1];
    const bid = st.next_id; st.next_id += 1;
    schoolB = W.newBuilding(bid, "Highfield School", "school", sx, sy, sbw, sbh, 2, door);
    schoolB.yard = [sx + sbw, sy, yw, sbh];
    schoolB.gate = [gate[0], gate[1]];
    st.buildings[String(bid)] = schoolB;
    rect(cells, door[0], cy1 + 1, door[0], door[1], "path");
    rect(cells, door[0], door[1], gate[0], gate[1], "path");
    reserved.add(key(door[0], cy1 + 1));
  }
  let stopAt: P | null = null;
  if (g.bus_stop) {
    const far = h - rw * 2 - 2;
    const bx = buildings[buildings.length - 1]!.door[0];
    for (let y = cy1 + 1; y < far; y++) {
      const site = cells[y]![bx]!.site;
      if (site !== "lawn" && site !== "path") {
        throw new RangeError(
          `the bus stop's path down x=${bx} meets '${site}' at y=${y} — the plan has no clear way ` +
            `from the blocks to the road`,
        );
      }
    }
    rect(cells, bx, cy1 + 1, bx, far - 1, "path");
    reserved.add(key(bx, cy1 + 1));
    stopAt = [bx, far + 1];
  }

  // --- the fixtures
  st.fixtures = {};
  const taken = new Set<string>();

  const place = (kind: string, x: number, y: number): W.Fixture | null => {
    if (!(0 <= x && x < w && 0 <= y && y < h)) return null;
    if (taken.has(key(x, y))) return null;
    if (walkOf(cells[y]![x]!.site) === null && kind !== "shop") return null;
    const fid = st.next_id; st.next_id += 1;
    const f = W.newFixture(fid, kind, x, y);
    st.fixtures[String(fid)] = f;
    taken.add(key(x, y));
    return f;
  };

  if (playAt) place("playground", playAt[0], playAt[1]);
  if (schoolB) {
    const gt = schoolB.gate as [number, number];
    place("school", gt[0], gt[1]);
  }
  if (stopAt) place("bus_stop", stopAt[0], stopAt[1]);

  const free = (x: number, y: number): boolean =>
    0 <= x && x < w && 0 <= y && y < h && !taken.has(key(x, y)) && walkOf(cells[y]![x]!.site) !== null;

  let edge: P[] = [];
  for (const y of [cy0 - 1, cy1 + 1]) for (let x = cx0; x <= cx1; x++) if (free(x, y)) edge.push([x, y]);
  rng.shuffle(edge);
  edge = edge.filter(([x, y]) => !reserved.has(key(x, y)) && !clear.has(key(x, y)));
  const inner: P[] = [];
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0 + 1; x < cx1; x++) if (free(x, y) && !clear.has(key(x, y))) inner.push([x, y]);
  }
  rng.shuffle(inner);

  const plan: [string, P[]][] = [
    ["bench", edge.slice(0, g.benches)],
    ["lamp", edge.slice(g.benches, g.benches + g.lamps)],
    ["table", inner.slice(0, g.tables)],
  ];
  for (const [kind, spots] of plan) for (const [x, y] of spots) place(kind, x, y);

  // trees on the open lawns
  let planted = 0;
  let tries = 0;
  while (planted < g.trees && tries < 400) {
    tries += 1;
    const x = rng.randrange(w);
    const y = rng.randrange(h);
    if (cells[y]![x]!.site !== "lawn" || taken.has(key(x, y)) || clear.has(key(x, y))) continue;
    let near = false;
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) if ((dx || dy) && taken.has(key(x + dx, y + dy))) near = true;
    }
    if (near) continue;
    if (place("tree", x, y)) planted += 1;
  }

  // --- benches along the perimeter footpath
  const perimeterBenches = g.perimeter_benches ?? 0;
  if (perimeterBenches) {
    const e = rw * 2;
    const farX = w - rw * 2 - 1;
    const farY = h - rw * 2 - 1;
    const sides: Record<string, [P[], (p: P) => number]> = {
      top: [range(e + 1, farX).map((x) => [x, e] as P), (p) => p[0]],
      bottom: [range(e + 1, farX).map((x) => [x, farY] as P), (p) => p[0]],
      left: [range(e + 2, farY - 1).map((y) => [e, y] as P), (p) => p[1]],
      right: [range(e + 2, farY - 1).map((y) => [farX, y] as P), (p) => p[1]],
    };
    const order = ["top", "bottom", "left", "right"] as const;
    const [base, extra] = divmod(perimeterBenches, order.length);
    const chosen: P[] = [];
    order.forEach((s, i) => {
      const want = base + (i < extra ? 1 : 0);
      const [cands, k] = sides[s]!;
      const spots = cands.filter(([x, y]) => free(x, y));
      spots.sort((a, b) => k(a) - k(b)); // stable, as sorted() is
      if (spots.length < want) {
        throw new RangeError(
          `the recipe asks for ${perimeterBenches} perimeter benches but the ${s} side holds only ` +
            `${spots.length} free spots beside the path — widen the plan or lower gen.perimeter_benches`,
        );
      }
      for (let j = 0; j < want; j++) {
        const t = want > 1 ? j / (want - 1) : 0.5;
        chosen.push(spots[pyRound(t * (spots.length - 1))]!);
      }
    });
    if (chosen.length !== perimeterBenches) {
      throw new RangeError(
        `the recipe asks for ${perimeterBenches} perimeter benches but this plan holds only ` +
          `${chosen.length} free spots beside the path — widen the plan or lower gen.perimeter_benches`,
      );
    }
    for (const [x, y] of chosen) {
      const f = place("bench", x, y);
      if (f) f.perimeter = true;
    }
  }

  if (shopB) place("shop", shopB.door[0], shopB.door[1]);

  // The recipe is a promise: fewer than it asks fails loudly.
  const got: Record<string, number> = {};
  for (const f of Object.values(st.fixtures)) got[f.kind] = (got[f.kind] ?? 0) + 1;
  const asked: Record<string, number> = {
    bench: g.benches + perimeterBenches, lamp: g.lamps, table: g.tables, tree: g.trees,
    playground: playAt ? g.playgrounds : 0, shop: shopB ? 1 : 0,
    school: schoolB ? 1 : 0, bus_stop: stopAt ? 1 : 0,
  };
  const short = Object.entries(asked).filter(([k, v]) => (got[k] ?? 0) !== v);
  if (short.length) {
    throw new RangeError(
      `the recipe asks for more than this plan can hold: ` +
        `${short.map(([k, v]) => `${k}: (${v}, ${got[k] ?? 0})`).join(", ")} (asked, placed) — ` +
        `widen the plan or lower the recipe`,
    );
  }

  checkReach(st, cells, buildings);
  checkOlder(st, buildings);

  st.cells = cells;

  // --- the first households
  st.households = {};
  st.residents = {};
  const units: number[] = [];
  for (const b of buildings) for (const u of b.units) if (st.units[String(u)]!.floor <= 4) units.push(u);
  rng.shuffle(units);
  const founding: string[] = [];
  for (const [kind, n] of Object.entries(g.founding)) for (let i = 0; i < n; i++) founding.push(kind);
  rng.shuffle(founding);
  for (const kind of founding) {
    if (!units.length) break;
    moveIn(st, kind, st.units[String(units.pop())]!, rng);
  }
  for (let i = 0; i < g.waiting; i++) st.waiting.push({ kind: rng.choice(R.pop.roster) });

  for (const b of buildings) rng.shuffle(b.units);

  st.day = 1;
  return st;
}

/** Can a walker get from one passable cell to another within `limit` steps? */
export function reachable(cells: W.Cell[][], start: P, goal: P, limit: number): boolean {
  if (start[0] === goal[0] && start[1] === goal[1]) return true;
  const seen = new Set<string>([key(start[0], start[1])]);
  let frontier: P[] = [start];
  for (let i = 0; i < limit; i++) {
    const nxt: P[] = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const px = x + dx;
        const py = y + dy;
        if (seen.has(key(px, py))) continue;
        if (!(0 <= px && px < cells[0]!.length && 0 <= py && py < cells.length)) continue;
        if (px === goal[0] && py === goal[1]) return true;
        if (walkOf(cells[py]![px]!.site) === null) continue;
        seen.add(key(px, py));
        nxt.push([px, py]);
      }
    }
    frontier = nxt;
  }
  return false;
}

function checkReach(st: W.World, cells: W.Cell[][], buildings: W.Building[]): void {
  const scan = R.engine.scan!;
  const doors = buildings.map((b) => b.door);
  for (const [need, spec] of Object.entries(R.needs)) {
    if (spec.from === "noise") continue;
    const goals: P[] = Object.values(st.fixtures)
      .filter((f) => R.fixtures[f.kind]!.affords[need])
      .map((f) => [f.x, f.y]);
    if (!goals.length) {
      throw new RangeError(
        `this plan places nothing that affords '${need}' — the need is in the law and nothing in ` +
          `the estate can meet it`,
      );
    }
    for (const d of doors) {
      if (!goals.some((gl) => reachable(cells, d, gl, scan))) {
        throw new RangeError(
          `the door at (${d[0]}, ${d[1]}) cannot reach anywhere affording '${need}' within ${scan} ` +
            `steps — nobody in that building can meet it, whatever they choose`,
        );
      }
    }
  }
}

function checkOlder(st: W.World, buildings: W.Building[]): void {
  const f = R.families;
  if (!f) return;
  const doors = buildings.map((b) => b.door);
  for (const kind of f.older_places) {
    const spots = Object.values(st.fixtures).filter((x) => x.kind === kind).map((x) => [x.x, x.y] as P);
    if (!spots.length) continue;
    for (const d of doors) {
      const near = Math.min(...spots.map(([x, y]) => Math.abs(x - d[0]) + Math.abs(y - d[1])));
      if (near > f.older_range) {
        throw new RangeError(
          `the door at (${d[0]}, ${d[1]}) is ${near} cells from the nearest ${kind}, past ` +
            `families.older_range (${f.older_range}) — the 10-15s there could never go to one`,
        );
      }
    }
  }
}
