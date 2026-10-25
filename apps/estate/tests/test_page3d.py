"""The 3D view's static server: what it will serve, and what it will not.

`_page3d` is the one place the web server turns a URL path into a file, and
the 3D page is the only part of the site served from a directory rather
than from an in-memory string. These tests pin the boundary: plain,
encoded, double-encoded and NUL-bearing traversals all resolve to nothing,
a directory is not a file, and every response carries `nosniff`.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import io
import types
import unittest

from estate import gen, rules, web


class GroundWalkTest(unittest.TestCase):
    """The pages route on the plan, so the plan has to carry the pack's
    prices. A client that invented its own would be a second copy of a fact
    the engine owns — and the two would disagree the first time the pack was
    tuned."""

    def test_ground_ships_the_packs_walk_costs(self):
        world = gen.generate(42)
        g = web.ground(types.SimpleNamespace(world=world))
        self.assertEqual(
            g["walk"],
            {name: rules.R["sites"][name].get("walk")
             for name in g["codes"]})
        # the two facts the router needs most: a lawn is dearer than a path,
        # and a wall is not a step
        self.assertLess(g["walk"]["path"], g["walk"]["lawn"])
        self.assertIsNone(g["walk"]["building"])
        self.assertIsNone(g["walk"]["water"])


class WalkModuleTest(unittest.TestCase):
    """One router, two viewers: the plan page inlines it and the 3D page
    loads it from the same place."""

    def test_the_router_is_served(self):
        data = web._walk_bytes()
        self.assertIsInstance(data, bytes)
        self.assertIn(b"EstateWalk", data)
        self.assertIn(b"findPath", data)

    def test_the_plan_page_inlines_the_router(self):
        page = web._load_page()
        self.assertIn("root.EstateWalk", page)
        # and it is before the scene that reads it
        self.assertLess(page.index("root.EstateWalk"),
                        page.index("const Walk ="))


class Page3dTest(unittest.TestCase):
    def test_page_resolves(self):
        got = web._page3d("index.html")
        self.assertIsNotNone(got)
        data, ctype = got
        self.assertIsInstance(data, bytes)
        self.assertTrue(data)
        self.assertEqual(ctype, "text/html; charset=utf-8")

    def test_module_resolves(self):
        got = web._page3d("viewer.js")
        self.assertIsNotNone(got)
        data, ctype = got
        self.assertTrue(data)
        self.assertEqual(ctype, "application/javascript; charset=utf-8")

    def test_vendored_licence_resolves(self):
        got = web._page3d("vendor/LICENSE")
        self.assertIsNotNone(got)
        data, ctype = got
        self.assertTrue(data)
        self.assertEqual(ctype, "text/plain; charset=utf-8")

    def test_traversal_is_refused(self):
        """Every one of these is a 404, not a file outside `page3d/`."""
        paths = [
            "../web.py",
            "%2e%2e/web.py",
            "%2e%2e%2fweb.py",
            "..%2f..%2fREADME.md",
            "/etc/passwd",
            "//etc/passwd",
            "vendor/../../web.py",
            "vendor/",              # a directory, not a file
            "a%00b",                # a NUL in the path
            "%252e%252e/web.py",    # encoded once by the client, once by us
        ]
        for rel in paths:
            with self.subTest(rel=rel):
                self.assertIsNone(web._page3d(rel))


class _Handler:
    """Just enough of `BaseHTTPRequestHandler` to write a response."""

    def __init__(self):
        self.code = None
        self.headers = []
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.code = code

    def send_header(self, key, value):
        self.headers.append((key, value))

    def end_headers(self):
        pass


class ResponseHeaderTest(unittest.TestCase):
    def test_nosniff_on_a_static_response(self):
        h = _Handler()
        data, ctype = web._page3d("viewer.js")
        web._respond(h, 200, data, ctype)
        self.assertEqual(h.code, 200)
        self.assertIn(("X-Content-Type-Options", "nosniff"), h.headers)
        self.assertEqual(h.wfile.getvalue(), data)

    def test_nosniff_on_a_404(self):
        h = _Handler()
        web._respond(h, 404, "no such thing", "text/plain")
        self.assertEqual(h.code, 404)
        self.assertIn(("X-Content-Type-Options", "nosniff"), h.headers)


if __name__ == "__main__":
    unittest.main()
