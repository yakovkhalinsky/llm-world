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
import unittest

from estate import web


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
