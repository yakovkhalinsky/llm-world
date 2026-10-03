"""Verify the served grove page headlessly.

Builds the page exactly as a browser receives it (the evaluated PAGE
string), snapshots real world state, and runs the stub-DOM node harness
through the page's true rAF loop.

  python3 tools/check_page.py          # uses ./grove_data, needs node
"""

import json
import pathlib
import subprocess
import sys
import threading
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from grove import web, llm as llmm          # noqa: E402
from grove.app import Grove                 # noqa: E402
from grove.web import snapshot, SimRunner   # noqa: E402

TMP = pathlib.Path("/tmp")
args = types.SimpleNamespace(
    data="./grove_data", model=llmm.DEFAULT_MODEL,
    host=llmm.DEFAULT_HOST, offline=True, cmd="web", tick_seconds=4)
g = Grove(args)
g.load_or_exit()
g.init_llm()
state = snapshot(g, SimRunner(g, threading.Lock(), 4), threading.Lock())
args.offline = False    # restore — llm presence doesn't matter for the page

html = web.PAGE   # exactly what a browser receives
assert 'join("\\n")' in html, "JS \\n escape got eaten by Python"
assert 'requestAnimationFrame(loop)' in html

(TMP / "grove_page.html").write_text(html)
(TMP / "grove_state.json").write_text(json.dumps(state))
print(f"page {len(html)} chars · state tick {state['tick']}, "
      f"{len(state['cells'])} cells, {len(state['plants'])} plants")

r = subprocess.run(["node", str(pathlib.Path(__file__).parent /
                                 "page_harness.js"),
                    str(TMP / "grove_page.html"),
                    str(TMP / "grove_state.json")],
                   capture_output=True, text=True)
print(r.stdout.strip())
if r.returncode != 0:
    sys.exit(f"harness failed:\n{r.stderr.strip()}")