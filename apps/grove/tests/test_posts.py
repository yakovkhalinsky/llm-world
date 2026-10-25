"""The POSTs: everything that changes the world from the page.

Each one must come from the page — its own host, its own origin, a JSON
body of a declared and bounded length — and the steward's two buttons must
do what they say to the proposal they name, and nothing to any other:

    python3 -m unittest tests.test_posts
"""

import copy
import json
import os
import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from grove import reviewer, rules, web, webguard

from tests.helpers import make_grove

POSTS = ("/api/pause", "/api/step", "/api/soul", "/api/ask",
         "/api/tuning/accept", "/api/tuning/dismiss")


class PostServer(unittest.TestCase):
    """A fresh grove and server per test, and the rules as they were."""

    hosts = None

    def setUp(self):
        self.rules_before = copy.deepcopy(rules.R)
        self.tmp, self.data, self.g, self.lock, self.runner = make_grove(42)
        handler = web.make_handler(self.g, self.lock, self.runner, self.data,
                                   hosts=self.hosts)
        handler.timeout = 1        # a short wait for the lying lengths
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever,
                         daemon=True).start()
        self.host = "127.0.0.1:%d" % self.port

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.g.db.con.close()
        self.tmp.cleanup()
        rules.R.clear()
        rules.R.update(self.rules_before)

    # ------------------------------------------------------------ helpers
    def raw(self, data, wait=10):
        """Send bytes as they are; the status code and the parsed body."""
        s = socket.create_connection(("127.0.0.1", self.port), timeout=wait)
        s.sendall(data)
        out = b""
        try:
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                out += chunk
        finally:
            s.close()
        head, _, body = out.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        self.assertTrue(lines[0].startswith(b"HTTP/1."), out[:120])
        code = int(lines[0].split()[1])
        headers = {}
        for ln in lines[1:]:
            k, _, v = ln.partition(b":")
            headers.setdefault(k.strip().lower().decode(), []).append(
                v.strip().decode())
        self.assertEqual(headers.get("x-content-type-options"), ["nosniff"])
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = body
        return code, parsed

    def post(self, path, body=b"{}", ctype="application/json", host=None,
             origin=None, extra=(), length=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
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
        return self.raw(("\r\n".join(hs) + "\r\n\r\n").encode() + body)

    def offer(self, rule="animals.fox.cap", value=9.0, status="offered"):
        with self.lock:
            self.g.db.add_amendment(1, status, rule, value, "a test", "",
                                    was=6)
            return self.g.db.con.execute(
                "SELECT max(id) FROM proposals").fetchone()[0]

    def status_of(self, pid):
        with self.lock:
            return self.g.db.con.execute(
                "SELECT status FROM proposals WHERE id=?",
                (pid,)).fetchone()[0]

    def override(self):
        path = self.g.db.override_path(self.data)
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)


