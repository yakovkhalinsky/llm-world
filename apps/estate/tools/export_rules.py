"""The live ruleset as JSON, for apps/estate-web.

The browser port reads the same rules the engine reads, and one home per
fact (class 2) means it must not keep its own copy by hand: this prints
`rules.R` — the base merged with the estate pack, exactly as the engine
sees it — and estate-web commits the output as src/sim/rules.json. Its
parity test runs this again and fails if the committed file has drifted.

Key order is kept, not sorted: the engine iterates its tables (the needs,
the fixtures, the roster) in the order they are written, and a port that
iterated them in another order would draw its numbers in another order.

  python3 tools/export_rules.py > ../estate-web/src/sim/rules.json

Read-only: it imports the rules and prints them, and changes nothing.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from estate import rules                                 # noqa: E402


def main():
    # no `default=`: a value JSON cannot carry is an error here, not a
    # string the port would silently read as something else
    sys.stdout.write(json.dumps(rules.R, indent=1, ensure_ascii=False))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
