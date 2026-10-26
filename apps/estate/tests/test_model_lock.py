"""The model lock across processes: two llm-world processes on one box
take turns at Ollama, and a call whose wait for the lock runs out does not
go ahead without it.

    python3 -m unittest tests.test_model_lock
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = "estate"
sys.path.insert(0, ROOT)
llmm = __import__(APP + ".llm", fromlist=["llm"])

MODELS = [llmm.CHOICE_MODEL, llmm.PROSE_MODEL, "nomic-embed-text:latest"]


class Fake:
    """An Ollama that takes `hold` seconds per chat and counts how many
    chats it is serving at once."""

    def __init__(self, hold=0.3):
        self.hold = hold
        self.inflight = 0
        self.most = 0
        self.chats = 0
        self.mu = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, ctype="application/json"):
                data = body.encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/api/tags":
                    self._send(200, json.dumps(
                        {"models": [{"name": m} for m in MODELS]}))
                elif self.path == "/api/ps":
                    self._send(200, json.dumps({"models": []}))
                else:
                    self._send(404, "{}")

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(n)
                if self.path != "/api/chat":
                    self._send(200, "{}")
                    return
                with fake.mu:
                    fake.chats += 1
                    fake.inflight += 1
                    fake.most = max(fake.most, fake.inflight)
                try:
                    time.sleep(fake.hold)
                    line = json.dumps({"message": {"content":
                                                   '{"why": "ok"}'},
                                       "done": True}) + "\n"
                    self._send(200, line, "application/x-ndjson")
                finally:
                    with fake.mu:
                        fake.inflight -= 1

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.host = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


CHILD = r"""
import sys, time
sys.path.insert(0, {root!r})
llmm = __import__({app!r} + ".llm", fromlist=["llm"])
llm = llmm.LLM(tier="local", host={host!r}, lock_path={lock!r},
               resident="many", timeout=30, lock_wait=30)
mode = {mode!r}
if mode == "hold":
    with llm._serial():
        print("held", flush=True)
        time.sleep({hold})
else:
    ok = 0
    for _ in range({n}):
        ok += llm.chat_json("s", "u", {{"type": "object"}},
                            job=llmm.LEAD_JOB, retries=0) is not None
    print(ok, flush=True)
"""


def child(fake, lock, mode="calls", n=4, hold=0.0):
    code = CHILD.format(root=ROOT, app=APP, host=fake.host, lock=lock,
                        mode=mode, n=n, hold=hold)
    return subprocess.Popen([sys.executable, "-c", code], cwd=ROOT,
                            stdout=subprocess.PIPE, text=True)


class ModelLockTest(unittest.TestCase):

    def setUp(self):
        self.fake = Fake()
        self.addCleanup(self.fake.close)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.lock = os.path.join(tmp.name, "model.lock")

    def test_two_processes_never_overlap(self):
        a = child(self.fake, self.lock)
        b = child(self.fake, self.lock)
        outs = [p.communicate(timeout=60)[0].strip() for p in (a, b)]
        for p in (a, b):
            p.stdout.close()
        self.assertEqual(outs, ["4", "4"])
        self.assertEqual(self.fake.chats, 8)
        self.assertEqual(self.fake.most, 1)

    def _held(self, seconds):
        h = child(self.fake, self.lock, mode="hold", hold=seconds)
        self.addCleanup(h.stdout.close)
        self.addCleanup(h.wait)
        self.assertEqual(h.stdout.readline().strip(), "held")
        return h

    def test_a_wait_that_runs_out_does_not_go_ahead(self):
        self._held(3.0)
        llm = llmm.LLM(tier="local", host=self.fake.host,
                       lock_path=self.lock, resident="many", timeout=30,
                       lock_wait=0.5)
        t0 = time.time()
        out = llm.chat_json("s", "u", {"type": "object"},
                            job=llmm.LEAD_JOB, retries=1)
        self.assertIsNone(out)
        self.assertLess(time.time() - t0, 2.5)
        self.assertEqual(self.fake.chats, 0)     # never sent unlocked
        self.assertIn("holds the model", llm.reason)

    def test_the_deadline_starts_once_the_lock_is_ours(self):
        self._held(1.5)
        llm = llmm.LLM(tier="local", host=self.fake.host,
                       lock_path=self.lock, resident="many", timeout=1.0,
                       lock_wait=10)
        out = llm.chat_json("s", "u", {"type": "object"},
                            job=llmm.LEAD_JOB, retries=0)
        self.assertEqual(out, {"why": "ok"})
        self.assertEqual(self.fake.chats, 1)

    def test_the_process_lock_is_released_after_a_timeout(self):
        self._held(1.5)
        llm = llmm.LLM(tier="local", host=self.fake.host,
                       lock_path=self.lock, resident="many", timeout=30,
                       lock_wait=0.3)
        self.assertIsNone(llm.chat_json("s", "u", {"type": "object"},
                                        job=llmm.LEAD_JOB, retries=0))
        # another thread can take the in-process lock straight away
        got = []

        def take():
            ok = llmm._CALL_LOCK.acquire(timeout=0.5)
            got.append(ok)
            if ok:
                llmm._CALL_LOCK.release()
        t = threading.Thread(target=take)
        t.start()
        t.join()
        self.assertEqual(got, [True])


if __name__ == "__main__":
    unittest.main()
