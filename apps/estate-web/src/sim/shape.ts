/**
 * Which numbers in the world are Python floats.
 *
 * The canonical hash can't see 0 vs 0.0, and JS can't hold the
 * difference, so a field that is a float in Python and an int here (or the
 * other way) would hash the same until arithmetic on it parted — sum()'s
 * int path, json.dumps, repr. This is the port's declaration, held to the
 * engine by tests/shape.test.ts against `parity.py shapes`: every path here
 * holds only floats in Python, every other numeric path only ints, and
 * no path holds both. (Ids and list indices read as `*`.)
 */
export const FLOAT_FIELDS: ReadonlySet<string> = new Set([
  "$.buildings.*.condition",
  "$.cells[*][*].light",
  "$.cells[*][*].noise",
  "$.cells[*][*].shade",
  "$.cells[*][*].wear",
  "$.daybook.noise",
  "$.fates[*].noise_mult",
  "$.fates[*].stair_mult",
  "$.fates[*].walk_mult",
  "$.fixtures.*.condition",
  "$.households.*.unhappy",
  "$.residents.*.mobility",
  "$.residents.*.needs.company",
  "$.residents.*.needs.food",
  "$.residents.*.needs.play",
  "$.residents.*.needs.quiet",
  "$.residents.*.needs.rest",
  "$.residents.*.stress",
  "$.units.*.condition",
  "$.units.*.quiet_base",
]);

/** The numeric JSON paths in `v`, ids and indices as `*`, into `out`. */
export function numericPaths(v: unknown, path = "$", out = new Set<string>()): Set<string> {
  if (typeof v === "number") out.add(path);
  else if (Array.isArray(v)) for (const x of v) numericPaths(x, `${path}[*]`, out);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      numericPaths(x, `${path}.${/^-?\d+$/.test(k) ? "*" : k}`, out);
    }
  }
  return out;
}

/** Is this path's number a Python float? */
export const isFloatField = (path: string): boolean => FLOAT_FIELDS.has(path);
