"""audit.py — the config audit.

Lists every key in the live ruleset that no reader module names. Grove
found sixteen dead knobs this way, and the method is the point: a setting
that exists, is settable, and does nothing is a lie told to whoever tunes
it.

  python3 tools/audit.py            # report, grouped by section
  python3 tools/audit.py --strict   # exit 1 if anything is unread

The definition file does not count as a reader of its own keys — an audit
that counted `rules.py` would always pass, which is the failure class it
exists to catch (Grove's b20: a gate that lied about what it checked).
"""

import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from estate import rules                                  # noqa: E402

# Never a reader: where the keys are defined, and where a pack ships them.
NOT_READERS = ("rules.py",)
NOT_READER_DIRS = ("biomes",)


def readers() -> str:
    blob = ""
    for p in (ROOT / "estate").rglob("*.py"):
        if p.name in NOT_READERS or any(d in p.parts for d in NOT_READER_DIRS):
            continue
        blob += p.read_text()
    for p in (ROOT / "tools").rglob("*.py"):
        if p.name == "audit.py":
            continue
        blob += p.read_text()
    return blob


def leaves(node, path=()):
    for k, v in node.items():
        if isinstance(v, dict) and v:
            yield from leaves(v, path + (str(k),))
        else:
            yield ".".join(path + (str(k),))


def unread():
    blob = readers()
    out = {}
    for path in leaves(rules.R):
        if path.split(".")[-1] not in blob:
            out.setdefault(path.split(".")[0], []).append(path)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args()
    dead = unread()
    total = sum(len(v) for v in dead.values())
    if not total:
        print("every rules key is named by a reader")
        return 0
    print(f"{total} keys are named by no reader yet:\n")
    for section, paths in sorted(dead.items()):
        print(f"  {section}  ({len(paths)})")
        for p in sorted(paths)[:6]:
            print(f"      {p}")
        if len(paths) > 6:
            print(f"      … and {len(paths) - 6} more")
    if a.strict:
        print("\nFAIL: a key nothing reads is a bug, not a hook for later")
        return 1
    print("\n(report only; --strict fails on any of these)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
