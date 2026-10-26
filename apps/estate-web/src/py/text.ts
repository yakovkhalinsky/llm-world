/** Python's str.strip() with no argument: the characters str.isspace()
 * accepts, which are not JavaScript's trim() set (JS also strips U+FEFF;
 * Python also strips U+001C–U+001F and U+0085).
 *
 * A scan from each end, not a regex: `[ws]+$` retries from every
 * whitespace position and goes quadratic on a long run inside the text,
 * and this runs on a model's reply before it is cut to length. */
export function isPySpace(c: number): boolean {
  return (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000;
}

export function pyStrip(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && isPySpace(s.charCodeAt(i))) i++;
  while (j > i && isPySpace(s.charCodeAt(j - 1))) j--;
  return i === 0 && j === s.length ? s : s.slice(i, j);
}
