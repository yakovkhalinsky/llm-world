"""The 3D view's static server: what it will serve, and what it will not.

`_page3d` is the one place the web server turns a URL path into a file, and
the 3D page is the only part of the site served from a directory rather
than from an in-memory string. These tests pin the boundary: plain,
encoded, double-encoded and NUL-bearing traversals all resolve to nothing,
a directory is not a file, and every response carries `nosniff`.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import http.client
import io
import os
import socket
import threading
import types
import unittest
from http.server import ThreadingHTTPServer

from estate import gen, rules, web


class GroundWalkTest(unittest.TestCase):
    """The view routes on the plan, so the plan has to carry the pack's
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
    """The router lives beside the page and is served as its own script."""

    def test_the_router_is_served(self):
        got = web._page3d("walk.js")
        self.assertIsNotNone(got)
        data, ctype = got
        self.assertIn(b"EstateWalk", data)
        self.assertIn(b"findPath", data)
        self.assertEqual(ctype, "application/javascript; charset=utf-8")

    def test_the_page_loads_the_router_before_its_module(self):
        data, _ = web._page3d("index.html")
        page = data.decode()
        self.assertIn('src="/3d/walk.js"', page)
        # a classic script before the module: `EstateWalk` exists by the
        # time the deferred module runs
        self.assertLess(page.index("/3d/walk.js"),
                        page.index("/3d/viewer.js"))

    def test_the_page_loads_the_light_field_before_its_module(self):
        """The lamplight is painted by the shared `field.js`; the world
        throws without it, so it must load before the module runs."""
        page = web._page3d("index.html")[0].decode()
        self.assertIn('src="/3d/field.js"', page)
        self.assertLess(page.index("/3d/field.js"),
                        page.index("/3d/viewer.js"))


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

    def test_the_no_webgl_fallback_shows_the_glyph_map(self):
        """Without WebGL the page still has to show the estate. The server's
        glyph map at `/api/plain` is that view; there is no second page to
        link to any more."""
        page = web._page3d("index.html")[0].decode()
        viewer = web._page3d("viewer.js")[0].decode()
        self.assertIn('id="plain"', page)
        self.assertIn("/api/plain", viewer)
        self.assertNotIn("2D plan", page)
        self.assertNotIn('href="/"', page)

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
            "..\\web.py",           # a Windows separator, as a literal
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

    def test_shared_files_come_from_the_shared_folder(self):
        """The engine, the clock and the router live in apps/shared/page3d
        (the grove's 3D view reads the same files); they are still served
        under the estate's `/3d/`, and only from that folder."""
        shared = os.path.realpath(web.SHARED3D)
        for rel in ("clock.js", "walk.js", "field.js",
                    "vendor/three.module.min.js", "vendor/OrbitControls.js"):
            with self.subTest(rel=rel):
                got = web._page3d(rel)
                self.assertIsNotNone(got)
                with open(os.path.join(shared, rel), "rb") as f:
                    self.assertEqual(got[0], f.read())
        # nothing of the estate's own is duplicated in the shared folder
        for name in os.listdir(web.PAGE3D):
            with self.subTest(own=name):
                self.assertFalse(os.path.exists(os.path.join(shared, name)),
                                 name + " is in both folders")

    def test_traversal_out_of_the_shared_folder_is_refused(self):
        """The second root is confined like the first: its parent is the
        other apps, and none of them is reachable through it."""
        for rel in ("../../estate/estate/web.py",
                    "../../grove/grove/web.py",
                    "%2e%2e/%2e%2e/estate/estate/web.py",
                    "vendor/../../../estate/estate/web.py",
                    "../page3d/../../estate/estate/web.py"):
            with self.subTest(rel=rel):
                self.assertIsNone(web._page3d(rel))

    def test_symlinks_out_of_page3d_are_refused(self):
        """A link's *real* path is what must stay under page3d/, file or
        directory; `realpath` plus `commonpath` is what refuses both."""
        link_file = os.path.join(web.PAGE3D, ".test-link-file")
        link_dir = os.path.join(web.PAGE3D, ".test-link-dir")
        try:
            os.symlink(os.path.join(web.PAGE3D, "..", "web.py"), link_file)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not supported here")
        self.addCleanup(_unlink_quiet, link_file)
        try:
            os.symlink(os.path.dirname(web.PAGE3D), link_dir)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not supported here")
        self.addCleanup(_unlink_quiet, link_dir)
        self.assertIsNone(web._page3d(".test-link-file"))
        self.assertIsNone(web._page3d(".test-link-dir/web.py"))
        # the link itself resolves, so the refusal is about where it points
        self.assertEqual(os.path.realpath(os.path.join(
            web.PAGE3D, ".test-link-dir")),
            os.path.realpath(os.path.dirname(web.PAGE3D)))


def _unlink_quiet(path):
    try:
        os.unlink(path)
    except OSError:
        pass


class StartupTest(unittest.TestCase):
    """The page is files on disk, so a missing page has to stop the server
    when it starts, not wait to be a 404 on `/`."""

    def test_the_server_refuses_to_start_without_its_page(self):
        real = web._page3d
        web._page3d = lambda rel: None
        try:
            with self.assertRaises(SystemExit) as cm:
                web.cmd_web(types.SimpleNamespace())
        finally:
            web._page3d = real
        self.assertIn("index.html", str(cm.exception))


