"""The startup line names the port the server is on, tunnel included."""

import unittest

from grove import web


class HintTest(unittest.TestCase):
    def test_the_hint_uses_the_real_port(self):
        for host in ("127.0.0.1", "0.0.0.0"):
            with self.subTest(host=host):
                line = web._ip_hint(host).format(8789)
                self.assertNotIn("8787", line)
                if "undetectable" not in line:
                    self.assertIn("ssh -L 8789:localhost:8789", line)
                    self.assertIn(":8789", line.split("ssh")[0])


if __name__ == "__main__":
    unittest.main()