class StewardTest(PostServer):
    def test_accept_applies_the_rule_and_writes_it_down(self):
        pid = self.offer(value=9.0)
        self.assertIsNone(self.override())
        code, out = self.post("/api/tuning/accept", {"id": pid})
        self.assertEqual(code, 200, out)
        self.assertEqual(out, {"ok": True, "rule": "animals.fox.cap",
                               "value": 9.0})
        self.assertEqual(rules.R["animals"]["fox"]["cap"], 9.0)
        self.assertEqual(self.status_of(pid), "applied")
        saved = self.override()
        self.assertIsNotNone(saved)
        self.assertEqual(saved["animals"]["fox"]["cap"], 9.0)

    def test_a_handled_proposal_is_a_conflict_and_stays_handled(self):
        pid = self.offer()
        self.assertEqual(self.post("/api/tuning/accept", {"id": pid})[0], 200)
        # accepted twice, or dismissed after: 409, and still applied
        self.assertEqual(self.post("/api/tuning/accept", {"id": pid})[0], 409)
        self.assertEqual(self.post("/api/tuning/dismiss", {"id": pid})[0],
                         409)
        self.assertEqual(self.status_of(pid), "applied")
        other = self.offer(rule="animals.deer.cap", value=7.0)
        self.assertEqual(self.post("/api/tuning/dismiss", {"id": other})[0],
                         200)
        self.assertEqual(self.status_of(other), "dismissed")
        self.assertEqual(self.post("/api/tuning/dismiss", {"id": other})[0],
                         409)
        self.assertEqual(self.post("/api/tuning/accept", {"id": other})[0],
                         409)
        self.assertEqual(self.status_of(other), "dismissed")
        self.assertNotEqual(rules.R["animals"]["deer"]["cap"], 7.0)
        for status in ("expired", "applied", "dismissed"):
            pid = self.offer(status=status)
            with self.subTest(status=status):
                code, out = self.post("/api/tuning/accept", {"id": pid})
                self.assertEqual(code, 409)
                self.assertEqual(out, {"error": "already " + status})

    def test_dismiss_leaves_the_rules_alone(self):
        before = copy.deepcopy(rules.R)
        pid = self.offer()
        self.assertEqual(self.post("/api/tuning/dismiss", {"id": pid}),
                         (200, {"ok": True}))
        self.assertEqual(rules.R, before)
        self.assertIsNone(self.override())

    def test_the_reviewer_will_not_relabel_an_applied_amendment(self):
        pid = self.offer(status="applied")
        self.assertFalse(reviewer.dismiss(self.g.db, pid))
        self.assertEqual(self.status_of(pid), "applied")

    def test_unknown_ids_are_not_found(self):
        self.offer()
        for pid in (999, 2 ** 62):
            for path in ("/api/tuning/accept", "/api/tuning/dismiss"):
                with self.subTest(path=path, pid=pid):
                    self.assertEqual(self.post(path, {"id": pid}),
                                     (404, {"error": "no such proposal"}))

    def test_bodies_that_are_not_an_id(self):
        pid = self.offer()
        before = copy.deepcopy(rules.R)
        for body in (b"[1]", b'"x"', b"1", b"null", b"nope",
                     b'{"id":1e400}', b'{"id":true}', b'{"id":"%d"}' % pid,
                     b'{"id":%d.0}' % pid, b'{"id":-1}', b'{"id":0}',
                     b'{"id":NaN}', b'{"id":Infinity}', b'{"id":[1]}',
                     b'{"id":{"id":1}}', b'{"id":99999999999999999999999}',
                     b'{}', b'{"ID":1}', b"\xff\xfe", b"[" * 3000):
            for path in ("/api/tuning/accept", "/api/tuning/dismiss"):
                with self.subTest(path=path, body=body[:40]):
                    code, out = self.post(path, body)
                    self.assertEqual(code, 400, out)
                    self.assertIn("error", out)
        self.assertEqual(self.status_of(pid), "offered")
        self.assertEqual(rules.R, before)
        self.assertIsNone(self.override())

    def test_an_unlawful_row_is_not_applied(self):
        # rows the steward could never have recorded, put there by hand:
        # a whole species, an unknown path, a value that is not a number
        before = copy.deepcopy(rules.R)
        for rule, value in (("animals.rabbit", 1.0), ("animals.fox.nope", 3),
                            ("animals.fox.cap", None), ("weather", 2),
                            ("animals.*.cap", 9)):
            pid = self.offer(rule=rule, value=value)
            with self.subTest(rule=rule, value=value):
                code, out = self.post("/api/tuning/accept", {"id": pid})
                self.assertEqual(code, 409, out)
                self.assertEqual(self.status_of(pid), "offered")
        self.assertEqual(rules.R, before)
        self.assertIsNone(self.override())

    def test_an_out_of_bounds_value_is_clamped_as_at_record(self):
        pid = self.offer(value=500.0)
        code, out = self.post("/api/tuning/accept", {"id": pid})
        self.assertEqual(code, 200, out)
        self.assertEqual(rules.R["animals"]["fox"]["cap"], 60.0)


class LengthTest(PostServer):
    def test_lengths_that_lie(self):
        pid = self.offer()
        good = json.dumps({"id": pid}).encode()
        for length, code in (("omit", 411), ("-1", 400), ("abc", 400),
                             ("1e3", 400), ("+5", 400), (" ", 400),
                             ("5000", 413), ("99999999999999999999", 413),
                             (str(len(good) + 20), 400)):
            with self.subTest(length=length):
                t0 = time.time()
                got, out = self.post("/api/tuning/accept", good,
                                     length=length)
                self.assertEqual(got, code, out)
                self.assertLess(time.time() - t0, 5)
        self.assertEqual(self.status_of(pid), "offered")

    def test_two_lengths_are_refused(self):
        got, _ = self.post("/api/tuning/dismiss", b"{}",
                           extra=("Content-Length: 2",))
        self.assertEqual(got, 400)

    def test_a_body_over_the_limit_is_refused_before_it_is_read(self):
        body = b'{"q":"' + b"a" * webguard.BODY_LIMIT + b'"}'
        got, _ = self.post("/api/ask", body)
        self.assertEqual(got, 413)

    def test_ask_reads_only_what_it_was_told(self):
        for body, code in ((b'{"q":"hello"}', 200), (b'{"q":5}', 400),
                           (b'[]', 400), (b'{"q":', 400)):
            with self.subTest(body=body):
                got, out = self.post("/api/ask", body)
                self.assertEqual(got, code, out)
        got, out = self.post("/api/ask", b'{"q":"hello"}', length="40")
        self.assertEqual(got, 400)
        got, out = self.post("/api/ask", b'{"q":"hello"}', length="-1")
        self.assertEqual(got, 400)


