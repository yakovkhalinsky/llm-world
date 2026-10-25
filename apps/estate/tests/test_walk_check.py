"""The router's test, run where Node exists.

`tools/walk_check.js` is the committed check for `page3d/walk.js`. It needs
Node, which the Python test suite cannot assume, so this wrapper skips when
`node` is absent and otherwise plants a fresh seed-42 estate, writes the
same two payloads the server serves, and runs the check over them.

The payloads are built through the package's own `web.ground` and
`web.snapshot` rather than by starting a server: the objects they read are
the estate and a runner, not a socket, so no port is bound and nothing is
left running.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import json
import os
import shutil
import subprocess
import tempfile
import threading
import types
import unittest

from estate import gen, web

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "walk_check.js")


def _state_payload(world):
    """`/api/state` without a server or a background tick.

    `snapshot` reads the world and a runner's small cache of what the last
    poll saw; an empty cache is exactly a page's first poll.
    """
    est = types.SimpleNamespace(world=world)
    runner = types.SimpleNamespace(
        prev={}, events=[], daybooks={}, past_lines={}, past_news={},
        chronicle=[], paused=False, tick_seconds=60,
        last_watch={"fate": None, "region": None, "why": None, "day": None},
        llm=None)
    return web.snapshot(est, runner, threading.Lock())


@unittest.skipUnless(NODE, "node is not installed")
class WalkCheckTest(unittest.TestCase):
    def test_the_router_passes_its_check(self):
        world = gen.generate(42)
        ground = web.ground(types.SimpleNamespace(world=world))
        state = _state_payload(world)
        with tempfile.TemporaryDirectory() as tmp:
            gpath = os.path.join(tmp, "ground.json")
            spath = os.path.join(tmp, "state.json")
            with open(gpath, "w") as f:
                json.dump(ground, f)
            with open(spath, "w") as f:
                json.dump(state, f)
            run = subprocess.run(
                [NODE, CHECK, gpath, spath], cwd=ROOT,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=180)
        self.assertEqual(run.returncode, 0,
                         "walk_check failed:\n" + run.stdout)
        self.assertIn("all ok", run.stdout)

    def test_the_check_accepts_a_live_server(self):
        """The HTTP form reads the same two payloads from a socket.

        This pins the other input mode without binding a simulation: a
        tiny HTTP server serves the two JSON documents `walk_check.js`
        asks for, so the check's own fetch path is exercised.
        """
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        world = gen.generate(42)
        payloads = {
            "/api/ground": json.dumps(
                web.ground(types.SimpleNamespace(world=world))).encode(),
            "/api/state": json.dumps(_state_payload(world)).encode(),
        }

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):
                pass

            def do_GET(self):
                body = payloads.get(self.path)
                if body is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            url = "http://127.0.0.1:%d" % httpd.server_address[1]
            run = subprocess.run(
                [NODE, CHECK, url], cwd=ROOT,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=180)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)
        self.assertEqual(run.returncode, 0,
                         "walk_check (http) failed:\n" + run.stdout)
        self.assertIn("all ok", run.stdout)


if __name__ == "__main__":
    unittest.main()