class _LiveServer:
    """A real `ThreadingHTTPServer` on port 0 with the page's own handler.

    The static tests above call `_page3d` directly; these go through
    `do_GET` and the stdlib's error paths, which is where the header and
    the traversal prefix strip actually run.
    """

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            web.make_handler(None, threading.Lock(), None))
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)

    def request(self, method, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path)
            resp = conn.getresponse()
            body = resp.read()
            return resp, body
        finally:
            conn.close()


class LiveTraversalTest(_LiveServer, unittest.TestCase):
    """The traversal boundary over the real HTTP path.

    `http.client` sends the path as given — no normalisation on the client
    side — so these are the bytes the server's `urlparse` and its `/3d/`
    prefix strip actually see.
    """

    def test_traversals_are_404(self):
        paths = [
            "/3d/../web.py",
            "/3d/%2e%2e/web.py",
            "/3d/..%5cweb.py",
            "/3d/%252e%252e/web.py",
            "//etc/passwd",
            "/3d/%2fetc%2fpasswd",
            "/3d/vendor/..%2f..%2fweb.py",
            "/3d/a%00b",
            "/3d/vendor",
        ]
        for path in paths:
            with self.subTest(path=path):
                resp, _ = self.request("GET", path)
                self.assertEqual(resp.status, 404, path)

    def test_the_real_page_still_serves(self):
        for path, ctype in (("/", "text/html; charset=utf-8"),
                            ("/3d", "text/html; charset=utf-8"),
                            ("/3d/", "text/html; charset=utf-8"),
                            ("/3d/viewer.js",
                             "application/javascript; charset=utf-8"),
                            ("/3d/walk.js",
                             "application/javascript; charset=utf-8")):
            with self.subTest(path=path):
                resp, body = self.request("GET", path)
                self.assertEqual(resp.status, 200, path)
                self.assertEqual(resp.getheader("Content-Type"), ctype)
                self.assertTrue(body)

    def test_the_root_and_the_3d_alias_serve_the_same_page(self):
        """`/` is the view's address; `/3d` is kept for old links and for
        screenshot URLs whose query string a redirect would drop."""
        _, root = self.request("GET", "/")
        _, alias = self.request("GET", "/3d?phase=night")
        self.assertEqual(root, alias)

    def test_the_plan_page_routes_are_gone(self):
        for path in ("/pixi.js", "/walk.js"):
            with self.subTest(path=path):
                resp, _ = self.request("GET", path)
                self.assertEqual(resp.status, 404, path)

    def test_a_backslash_symlink_through_http_is_404(self):
        link = os.path.join(web.PAGE3D, ".test-http-link")
        try:
            os.symlink(os.path.join(web.PAGE3D, "..", "web.py"), link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not supported here")
        self.addCleanup(_unlink_quiet, link)
        resp, _ = self.request("GET", "/3d/.test-http-link")
        self.assertEqual(resp.status, 404)


class ResponseHeaderLiveTest(_LiveServer, unittest.TestCase):
    """`nosniff` is on every response, including the stdlib's own errors.

    `BaseHTTPRequestHandler.send_error` writes the 501 for an unsupported
    method (PUT, HEAD) and the 400 for a malformed request line without
    passing through `_respond`, so the handler adds the header in
    `end_headers` and marks `_respond`'s own copy to avoid sending it twice.
    """

    def assert_nosniff_once(self, resp):
        values = resp.headers.get_all("X-Content-Type-Options") or []
        self.assertEqual(values, ["nosniff"],
                         "expected exactly one nosniff, got " + repr(values))

    def test_nosniff_on_200(self):
        resp, _ = self.request("GET", "/")
        self.assertEqual(resp.status, 200)
        self.assert_nosniff_once(resp)

    def test_nosniff_on_404(self):
        resp, _ = self.request("GET", "/nope")
        self.assertEqual(resp.status, 404)
        self.assert_nosniff_once(resp)

    def test_nosniff_on_501_for_put(self):
        resp, _ = self.request("PUT", "/api/control")
        self.assertEqual(resp.status, 501)
        self.assert_nosniff_once(resp)

    def test_nosniff_on_501_for_head(self):
        resp, _ = self.request("HEAD", "/")
        self.assertEqual(resp.status, 501)
        self.assert_nosniff_once(resp)

    def raw(self, line):
        """Send one request line as bytes and read the whole reply.

        `http.client` will not send a malformed request line, and the 400
        for one is the case that matters: until the handler's default
        version was HTTP/1.0, the stdlib answered it as HTTP/0.9 and
        `send_header` wrote no headers at all, nosniff included.
        """
        with socket.create_connection(("127.0.0.1", self.port),
                                      timeout=10) as s:
            s.sendall(line + b"\r\n\r\n")
            chunks = []
            while True:
                b = s.recv(65536)
                if not b:
                    break
                chunks.append(b)
        return b"".join(chunks)

    def test_nosniff_on_400_for_a_malformed_request_line(self):
        for line in (b"GARBAGE", b"GET / HTTP/1.x", b"GET / HTTP/9.9",
                     b"GET / NOTHTTP/1.1"):
            with self.subTest(line=line):
                reply = self.raw(line)
                head = reply.split(b"\r\n\r\n", 1)[0].decode("latin-1")
                status, *headers = head.split("\r\n")
                self.assertRegex(status, r"^HTTP/1\.[01] (400|505) ")
                values = [h.split(":", 1)[1].strip() for h in headers
                          if h.lower().startswith("x-content-type-options:")]
                self.assertEqual(values, ["nosniff"], repr(head))


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