class CrossSiteTest(PostServer):
    def refused(self, **kw):
        """Every POST, sent this way, is a 403 and changes nothing."""
        pid = self.offer()
        tick = self.g.world["tick"]
        self.runner.paused = True
        before = copy.deepcopy(rules.R)
        for path in POSTS:
            body = {"id": pid} if "tuning" in path else {"q": "hi"}
            with self.subTest(path=path, **{k: str(v) for k, v in kw.items()}):
                code, out = self.post(path, body, **kw)
                self.assertEqual(code, 403, out)
        self.assertEqual(self.status_of(pid), "offered")
        self.assertEqual(self.g.world["tick"], tick)
        self.assertTrue(self.runner.paused)
        self.assertEqual(rules.R, before)
        self.assertIsNone(self.override())

    def test_the_page_itself_is_answered(self):
        pid = self.offer()
        code, _ = self.post("/api/tuning/dismiss", {"id": pid},
                            origin="http://" + self.host,
                            ctype="application/json; charset=utf-8",
                            extra=("Sec-Fetch-Site: same-origin",))
        self.assertEqual(code, 200)
        self.runner.paused = True          # pause toggles
        self.assertEqual(self.post("/api/pause", host="localhost:%d"
                                   % self.port), (200, {"paused": False}))

    def test_a_plain_text_body_is_refused(self):
        self.refused(ctype="text/plain")

    def test_a_form_body_is_refused(self):
        self.refused(ctype="application/x-www-form-urlencoded")

    def test_a_missing_content_type_is_refused(self):
        self.refused(ctype=None)

    def test_a_json_lookalike_is_refused(self):
        self.refused(ctype="application/jsonx")

    def test_a_foreign_origin_is_refused(self):
        self.refused(origin="https://evil.example")

    def test_a_null_origin_is_refused(self):
        self.refused(origin="null")

    def test_an_origin_on_another_port_is_refused(self):
        self.refused(origin="http://127.0.0.1:1")

    def test_a_cross_site_fetch_is_refused(self):
        self.refused(extra=("Sec-Fetch-Site: cross-site",))

    def test_a_foreign_host_is_refused(self):
        # DNS rebinding: a hostile name resolved to this machine
        self.refused(host="evil.example:%d" % self.port)

    def test_a_foreign_host_with_a_matching_origin_is_refused(self):
        self.refused(host="evil.example:%d" % self.port,
                     origin="http://evil.example:%d" % self.port)

    def test_the_right_name_on_the_wrong_port_is_refused(self):
        self.refused(host="127.0.0.1:1")

    def test_no_host_is_refused(self):
        self.refused(host="")

    def test_two_hosts_are_refused(self):
        self.refused(extra=("Host: evil.example",))

    def test_the_tailnet_name_is_refused_when_not_public(self):
        self.refused(host="station.tail8a1a2.ts.net:%d" % self.port)


class PublicHostsTest(PostServer):
    """`--public`: the station's tailnet name is answered too."""

    def setUp(self):
        # the port is not known until the server binds, so the set is
        # filled in after (it is read on each request)
        self.hosts = set()
        super().setUp()
        self.hosts |= webguard.allowed_hosts("0.0.0.0", self.port, True,
                                             extra=("grove.lan",),
                                             lookup=False)

    def test_the_tailnet_name_is_answered(self):
        for host in ("station.tail8a1a2.ts.net:%d" % self.port,
                     "STATION.tail8a1a2.ts.net:%d" % self.port,
                     "grove.lan:%d" % self.port, self.host):
            with self.subTest(host=host):
                code, _ = self.post("/api/pause", host=host,
                                    origin="http://" + host)
                self.assertEqual(code, 200)
        code, _ = self.post("/api/pause",
                            host="station.tail8a1a2.ts.net:%d" % self.port,
                            origin="http://evil.example")
        self.assertEqual(code, 403)
        code, _ = self.post("/api/pause", host="evil.example:%d" % self.port)
        self.assertEqual(code, 403)


class AllowedHostsTest(unittest.TestCase):
    def test_loopback_only_unless_public(self):
        h = webguard.allowed_hosts("127.0.0.1", 8787, False)
        self.assertEqual(h, {"localhost:8787", "127.0.0.1:8787",
                             "[::1]:8787"})

    def test_public_adds_the_station_and_its_addresses(self):
        h = webguard.allowed_hosts("0.0.0.0", 8787, True, lookup=False)
        self.assertIn("station.tail8a1a2.ts.net:8787", h)
        self.assertNotIn("0.0.0.0:8787", h)
        real = webguard.allowed_hosts("0.0.0.0", 8787, True)
        self.assertTrue(h <= real)

    def test_port_80_answers_without_the_port(self):
        h = webguard.allowed_hosts("127.0.0.1", 80, False)
        self.assertIn("localhost", h)
        self.assertIn("localhost:80", h)

    def test_the_guard_is_the_estates_guard(self):
        here = os.path.dirname(webguard.__file__)
        other = os.path.join(here, "..", "..", "estate", "estate",
                             "webguard.py")
        with open(webguard.__file__, "rb") as a, open(other, "rb") as b:
            self.assertEqual(a.read(), b.read(),
                             "grove and estate webguard.py differ")


if __name__ == "__main__":
    unittest.main()
