"""The card's ask: `/api/bio`, the request the page makes when a creature or
a plant is clicked. It must be answered — through the guard, with the
page's own request shape, on the loopback name and on the station's tailnet
name — and answered straight away from the world and the chronicle, never
waiting on a model, so a dead or absent LLM still fills the card:

    python3 -m unittest tests.test_card
"""

import json
import os
import socket
import time
import unittest

from grove import llm as llmm, webguard

from tests.test_posts import PostServer

NODE_SRC = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "grove", "page3d", "viewer.js")


def dead_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class CardServer(PostServer):
    def get(self, path, host=None, extra=()):
        """A GET shaped as the page's `fetch(url, {cache: 'no-store'})`:
        same-origin, so no Origin and no Content-Type, a Referer, and the
        browser's no-store headers."""
        host = self.host if host is None else host
        hs = ["GET %s HTTP/1.0" % path, "Host: %s" % host,
              "Accept: */*", "Referer: http://%s/" % host,
              "Cache-Control: no-cache", "Pragma: no-cache",
              "Sec-Fetch-Mode: cors", "Sec-Fetch-Site: same-origin"]
        hs.extend(extra)
        return self.raw(("\r\n".join(hs) + "\r\n\r\n").encode())

    def some(self, kind):
        with self.lock:
            return next(iter(self.g.world[kind].values()))


class CardTest(CardServer):
    def test_the_page_still_asks_with_a_get(self):
        # the page's own call; the server answers it on GET
        with open(NODE_SRC) as f:
            src = f.read()
        self.assertIn("fetch('/api/bio?id=' + encodeURIComponent(id)", src)
        self.assertNotIn("method: 'POST'", src[src.index("function askBio"):
                                               src.index("function select")])

    def test_a_creature_is_answered_with_its_facts(self):
        a = self.some("animals")
        code, b = self.get("/api/bio?id=%d" % a["id"])
        self.assertEqual(code, 200, b)
        self.assertEqual(b["kind"], "animal")
        self.assertEqual(b["sp"], a["sp"])
        self.assertTrue(b["alive"])
        self.assertEqual((b["x"], b["y"]), (a["x"], a["y"]))
        self.assertEqual(b["age"], round(a.get("age", 0)))
        self.assertEqual(b["hunger"], round(a["hunger"], 1))
        self.assertEqual(b["energy"], round(a["energy"], 1))
        self.assertIsInstance(b["events"], list)

    def test_a_plant_is_answered_with_its_stage(self):
        p = self.some("plants")
        code, b = self.get("/api/bio?id=%d" % p["id"])
        self.assertEqual(code, 200, b)
        self.assertEqual(b["kind"], "plant")
        self.assertEqual(b["stage"], p["stage"])

    def test_a_soul_that_is_gone_is_answered(self):
        code, b = self.get("/api/bio?id=987654321")
        self.assertEqual(code, 200, b)
        self.assertTrue(b["gone"])
        self.assertEqual(b["events"], [])

    def test_an_id_that_is_not_a_number_is_answered(self):
        code, b = self.get("/api/bio?id=%3Cx%3E")
        self.assertEqual(code, 200, b)
        self.assertTrue(b["gone"])

    def test_an_origin_header_does_not_block_it(self):
        # some browsers send Origin on a same-origin fetch too
        a = self.some("animals")
        code, b = self.get("/api/bio?id=%d" % a["id"],
                           extra=("Origin: http://%s" % self.host,))
        self.assertEqual(code, 200, b)


class CardPublicTest(CardServer):
    """`--public`, as station runs it: the tailnet name is answered."""

    def setUp(self):
        self.hosts = set()
        super().setUp()
        self.hosts |= webguard.allowed_hosts("0.0.0.0", self.port, True,
                                             lookup=False)

    def test_the_tailnet_name_is_answered(self):
        a = self.some("animals")
        code, b = self.get("/api/bio?id=%d" % a["id"],
                           host="station.tail8a1a2.ts.net:%d" % self.port)
        self.assertEqual(code, 200, b)
        self.assertEqual(b["id"], a["id"])


class NoModel:
    """A model that must never be asked: any use fails the test, and a
    call that slipped past would hang the request."""

    def __getattr__(self, name):
        time.sleep(30)
        raise AssertionError("the card asked the model for " + name)


class CardWithoutTheModelTest(CardServer):
    def assert_answered_fast(self):
        a = self.some("animals")
        t0 = time.monotonic()
        code, b = self.get("/api/bio?id=%d" % a["id"])
        took = time.monotonic() - t0
        self.assertEqual(code, 200, b)
        self.assertEqual(b["sp"], a["sp"])
        self.assertIn("hunger", b)
        self.assertLess(took, 2.0)

    def test_ollama_refusing_the_connection(self):
        # the live failure: "ollama unreachable … connection refused"
        dead = llmm.LLM(host="http://127.0.0.1:%d" % dead_port(),
                        timeout=1.0)
        self.assertFalse(dead.enabled)
        self.assertIn("unreachable", dead.reason)
        self.g.llm = dead
        self.assert_answered_fast()

    def test_the_card_never_waits_on_a_model(self):
        self.g.llm = NoModel()
        self.assert_answered_fast()

    def test_the_page_gives_up_on_a_slow_ledger(self):
        # the viewer's side: a timeout that aborts the ask, and a plain
        # line (not the spinner) when it fails
        with open(NODE_SRC) as f:
            src = f.read()
        body = src[src.index("function askBio"):src.index("function select")]
        self.assertIn("BIO_TIMEOUT_MS", body)
        self.assertIn("ctl.abort()", body)
        self.assertIn("state: 'fail'", body)
        self.assertIn("HUD.card(S.state, S.selected, S.ledger)", src)


if __name__ == "__main__":
    unittest.main()
