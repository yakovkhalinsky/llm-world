/** Python's str.strip() with no argument: the characters str.isspace()
 * accepts, which are not JavaScript's trim() set (JS also strips U+FEFF;
 * Python also strips U+001C–U+001F and U+0085). */
const WS = "\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGES = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

export function pyStrip(s: string): string {
  return s.replace(EDGES, "");
}
