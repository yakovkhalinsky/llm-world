/**
 * The live ruleset — apps/estate's `rules.R`, base merged with the estate
 * pack, exported by `apps/estate/tools/export_rules.py` into rules.json.
 *
 * One home per fact (class 2): the port never writes a rule value of its
 * own. `npm run rules` regenerates the file, and the parity test fails if
 * the committed copy has drifted from what the Python engine reads.
 *
 * Tables keep the order they were written in (the engine iterates the
 * needs, the fixtures and the roster in that order). Numeric-string keys —
 * the seasonal tables, "0".."3" — are written ascending, which is the order
 * a JS object iterates them in anyway.
 */
import rulesJson from "./rules.json";

export type Pair = [number, number];

export interface Site { walk: number | null; noise: number; glyph: string }
export interface Need {
  urge: number; rate: number; glyph: string;
  phases?: Record<string, number>; weekend?: number; home?: boolean;
  roles?: string[]; from?: string;
}
export interface FixtureSpec {
  affords: Record<string, number>; capacity?: number; hard_capacity?: boolean;
  decay: number; loud?: number; carry?: number; light?: number;
  perimeter_bonus?: Record<string, number>; upkeep?: number; break_prob?: number;
  stock?: number; supplied?: boolean; storm_fall?: number; living?: boolean; glyph: string;
}
export interface HouseholdSpec {
  members: Pair; children: Pair; drains: Record<string, number>;
  mobility?: number; glyph: string;
}
export interface FateSpec {
  days: Pair; glyph: string; why: string; weather?: string; stock?: boolean;
  walk_mult?: number; stair_mult?: number; noise_mult?: number; damage?: number;
  regions?: string[];
}
export interface Region { x?: Pair; y?: Pair }

export interface Rules {
  world: { width: number; height: number; days_per_season: number; phases: string[] };
  sites: Record<string, Site>;
  needs: Record<string, Need>;
  fixtures: Record<string, FixtureSpec>;
  households: Record<string, HouseholdSpec>;
  people: { ages: { adult: number; elder: number } };
  gen: {
    layout?: string; blocks: number; block_floors: Pair; units_per_floor: Pair;
    block_gap: number; road_width: number; playgrounds: number; benches: number;
    perimeter_path?: boolean; perimeter_benches?: number; tables: number; trees: number;
    lamps: number; shop: boolean; pond: boolean; school?: boolean; bus_stop?: boolean;
    founding: Record<string, number>; waiting: number;
    [k: string]: unknown;
  };
  presentation: {
    world_word: string; seasons: string[]; weekdays: string[];
    season_lines: Record<string, string>; resident_names?: string[];
    edge_name: string; [k: string]: unknown;
  };
  pop: {
    roster: string[]; letting_after: number; waiting_size?: number; crowding: number;
    fill_to?: number; birth_prob?: number; death_prob?: number; unhappy_rise?: number;
    unhappy_decay?: number; emigrate_at?: number; move_away_prob?: number;
  };
  weather: {
    outdoor: Record<string, number>; rain_prob: Record<string, number>;
    storm_prob: Record<string, number>; heat_prob: Record<string, number>;
    frost_week: number; soften: number;
  };
  gate: {
    seeds: number; years: number; residents_min: number; residents_max: number;
    occupancy_min: number; friction: Pair; distinct_min: number; use_min: number;
  };
  fates: Record<string, FateSpec>;
  regions: Record<string, Region>;
  engine: Record<string, number>;
  families: {
    young_under: number; guardian_from: number; near: number; older_places: string[];
    older_range: number; older_daytime: string[]; evening_range: number; home_by: string[];
  };
  school: {
    ages: Pair; days: number[]; run: string; hours: string[];
    meets: Record<string, number>; per_yard_cell: number;
  };
  work: {
    share: number; commute: string; shift: string[]; school_hours: string[];
    meets: Record<string, number>;
  };
  pacing: Record<string, unknown>;
  bounds: Record<string, unknown>;
}

export const R = rulesJson as unknown as Rules;

/** rules.intkey: the seasonal tables come keyed by strings. */
export function intkey<V>(d: Record<string, V> | undefined | null): Map<number, V> {
  const out = new Map<number, V>();
  for (const [k, v] of Object.entries(d ?? {})) out.set(parseInt(k, 10), v);
  return out;
}
