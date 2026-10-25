"""The one POST, `/api/control`: pause, step and pace from the page only.

The same guard as the grove's buttons (`estate/webguard.py`, kept
byte-identical to `grove/webguard.py`): this host, this origin, a JSON body
of a declared and bounded length, and each field of its one type.

    python3 -m unittest tests.test_control
"""

import json
import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from estate import web, webguard


class FakeRunner:
    def __init__(self):
        self.paused = False
        self.step_once = 0
        self.tick_seconds = 5.0

    def state(self):
        return (self.paused, self.step_once, self.tick_seconds)


class ControlTest(unittest.TestCase):
    hosts = None

    def setUp(self):
        self.runner = FakeRunner()
        handler = web.make_handler(None, threading.Lock(), self.runner,
                                   hosts=self.hosts)
        handler.timeout = 1
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.host = "127.0.0.1:%d" % self.port
        threading.Thread(target=self.httpd.serve_forever,
                         daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def post(self, body=b"{}", ctype="application/json", host=None,
             origin=None, extra=(), length=None, path="/api/control"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        hs = ["POST %s HTTP/1.0" % path,
              "Host: %s" % (self.host if host is None else host)]
        if ctype is not None:
            hs.append("Content-Type: " + ctype)
        if origin is not None:
            hs.append("Origin: " + origin)
        if length != "omit":
            hs.append("Content-Length: %s" %
                      (len(body) if length is None else length))
        hs.extend(extra)
        s = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        s.sendall(("\r\n".join(hs) + "\r\n\r\n").encode() + body)
        out = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            out += chunk
        s.close()
        head, _, rest = out.partition(b"\r\n\r\n")
        self.assertIn(b"X-Content-Type-Options: nosniff", head)
        return int(head.split()[1]), rest

    def test_the_pages_own_requests_work(self):
        code, out = self.post({"paused": True},
                              origin="http://" + self.host,
                              extra=("Sec-Fetch-Site: same-origin",))
        self.assertEqual((code, json.loads(out)), (200, {"ok": True}))
        self.assertTrue(self.runner.paused)
        self.assertEqual(self.post({"paused": False})[0], 200)
        self.assertEqual(self.post({"step": 1})[0], 200)
        self.assertEqual(self.runner.state(), (True, 1, 5.0))
        self.assertEqual(self.post({"tick_seconds": 60})[0], 200)
        self.assertEqual(self.runner.tick_seconds, 60.0)
        self.assertEqual(self.post({"tick_seconds": 0.01})[0], 200)
        self.assertEqual(self.runner.tick_seconds, 0.2)
        self.assertEqual(self.post({"tick_seconds": 1e9})[0], 200)
        self.assertEqual(self.runner.tick_seconds, 86400.0)

    def test_fields_of_the_wrong_type_change_nothing(self):
        before = self.runner.state()
        for body in (b'{"paused":1}', b'{"paused":"no"}', b'{"step":true}',
                     b'{"step":1.0}', b'{"step":0}', b'{"step":-5}',
                     b'{"step":101}', b'{"step":1e400}', b'{"step":"1"}',
                     b'{"tick_seconds":NaN}', b'{"tick_seconds":Infinity}',
                     b'{"tick_seconds":1e400}', b'{"tick_seconds":"5"}',
                     b'{"tick_seconds":true}', b'{"paused":true,"step":0}',
                     b'{"bogus":1}', b"[1]", b'"x"', b"nope", b"null"):
            with self.subTest(body=body):
                self.assertEqual(self.post(body)[0], 400)
        self.assertEqual(self.runner.state(), before)

    def test_lengths_that_lie(self):
        good = b'{"paused":true}'
        for length, code in (("omit", 411), ("-1", 400), ("abc", 400),
                             ("5000", 413), ("40", 400)):
            with self.subTest(length=length):
                t0 = time.time()
                self.assertEqual(self.post(good, length=length)[0], code)
                self.assertLess(time.time() - t0, 5)
        self.assertFalse(self.runner.paused)

    def test_other_paths_are_404(self):
        self.assertEqual(self.post(path="/api/nope")[0], 404)

    def refused(self, **kw):
        before = self.runner.state()
        for body in ({"paused": True}, {"step": 3}, {"tick_seconds": 0.2}):
            with self.subTest(body=body, **{k: str(v) for k, v in kw.items()}):
                self.assertEqual(self.post(body, **kw)[0], 403)
        self.assertEqual(self.runner.state(), before)

    def test_a_plain_text_body_is_refused(self):
        self.refused(ctype="text/plain")

    def test_a_form_body_is_refused(self):
        self.refused(ctype="application/x-www-form-urlencoded")

    def test_a_missing_content_type_is_refused(self):
        self.refused(ctype=None)

    def test_a_foreign_origin_is_refused(self):
        self.refused(origin="https://evil.example")

    def test_a_null_origin_is_refused(self):
        self.refused(origin="null")

    def test_a_cross_site_fetch_is_refused(self):
        self.refused(extra=("Sec-Fetch-Site: cross-site",))

    def test_a_foreign_host_is_refused(self):
        self.refused(host="evil.example:%d" % self.port)
        self.refused(host="evil.example:%d" % self.port,
                     origin="http://evil.example:%d" % self.port)

    def test_two_hosts_are_refused(self):
        self.refused(extra=("Host: evil.example",))

    def test_the_tailnet_name_is_refused_when_not_public(self):
        self.refused(host="station.tail8a1a2.ts.net:%d" % self.port)


class PublicControlTest(ControlTest):
    def setUp(self):
        self.hosts = set()
        super().setUp()
        self.hosts |= webguard.allowed_hosts("0.0.0.0", self.port, True,
                                             lookup=False)

    def test_the_tailnet_name_is_refused_when_not_public(self):
        name = "station.tail8a1a2.ts.net:%d" % self.port
        code, _ = self.post({"paused": True}, host=name,
                            origin="http://" + name)
        self.assertEqual(code, 200)
        self.assertTrue(self.runner.paused)


if __name__ == "__main__":
    unittest.main()
