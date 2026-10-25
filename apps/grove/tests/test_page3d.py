"""The 3D page's server: its routes, the files it serves from two folders
and from nowhere else, the headers on every response, the steward's POSTs,
and the light field the page paints the mushrooms' glow from.

Run from `apps/grove` (the package's `operator.py` shadows the stdlib's,
so the folder must be the working directory):

    python3 -m unittest discover -s tests
"""

import http.client
import json
import os
import socket
import threading
import unittest
from http.server import ThreadingHTTPServer

from grove import web

from tests.helpers import make_grove


class StaticFilesTest(unittest.TestCase):
    def test_the_page_and_its_modules_resolve(self):
        for rel, ctype in (("index.html", "text/html; charset=utf-8"),
                           ("viewer.js",
                            "application/javascript; charset=utf-8"),
                           ("world.js",
                            "application/javascript; charset=utf-8"),
                           ("hud.js",
                            "application/javascript; charset=utf-8"),
                           ("forest.js",
                            "application/javascript; charset=utf-8"),
                           ("glow.js",
                            "application/javascript; charset=utf-8"),
                           ("style.css", "text/css; charset=utf-8")):
            with self.subTest(rel=rel):
                got = web._page3d(rel)
                self.assertIsNotNone(got)
                self.assertEqual(got[1], ctype)

    def test_shared_files_come_from_the_shared_folder(self):
        shared = os.path.realpath(web.SHARED3D)
        for rel in ("clock.js", "walk.js", "field.js",
                    "vendor/three.module.min.js", "vendor/OrbitControls.js"):
            with self.subTest(rel=rel):
                got = web._page3d(rel)
                self.assertIsNotNone(got)
                with open(os.path.join(shared, rel), "rb") as f:
                    self.assertEqual(got[0], f.read())
        # nothing of the grove's own shadows a shared file, at any depth
        # (a grove `vendor/three.module.min.js` would replace the engine)
        own = os.path.realpath(web.PAGE3D)
        for d, _dirs, files in os.walk(own):
            for name in files:
                rel = os.path.relpath(os.path.join(d, name), own)
                with self.subTest(own=rel):
                    self.assertFalse(
                        os.path.exists(os.path.join(shared, rel)))

    def test_the_page_loads_its_classic_scripts_before_the_module(self):
        page = web._page3d("index.html")[0].decode()
        at = page.index("/3d/viewer.js")
        for rel in ("walk.js", "clock.js", "field.js", "forest.js", "glow.js",
                    "hud.js"):
            with self.subTest(rel=rel):
                self.assertIn('src="/3d/' + rel + '"', page)
                self.assertLess(page.index("/3d/" + rel), at)
        self.assertIn('type="module"', page)

    def test_no_traversal_leaves_either_folder(self):
        for rel in ("../web.py", "..%2Fweb.py", "%2e%2e/web.py",
                    "../../grove/web.py", "/etc/passwd", "../../../README.md",
                    "vendor/../../page3d/../../web.py", "x\x00.js",
                    "%00", "../../shared/page3d/walk.js/.."):
            with self.subTest(rel=rel):
                self.assertIsNone(web._page3d(rel))
        # the shared folder's own lookup is confined the same way
        self.assertIsNone(web._static_under(web.SHARED3D, "../../grove/README.md"))
        self.assertIsNone(web._static_under(web.PAGE3D, "../web.py"))

    def test_only_known_types_are_served(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("a.svg", "b.bin", "c", "LICENSE", "d.js"):
                with open(os.path.join(tmp, name), "w") as f:
                    f.write("<svg onload=alert(1)>")
            self.assertIsNone(web._static_under(tmp, "a.svg"))
            self.assertIsNone(web._static_under(tmp, "b.bin"))
            self.assertIsNone(web._static_under(tmp, "c"))
            self.assertEqual(web._static_under(tmp, "LICENSE")[1],
                             "text/plain; charset=utf-8")
            self.assertEqual(web._static_under(tmp, "d.js")[1],
                             "application/javascript; charset=utf-8")
        self.assertNotIn(".svg", web._STATIC_TYPES)

    def test_the_old_page_is_gone(self):
        here = os.path.dirname(web.__file__)
        self.assertFalse(os.path.exists(os.path.join(here, "page")))
        self.assertIsNone(web._page3d("pixi.min.js"))


class GlowFieldTest(unittest.TestCase):
    def _world(self, size, mush):
        cells = [[{"mushroom": 1 if (x, y) in mush else 0}
                  for x in range(size)] for y in range(size)]
        return {"size": size, "cells": cells}

    def test_no_mushrooms_no_light(self):
        self.assertEqual(web.glow_field(self._world(5, set())), [0] * 25)

    def test_brightest_on_the_mushroom_and_fading(self):
        f = web.glow_field(self._world(7, {(3, 3)}))
        self.assertEqual(f[3 * 7 + 3], web.GLOW_STEPS)
        self.assertGreater(f[3 * 7 + 3], f[3 * 7 + 4])
        self.assertGreater(f[3 * 7 + 4], f[3 * 7 + 5])
        self.assertEqual(f[0], 0)            # beyond the reach
        self.assertTrue(all(0 <= v <= web.GLOW_STEPS for v in f))

    def test_two_mushrooms_take_the_brighter_not_the_sum(self):
        f = web.glow_field(self._world(5, {(1, 2), (3, 2)}))
        self.assertEqual(f[2 * 5 + 2], max(
            web.glow_field(self._world(5, {(1, 2)}))[2 * 5 + 2],
            web.glow_field(self._world(5, {(3, 2)}))[2 * 5 + 2]))

    def test_it_writes_nothing(self):
        w = self._world(4, {(0, 0)})
        before = json.dumps(w, sort_keys=True)
        web.glow_field(w)
        self.assertEqual(json.dumps(w, sort_keys=True), before)


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp, cls.data, cls.g, cls.lock, cls.runner = make_grove(42, 3)
        handler = web.make_handler(cls.g, cls.lock, cls.runner, cls.data)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.g.db.con.close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def raw(self, line):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        s.sendall(line)
        out = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            out += chunk
        s.close()
        return out

    def test_the_page_serves_at_the_root_and_the_3d_alias(self):
        bodies = []
        for path in ("/", "/3d", "/3d/"):
            with self.subTest(path=path):
                r, body = self.request("GET", path)
                self.assertEqual(r.status, 200)
                self.assertEqual(r.getheader("Content-Type"),
                                 "text/html; charset=utf-8")
                bodies.append(body)
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[0], bodies[2])

    def test_modules_are_served_as_javascript(self):
        for path in ("/3d/viewer.js", "/3d/world.js", "/3d/walk.js",
                     "/3d/field.js", "/3d/vendor/three.module.min.js"):
            with self.subTest(path=path):
                r, body = self.request("GET", path)
                self.assertEqual(r.status, 200)
                self.assertEqual(r.getheader("Content-Type"),
                                 "application/javascript; charset=utf-8")
                self.assertTrue(body)

    def test_the_old_routes_are_gone(self):
        for path in ("/pixi.js", "/walk.js", "/3d/../web.py",
                     "/3d/%2e%2e/web.py", "/3d/..%2Fweb.py"):
            with self.subTest(path=path):
                r, _ = self.request("GET", path)
                self.assertEqual(r.status, 404)

    def test_traversal_over_the_wire_is_refused(self):
        for target in (b"/3d/../web.py", b"/3d/%2e%2e/web.py",
                       b"/3d/..%2f..%2fshared/page3d/walk.js/../../../grove/grove/web.py"):
            with self.subTest(target=target):
                out = self.raw(b"GET " + target + b" HTTP/1.0\r\n\r\n")
                self.assertTrue(out.startswith(b"HTTP/1.0 404"), out[:80])
                self.assertNotIn(b"def make_handler", out)

    def test_every_response_carries_nosniff(self):
        cases = [("GET", "/", 200), ("GET", "/3d/world.js", 200),
                 ("GET", "/api/state", 200), ("GET", "/api/plain", 200),
                 ("GET", "/api/bio?id=1", 200), ("GET", "/api/tuning", 200),
                 ("GET", "/nope", 404), ("GET", "/3d/nope.js", 404),
                 ("POST", "/nope", 404), ("POST", "/api/pause", 403),
                 ("PUT", "/", 501), ("OPTIONS", "/api/pause", 501),
                 ("DELETE", "/", 501), ("HEAD", "/", 200)]
        for method, path, code in cases:
            with self.subTest(method=method, path=path):
                r, _ = self.request(method, path)
                self.assertEqual(r.status, code)
                self.assertEqual(r.getheader("X-Content-Type-Options"),
                                 "nosniff")
                # once, not twice: a doubled header is a header some
                # clients refuse
                self.assertEqual(len(r.msg.get_all(
                    "X-Content-Type-Options")), 1)

    def test_a_malformed_request_line_still_carries_nosniff(self):
        out = self.raw(b"GARBAGE\r\n\r\n")
        head = out.split(b"\r\n\r\n", 1)[0]
        self.assertTrue(head.startswith(b"HTTP/1.0 400"), head[:80])
        self.assertIn(b"X-Content-Type-Options: nosniff", head)

    def test_no_response_is_cached(self):
        for method, path in (("GET", "/"), ("GET", "/3d/world.js"),
                             ("GET", "/api/state"), ("GET", "/nope"),
                             ("PUT", "/"), ("OPTIONS", "/")):
            with self.subTest(method=method, path=path):
                r, _ = self.request(method, path)
                self.assertEqual(r.msg.get_all("Cache-Control"),
                                 ["no-store"])
        out = self.raw(b"GARBAGE\r\n\r\n")
        self.assertIn(b"Cache-Control: no-store",
                      out.split(b"\r\n\r\n", 1)[0])

    def test_head_is_get_without_the_body(self):
        for path in ("/", "/3d/world.js", "/nope"):
            with self.subTest(path=path):
                g, gbody = self.request("GET", path)
                h, hbody = self.request("HEAD", path)
                self.assertEqual(h.status, g.status)
                self.assertEqual(hbody, b"")
                self.assertEqual(h.getheader("Content-Length"),
                                 str(len(gbody)))
                self.assertEqual(h.getheader("Content-Type"),
                                 g.getheader("Content-Type"))

    def test_the_state_carries_what_the_page_draws(self):
        r, body = self.request("GET", "/api/state")
        st = json.loads(body)
        n = st["size"]
        self.assertEqual(len(st["cells"]), n * n)
        self.assertEqual(len(st["glow"]), n * n)
        self.assertTrue(all(0 <= v <= web.GLOW_STEPS for v in st["glow"]))
        for k in ("seasons", "bodies", "shapes", "kinds", "flyers"):
            self.assertIn(k, st["biome"])
        self.assertEqual(st["biome"]["flyers"], ["robin"])
        for a in st["animals"]:
            for k in ("id", "sp", "x", "y", "px", "py"):
                self.assertIn(k, a)
        # the glow is the field of the world's own mushrooms
        self.assertEqual(st["glow"], web.glow_field(self.g.world))

    def test_the_plain_fallback_is_text(self):
        r, body = self.request("GET", "/api/plain")
        self.assertEqual(r.getheader("Content-Type"),
                         "text/plain; charset=utf-8")
        self.assertTrue(body.strip())


if __name__ == "__main__":
    unittest.main()
