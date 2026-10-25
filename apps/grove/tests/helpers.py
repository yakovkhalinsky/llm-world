"""A real grove for the tests: made by the CLI in a temporary folder,
loaded the way `grove web` loads it, with the LLM off and the runner never
started (paused), so nothing moves unless a test steps it."""

import os
import subprocess
import sys
import tempfile
import threading
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_grove(seed=42, steps=0, size=None):
    tmp = tempfile.TemporaryDirectory()
    data = os.path.join(tmp.name, "data")
    env = dict(os.environ, PYTHONPATH=ROOT)
    subprocess.run([sys.executable, "-m", "grove", "--data", data, "new",
                    "--seed", str(seed)]
                   + (["--size", str(size)] if size else []),
                   cwd=ROOT, env=env, check=True,
                   stdout=subprocess.DEVNULL)
    if steps:
        subprocess.run([sys.executable, "-m", "grove", "--data", data,
                        "step", str(steps), "--offline"], cwd=ROOT, env=env,
                       check=True, stdout=subprocess.DEVNULL)
    from grove.app import Grove
    from grove import web
    args = types.SimpleNamespace(data=data, rules=None, biome=None,
                                 offline=True, cmd="web")
    g = Grove(args)
    g.load_or_exit()
    lock = threading.Lock()
    runner = web.SimRunner(g, lock, 3600)
    runner.paused = True
    return tmp, data, g, lock, runner
