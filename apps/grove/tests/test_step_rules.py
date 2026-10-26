"""grove step --narrate with decide=rules: the soul's choice is made in
code, so whether the model answers changes the words and never the world.

    python3 -m unittest tests.test_step_rules
"""

import contextlib
import io
import os
import socket
import tempfile
import unittest

from grove import __main__ as cli
from tests.test_models import FakeOllama, QWEN, GEMMA


def _dead_host():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()                        # nothing listens here now
    return "http://127.0.0.1:%d" % port


def _run(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        args = cli.build_parser().parse_args(list(argv))
        args.func(args)
    return out.getvalue()


class StepRulesTest(unittest.TestCase):

    def world_after(self, host, weeks=40):
        with tempfile.TemporaryDirectory() as d:
            lock = os.path.join(d, "model.lock")
            _run("--data", d, "new", "--seed", "42")
            _run("--data", d, "step", str(weeks), "--narrate",
                 "--tier", "local", "--host", host, "--model-lock", lock)
            return _run("--data", d, "map") + _run("--data", d, "status")

    def test_dead_and_live_models_reach_the_same_world(self):
        fake = FakeOllama(tags=[QWEN, GEMMA, "nomic-embed-text:latest"],
                          reply={"intent": "to hold the ridge",
                                 "destiny": "the ridge holds",
                                 "soul_line": "the grove leans east",
                                 "text": "a quiet week"})
        try:
            live = self.world_after(fake.host)
            self.assertTrue(fake.chats, "the live model was never asked")
        finally:
            fake.close()
        dead = self.world_after(_dead_host())
        self.assertEqual(live, dead)

    def test_rules_mode_acts_with_no_model(self):
        """The soul's op lands with a dead host — the world differs from
        a run where nothing narrates (no op at all)."""
        with tempfile.TemporaryDirectory() as d:
            _run("--data", d, "new", "--seed", "42")
            _run("--data", d, "step", "40", "--offline")
            quiet = _run("--data", d, "map") + _run("--data", d, "status")
        self.assertNotEqual(quiet, self.world_after(_dead_host()))


if __name__ == "__main__":
    unittest.main()
