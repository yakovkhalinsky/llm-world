"""`webguard.read_json` on its own, and the pin that keeps this app's
copy of the guard the same file as the estate's.

    python3 -m unittest tests.test_webguard
"""

import io
import os
import unittest
from email.message import Message

from grove import webguard


class FakeHandler:
    def __init__(self, body, length=None):
        self.headers = Message()
        self.headers["Content-Length"] = str(
            len(body) if length is None else length)
        self.rfile = io.BytesIO(body)


def refused(body, length=None):
    try:
        webguard.read_json(FakeHandler(body, length))
    except webguard.Refused as e:
        return e.code
    return None


class ReadJsonTest(unittest.TestCase):
    def test_an_object_is_read(self):
        self.assertEqual(webguard.read_json(FakeHandler(b'{"q":"hi"}')),
                         {"q": "hi"})
        self.assertEqual(webguard.read_json(FakeHandler(b"")), {})

    def test_the_constants_json_does_not_have_are_refused(self):
        for body in (b'{"q":NaN}', b'{"q":Infinity}', b'{"q":-Infinity}',
                     b'{"a":[1,NaN]}'):
            with self.subTest(body=body):
                self.assertEqual(refused(body), 400)

    def test_a_body_shorter_than_its_length_is_refused(self):
        # the client closed early: the read comes back short, not blocked
        self.assertEqual(refused(b'{"q":"hi"}', length=40), 400)
        self.assertEqual(refused(b"", length=2), 400)


class PinTest(unittest.TestCase):
    def test_the_guard_is_the_estates_guard(self):
        here = os.path.dirname(os.path.abspath(webguard.__file__))
        theirs = os.path.join(here, "..", "..", "estate", "estate",
                              "webguard.py")
        with open(webguard.__file__, "rb") as a, open(theirs, "rb") as b:
            self.assertEqual(a.read(), b.read(),
                             "grove and estate webguard.py differ")


if __name__ == "__main__":
    unittest.main()
